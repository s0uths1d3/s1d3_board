import Database from "@tauri-apps/plugin-sql";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "~/utils/env";
import { toDateString } from "~/utils/datetime";

/**
 * 统计服务（单例）
 *
 * 职责边界（设计文档 §4）：只负责 `daily_stat` 的读写与聚合查询
 * （record / getDaily / getStatsRange / getDailySeries / 使用时长累计），
 * **不包含任何用户标签 / 趣味换算逻辑**（标签逻辑独立在 userTags.ts）。
 *
 * 性能约束（设计文档 §14）：
 * - §14.1 写入合并：`record()` 只写内存累加器 pending，2s 节流后 `flush()` 批量 UPSERT；
 * - §14.1.1 退出 flush：`app.vue` 监听 beforeunload / Tauri 退出事件强制落库，防内容损耗；
 * - §14.2 存储精简：`stat_date TEXT PRIMARY KEY`，无 id / updated_at / 冗余索引；
 * - §14.3 查询裁剪：只 SELECT 所需列，聚合在数据库侧完成；
 * - §14.4 趋势降采样：区间 > TREND_DOWNSAMPLE_DAYS 时按月聚合；
 * - §14.7 读取时合并 pending：查询把未落库累加器合并进结果，避免实时统计短暂不一致。
 */

/** 统计维度字段（与 daily_stat 各列同名） */
export type StatField =
  | 'clip_text' | 'clip_image' | 'clip_use' | 'clip_chars'
  | 'todo_added' | 'todo_completed' | 'todo_deleted' | 'todo_chars' | 'todo_reminded'
  | 'note_added' | 'note_deleted' | 'favorite_toggle'
  | 'usage_seconds' | 'shortcut_count'
  | 'tab_clip' | 'tab_todo' | 'tab_note' | 'tab_pinned'
  | 'tab_setting' | 'tab_statistics'
  | 'active_dawn' | 'active_day' | 'active_evening' | 'active_night';

/** 区间聚合结果（与 daily_stat 各列同名，值来自 SUM/COALESCE） */
export interface StatsSummary {
  [key: string]: number;
}

/** 趋势图 / 标签计算使用的逐日明细行 */
export interface DailyStatRow {
  stat_date: string;
  [key: string]: number | string;
}

/** 趋势降采样阈值（§14.4）：区间超过约一季则按月聚合，避免上千个柱条常驻 DOM */
export const TREND_DOWNSAMPLE_DAYS = 92;

/** 区间聚合默认查询的字段（§14.3 查询裁剪：不含动态扩展列） */
const DEFAULT_RANGE_FIELDS: StatField[] = [
  'clip_text', 'clip_image', 'clip_use', 'clip_chars',
  'todo_added', 'todo_completed', 'todo_deleted', 'todo_chars', 'todo_reminded',
  'note_added', 'note_deleted', 'favorite_toggle',
  'usage_seconds', 'shortcut_count',
  'tab_clip', 'tab_todo', 'tab_note', 'tab_pinned', 'tab_setting', 'tab_statistics',
  'active_dawn', 'active_day', 'active_evening', 'active_night',
];

/** 两个 YYYY-MM-DD 之间的天数差（含端点），如 08-01~08-15 = 15 天 */
export function daySpan(from: string, to: string): number {
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  if (isNaN(f.getTime()) || isNaN(t.getTime())) return 0;
  return Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
}

class StatsService {
  private static instance: StatsService;
  private db: Database | undefined;

  /** 内存累加器：按日期暂存未落库增量，周期批量写库（§14.1） */
  private pending = new Map<string, Partial<Record<StatField, number>>>();
  /** 节流落库定时器（pending 为空时不挂起，首条写入后启动） */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** 使用时长跟踪状态（§4.5）：30s 结算一次，仅主窗口启动 */
  private usageInterval: ReturnType<typeof setInterval> | null = null;
  private usageLastTick = 0;

  private constructor() {}

  public static getInstance(): StatsService {
    if (!StatsService.instance) {
      StatsService.instance = new StatsService();
    }
    return StatsService.instance;
  }

  private async initDatabase(): Promise<void> {
    this.db = await Database.load('sqlite:s1d3_board.db');
  }

  public async ensureDbInitialized(): Promise<void> {
    if (!this.db) {
      await this.initDatabase();
    }
  }

  /** 供统计相关模块复用同一数据库连接，避免各模块重复 Database.load（多持连接） */
  public async getRawDb(): Promise<Database> {
    await this.ensureDbInitialized();
    return this.db!;
  }

  /** 本地时区今天（YYYY-MM-DD） */
  private today(): string {
    return toDateString(new Date());
  }

  /**
   * 1) 当日累加（核心写入口，fire-and-forget）
   * 仅写入内存累加器，不立即落库——把「事件级」写库降到「窗口级」（§14.1）。
   * 趣味时段列（active_*）按当前小时自动累加，埋点无需感知时段。
   * 传入 key 按白名单过滤：误传未知字段名时静默丢弃，而非拼进 SQL 造成非法语句。
   */
  public async record(partial: Partial<Record<StatField, number>>): Promise<void> {
    try {
      const date = this.today();

      // 趣味数据：按当前小时自动累加到时段列
      const hour = new Date().getHours();
      const bucket: StatField = hour >= 5 && hour < 9
        ? 'active_dawn'
        : hour >= 9 && hour < 18
          ? 'active_day'
          : hour >= 18 && hour < 23
            ? 'active_evening'
            : 'active_night';

      const acc = this.pending.get(date) ?? {};
      for (const [k, v] of Object.entries(partial)) {
        if (!DEFAULT_RANGE_FIELDS.includes(k as StatField)) continue;
        acc[k as StatField] = (acc[k as StatField] ?? 0) + (v ?? 0);
      }
      acc[bucket] = (acc[bucket] ?? 0) + 1;
      this.pending.set(date, acc);

      // 首条触发一个轻量定时器（2s 节流），到期批量 flush
      if (this.flushTimer == null) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush();
        }, 2000);
      }
    } catch (e) {
      // 统计失败不影响业务
      console.error('[stats] record failed:', e);
    }
  }

  /** 2) 强制落库内存累加器（定时 flush / 退出前共用，§14.1 / §14.1.1） */
  public async flush(): Promise<void> {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.size === 0) return;
    try {
      await this.ensureDbInitialized();
      for (const [date, acc] of this.pending) {
        const cols = Object.keys(acc);
        const vals = cols.map(c => acc[c as StatField] ?? 0);
        const setClause = cols.map(k => `${k} = ${k} + excluded.${k}`).join(', ');
        await this.db!.execute(
          `INSERT INTO daily_stat (stat_date, ${cols.join(', ')})
           VALUES ($1, ${vals.map((_, i) => `$${i + 2}`).join(', ')})
           ON CONFLICT(stat_date) DO UPDATE SET ${setClause}`,
          [date, ...vals]
        );
      }
      this.pending.clear();
    } catch (e) {
      // 失败保留 pending 下次重试，不丢数据
      console.error('[stats] flush failed:', e);
    }
  }

  /**
   * 清空全部统计数据（"清空数据库"入口调用）：
   * daily_stat 表与内存累加器必须一并清——只删表的话，pending 里未落库的
   * 增量会在下次 flush 时写回，表现为统计页出现"清不掉"的残留。
   */
  public async clearAll(): Promise<void> {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending.clear();
    await this.ensureDbInitialized();
    await this.db!.execute("DELETE FROM daily_stat");
  }

  /** 把 pending 中落在 [from, to] 区间内的增量合并到聚合结果（§14.7，纯内存加法） */
  private mergePending(target: Record<string, number>, from?: string, to?: string): void {
    for (const [date, acc] of this.pending) {
      if (from && date < from) continue;
      if (to && date > to) continue;
      for (const [k, v] of Object.entries(acc)) {
        target[k] = (target[k] ?? 0) + (v ?? 0);
      }
    }
  }

  /** 3) 查询单日聚合 */
  public async getDaily(date: string): Promise<StatsSummary> {
    await this.ensureDbInitialized();
    const fields = DEFAULT_RANGE_FIELDS.map(f => `COALESCE(${f}, 0) AS ${f}`).join(', ');
    const rows: any[] = await this.db!.select(
      `SELECT ${fields} FROM daily_stat WHERE stat_date = $1`,
      [date]
    );
    const sum: StatsSummary = { ...(rows?.[0] ?? {}) };
    // §14.7：合并未落库的当日累加
    this.mergePending(sum, date, date);
    return sum;
  }

  /** 4) 查询区间聚合（日/周/月/年/自定义统一走这里，仅 SELECT 所需列，§14.3） */
  public async getStatsRange(from: string, to: string, fields?: StatField[]): Promise<StatsSummary> {
    await this.ensureDbInitialized();
    const sumCols = (fields ?? DEFAULT_RANGE_FIELDS)
      .map(f => `COALESCE(SUM(${f}), 0) AS ${f}`)
      .join(', ');
    const rows: any[] = await this.db!.select(
      `SELECT ${sumCols} FROM daily_stat WHERE stat_date BETWEEN $1 AND $2`,
      [from, to]
    );
    const sum: StatsSummary = { ...(rows?.[0] ?? {}) };
    this.mergePending(sum, from, to);
    return sum;
  }

  /**
   * 5) 查询区间内按日（或按月降采样）分组的趋势明细（§7.6 / §14.4）
   * 区间 ≤ TREND_DOWNSAMPLE_DAYS：逐日柱状；超过：按月聚合返回稀疏月柱。
   * 支持多字段求和（如 ["clip_text","clip_image","clip_use"] 为"剪贴活动"）。
   */
  public async getDailySeries(
    from: string,
    to: string,
    fields: StatField[] = ['clip_text', 'clip_image', 'clip_use']
  ): Promise<{ stat_date: string; value: number }[]> {
    await this.ensureDbInitialized();
    if (fields.length === 0) return [];
    const downsample = daySpan(from, to) > TREND_DOWNSAMPLE_DAYS;
    const sumExpr = fields.map(f => `COALESCE(${f}, 0)`).join(' + ');
    // §14.7：pending 中本字段增量
    const pendingAdd = (acc: Partial<Record<StatField, number>>): number =>
      fields.reduce((sum, f) => sum + (acc[f] ?? 0), 0);

    let rows: any[];
    if (downsample) {
      // §14.4 按月降采样：服务端 strftime GROUP BY，不把上千行灌入前端
      rows = await this.db!.select(
        `SELECT strftime('%Y-%m', stat_date) AS stat_date, ${sumExpr} AS value
         FROM daily_stat WHERE stat_date BETWEEN $1 AND $2
         GROUP BY strftime('%Y-%m', stat_date) ORDER BY stat_date`,
        [from, to]
      );
      // §14.7：pending 按所属月份合并进降采样结果
      const map = new Map<string, { stat_date: string; value: number }>(
        rows.map(r => [r.stat_date, { stat_date: r.stat_date, value: Number(r.value ?? 0) }])
      );
      for (const [date, acc] of this.pending) {
        if (date < from || date > to) continue;
        const add = pendingAdd(acc);
        if (add <= 0) continue;
        const month = date.slice(0, 7);
        const row = map.get(month);
        if (row) row.value += add;
        else map.set(month, { stat_date: month, value: add });
      }
      return [...map.values()].sort((a, b) => (a.stat_date < b.stat_date ? -1 : 1));
    }

    rows = await this.db!.select(
      `SELECT stat_date, ${sumExpr} AS value FROM daily_stat WHERE stat_date BETWEEN $1 AND $2 ORDER BY stat_date`,
      [from, to]
    );
    const map = new Map<string, { stat_date: string; value: number }>(
      rows.map(r => [r.stat_date, { stat_date: r.stat_date, value: Number(r.value ?? 0) }])
    );
    // §14.7：逐日合并 pending（含跨日边界新行）
    for (const [date, acc] of this.pending) {
      if (date < from || date > to) continue;
      const add = pendingAdd(acc);
      if (add <= 0) continue;
      const row = map.get(date);
      if (row) row.value += add;
      else map.set(date, { stat_date: date, value: add });
    }
    return [...map.values()].sort((a, b) => (a.stat_date < b.stat_date ? -1 : 1));
  }

  /** 最常复制的文本项（趣味数据"复制之王"，§7.5） */
  public async getTopClipboard(): Promise<{ content: string; count: number } | null> {
    await this.ensureDbInitialized();
    const rows: any[] = await this.db!.select(
      `SELECT content, count FROM clipboard WHERE type = 'text' ORDER BY count DESC LIMIT 1`
    );
    return rows?.[0] ?? null;
  }

  /** 区间内活跃天数（有统计记录的天数，供标签/粘性计算） */
  public async getActiveDays(from: string, to: string): Promise<number> {
    await this.ensureDbInitialized();
    const rows: any[] = await this.db!.select(
      `SELECT COUNT(DISTINCT stat_date) AS days FROM daily_stat WHERE stat_date BETWEEN $1 AND $2`,
      [from, to]
    );
    return (rows?.[0]?.days ?? 0);
  }

  /** 最早一条统计日期（YYYY-MM-DD），无数据返回 null */
  public async getEarliestDate(): Promise<string | null> {
    await this.ensureDbInitialized();
    const rows: any[] = await this.db!.select(`SELECT MIN(stat_date) AS d FROM daily_stat`);
    return rows?.[0]?.d ?? null;
  }

  /** 统计表是否已有任何数据（用于判断是否需要生成演示数据） */
  public async hasAnyData(): Promise<boolean> {
    await this.ensureDbInitialized();
    const rows: any[] = await this.db!.select(`SELECT COUNT(*) AS cnt FROM daily_stat`);
    return (rows?.[0]?.cnt ?? 0) > 0;
  }

  /** 7) 使用时长跟踪（app.vue 主窗口调用，§4.5）：30s 结算一次可见且聚焦的时长 */
  public startUsageTracking(): void {
    if (this.usageInterval || !isTauri()) return;
    this.usageLastTick = Date.now();
    this.usageInterval = setInterval(() => {
      void this.tickUsage();
    }, 30000);
  }

  public stopUsageTracking(): void {
    if (this.usageInterval) {
      clearInterval(this.usageInterval);
      this.usageInterval = null;
    }
    // 卸载时执行最后一次结算并落库
    void this.tickUsage().finally(() => void this.flush());
  }

  /** 结算一个 30s 周期：若窗口可见且聚焦则把秒数合并进 pending 累加器（不在此直接落库） */
  private async tickUsage(): Promise<void> {
    try {
      const now = Date.now();
      const elapsed = Math.max(0, now - this.usageLastTick);
      this.usageLastTick = now;
      if (!isTauri()) return;
      const win = getCurrentWindow();
      const [visible, focused] = await Promise.all([
        win.isVisible().catch(() => false),
        win.isFocused().catch(() => false),
      ]);
      if (visible && focused && elapsed > 0) {
        await this.record({ usage_seconds: Math.round(elapsed / 1000) });
      }
    } catch (e) {
      console.error('[stats] usage tick failed:', e);
    }
  }
}

const statsService = StatsService.getInstance();
export default statsService;
