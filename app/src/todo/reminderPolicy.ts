/**
 * 待办智能提醒策略（纯函数，无副作用）
 *
 * 设计目标：低门槛、零配置、自然不机械。
 *
 * 智能分档（按"创建时刻距截止的总时长 runway"判断任务长短）：
 * - runway ≥ 1 小时（长任务）：截止前 30 分钟、10 分钟 各提醒一次
 * - runway < 1 小时（短任务）：仅截止前 5 分钟提醒一次
 *
 * 自然性守卫：
 * - 触发时刻已过、或距当前不足 2 分钟的阶段直接丢弃——临期创建的任务
 *   不会在创建瞬间被"提前提醒"轰炸；
 * - 触发时刻已过但截止时间仍在未来的阶段标记为 missed——应用重启时
 *   由 reminderService 统一补发（多条合并汇总）；
 * - 改期（dueDate/remindAt 变化）会生成全新的 key，已发过的旧 key 不会
 *   阻止新截止时间的提醒重新武装。
 */
import type { Todo, ReminderRule } from '../entities';
import { parseLocalDateTime } from '~/utils/datetime';

/** 提醒阶段：p30/p10/p5 = 截止前 30/10/5 分钟（智能），custom = 自定义闹钟规则，due = 到期时刻 */
export type ReminderStage = 'p30' | 'p10' | 'p5' | 'custom' | 'due';

export interface PlannedReminder {
  /** 去重/重排 key：todoId|dueDate|stage（自定义含 remindAt） */
  key: string;
  stage: ReminderStage;
  /** 触发时刻（毫秒时间戳） */
  fireAt: number;
}

export interface ReminderPlan {
  /** 未来待触发的提醒（正常调度） */
  active: PlannedReminder[];
  /** 已错过触发时刻、但截止仍在未来的提醒（启动补发候选） */
  missed: PlannedReminder[];
}

/** 距现在不足该毫秒数的阶段视为"立即触发"而丢弃，避免临期轰炸 */
const IMMEDIATE_GRACE_MS = 2 * 60 * 1000;

/** 解析本地日期时间字符串（统一走 utils/datetime），非法返回 null */
function parseLocalISO(s?: string): number | null {
  const t = parseLocalDateTime(s);
  return Number.isFinite(t) ? t : null;
}

/** 任务"总时长"：截止时刻 - 创建时刻；created_at 缺失/非法时回退为当前时刻起算 */
function runwayMs(todo: Todo, nowMs: number, dueMs: number): number {
  const created = Number(todo.created_at);
  const createdMs = Number.isFinite(created) && created > 0 ? created : nowMs;
  return Math.max(0, dueMs - createdMs);
}

/** 通知文案：随阶段自然变化 */
export function reminderText(todo: Todo, stage: ReminderStage, nowMs: number): { title: string; body: string } {
  const title = '待办提醒';
  const name = todo.title || '未命名任务';
  switch (stage) {
    case 'p30': return { title, body: `「${name}」还有 30 分钟到期` };
    case 'p10': return { title, body: `「${name}」还有 10 分钟到期` };
    case 'p5': return { title, body: `「${name}」还有 5 分钟到期` };
    case 'custom': {
      const due = parseLocalISO(todo.dueDate) ?? nowMs;
      const remainMin = Math.ceil((due - nowMs) / 60000);
      const remainTxt = remainMin >= 1 ? `还有约 ${remainMin} 分钟到期` : '即将到期';
      return { title, body: `「${name}」${remainTxt}` };
    }
    case 'due': {
      const overdue = (parseLocalISO(todo.dueDate) ?? nowMs) <= nowMs;
      return { title: overdue ? '任务已逾期' : '待办到期', body: `「${name}」已到截止时间` };
    }
  }
}

/** 单条待办的提醒规划：完成/无截止时间 → 空；自定义模式 → 单条 custom；智能模式 → 分档 */
export function computeReminders(todo: Todo, nowMs: number): ReminderPlan {
  const plan: ReminderPlan = { active: [], missed: [] };
  const dueMs = parseLocalISO(todo.dueDate);
  if (!dueMs || todo.completed === 1) return plan;

  const push = (stage: ReminderStage, fireAt: number, keySuffix: string) => {
    const key = `${todo.id}|${todo.dueDate || ''}|${keySuffix}`;
    const item: PlannedReminder = { key, stage, fireAt };
    if (fireAt <= nowMs) {
      // 已错过：智能/到期阶段仅在截止前仍有补发价值（截止后补发已无意义）；
      // 自定义闹钟（custom）是用户显式指定的时刻，即便晚于截止时间也要补发，
      // 否则"截止 18:00、明天 9:00 提醒我"这类规则会在触发瞬间被静默吞掉。
      if (fireAt < dueMs || stage === 'custom') plan.missed.push(item);
    } else if (fireAt - nowMs > IMMEDIATE_GRACE_MS || stage === 'due') {
      plan.active.push(item);
    }
    // 其余：距现在不足 2 分钟的未来阶段丢弃（临期创建不轰炸）
  };

  const mode = todo.remindMode || 'smart';
  if (mode === 'off') return plan;

  if (mode === 'custom') {
    for (const rule of todo.remindRules ?? []) {
      const fireAt = computeRuleFireAt(rule, todo, nowMs, dueMs);
      if (fireAt !== null) push('custom', fireAt, `${rule.id}|${rule.kind}|${rule.value}`);
    }
    return plan;
  }

  // 智能分档
  const runway = runwayMs(todo, nowMs, dueMs);
  if (runway >= 60 * 60 * 1000) {
    push('p30', dueMs - 30 * 60 * 1000, 'p30');
    push('p10', dueMs - 10 * 60 * 1000, 'p10');
  } else {
    push('p5', dueMs - 5 * 60 * 1000, 'p5');
  }
  // 到期时刻通知（沿用现有"已逾期不补发历史"语义：错过即在 missed 中被过滤）
  push('due', dueMs, 'due');
  return plan;
}

/** 计算单条闹钟规则的触发时刻；无法计算（缺截止/非法值/时刻解析失败）返回 null */function computeRuleFireAt(rule: ReminderRule, todo: Todo, nowMs: number, dueMs: number): number | null {
  switch (rule.kind) {
    case 'percent': {
      // 按百分比：剩余时长降到该比例的时刻（提前 runway 的 value%）
      if (!(rule.value > 0 && rule.value < 100)) return null;
      const runway = runwayMs(todo, nowMs, dueMs);
      return dueMs - Math.round((runway * rule.value) / 100);
    }
    case 'offset': {
      // 按时间：截止前 value 分钟
      if (!(rule.value > 0)) return null;
      return dueMs - rule.value * 60 * 1000;
    }
    case 'at':
      return parseLocalISO(rule.value);
  }
}

/** 复核 key 是否仍属于该待办的有效提醒（服务触发时防规则被删/改后误发） */
export function hasReminderKey(todo: Todo, key: string, nowMs: number): boolean {
  const plan = computeReminders(todo, nowMs);
  return plan.active.some(i => i.key === key) || plan.missed.some(i => i.key === key);
}

/**
 * 智能分档的可读描述（与 computeReminders 的分档逻辑同源）。
 * 供 Todoitem 悬停提示使用：此前分档阈值在策略与提示两处各写一份，策略一改提示即漂移。
 */
export function describeSmartPlan(todo: Todo): string {
  const dueMs = parseLocalISO(todo.dueDate);
  if (!dueMs) return '';
  const runway = runwayMs(todo, Date.now(), dueMs);
  return runway >= 60 * 60 * 1000
    ? '截止前 30 / 10 分钟各提醒一次'
    : '截止前 5 分钟提醒一次';
}
