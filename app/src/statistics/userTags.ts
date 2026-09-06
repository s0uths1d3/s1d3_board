import type { StatsSummary } from './statsService';
import { daySpan } from './statsService';
import statsService from './statsService';

/**
 * 用户标签模块（独立，§7.8.0）
 *
 * 职责边界：只负责"根据统计信息计算用户画像标签/专属称号"，规则集中配置、纯函数计算，
 * 不写库、不产生副作用；依赖单向（本模块只读调用 statsService 的查询接口）。
 *
 * 设计要点：
 * - 小标签：画像型、趣味命名、比例驱动（相对指标，无绝对阈值），按五类展示上限 + 类别内优先级截取；
 * - 时段类互斥（只保留优先级最高的 1 个），其它类可并列但受类别上限约束；
 * - 大标签：唯一专属称号，综合评分取最高且 ≥ 1.0，否则用兜底称号；
 * - §7.8.5 标签显示门槛：区间跨度 ≥ TAG_MIN_SPAN_DAYS 才计算/展示；
 * - 展示仅文字，不含 emoji 图标（用户要求）。
 */

/** 标签显示门槛（§7.8.5）：所选时间区间跨度必须 ≥ 15 天才展示标签 */
export const TAG_MIN_SPAN_DAYS = 15;

export type UserTagCategory = 'time' | 'intensity' | 'content' | 'feature' | 'stickiness';

export interface UserTag {
  id: string;
  name: string;
  category: UserTagCategory;
}

/**
 * 标签计算上下文（由 computeTags/computeUniqueTitle 统一预处理，供规则条件判定）
 * 包含区间基础量（stats/days/spanDays/earliestDate）与全部派生相对量。
 */
export interface TagContext {
  stats: StatsSummary;
  /** 区间内活跃天数 */
  days: number;
  /** 区间跨度天数（含端点） */
  spanDays: number;
  /** 全局最早使用日期（YYYY-MM-DD）或 null */
  earliestDate: string | null;
  // ===== 派生相对量（§7.8.1 基础量定义）=====
  /** 用户可感知的操作总量（不含时段冗余计数） */
  total: number;
  /** 时段活跃总量（Σ active_*） */
  active: number;
  /** Tab 访问总量（Σ tab_*） */
  tabs: number;
  /** 剪贴总量（文本 + 图片） */
  clipSum: number;
  /** 文字占比 clip_text / (text + image) */
  textRatio: number;
  /** 图片占比 clip_image / (text + image) */
  imageRatio: number;
  /** 粘贴占比 clip_use / (clip_use + clip_text + clip_image) */
  pasteRatio: number;
  /** 快捷键占比 shortcut_count / total */
  shortcutRatio: number;
  /** 待办完成率 todo_completed / todo_added */
  todoCompleteRate: number;
  /** 日均剪贴（text + image）/ days */
  dailyClip: number;
  /** 日均图片 clip_image / days */
  dailyImage: number;
  /** 日均使用时长（小时） */
  dailyHours: number;
  /** 清晨占比 active_dawn / active */
  dawnRatio: number;
  /** 白天占比 active_day / active */
  dayRatio: number;
  /** 深夜占比 active_night / active */
  nightRatio: number;
  /** 四时段最大占比 */
  maxPeriodRatio: number;
  /** 最早使用距今的天数（粘性画像） */
  daysSinceEarliest: number;
}

export interface UserTagRule {
  id: string;
  name: string;
  category: UserTagCategory;
  /** 类别内优先级（小 = 优先展示） */
  priority: number;
  /** 相对指标判定 */
  condition: (ctx: TagContext) => boolean;
}

export interface UserTitleRule {
  id: string;
  name: string;
  /** 相对归一化评分（≥1.0 视为达标） */
  score: (ctx: TagContext) => number;
}

/** 类别展示上限（互斥类上限即 1，§7.8.2） */
export const CATEGORY_LIMIT: Record<UserTagCategory, number> = {
  time: 1,
  intensity: 3,
  content: 3,
  feature: 3,
  stickiness: 2,
};

/** 类别展示标题（§7.8.3） */
export const CATEGORY_LABEL: Record<UserTagCategory, string> = {
  time: 'Usage Period',
  intensity: 'Usage Intensity',
  content: 'Content Preference',
  feature: 'Feature Preference',
  stickiness: 'Stickiness',
};

/** 兜底专属称号（无任何大标签达标时使用，§7.8.4） */
export const DEFAULT_TITLE: UserTag = {
  id: 'newbie',
  name: 'Curious Newbie',
  category: 'time',
};

/** 区间是否满足标签展示门槛（§7.8.5） */
export function tagsSpanEnough(from: string, to: string): boolean {
  return daySpan(from, to) >= TAG_MIN_SPAN_DAYS;
}

// ===== 基础量辅助（相对指标，§7.8.1 基础量定义）=====

/** 用户可感知的操作总量（不含时段列——时段列是 record 的冗余计数，用于时段画像内部占比） */
function statTotal(s: StatsSummary): number {
  const keys = [
    'clip_text', 'clip_image', 'clip_use',
    'todo_added', 'todo_completed', 'todo_deleted',
    'note_added', 'note_deleted', 'favorite_toggle',
    'shortcut_count',
    'tab_clip', 'tab_todo', 'tab_note', 'tab_pinned', 'tab_setting', 'tab_statistics',
  ];
  return keys.reduce((sum, k) => sum + (s[k] ?? 0), 0);
}

function sumActive(s: StatsSummary): number {
  return (s.active_dawn ?? 0) + (s.active_day ?? 0) + (s.active_evening ?? 0) + (s.active_night ?? 0);
}

function sumTabs(s: StatsSummary): number {
  return (s.tab_clip ?? 0) + (s.tab_todo ?? 0) + (s.tab_note ?? 0)
    + (s.tab_pinned ?? 0) + (s.tab_setting ?? 0) + (s.tab_statistics ?? 0);
}

/** 相对比例辅助（除零安全） */
function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** 从基础量构建 TagContext 的派生相对量部分 */
function buildDerived(stats: StatsSummary, days: number, earliestDate: string | null) {
  const total = statTotal(stats);
  const active = sumActive(stats);
  const tabs = sumTabs(stats);
  const clipSum = (stats.clip_text ?? 0) + (stats.clip_image ?? 0);
  const textRatio = ratio(stats.clip_text ?? 0, clipSum);
  const imageRatio = ratio(stats.clip_image ?? 0, clipSum);
  const pasteRatio = ratio(stats.clip_use ?? 0, (stats.clip_use ?? 0) + clipSum);
  const shortcutRatio = ratio(stats.shortcut_count ?? 0, total);
  const todoCompleteRate = ratio(stats.todo_completed ?? 0, stats.todo_added ?? 0);
  const dailyClip = days > 0 ? clipSum / days : 0;
  const dailyImage = days > 0 ? (stats.clip_image ?? 0) / days : 0;
  const dailyHours = days > 0 ? (stats.usage_seconds ?? 0) / 3600 / days : 0;
  const dawnRatio = ratio(stats.active_dawn ?? 0, active);
  const dayRatio = ratio(stats.active_day ?? 0, active);
  const nightRatio = ratio(stats.active_night ?? 0, active);
  const maxPeriodRatio = active > 0
    ? Math.max(dawnRatio, dayRatio, ratio(stats.active_evening ?? 0, active), nightRatio)
    : 0;
  const earliest = earliestDate ? new Date(`${earliestDate}T00:00:00`) : null;
  const daysSinceEarliest = earliest
    ? Math.max(0, Math.round((Date.now() - earliest.getTime()) / 86400000))
    : 0;

  return {
    total,
    active,
    tabs,
    clipSum,
    textRatio,
    imageRatio,
    pasteRatio,
    shortcutRatio,
    todoCompleteRate,
    dailyClip,
    dailyImage,
    dailyHours,
    dawnRatio,
    dayRatio,
    nightRatio,
    maxPeriodRatio,
    daysSinceEarliest,
  };
}

/** 组装完整 TagContext：区间基础量 + 派生相对量 */
function buildContext(stats: StatsSummary, days: number, spanDays: number, earliestDate: string | null): TagContext {
  return { stats, days, spanDays, earliestDate, ...buildDerived(stats, days, earliestDate) };
}

// ===== 小标签规则（§7.8.1，数组驱动，扩展只改这里）=====

export const USER_TAG_RULES: UserTagRule[] = [
  // ----- ① 使用时段画像（占比 · 互斥取 1）-----
  { id: 'xiuxian', name: 'Immortal Cultivator', category: 'time', priority: 1,
    condition: (c) => c.active > 0 && c.nightRatio > 0.6 },
  { id: 'night_owl', name: 'Night Owl', category: 'time', priority: 2,
    condition: (c) => c.active > 0 && c.nightRatio > 0.3 },
  { id: 'worker', name: 'Working Class', category: 'time', priority: 3,
    condition: (c) => c.active > 0 && c.dayRatio > 0.5 },
  { id: 'early_bird', name: 'Early Bird', category: 'time', priority: 4,
    condition: (c) => c.active > 0 && c.dawnRatio > 0.3 },
  { id: 'shift_worker', name: 'Shift Rotator', category: 'time', priority: 5,
    condition: (c) => c.active > 0 && c.maxPeriodRatio <= 0.4 },

  // ----- ② 使用强度画像（日均 / log / 占比 · 上限 3）-----
  { id: 'hardcore', name: 'Grind Lord', category: 'intensity', priority: 1,
    condition: (c) => c.dailyHours >= 4 },
  { id: 'hamster', name: 'Digital Hamster', category: 'intensity', priority: 2,
    condition: (c) => c.dailyClip >= 60 },
  { id: 'roll_king', name: 'Overachiever', category: 'intensity', priority: 3,
    condition: (c) => c.shortcutRatio > 0.5 && c.todoCompleteRate > 0.5 },
  { id: 'freq_clip', name: 'Frequent Clipper', category: 'intensity', priority: 4,
    condition: (c) => c.dailyClip >= 20 },
  { id: 'shortcut_dep', name: 'Shortcut Dependent', category: 'intensity', priority: 5,
    condition: (c) => c.shortcutRatio > 0.3 },
  { id: 'heavy_user', name: 'Heavy User', category: 'intensity', priority: 6,
    condition: (c) => c.dailyHours >= 1 },
  { id: 'shortcut_phd', name: 'Shortcut PhD', category: 'intensity', priority: 7,
    condition: (c) => c.shortcutRatio > 0.6 },
  { id: 'clip_clerk', name: 'Copy-Paste Clerk', category: 'intensity', priority: 8,
    condition: (c) => c.pasteRatio > 0.4 },
  { id: 'clip_machine', name: 'Ruthless Clipboard Machine', category: 'intensity', priority: 9,
    condition: (c) => c.dailyClip > 30 && c.pasteRatio > 0.3 },

  // ----- ③ 内容偏好画像（占比 · 上限 3）-----
  { id: 'image_freak', name: 'Image Addict', category: 'content', priority: 1,
    condition: (c) => c.imageRatio > 0.5 },
  { id: 'text_prison', name: 'Text Jailer', category: 'content', priority: 2,
    condition: (c) => c.textRatio > 0.7 },
  { id: 'homework_sage', name: 'Homework Copier', category: 'content', priority: 3,
    condition: (c) => c.pasteRatio > 0.5 },
  { id: 'snack', name: 'Digital Snack', category: 'content', priority: 4,
    condition: (c) => Math.log10(Math.max(1, c.stats.clip_chars ?? 0)) >= 5 && c.textRatio > 0.6 },
  { id: 'bald_programmer', name: 'Bald Programmer', category: 'content', priority: 5,
    condition: (c) => c.shortcutRatio > 0.3 && c.textRatio > 0.5 },
  { id: 'image_mover', name: 'Image Mover', category: 'content', priority: 6,
    condition: (c) => c.imageRatio > 0.4 && c.dailyImage >= 5 },

  // ----- ④ 功能偏好画像（占比 · 上限 3）-----
  { id: 'efficiency_machine', name: 'Efficiency Machine', category: 'feature', priority: 1,
    condition: (c) => c.shortcutRatio > 0.2 && c.todoCompleteRate > 0.5 && c.dailyHours >= 1 },
  { id: 'time_manager', name: 'Time Master', category: 'feature', priority: 2,
    condition: (c) => c.todoCompleteRate > 0.6 },
  { id: 'pinned_dep', name: 'Pinned Dependent', category: 'feature', priority: 3,
    condition: (c) => c.tabs > 0 && c.stats.tab_pinned! / c.tabs > 0.3 && c.pasteRatio > 0.3 },
  { id: 'todo_freak', name: 'Todo Freak', category: 'feature', priority: 4,
    condition: (c) => ((c.stats.todo_added ?? 0) + (c.stats.todo_completed ?? 0)) / c.total > 0.3 },
  { id: 'note_poet', name: 'Note Poet', category: 'feature', priority: 5,
    condition: (c) => (c.stats.note_added ?? 0) / c.total > 0.3 },
  { id: 'collector_freak', name: 'Collector', category: 'feature', priority: 6,
    condition: (c) => (c.stats.favorite_toggle ?? 0) / c.total > 0.3 },
  { id: 'cloud_supervisor', name: 'Cloud Supervisor', category: 'feature', priority: 7,
    condition: (c) => c.tabs > 0 && (c.stats.tab_statistics ?? 0) / c.tabs > 0.3 },
  { id: 'inspiration', name: 'Inspiration Flowing', category: 'feature', priority: 8,
    condition: (c) => (c.stats.note_added ?? 0) / c.total > 0.3 && c.textRatio > 0.5 },
  { id: 'clip_guard', name: 'Clipboard Guardian', category: 'feature', priority: 9,
    condition: (c) => c.tabs > 0 && (c.stats.tab_clip ?? 0) / c.tabs > 0.5 },
  { id: 'procrastinator', name: 'Procrastinator', category: 'feature', priority: 10,
    // 前置 todo_added > 0：从未使用待办的用户完成率为 0，不该被打上"拖更"标签
    condition: (c) => (c.stats.todo_added ?? 0) > 0 && c.todoCompleteRate < 0.2 },

  // ----- ⑤ 粘性画像（相对 · 上限 2）-----
  { id: 'regular', name: 'Regular', category: 'stickiness', priority: 1,
    condition: (c) => c.spanDays > 0 && c.days / c.spanDays > 0.5 },
  { id: 'loyal', name: 'Loyal User', category: 'stickiness', priority: 2,
    condition: (c) => c.daysSinceEarliest >= 90 },
  { id: 'full_attendance', name: 'Perfect Attendance', category: 'stickiness', priority: 3,
    condition: (c) => c.spanDays > 0 && c.days / c.spanDays > 0.7 },
  { id: 'veteran', name: 'Veteran', category: 'stickiness', priority: 4,
    condition: (c) => c.daysSinceEarliest >= 365 },
];

// ===== 大标签规则（§7.8.4，唯一专属称号）=====

export const USER_TITLE_RULES: UserTitleRule[] = [
  {
    id: 'hexagon_warrior', name: 'Hexagon Warrior',
    score: (c) => {
      const clipRatio = c.clipSum / c.total;
      const todoRatio = ((c.stats.todo_added ?? 0) + (c.stats.todo_completed ?? 0)) / c.total;
      const noteRatio = (c.stats.note_added ?? 0) / c.total;
      const fiveOk = [clipRatio, todoRatio, noteRatio, c.shortcutRatio, c.dailyHours]
        .every(v => v >= 0.3);
      return fiveOk ? 5 : 0;
    },
  },
  { id: 'copy_god', name: 'Copy-Paste God',
    score: (c) => c.dailyClip / 20 + c.pasteRatio * 2 },
  { id: 'hamster_king', name: 'Hamster King',
    score: (c) => c.dailyClip / 60 },
  { id: 'roll_god', name: 'Rolling God',
    score: (c) => c.shortcutRatio * 3 + c.todoCompleteRate * 2 },
  { id: 'night_master', name: 'Night Walker',
    score: (c) => c.nightRatio * 3 },
  { id: 'early_warrior', name: '8AM Warrior',
    score: (c) => c.dawnRatio * 3 },
  { id: 'liver_legend', name: 'Grind Legend',
    score: (c) => c.dailyHours / 4 },
  { id: 'homework_master', name: 'Homework Master',
    score: (c) => c.pasteRatio * 3 },
  { id: 'dust_collector', name: 'Dust-Collector Master',
    score: (c) => (c.stats.favorite_toggle! / c.total + (c.tabs > 0 ? c.stats.tab_pinned! / c.tabs : 0)) * 3 },
  { id: 'stats_eye', name: 'Stats Eye',
    score: (c) => (c.tabs > 0 ? c.stats.tab_statistics! / c.tabs : 0) * 3 },
  { id: 'time_lord', name: 'Time Lord',
    score: (c) => c.todoCompleteRate * 3 + c.dailyHours / 4 },
  { id: 'inspire_master', name: 'Inspiration Master',
    score: (c) => (c.stats.note_added! / c.total) * 3 + c.textRatio * 2 },
  { id: 'brick_king', name: 'Brick King',
    score: (c) => c.dayRatio * 3 },
  { id: 'alchemist', name: 'Text Alchemist',
    score: (c) => c.textRatio * 2 + Math.log10(Math.max(1, c.stats.clip_chars ?? 0)) },
  { id: 'clip_collector', name: 'Clipboard Collector',
    score: (c) => (c.clipSum / c.total) * 2 + (c.stats.favorite_toggle! / c.total) * 2 },
];

// ===== 纯函数计算 =====

/** buildCtx 结果短缓存：同一区间内 computeTags/computeUniqueTitle/computeTitleScores
 *  各自调用 buildCtx 会重复执行 3 组相同的区间查询（实测一次加载 11 次 SQL），
 *  这里做 in-flight 去重 + 短 TTL 复用（区间聚合输入不变时结果一致） */
/** 预处理上下文（派生相对量由 buildContext 在调用方补全） */
interface CtxBase {
  stats: StatsSummary;
  days: number;
  spanDays: number;
  earliestDate: string | null;
}
const ctxCache = new Map<string, { promise: Promise<CtxBase>; expires: number }>();
const CTX_CACHE_TTL_MS = 2000;

/** 预处理查询：区间聚合 + 活跃天数 + 最早日期（全部为只读查询） */
function buildCtx(from: string, to: string): Promise<CtxBase> {
  const key = `${from}|${to}`;
  const hit = ctxCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = (async (): Promise<CtxBase> => {
    const [stats, days, earliestDate] = await Promise.all([
      statsService.getStatsRange(from, to),
      statsService.getActiveDays(from, to),
      statsService.getEarliestDate(),
    ]);
    return { stats, days, spanDays: daySpan(from, to), earliestDate };
  })();
  ctxCache.set(key, { promise, expires: Date.now() + CTX_CACHE_TTL_MS });
  // 失败不留缓存，下次调用重查
  promise.catch(() => ctxCache.delete(key));
  return promise;
}

/**
 * 计算小标签（§7.8.2）
 * 入口首行判断区间跨度门槛（§7.8.5）：不足 15 天返回空数组。
 * 返回按类别分组、类别内按 priority 排序、经互斥/上限截取后的标签数组。
 */
export async function computeTags(from: string, to: string): Promise<UserTag[]> {
  if (daySpan(from, to) < TAG_MIN_SPAN_DAYS) return [];

  const ctx = await buildCtx(from, to);
  const c = buildContext(ctx.stats, ctx.days, ctx.spanDays, ctx.earliestDate);

  const matched = USER_TAG_RULES.filter(r => r.condition(c));

  // 按类别分组，类别内按 priority（小→大）排序
  const byCategory = new Map<UserTagCategory, UserTagRule[]>();
  for (const rule of matched) {
    const list = byCategory.get(rule.category) ?? [];
    list.push(rule);
    byCategory.set(rule.category, list);
  }

  const result: UserTag[] = [];
  for (const [category, rules] of byCategory) {
    rules.sort((a, b) => a.priority - b.priority);
    // 互斥类只取 1 个（优先级最高）；非互斥取前 limit 个
    rules.slice(0, CATEGORY_LIMIT[category]).forEach(r => {
      result.push({ id: r.id, name: r.name, category: r.category });
    });
  }
  return result;
}

/**
 * 计算专属大标签（§7.8.4）
 * 入口首行判断区间跨度门槛（§7.8.5）：不足 15 天返回 null（StatsPage 显示"样本不足"占位）。
 * 达标（score ≥ 1.0）且最高分者为专属称号；全部不达标时返回兜底称号。
 */
export async function computeUniqueTitle(from: string, to: string): Promise<UserTag | null> {
  if (daySpan(from, to) < TAG_MIN_SPAN_DAYS) return null;

  const ctx = await buildCtx(from, to);
  const c = buildContext(ctx.stats, ctx.days, ctx.spanDays, ctx.earliestDate);

  const scored = USER_TITLE_RULES
    .map(rule => ({ rule, score: rule.score(c) }))
    .filter(x => x.score >= 1.0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return DEFAULT_TITLE;
  // category 仅供小标签分组渲染使用；大标签在 StatsPage 中单独展示，不消费该字段
  return { id: best.rule.id, name: best.rule.name, category: 'time' as UserTagCategory };
}

/** 供 StatsPage 展示大标签时参考的评分明细（点击大标签可查看） */
export async function computeTitleScores(from: string, to: string): Promise<{ name: string; score: number }[]> {
  if (daySpan(from, to) < TAG_MIN_SPAN_DAYS) return [];
  const ctx = await buildCtx(from, to);
  const c = buildContext(ctx.stats, ctx.days, ctx.spanDays, ctx.earliestDate);
  return USER_TITLE_RULES
    .map(rule => ({ name: rule.name, score: rule.score(c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
