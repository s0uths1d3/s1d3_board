import type { StatField, StatsSummary } from './statsService';
import { toDateString } from '~/utils/datetime';

/**
 * 统计图表数学层（纯函数，无副作用、无 i18n、无查询）
 *
 * 职责边界：把逐日序列/区间聚合转成图表可直接消费的结构化数据
 * （热力图分格、星期聚合、环比对齐、日期→毫秒换算），
 * 与 story.ts / userTags.ts 同模式：规则集中配置、纯函数计算，便于 vitest 覆盖。
 */

/**
 * 用户可感知操作总量口径字段（与原 StatsPage.totalOpsOf / userTags.statTotal 同口径：
 * 10 个操作字段 + 6 个 tab_* 访问字段，不含 tab_app_usage 与 active_* 时段冗余计数）。
 */
export const OPS_FIELDS: StatField[] = [
  'clip_text', 'clip_image', 'clip_use',
  'todo_added', 'todo_completed', 'todo_deleted',
  'note_added', 'note_deleted', 'favorite_toggle',
  'shortcut_count',
  'tab_clip', 'tab_todo', 'tab_note', 'tab_pinned', 'tab_setting', 'tab_statistics',
];

/** 区间聚合的总操作量（OPS_FIELDS 求和，缺省按 0） */
export function totalOps(s: StatsSummary): number {
  return OPS_FIELDS.reduce((sum, k) => sum + (s[k] ?? 0), 0);
}

/** 逐日序列行（与 statsService.getDailySeries 返回对齐） */
export interface SeriesRow {
  stat_date: string;
  value: number;
}

/** 热力图单元格（level 0-4 对应五档颜色深度） */
export interface HeatmapCell {
  /** YYYY-MM-DD */
  date: string;
  /** 当日总操作量 */
  value: number;
  /** 颜色档位 0（无数据）~ 4（最深） */
  level: 0 | 1 | 2 | 3 | 4;
  /** 周列序号（0 = 最左列） */
  weekIdx: number;
  /** 列内行序号（0 = 周一 … 6 = 周日） */
  dayIdx: number;
}

/** 热力图月份标注（月初所在列） */
export interface HeatmapMonth {
  /** 周列序号（标注起始列） */
  idx: number;
  /** 展示文案（如 "3月" / "Mar"），由调用方传入 */
  label: string;
}

export interface HeatmapGrid {
  cells: HeatmapCell[];
  months: HeatmapMonth[];
}

/**
 * 构建近一年（含 endDate）热力图网格：53 整列 × 7 行（371 格，周一列首）：
 * - 末列覆盖 endDate 所在整周（其后日期为占位格，value 0 灰显，不标注月份）；
 * - 每格 level 按 max 的比例分五档：0 无数据 / >0 / ≥25% / ≥50% / ≥75%；
 * - months 为各月 1 号所在列（同列去重，未来占位日跳过）。
 */
export function buildHeatmapCells(rows: SeriesRow[], endDate: string, monthLabel: (m: number) => string): HeatmapGrid {
  const byDate = new Map(rows.map(r => [r.stat_date, r.value]));
  const end = new Date(`${endDate}T00:00:00`);
  if (isNaN(end.getTime())) return { cells: [], months: [] };

  // 末列周一：endDate 所在周的周一（可能落在 endDate 之前，属未来/占位日期）
  const endDayIdx = (end.getDay() + 6) % 7;
  const lastMonday = new Date(end);
  lastMonday.setDate(end.getDate() - endDayIdx);

  // 首格：倒推 364 天后对齐到所在周的周一
  const first = new Date(end);
  first.setDate(end.getDate() - 364);
  const firstDayIdx = (first.getDay() + 6) % 7;
  const firstMonday = new Date(first);
  firstMonday.setDate(first.getDate() - firstDayIdx);

  // 网格覆盖 firstMonday 至 endDate 所在周的周日（53 整列 × 7 格）：
  // 末列中 endDate 之后的日期为占位格（value 0，level 0 灰显）
  const totalDays = Math.round((lastMonday.getTime() - firstMonday.getTime()) / 86400000) + 7;
  const cells: HeatmapCell[] = [];
  let max = 0;
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(firstMonday);
    d.setDate(firstMonday.getDate() + i);
    const ds = toDateString(d);
    const weekIdx = Math.floor(i / 7);
    const dayIdx = i % 7;
    // 占位格（未来日期）与无记录日均补 0；未来日期不进入 cells 之外的额外处理（level 0 自然灰显）
    const value = byDate.get(ds) ?? 0;
    if (value > max) max = value;
    cells.push({ date: ds, value, level: 0, weekIdx, dayIdx });
  }
  for (const c of cells) {
    if (c.value <= 0) c.level = 0;
    else if (c.value >= max * 0.75) c.level = 4;
    else if (c.value >= max * 0.5) c.level = 3;
    else if (c.value >= max * 0.25) c.level = 2;
    else c.level = 1;
  }

  // 月份标注：每月 1 号所在列（同列去重，首格所在的 1 号若不在网格内自然跳过）
  const months: HeatmapMonth[] = [];
  const seen = new Set<number>();
  for (const c of cells) {
    const d = new Date(`${c.date}T00:00:00`);
    if (d.getDate() !== 1) continue;
    if (c.date > endDate) continue;
    if (!seen.has(c.weekIdx)) {
      seen.add(c.weekIdx);
      months.push({ idx: c.weekIdx, label: monthLabel(d.getMonth()) });
    }
  }
  return { cells, months };
}

/** 星期节奏：周一~周日日均操作量（仅统计有序数值的日期；无记录的星期返回 0） */
export function weekdayAverages(rows: SeriesRow[]): number[] {
  const sums = [0, 0, 0, 0, 0, 0, 0];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    const d = new Date(`${r.stat_date}T00:00:00`);
    if (isNaN(d.getTime())) continue;
    const idx = (d.getDay() + 6) % 7; // 0 = 周一
    sums[idx] = (sums[idx] ?? 0) + r.value;
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  return sums.map((s, i) => ((counts[i] ?? 0) > 0 ? s / (counts[i] ?? 1) : 0));
}

/** 幽灵序列行（上一等长区间；无对照数据的点为 null） */
export interface GhostRow {
  stat_date: string;
  value: number | null;
}

/**
 * 环比对齐：按索引 zip 截断最短（逐日等长区间天然对齐；
 * 降采样月数可能差 1，按索引截断即可，不做日期推断）。
 */
export function alignGhost(cur: SeriesRow[], prev: SeriesRow[]): GhostRow[] {
  const n = Math.min(cur.length, prev.length);
  const out: GhostRow[] = [];
  for (let i = 0; i < n; i++) {
    const c = cur[i]!;
    const p = prev[i]!;
    out.push({ stat_date: c.stat_date, value: p.value });
  }
  return out;
}

/** 日期区间 → 毫秒边界（clipboard.created_at 为本地时区毫秒时间戳；end 为开区间） */
export function dateRangeToMs(from: string, to: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(`${from}T00:00:00`);
  const endMs = Date.parse(`${to}T00:00:00`) + 86400000;
  return { startMs: isNaN(startMs) ? 0 : startMs, endMs: isNaN(endMs) ? startMs : endMs };
}
