/**
 * 待办提醒调度服务（单例，app 级生命周期）
 *
 * 职责：接管待办的全部时间类通知——智能提前提醒（30/10/5 分钟）、自定义提醒、
 * 到期时刻通知——替代原先内联在 TodoList.vue 的单一定时器方案。
 * 收益：定时器挂在主窗口服务上，切换 Tab（TodoList 卸载）不再丢失；
 * 已发记录持久化到 settings 表，重启后不重复轰炸；错过的提醒按策略补发/汇总。
 *
 * 生命周期：app.vue onMounted（仅主窗口）调用 start()（随后首个 sync 处于补发阶段），
 * onBeforeUnmount 调用 stop()；TodoList 在每次数据变化（含 1s 轮询兜底）后调用
 * sync(todos)——策略为纯函数，每次全量重算后与现有定时器 diff，增删有序。
 */
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { watch } from 'vue';
import dbService from '~/src/db/dbService';
import { isTauri } from '~/utils/env';
import { playNotificationSound } from '~/utils/notifySound';
import statsService, { type StatField } from '~/src/statistics/statsService';
import { computeReminders, hasReminderKey, reminderText, type PlannedReminder, type ReminderStage } from '~/src/todo/reminderPolicy';
import type { Todo } from '~/src/entities';
import { isTodoSmartRemindEnabled, useTodoSmartRemind } from '~/composables/useTodoSmartRemind';

/** 已发记录持久化 key（key → 发送时刻毫秒） */
const FIRED_LOG_KEY = 'todo_remind_fired';
/** 已发记录保留时长：30 天前的条目启动时清理 */
const FIRED_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** WebView 将 setTimeout 延迟存为 32 位有符号整数（约 24.86 天），超限溢出为立即执行 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** 单条提醒查询失败的最大重试次数（指数退避），超过后放弃 */
const MAX_FIRE_RETRIES = 5;

interface ScheduledEntry {
  todoId: string;
  stage: ReminderStage;
  timer: ReturnType<typeof setTimeout>;
}

class ReminderService {
  /** key → 定时器条目 */
  private timers = new Map<string, ScheduledEntry>();
  /** 已发记录（持久化，防重启重复轰炸） */
  private firedLog: Record<string, number> = {};
  private started = false;
  /** start() 的初始化 Promise：sync 等到它完成后再执行，防止 firedLog 未加载完成时误补发 */
  private readyPromise: Promise<void> | null = null;
  /** 最近一次 sync 的待办列表（开关切换时重新同步用） */
  private lastTodos: Todo[] = [];
  /** 各提醒 key 的重试计数（handleFire 查询失败退避用） */
  private retryCounts = new Map<string, number>();
  /** 补发阶段：start() 后的首个 sync 收集错过的提醒并合并汇总 */
  private inCatchUp = false;
  /** 补发阶段收集队列 */
  private catchUpQueue: { todo: Todo; item: PlannedReminder }[] = [];
  /** 权限是否已确认授予（避免每次发送都查询） */
  private permissionGranted = false;

  start(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.init().catch((e) => {
        // 初始化失败允许下次 start 重试
        this.readyPromise = null;
        this.started = false;
        throw e;
      });
    }
    return this.readyPromise;
  }

  private async init(): Promise<void> {
    this.started = true;
    this.inCatchUp = true;
    // 触发全局开关的持久化懒加载（默认开启；此前手动关过则此处读回 false）
    const { smartRemindEnabled } = useTodoSmartRemind();
    // 全局开关切换时立即重新同步（关闭拆掉已排程的提前提醒，开启恢复排程），
    // 不必等下一次 TodoList 轮询兜底
    watch(smartRemindEnabled, () => {
      if (this.started && this.lastTodos.length > 0) void this.sync(this.lastTodos);
    });
    // 加载已发记录并清理 30 天前的旧条目
    try {
      const raw = await dbService.getKeyValue(FIRED_LOG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, number>;
        const cutoff = Date.now() - FIRED_LOG_TTL_MS;
        for (const k of Object.keys(parsed)) {
          if ((parsed[k] ?? 0) < cutoff) delete parsed[k];
        }
        this.firedLog = parsed;
      }
    } catch { /* 记录损坏则从空开始，最多重复提醒一次 */ }
    // 预请求系统通知权限（沿用 TodoList 原有行为）
    if (isTauri()) {
      try {
        this.permissionGranted = await isPermissionGranted();
        if (!this.permissionGranted) {
          const p = await requestPermission();
          this.permissionGranted = p === 'granted';
        }
      } catch { /* 发送时再兜底请求 */ }
    }
  }

  stop(): void {
    for (const entry of this.timers.values()) clearTimeout(entry.timer);
    this.timers.clear();
    this.started = false;
    this.inCatchUp = false;
    this.catchUpQueue = [];
    this.lastTodos = [];
    this.retryCounts.clear();
  }

  /** 全量同步：对每条待办重算提醒计划，与当前定时器 diff 后增删 */
  async sync(todos: Todo[]): Promise<void> {
    if (!this.started) return;
    // 等 firedLog 加载完成后再 diff：否则重启瞬间会把已补发过的提醒当成 fresh 再次补发
    await this.readyPromise;
    if (!this.started) return;
    this.lastTodos = todos;
    const now = Date.now();
    const desired = new Map<string, { todo: Todo; item: PlannedReminder }>();

    for (const todo of todos) {
      const plan = computeReminders(todo, now);
      // 全局智能提醒开关关闭时：提前类/自定义类不进入期望集合（diff 循环会移除已排程的定时器），到期通知保留
      for (const item of plan.active) {
        if (item.stage !== 'due' && !isTodoSmartRemindEnabled()) continue;
        desired.set(item.key, { todo, item });
      }
      this.handleMissed(todo, plan.missed);
    }

    // 删除不再需要的定时器（完成/删除/改期/模式切换后旧 key 消失）
    for (const [key, entry] of this.timers) {
      if (!desired.has(key)) {
        clearTimeout(entry.timer);
        this.timers.delete(key);
      }
    }
    // 新增缺失的定时器（已发过的 key 不重发；全局开关关闭时仅保留到期通知）
    for (const [key, { todo, item }] of desired) {
      if (this.timers.has(key) || this.firedLog[key]) continue;
      if (item.stage !== 'due' && !isTodoSmartRemindEnabled()) continue;
      this.scheduleTimer(key, todo.id, item.stage, item.fireAt);
    }

    // 补发阶段结束：本轮收集的 missed 统一汇总发送
    if (this.inCatchUp) {
      this.inCatchUp = false;
      this.flushCatchUp();
    }
  }

  /**
   * 挂载单个提醒定时器（分段）：
   * WebView 将 setTimeout 延迟存为 32 位有符号整数，超过 MAX_TIMEOUT_MS（约 24.86 天）
   * 会溢出为"立即触发"——表现为远期任务创建当下就误报"已到期"，且真提醒被 firedLog 永久吞掉。
   * 因此对超远期的 fireAt 先排一段上限延迟，到点后若仍未到触发时刻则续排剩余时长。
   */
  private scheduleTimer(key: string, todoId: string, stage: ReminderStage, fireAt: number): void {
    const remaining = fireAt - Date.now();
    if (remaining > MAX_TIMEOUT_MS) {
      const timer = setTimeout(() => this.scheduleTimer(key, todoId, stage, fireAt), MAX_TIMEOUT_MS);
      this.timers.set(key, { todoId, stage, timer });
      return;
    }
    const timer = setTimeout(() => void this.handleFire(key, todoId, stage), Math.max(0, remaining));
    this.timers.set(key, { todoId, stage, timer });
  }

  /** missed 处理：补发阶段入队列；平时标记已发、静默跳过（防反复进入 missed 集合） */
  private handleMissed(todo: Todo, missed: PlannedReminder[]): void {
    const fresh = missed.filter(m => !this.firedLog[m.key]);
    if (fresh.length === 0) return;
    for (const item of fresh) this.firedLog[item.key] = Date.now();
    this.persistFiredLog();
    if (this.inCatchUp) {
      for (const item of fresh) this.catchUpQueue.push({ todo, item });
    }
  }

  /** 补发汇总：1 条单独发，多条合并为一条汇总，避免启动时通知轰炸 */
  private flushCatchUp(): void {
    if (this.catchUpQueue.length === 0) return;
    const queue = this.catchUpQueue;
    this.catchUpQueue = [];
    try {
      if (queue.length === 1) {
        // 自定义闹钟按用户设定时刻的口径描述（无截止时间的纯闹钟不涉及"到期"）
        const { todo, item } = queue[0]!;
        if (item.stage === 'custom') {
          const text = reminderText(todo, 'custom', Date.now());
          this.send(text.title, text.body);
        } else {
          this.send('待办提醒', `「${todo.title || '未命名任务'}」即将到期，请留意`);
        }
      } else {
        const names = queue.map(x => x.todo.title || '未命名任务');
        const shown = names.slice(0, 5).join('、');
        const suffix = names.length > 5 ? ` 等 ${names.length} 项` : '';
        this.send('待办提醒', `${names.length} 个待办即将到期：${shown}${suffix}`);
      }
      void statsService.record({ todo_reminded: 1 } as Partial<Record<StatField, number>>);
    } catch { /* 补发失败不影响主流程 */ }
  }

  /** 定时器触发：复核最新状态后再发送（期间可能被完成/改期/删除） */
  private async handleFire(key: string, todoId: string, stage: ReminderStage): Promise<void> {
    this.timers.delete(key);
    if (this.firedLog[key]) return;
    let todo: Todo | undefined;
    try {
      todo = await dbService.fetchSingleTodo(todoId);
    } catch {
      // 查询失败：指数退避重试（未写标记，不会丢提醒）；连续失败达到上限后放弃，
      // 避免数据库持久故障时每个提醒都常驻一个永久重试定时器
      const retries = (this.retryCounts.get(key) ?? 0) + 1;
      if (retries > MAX_FIRE_RETRIES) {
        this.retryCounts.delete(key);
        console.error(`[reminder] 提醒 ${key} 连续 ${MAX_FIRE_RETRIES} 次查询失败，放弃本次触发`);
        return;
      }
      this.retryCounts.set(key, retries);
      const backoff = 5000 * 2 ** (retries - 1);
      const retry = setTimeout(() => void this.handleFire(key, todoId, stage), backoff);
      this.timers.set(key, { todoId, stage, timer: retry });
      return;
    }
    this.retryCounts.delete(key);
    // 自定义闹钟（指定时刻）不依赖截止时间也能触发；其余阶段均围绕截止时间
    if (!todo || todo.completed === 1) return;
    if (stage !== 'custom' && !todo.dueDate) return;
    // 复核 key 仍有效（截止时间/闹钟规则未被改删）：
    // - 智能与到期阶段：key 前缀必须匹配当前截止时间（改期 → 丢弃，sync 重排新 key）
    // - 自定义闹钟：按规则集合重新规划后仍存在才发送（迟到但在截止前 → 照常提醒）
    if (stage === 'custom') {
      if (!hasReminderKey(todo, key, Date.now())) return;
    } else if (!key.startsWith(`${todo.id}|${todo.dueDate || ''}|${stage}`)) {
      return;
    }
    if (stage !== 'due' && todo.dueDate && new Date(todo.dueDate).getTime() <= Date.now() - 1000) return;

    this.firedLog[key] = Date.now();
    this.persistFiredLog();

    const { title, body } = reminderText(todo, stage, Date.now());
    this.send(title, body);
    void statsService.record({ todo_reminded: 1 } as Partial<Record<StatField, number>>);
  }

  /** 发送：合成提示音 + 系统通知（纯 Web 环境仅提示音） */
  private send(title: string, body: string): void {
    playNotificationSound();
    if (!isTauri()) return;
    void (async () => {
      try {
        if (!this.permissionGranted) {
          this.permissionGranted = await isPermissionGranted();
          if (!this.permissionGranted) {
            const p = await requestPermission();
            this.permissionGranted = p === 'granted';
          }
        }
        if (this.permissionGranted) {
          await sendNotification({ title, body });
        }
      } catch { /* 通知失败不影响主流程 */ }
    })();
  }

  private persistFiredLog(): void {
    void dbService.setKeyValue(FIRED_LOG_KEY, JSON.stringify(this.firedLog)).catch(() => { /* 写入失败容忍 */ });
  }
}

export default new ReminderService();
