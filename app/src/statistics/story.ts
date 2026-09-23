import type { StatsSummary } from './statsService';

/**
 * 数据故事化模块（纯函数，无副作用）
 *
 * 职责边界：把统计聚合结果转成"叙事事实"（结构化数字/日期/id），
 * 不做任何查询、不持有 i18n——文案拼装在 StoryCard 消费方完成；
 * 与 userTags.ts 同模式：规则集中配置、纯函数计算。
 *
 * 设计要点：
 * - 故事事实：峰值日 / 主力功能 / 字量换算 / 粘贴占比等原始数字，由页面转成叙事句；
 * - 洞察规则：条件命中的 id 集合（允许同时命中多条），页面按"每日轮换"挑重点展示；
 * - pickDailyInsight：以日期字符串为种子的确定性轮换（同一天结果稳定，无随机数）。
 */

/** 趋势序列行（与 statsService.getDailySeries 返回对齐） */
export interface StorySeriesRow {
  stat_date: string;
  value: number;
}

/** 数据故事事实（全部可空：空态时由页面兜底） */
export interface StoryFacts {
  /** 主力 Tab（访问量最高的功能 id：clip/todo/note/pinned/setting/statistics）或 null */
  topTab: string | null;
  /** 峰值日（区间内操作量最高的一天）或 null */
  topDay: { date: string; value: number } | null;
  /** 复制字符总量 */
  chars: number;
  /** 换算 A4 纸张数（按每页约 500 字） */
  a4Pages: number;
  /** 粘贴占比 0~1（clip_use / (clip_use + clip_text + clip_image)） */
  pasteRatio: number;
  /** 剪贴总量（文本 + 图片） */
  clipSum: number;
  /** 使用时长（秒） */
  usageSeconds: number;
}

function sumTabs(s: StatsSummary): number {
  return (s.tab_clip ?? 0) + (s.tab_todo ?? 0) + (s.tab_note ?? 0)
    + (s.tab_pinned ?? 0) + (s.tab_setting ?? 0) + (s.tab_statistics ?? 0);
}

/** 从聚合结果计算叙事事实 */
export function buildStoryFacts(stats: StatsSummary, series: StorySeriesRow[]): StoryFacts {
  const clipSum = (stats.clip_text ?? 0) + (stats.clip_image ?? 0);
  const chars = stats.clip_chars ?? 0;

  // 主力 Tab：访问量最高者（并列取先出现者）
  const tabEntries: [string, number][] = [
    ['clip', stats.tab_clip ?? 0],
    ['todo', stats.tab_todo ?? 0],
    ['note', stats.tab_note ?? 0],
    ['pinned', stats.tab_pinned ?? 0],
    ['setting', stats.tab_setting ?? 0],
    ['statistics', stats.tab_statistics ?? 0],
  ];
  let topTab: string | null = null;
  let topVal = 0;
  for (const [id, v] of tabEntries) {
    if (v > topVal) {
      topVal = v;
      topTab = id;
    }
  }
  if (topVal <= 0) topTab = null;

  // 峰值日
  let topDay: { date: string; value: number } | null = null;
  for (const row of series) {
    if (!topDay || row.value > topDay.value) topDay = { date: row.stat_date, value: row.value };
  }
  if (topDay && topDay.value <= 0) topDay = null;

  return {
    topTab,
    topDay,
    chars,
    a4Pages: Math.ceil(chars / 500),
    pasteRatio: (stats.clip_use ?? 0) + clipSum > 0 ? (stats.clip_use ?? 0) / ((stats.clip_use ?? 0) + clipSum) : 0,
    clipSum,
    usageSeconds: stats.usage_seconds ?? 0,
  };
}

// ===== 个性化洞察（条件命中 id 集合）=====

export interface InsightInput {
  stats: StatsSummary;
  /** 区间活跃天数 */
  days: number;
  /** 区间跨度天数（含端点） */
  spanDays: number;
  /** 区间内最长连续活跃天数 */
  longestStreak: number;
}

/**
 * 计算当前区间命中的洞察 id 集合（规则集中配置，阈值与画像标签同口径但文案偏"建议/鼓励"）。
 * 末尾保证兜底 insight_keep 一定存在（空数据也有正向反馈可展示）。
 */
export function computeInsightIds(input: InsightInput): string[] {
  const { stats, days, spanDays, longestStreak } = input;
  const ids: string[] = [];

  const clipSum = (stats.clip_text ?? 0) + (stats.clip_image ?? 0);
  const active = (stats.active_dawn ?? 0) + (stats.active_day ?? 0) + (stats.active_evening ?? 0) + (stats.active_night ?? 0);
  const ratio = (n: number, d: number) => (d > 0 ? n / d : 0);

  const nightRatio = ratio(stats.active_night ?? 0, active);
  const dawnRatio = ratio(stats.active_dawn ?? 0, active);
  const pasteRatio = ratio(stats.clip_use ?? 0, (stats.clip_use ?? 0) + clipSum);
  const imageRatio = ratio(stats.clip_image ?? 0, clipSum);
  const textRatio = ratio(stats.clip_text ?? 0, clipSum);
  const shortcutRatio = ratio(stats.shortcut_count ?? 0,
    (stats.clip_text ?? 0) + (stats.clip_image ?? 0) + (stats.clip_use ?? 0)
    + (stats.todo_added ?? 0) + (stats.todo_completed ?? 0) + (stats.todo_deleted ?? 0)
    + (stats.note_added ?? 0) + (stats.note_deleted ?? 0) + (stats.favorite_toggle ?? 0)
    + (stats.shortcut_count ?? 0));
  const todoCompleteRate = ratio(stats.todo_completed ?? 0, stats.todo_added ?? 0);

  if (nightRatio > 0.3) ids.push('insight_night');
  if (dawnRatio > 0.2) ids.push('insight_dawn');
  if (pasteRatio > 0.4) ids.push('insight_paste');
  if (imageRatio > 0.4) ids.push('insight_image');
  if (textRatio > 0.7) ids.push('insight_text');
  if (shortcutRatio > 0.3) ids.push('insight_shortcut');
  if ((stats.todo_added ?? 0) > 0 && todoCompleteRate > 0.5) ids.push('insight_todo');
  if (longestStreak >= 7) ids.push('insight_streak');
  if (spanDays > 0 && days / spanDays > 0.7) ids.push('insight_consistent');
  if ((stats.clip_chars ?? 0) >= 100000) ids.push('insight_chars');
  if ((stats.ai_analysis ?? 0) >= 50) ids.push('insight_ai');

  ids.push('insight_keep');
  return ids;
}

/** 简单字符串哈希（每日轮换用，确定性） */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * 从命中洞察中按日期种子确定性挑出 n 条（默认 2 条）。
 * 同一天同一数据源结果稳定；命中的洞察数不足时全量返回。
 */
export function pickDailyInsights(ids: string[], dateKey: string, n = 2): string[] {
  if (ids.length <= n) return ids.slice();
  // 兜底洞察 insight_keep 保持末位语义：优先展示条件命中项
  const conditional = ids.filter(id => id !== 'insight_keep');
  const fallback = ids.filter(id => id === 'insight_keep');
  const picked: string[] = [];
  const pool = conditional.slice();
  let seed = hashString(dateKey);
  while (picked.length < n && pool.length > 0) {
    seed = (seed * 1103515245 + 12345) | 0;
    const idx = Math.abs(seed) % pool.length;
    const hit = pool.splice(idx, 1)[0];
    if (hit) picked.push(hit);
  }
  return [...picked, ...fallback].slice(0, n);
}
