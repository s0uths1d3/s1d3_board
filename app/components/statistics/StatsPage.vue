<script setup lang="ts">
/**
 * 统计页（§7）
 * - 范围切换（日/周/月/年/自定义）→ 区间聚合 + 趋势 + 标签实时刷新（§7.2 / §14.8 按需加载）
 * - 专属大标签横幅（§7.8.4）+ 我的标签（§7.8.3，按类别分组，受 §7.8.5 区间门槛约束）
 * - 核心指标卡片 / Tab 访问分布 / 趣味数据 / 每日趋势（§7.3-7.6）
 * - 性能：聚合结果用 shallowRef；趋势超 92 天自动按月降采样（§14.4）；组件卸载清理定时器与监听（§14.5）
 */
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useI18n } from '~/composables/useI18n';
import statsService, { daySpan, TREND_DOWNSAMPLE_DAYS, type StatsSummary, type StatField } from '~/src/statistics/statsService';
import {
  computeTags, computeUniqueTitle, computeTitleScores, tagsSpanEnough,
  CATEGORY_LABEL, USER_TITLE_RULES, DEFAULT_TITLE,
  type UserTag, type UserTagCategory,
} from '~/src/statistics/userTags';
import { toDateString } from '~/utils/datetime';
import RangeBar from '~/components/statistics/RangeBar.vue';
import LazySection from '~/components/statistics/LazySection.vue';
import StoryCard from '~/components/statistics/StoryCard.vue';
import ActivityHeatmap from '~/components/statistics/ActivityHeatmap.vue';
import AnimatedNumber from '~/components/statistics/AnimatedNumber.vue';
import { buildStoryFacts, computeInsightIds, pickDailyInsights } from '~/src/statistics/story';
import {
  OPS_FIELDS, totalOps, buildHeatmapCells, weekdayAverages, alignGhost,
  type SeriesRow, type GhostRow,
} from '~/src/statistics/chartMath';
import dbService from '~/src/db/dbService';

const { t, tName, locale } = useI18n();

type RangeKey = 'day' | 'week' | 'month' | 'year' | 'custom';

const rangeOptions = computed<{ key: RangeKey; name: string; tip: string }[]>(() =>
  (['day', 'week', 'month', 'year', 'custom'] as RangeKey[]).map(key => ({
    key,
    name: t(`statistics.${key}`),
    // 范围标签的 hover 口径说明（RangeBar 以 v-tip 展示）
    tip: t(`statistics.range_${key}_desc`),
  }),
));

const range = ref<RangeKey>('month');
const customFrom = ref('');
const customTo = ref('');

/**
 * 阶段偏移：0 = 当前阶段，-1 = 上一阶段，1 = 下一阶段（仅预设范围，自定义不使用）。
 * 由范围切换栏左右箭头调整；周/月/年取完整阶段区间（整周/整月/整年），便于"上一个阶段"浏览。
 */
const rangeOffset = ref(0);

/** 所选范围起止日期 */
const rangeDates = computed<{ from: string; to: string }>(() => {
  const now = new Date();
  const off = rangeOffset.value;
  switch (range.value) {
    case 'day': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + off);
      const s = toDateString(d);
      return { from: s, to: s };
    }
    case 'week': {
      // 周一起始的整周
      const monday = new Date(now);
      monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + off * 7);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return { from: toDateString(monday), to: toDateString(sunday) };
    }
    case 'month': {
      const f = new Date(now.getFullYear(), now.getMonth() + off, 1);
      const last = new Date(f.getFullYear(), f.getMonth() + 1, 0);
      return { from: toDateString(f), to: toDateString(last) };
    }
    case 'year': {
      const y = now.getFullYear() + off;
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    case 'custom':
    default:
      return { from: customFrom.value || toDateString(now), to: customTo.value || toDateString(now) };
  }
});

// 范围选择/阶段切换的交互逻辑在共用组件 RangeBar 内（v-model 同步 range 与 rangeOffset）；
// rangeDates 变化（含 150ms 防抖）驱动下方 load 重新查询。

// ===== 数据（§14.5：聚合结果用 shallowRef，避免大对象深层响应）=====
const loading = ref(false);
/** 查询失败标记：与"暂无数据"空态区分，可重试 */
const loadError = ref(false);
const stats = shallowRef<StatsSummary>({});
/** 当前趋势字段组合 */
const trendFields = ref<StatField[]>(['clip_text', 'clip_image', 'clip_use']);
const series = shallowRef<{ stat_date: string; value: number }[]>([]);
const tags = ref<UserTag[]>([]);
const title = ref<UserTag | null>(null);
const titleScores = ref<{ name: string; score: number }[]>([]);
const kingClip = ref<{ content: string; count: number } | null>(null);

// ===== 成就庆祝 / 数据故事 / 图表视图（§7.9 统计界面升级）=====

/** 趋势图视图模式：柱状 / 折线 */
const trendMode = ref<'bar' | 'line'>('bar');
/** 甜甜圈图 hover 联动的 Tab id（null = 未悬停） */
const hoveredTab = ref<string | null>(null);
/** 区间活跃天数（洞察规则输入，load 时查询） */
const activeDays = ref(0);
/** 环比上一等长区间的操作总量变化（pct null = 无对照数据，不展示徽章） */
const growth = ref<{ pct: number | null; diff: number }>({ pct: null, diff: 0 });
/** 来源应用 Top（区间内复制条数；失败/无数据为空数组） */
const srcApps = ref<{ app: string; cnt: number }[]>([]);
/** 环比幽灵序列（上一等长区间，与 series 按索引对齐，短者截断） */
const ghostSeries = ref<GhostRow[]>([]);
/** 年度热力图逐日序列（近 365 天，仅挂载时查询一次） */
const heatRows = ref<SeriesRow[]>([]);
/** 区间内逐日总操作量（星期节奏输入） */
const weekRows = ref<SeriesRow[]>([]);
/** 竞态守卫：load 会话（主链/growth）与趋势会话（series/ghost）分离计数，
 *  响应落值前比对序号，过期即丢弃（快速切范围/切趋势字段的旧响应不覆盖新数据） */
let rangeSeq = 0;
let trendSeq = 0;

const trendOptions = computed<{ key: string; name: string; fields: StatField[]; desc: string }[]>(() => [
  { key: 'activity', name: t('statistics.trend_activity'), fields: ['clip_text', 'clip_image', 'clip_use'], desc: t('statistics.trend_desc_activity') },
  { key: 'clip_use', name: t('statistics.trend_paste'), fields: ['clip_use'], desc: t('statistics.trend_desc_clip_use') },
  { key: 'smart', name: t('statistics.trend_smart'), fields: ['ai_analysis', 'clip_cut'], desc: t('statistics.trend_desc_smart') },
  { key: 'usage', name: t('statistics.trend_duration'), fields: ['usage_seconds'], desc: t('statistics.trend_desc_usage') },
  { key: 'shortcut', name: t('statistics.trend_shortcut'), fields: ['shortcut_count'], desc: t('statistics.trend_desc_shortcut') },
  { key: 'todo', name: t('todo.title'), fields: ['todo_added', 'todo_completed', 'todo_reminded'], desc: t('statistics.trend_desc_todo') },
  { key: 'todo_chars', name: t('statistics.trend_todo_chars'), fields: ['todo_chars'], desc: t('statistics.trend_desc_todo_chars') },
  { key: 'note', name: t('note.title'), fields: ['note_added'], desc: t('statistics.trend_desc_note') },
]);

/** 标签区是否达到展示门槛（§7.8.5：跨度 ≥ 15 天） */
const tagSpanOK = computed(() => tagsSpanEnough(rangeDates.value.from, rangeDates.value.to));

/** 大标签评分明细是否展开 */
const showTitleScores = ref(false);

/** 范围切换时是否处于"降采样"（月度柱状） */
const isDownsampled = computed(() => daySpan(rangeDates.value.from, rangeDates.value.to) > TREND_DOWNSAMPLE_DAYS);

/** 流式区块重放标记：切换日期范围时递增，强制下方区块重新"骨架→滚动加载" */
const lazyKey = ref(0);

async function load(opts?: { skeleton?: boolean }) {
  const { from, to } = rangeDates.value;
  // 首次进入 Tab（或需要整页骨架）时显示整页加载态；
  // 切换日期范围时不隐藏首屏内容，仅重置下方流式区块（lazyKey++）重放流式加载。
  const showFullSkeleton = opts?.skeleton ?? true;
  loadError.value = false;
  if (showFullSkeleton) {
    loading.value = true;
  } else {
    lazyKey.value++;
  }
  // 竞态守卫：本会话序号（load 同时开新趋势会话，旧 series/ghost/growth 一并过期）
  const rs = ++rangeSeq;
  const ts = ++trendSeq;
  try {
    const [sum, s, tg, tl, scores, ad, week, srcTop] = await Promise.all([
      statsService.getStatsRange(from, to),
      statsService.getDailySeries(from, to, trendFields.value),
      computeTags(from, to),
      computeUniqueTitle(from, to),
      computeTitleScores(from, to),
      statsService.getActiveDays(from, to),
      // 星期节奏：逐日总操作量（强制逐日，与趋势字段选择无关）
      statsService.getDailySeries(from, to, OPS_FIELDS, { forceDaily: true }),
      // 来源应用 Top：失败不阻塞整页（旧数据无 source_app，常见空结果）
      dbService.fetchSourceAppTop(from, to, 5).catch(() => []),
    ]);
    if (rs !== rangeSeq) return; // 已有更新的 load 会话，丢弃本响应
    stats.value = sum;
    series.value = s;
    tags.value = tg;
    title.value = tl;
    titleScores.value = scores;
    activeDays.value = ad;
    weekRows.value = week;
    srcApps.value = srcTop;
    // 复制之王（趣味数据，§7.5）：直接查 clipboard 表
    try {
      kingClip.value = await statsService.getTopClipboard();
    } catch {
      kingClip.value = null;
    }
    // 阶段增长徽章：环比上一等长区间（fire-and-forget，失败不展示；过期会话丢弃）
    const prev = prevRangeDates.value;
    statsService.getStatsRange(prev.from, prev.to).then((ps) => {
      if (rs !== rangeSeq) return;
      const cur = totalOpsOf(sum);
      const pv = totalOpsOf(ps);
      growth.value = pv > 0
        ? { pct: ((cur - pv) / pv) * 100, diff: cur - pv }
        : { pct: null, diff: 0 };
    }).catch(() => { if (rs === rangeSeq) growth.value = { pct: null, diff: 0 }; });
    // 环比幽灵序列（fire-and-forget，仅趋势区可见时查询；降采样两侧同规则对齐）
    if (range.value !== 'day') {
      statsService.getDailySeries(prev.from, prev.to, trendFields.value).then((gs) => {
        if (ts !== trendSeq) return;
        ghostSeries.value = alignGhost(s, gs);
      }).catch(() => { if (ts === trendSeq) ghostSeries.value = []; });
    }
  } catch (e) {
    // 查询失败显式标记：不与"暂无统计数据"空态混淆（过期会话的失败不覆盖新会话状态）
    if (rs === rangeSeq) {
      loadError.value = true;
      console.error('统计页加载失败:', e);
    }
  } finally {
    if (rs === rangeSeq) loading.value = false;
  }
}

/** 切换趋势字段后仅重拉趋势序列（新趋势会话：旧 series/ghost 过期丢弃） */
async function switchTrend(opt: { key: string; name: string; fields: StatField[] }) {
  trendFields.value = opt.fields;
  const ts = ++trendSeq;
  const { from, to } = rangeDates.value;
  const s = await statsService.getDailySeries(from, to, opt.fields);
  if (ts !== trendSeq) return;
  series.value = s;
  // 幽灵序列同步重查（fire-and-forget，过期丢弃）
  const prev = prevRangeDates.value;
  statsService.getDailySeries(prev.from, prev.to, opt.fields).then((gs) => {
    if (ts !== trendSeq) return;
    ghostSeries.value = alignGhost(s, gs);
  }).catch(() => { if (ts === trendSeq) ghostSeries.value = []; });
}

// rangeDates 已涵盖 range 切换与自定义日期输入变化（§14.8：仅进入统计 Tab 才查询）
// 切换日期范围：不显示整页骨架，首屏原地更新，下方流式区块重放"骨架→滚动加载"。
// 加 150ms trailing 防抖：自定义区间下 DatePicker 分别写入 from/to，一次选择会触发两次变化，
// 合并为一次加载（配合 userTags 的 buildCtx 短缓存，避免连续全量重查）。
let loadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(rangeDates, () => {
  if (loadDebounceTimer) clearTimeout(loadDebounceTimer);
  loadDebounceTimer = setTimeout(() => {
    loadDebounceTimer = null;
    void load({ skeleton: false });
  }, 150);
});

onBeforeUnmount(() => {
  if (loadDebounceTimer) {
    clearTimeout(loadDebounceTimer);
    loadDebounceTimer = null;
  }
});

onMounted(async () => {
  // 进入统计 Tab 才发起查询（§14.8 按需加载），首次显示整页骨架
  await nextTick();
  void load({ skeleton: true });
  // 年度热力图：固定近 365 天，仅挂载时查询一次（切范围不重查；页面无 keep-alive，切 Tab 重挂即刷新）
  const today = toDateString(new Date());
  const fromD = new Date();
  fromD.setDate(fromD.getDate() - 364);
  statsService.getDailySeries(toDateString(fromD), today, OPS_FIELDS, { forceDaily: true })
    .then((rows) => { heatRows.value = rows; })
    .catch(() => { heatRows.value = []; });
});

/** 热力图点击某天：范围切换为该日的自定义区间 */
function heatmapPick(date: string) {
  range.value = 'custom';
  rangeOffset.value = 0;
  customFrom.value = date;
  customTo.value = date;
}

// ===== 派生指标 =====

const hasData = computed(() => {
  const s = stats.value;
  return Object.values(s).some(v => (v ?? 0) > 0);
});

/** 使用时长格式化：xx 小时 xx 分 / xx 分钟 / xx 秒（§7.3） */
function formatDuration(seconds: number): string {
  const sec = Math.round(seconds || 0);
  if (sec < 60) return t('statistics.dur_sec', { n: sec });
  const minutes = Math.floor(sec / 60);
  if (minutes < 60) return t('statistics.dur_min', { n: minutes });
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  return restMin > 0 ? t('statistics.dur_hour_min', { n: hours, m: restMin }) : t('statistics.dur_hour', { n: hours });
}

const metricCards = computed(() => {
  const s = stats.value;
  return [
    { name: t('statistics.metric_clip_total'), value: (s.clip_text ?? 0) + (s.clip_image ?? 0), hint: t('statistics.metric_clip_total_hint'), icon: 'clip' },
    { name: t('statistics.metric_image'), value: s.clip_image ?? 0, hint: t('statistics.metric_image_hint'), icon: 'image' },
    { name: t('statistics.metric_paste'), value: s.clip_use ?? 0, hint: t('statistics.metric_paste_hint'), icon: 'paste' },
    { name: t('statistics.metric_ai_analysis'), value: s.ai_analysis ?? 0, hint: t('statistics.metric_ai_analysis_hint'), icon: 'ai' },
    { name: t('statistics.metric_cut'), value: s.clip_cut ?? 0, hint: t('statistics.metric_cut_hint'), icon: 'cut' },
    { name: t('statistics.metric_todo_ops'), value: (s.todo_added ?? 0) + (s.todo_completed ?? 0), hint: t('statistics.metric_todo_ops_hint'), icon: 'todo' },
    { name: t('statistics.metric_todo_chars'), value: s.todo_chars ?? 0, hint: t('statistics.metric_todo_chars_hint'), icon: 'todo_text' },
    { name: t('statistics.metric_note'), value: s.note_added ?? 0, hint: t('statistics.metric_note_hint'), icon: 'note' },
    { name: t('statistics.metric_favorite'), value: s.favorite_toggle ?? 0, hint: t('statistics.metric_favorite_hint'), icon: 'star' },
    { name: t('statistics.metric_usage'), value: formatDuration(s.usage_seconds ?? 0), hint: t('statistics.metric_usage_hint'), icon: 'clock' },
    { name: t('statistics.metric_shortcut'), value: s.shortcut_count ?? 0, hint: t('statistics.metric_shortcut_hint'), icon: 'keyboard' },
  ];
});

/** Tab 访问分布（§7.4）；每行标签附 hover 说明 */
const tabDist = computed(() => {
  const s = stats.value;
  const items = [
    { id: 'clip', name: t('titlebar.clip'), value: s.tab_clip ?? 0 },
    { id: 'todo', name: t('titlebar.todo'), value: s.tab_todo ?? 0 },
    { id: 'note', name: t('titlebar.note'), value: s.tab_note ?? 0 },
    { id: 'pinned', name: t('titlebar.pinned'), value: s.tab_pinned ?? 0 },
    { id: 'setting', name: t('titlebar.setting'), value: s.tab_setting ?? 0 },
    { id: 'statistics', name: t('titlebar.statistics'), value: s.tab_statistics ?? 0 },
  ].filter(i => i.value > 0);
  const total = items.reduce((sum, i) => sum + i.value, 0);
  return items.map(i => ({
    ...i,
    pct: total > 0 ? (i.value / total) * 100 : 0,
    tip: t(`statistics.tabdist_${i.id}_desc`),
  }));
});

// ===== 趣味数据（§7.5）=====

/** 打字量（复制字符总量）→ "约 X 万字" */
const typingChars = computed(() => {
  const chars = stats.value.clip_chars ?? 0;
  return chars > 0 ? t('statistics.typing_wan', { n: (chars / 10000).toFixed(1) }) : t('statistics.typing_zero');
});

/** 最长连续使用天数（基于趋势序列的日期集合）；月降采样时单位为"月" */
const longestStreak = computed(() => {
  const dates = series.value.map(r => r.stat_date);
  if (dates.length === 0) return 0;
  // 月降采样时只统计月份连续（说明持续使用）
  if (isDownsampled.value) return dates.length;
  const set = new Set(dates);
  let best = 0;
  let cur = 0;
  const sorted = dates.slice().sort();
  // 基于首尾逐日遍历
  const start = new Date(`${sorted[0]}T00:00:00`);
  const end = new Date(`${sorted[sorted.length - 1]}T00:00:00`);
  const day = new Date(start);
  while (day.getTime() <= end.getTime()) {
    const ds = toDateString(day);
    cur = set.has(ds) ? cur + 1 : 0;
    best = Math.max(best, cur);
    day.setDate(day.getDate() + 1);
  }
  return best;
});

/** 展示文案：降采样视图统计的是"连续活跃月"，单位不能仍写"天" */
const longestStreakLabel = computed(() =>
  isDownsampled.value ? t('statistics.streak_months', { n: longestStreak.value }) : t('statistics.streak_days', { n: longestStreak.value })
);

/** 活跃时段分布（4 段条形，最高高亮，§7.5）；每行附时段口径 hover 说明 */
const periodDist = computed(() => {
  const s = stats.value;
  const items = [
    { id: 'dawn', name: t('statistics.period_dawn'), time: t('statistics.period_dawn_hours'), value: s.active_dawn ?? 0 },
    { id: 'day', name: t('statistics.period_day'), time: t('statistics.period_day_hours'), value: s.active_day ?? 0 },
    { id: 'evening', name: t('statistics.period_evening'), time: t('statistics.period_evening_hours'), value: s.active_evening ?? 0 },
    { id: 'night', name: t('statistics.period_night'), time: t('statistics.period_night_hours'), value: s.active_night ?? 0 },
  ];
  const total = items.reduce((sum, i) => sum + i.value, 0);
  const max = Math.max(...items.map(i => i.value), 0);
  return items.map(i => ({
    ...i,
    pct: total > 0 ? (i.value / total) * 100 : 0,
    isMax: i.value === max && max > 0,
    tip: t(`statistics.period_${i.id}_desc`),
  }));
});

/** 时长换算（§7.5）：相当于看了 X 部 2 小时电影 */
const movieEquiv = computed(() => {
  const sec = stats.value.usage_seconds ?? 0;
  return sec >= 7200 ? Math.floor(sec / 7200) : 0;
});

/** 复制之王预览（前 20 字） */
const kingPreview = computed(() => {
  const c = kingClip.value?.content ?? '';
  const clean = c.replace(/\s+/g, ' ').trim();
  return clean.length > 20 ? `${clean.slice(0, 20)}…` : (clean || t('statistics.no_copy_record'));
});

/** 图标渲染 */
const icons: Record<string, string> = {
  clip: 'M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2M4 8h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z',
  image: 'M4 16l4.586-4.586a2 2 0 0 1 2.828 0L16 16m-2-2 1.586-1.586a2 2 0 0 1 2.828 0L20 14m-6-6h.01M6 20h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z',
  paste: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2',
  ai: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Zm7 12l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9L19 15Z',
  cut: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.12 8.12 12 12l-3.88 3.88M20 4 8.12 15.88M14.8 14.8 20 20',
  todo: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4',
  todo_text: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M7 13h6M7 17h4',
  note: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
  star: 'M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z',
  clock: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  keyboard: 'M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Zm2 3h.01M7 13h.01M11 13h.01M15 13h.01M17 10h.01M10 17h4',
};

/** 指标卡片图标内联 SVG path（按名称取 path 片段） */
function iconPath(name: string): string {
  return icons[name] ?? icons.clip!;
}

/** 千分位格式化 */
function fmtNum(n: number): string {
  return (n ?? 0).toLocaleString('zh-CN');
}

/** 标签按类别分组展示（§7.8.3） */
const tagsByCategory = computed(() => {
  const order: UserTagCategory[] = ['time', 'intensity', 'content', 'feature', 'stickiness'];
  return order
    .map(cat => ({ cat, label: CATEGORY_LABEL[cat], items: tags.value.filter(t => t.category === cat) }))
    .filter(g => g.items.length > 0);
});

/** 称号内部名 → 规则 id（评分明细 chip 的 hover 说明按 id 取文案） */
const titleIdByName = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const r of USER_TITLE_RULES) map[r.name] = r.id;
  map[DEFAULT_TITLE.name] = DEFAULT_TITLE.id;
  return map;
});

/** 趋势图最大值（归一化柱高） */
const trendMax = computed(() => Math.max(...series.value.map(r => r.value), 0));

// ===== 数据故事 / 洞察 / 环比增长（§7.9）=====

/** 用户可感知操作总量（与 userTags.statTotal 同口径：不含时段冗余计数；字段清单统一在 chartMath.OPS_FIELDS） */
function totalOpsOf(s: StatsSummary): number {
  return totalOps(s);
}

/** 上一等长区间（整体前移一个跨度，含自定义区间） */
const prevRangeDates = computed<{ from: string; to: string }>(() => {
  const { from, to } = rangeDates.value;
  const f = new Date(`${from}T00:00:00`);
  const span = daySpan(from, to);
  const prevTo = new Date(f);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevTo.getDate() - (span - 1));
  return { from: toDateString(prevFrom), to: toDateString(prevTo) };
});

/** 数据故事事实（峰值日 / 主力功能 / 字量换算） */
const storyFacts = computed(() => buildStoryFacts(stats.value, series.value));

/** Tab 内部 id → 展示名（复用 titlebar 文案） */
function tabName(id: string): string {
  return t(`titlebar.${id}`);
}

/** 故事叙事行（[[...]] 标记金色高亮数字，StoryCard 拆分渲染） */
const storyLines = computed<string[]>(() => {
  const f = storyFacts.value;
  const lines: string[] = [];
  lines.push(t('statistics.story_ops', { n: `[[${fmtNum(totalOpsOf(stats.value))}]]` }));
  if (f.chars > 0) {
    lines.push(t('statistics.story_typing', { n: (f.chars / 10000).toFixed(1), m: `[[${fmtNum(f.a4Pages)}]]` }));
  }
  if (f.topTab) {
    lines.push(t('statistics.story_top_tab', { name: `[[${tabName(f.topTab)}]]` }));
  }
  if (f.clipSum > 0) {
    lines.push(t('statistics.story_paste', { pct: `[[${(f.pasteRatio * 100).toFixed(0)}]]` }));
  }
  if (f.topDay) {
    lines.push(t('statistics.story_top_day', { date: `[[${f.topDay.date}]]`, n: fmtNum(f.topDay.value) }));
  }
  if (f.usageSeconds >= 3600) {
    const h = Math.floor(f.usageSeconds / 3600);
    lines.push(t('statistics.story_usage', { n: `[[${t('statistics.dur_hour', { n: h })}]]`, m: Math.floor(f.usageSeconds / 7200) }));
  }
  return lines;
});

/** 个性化洞察（条件命中 + 按日期种子每日轮换取 2 条，同一天结果稳定） */
const insights = computed<string[]>(() => {
  const ids = computeInsightIds({
    stats: stats.value,
    days: activeDays.value,
    spanDays: daySpan(rangeDates.value.from, rangeDates.value.to),
    longestStreak: longestStreak.value,
  });
  return pickDailyInsights(ids, rangeDates.value.from, 2);
});

// ===== Tab 访问分布甜甜圈（§7.9，与列表 hover 联动）=====

/** 甜甜圈分段（周长 2πr，dasharray/dashoffset 累进绘制，透明度按序衰减） */
const donut = computed(() => {
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const OPS = [1, 0.82, 0.64, 0.5, 0.38, 0.28];
  const segs = tabDist.value.map((item, i) => {
    const len = Math.max((item.pct / 100) * C - 2, 0);
    const seg = { ...item, dash: `${len} ${C - len}`, dashOffset: -offset, op: OPS[i % OPS.length] };
    offset += len;
    return seg;
  });
  return { C, segs, total: tabDist.value.reduce((s, i) => s + i.value, 0) };
});

/** 甜甜圈中心内容：hover 时展示对应 Tab 的占比，否则展示总量 */
const donutCenter = computed(() => {
  if (hoveredTab.value) {
    const hit = donut.value.segs.find(sg => sg.id === hoveredTab.value);
    if (hit) return `${hit.pct.toFixed(0)}%`;
  }
  return fmtNum(donut.value.total);
});
const donutCenterLabel = computed(() => {
  if (hoveredTab.value) {
    const hit = donut.value.segs.find(sg => sg.id === hoveredTab.value);
    if (hit) return hit.name;
  }
  return t('statistics.donut_total');
});

// ===== 趋势折线视图（§7.9）=====

/** 图表归一化最大值：主序列与幽灵序列取大者（两侧同尺度，环比形状才可比） */
const chartMax = computed(() => {
  const g = Math.max(...ghostSeries.value.map(r => r.value ?? 0), 0);
  return Math.max(trendMax.value, g);
});

/** 折线几何：归一化点位 + 面积路径 + 峰值点（viewBox 拉伸 + non-scaling-stroke 保线宽） */
const lineChart = computed(() => {
  const rows = series.value;
  const n = rows.length;
  if (n === 0) return null;
  const step = 12;
  const H = 160;
  const padTop = 14;
  const padBottom = 6;
  const max = chartMax.value;
  const pts = rows.map((r, i) => ({
    x: i * step + step / 2,
    y: max > 0 ? padTop + (1 - r.value / max) * (H - padTop - padBottom) : H - padBottom,
    row: r,
  }));
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${path} L${pts[n - 1]!.x.toFixed(1)},${H} L${pts[0]!.x.toFixed(1)},${H} Z`;
  const peak = pts.reduce((a, b) => (b.row.value > a.row.value ? b : a), pts[0]!);
  return { W: n * step, H, step, pts, path, area, peak };
});

// ===== 环比幽灵序列（§7.9 深度优化：上一等长区间虚线/淡柱对照）=====

/** 幽灵线几何：与 lineChart 同 step/H/尺度（alignGhost 已按索引对齐截断） */
const ghostChart = computed(() => {
  const rows = ghostSeries.value;
  const n = rows.length;
  if (n === 0 || !lineChart.value) return null;
  const max = chartMax.value;
  const H = 160;
  const padTop = 14;
  const padBottom = 6;
  const pts = rows.map((r, i) => ({
    x: i * 12 + 6,
    y: r.value !== null && max > 0 ? padTop + (1 - r.value / max) * (H - padTop - padBottom) : H - padBottom,
  }));
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return { path };
});

/** 柱状视图幽灵柱高度值（0 = 无对照/无数据不渲染） */
function ghostBarAt(idx: number): number {
  return ghostSeries.value[idx]?.value ?? 0;
}

// ===== 年度热力图 / 星期节奏 / 来源应用（§7.9 深度优化）=====

/** 热力图网格：近 365 天逐日总操作量分格（月份短名跟随当前语言，Intl 生成无需 i18n key） */
const heatmap = computed(() => buildHeatmapCells(
  heatRows.value,
  toDateString(new Date()),
  m => new Date(2026, m, 1).toLocaleDateString(locale.value, { month: 'short' }),
));

/** 星期节奏：周一~周日日均操作量 */
const weekdayDist = computed(() => weekdayAverages(weekRows.value));
const weekdayMax = computed(() => Math.max(...weekdayDist.value, 0));

/** 星期均值展示：整数直接显示，小数保留 1 位 */
function fmtAvg(n: number): string {
  return Number.isInteger(n) ? fmtNum(n) : n.toFixed(1);
}

/** 来源榜条形相对最大值宽度 */
const srcMax = computed(() => Math.max(...srcApps.value.map(a => a.cnt), 0));

/** 来源榜 hover 描述：应用名条目上已可见，气泡补充条数与来源占比 */
function srcTip(a: { app: string; cnt: number }): string {
  const total = srcApps.value.reduce((s, x) => s + x.cnt, 0);
  const pct = total > 0 ? Math.round((a.cnt / total) * 100) : 0;
  return t('statistics.src_tip', { app: a.app, n: fmtNum(a.cnt), p: String(pct) });
}

/** 趋势图逐点 hover 描述：本期值 + 上一等长区间对照值（有幽灵数据时追加） */
function barTip(idx: number): string {
  const point = series.value[idx];
  if (!point) return '';
  const g = ghostBarAt(idx);
  const base = `${point.stat_date} · ${fmtNum(point.value)}`;
  return g > 0 ? `${base} · ${t('statistics.ghost_tip', { n: fmtNum(g) })}` : base;
}

</script>

<template>
  <div class="space-y-4 pb-8">
    <!-- ===== 范围切换栏（§7.2，与应用时长页共用 RangeBar）===== -->
    <RangeBar
      v-model="range"
      :options="rangeOptions"
      v-model:offset="rangeOffset"
      v-model:custom-from="customFrom"
      v-model:custom-to="customTo"
      :label="`${rangeDates.from} ~ ${rangeDates.to}`"
    />

    <div v-if="loading" class="space-y-4">
      <div class="glass-card h-24 animate-pulse rounded-2xl"></div>
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div v-for="i in 8" :key="i" class="glass-card h-24 animate-pulse rounded-2xl"></div>
      </div>
    </div>

    <template v-else>
      <!-- 查询失败态（与"暂无数据"空态区分，提供重试入口） -->
      <div v-if="loadError" class="glass-card rounded-2xl p-12 text-center">
        <p class="text-lg text-ink">{{ t('statistics.load_failed') }}</p>
        <p class="mt-1 text-sm text-ink-faint">{{ t('statistics.stat_load_failed_desc') }}</p>
        <button type="button" class="btn-soft mt-4 px-4 py-1.5 text-sm" @click="load({ skeleton: true })">
          {{ t('statistics.retry') }}
        </button>
      </div>

      <!-- ===== 空态（§7.7）===== -->
      <div v-else-if="!hasData" class="glass-card rounded-2xl p-12 text-center">
        <div class="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-gold/15">
          <svg class="h-8 w-8 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3v18h18" />
            <path d="M7 15l3-3 3 3 4-5" />
          </svg>
        </div>
        <p class="text-lg text-ink">{{ t('statistics.no_stats_data') }}</p>
        <p class="mt-1 text-sm text-ink-faint">{{ t('statistics.no_stats_data_desc') }}</p>
      </div>

      <template v-else>
        <!-- ===== 专属大标签横幅（§7.8.4）===== -->
        <div v-if="title" class="glass-card overflow-hidden rounded-2xl">
          <div class="relative flex items-center gap-4 bg-gradient-to-r from-gold/25 via-gold/10 to-transparent p-5">
            <div class="gold-bar min-w-0">
              <div class="text-xs uppercase tracking-widest text-gold">{{ t('statistics.unique_title') }}</div>
              <div class="mt-0.5 cursor-default text-2xl font-bold text-ink" v-tip="t(`statistics.title_desc_${title.id}`)">{{ tName(title.name) }}</div>
              <div class="mt-0.5 text-xs text-ink-faint">{{ t('statistics.unique_title_desc') }}</div>
            </div>
            <button
              v-if="titleScores.length > 0"
              type="button"
              class="btn-soft ml-auto shrink-0 px-3 py-1.5 text-xs"
              @click="showTitleScores = !showTitleScores"
            >
              {{ showTitleScores ? t('statistics.hide_scores') : t('statistics.score_details') }}
            </button>
          </div>
          <div v-if="showTitleScores && titleScores.length > 0" class="border-t border-accent/60 px-5 py-3">
            <div class="flex flex-wrap gap-3">
              <div
                v-for="(sc, idx) in titleScores"
                :key="sc.name"
                class="cursor-default rounded-full border px-3 py-1 text-xs tabular-nums"
                :class="idx === 0 ? 'border-gold bg-gold/15 text-gold' : 'border-accent bg-surface-field text-ink-soft'"
                v-tip="t(`statistics.title_desc_${titleIdByName[sc.name] ?? ''}`)"
              >
                {{ tName(sc.name) }}
                <span class="font-semibold">{{ sc.score.toFixed(1) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== 我的标签（§7.8，受区间跨度门槛控制：跨度 < 15 天时整块不显示）===== -->
        <div v-if="tagSpanOK" class="glass-card card-lift rounded-2xl p-4">
          <h2 class="gold-bar mb-3 text-sm font-semibold text-ink">{{ t('statistics.my_tags') }}</h2>
          <div v-if="tags.length === 0" class="rounded-xl border border-dashed border-accent px-4 py-3 text-sm text-ink-faint">
            {{ t('statistics.no_tags') }}
          </div>
          <div v-else class="space-y-3">
            <div v-for="group in tagsByCategory" :key="group.cat">
              <div class="mb-1.5 text-xs font-medium text-ink-soft">{{ tName(group.label) }}</div>
              <div class="flex flex-wrap gap-2">
                <span
                  v-for="tag in group.items"
                  :key="tag.id"
                  class="inline-flex cursor-default items-center rounded-full border border-gold/40 bg-gradient-to-r from-gold/20 to-gold/5 px-3 py-1 text-sm text-ink"
                  v-tip="t(`statistics.tag_desc_${tag.id}`)"
                >
                  {{ tName(tag.name) }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== 核心指标卡片网格（§7.3，入场级联动画）===== -->
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <div
            v-for="(card, idx) in metricCards"
            :key="card.name"
            class="glass-card card-lift group stat-pop rounded-2xl p-4"
            :style="{ animationDelay: `${Math.min(idx * 45, 450)}ms` }"
          >
            <div class="mb-2 flex items-center justify-between">
              <svg class="h-5 w-5 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                   stroke-linecap="round" stroke-linejoin="round">
                <path :d="iconPath(card.icon)" />
              </svg>
              <span class="text-xs text-ink-faint">{{ card.hint }}</span>
            </div>
            <div class="text-xl font-semibold text-ink tabular-nums">
              <AnimatedNumber v-if="typeof card.value === 'number'" :value="card.value" />
              <template v-else>{{ card.value }}</template>
            </div>
            <div class="mt-0.5 text-xs uppercase tracking-wide text-ink-faint">{{ card.name }}</div>
          </div>
        </div>

        <!-- ===== 年度活跃热力图（§7.9 深度优化）· 点击某天跳转该日 · 流式加载 ===== -->
        <LazySection :key="`heat-${lazyKey}`" skeleton-class="h-40">
          <ActivityHeatmap :cells="heatmap.cells" :months="heatmap.months" @select-day="heatmapPick" />
        </LazySection>

        <!-- ===== 数据故事（§7.9）· 流式加载：叙事句 + 个性化洞察 + 阶段增长徽章 ===== -->
        <LazySection :key="`story-${lazyKey}`" skeleton-class="h-40">
          <StoryCard :story-lines="storyLines" :insights="insights" :growth="growth" />
        </LazySection>

        <!-- ===== 趣味数据（§7.5）· 流式加载 ===== -->
        <LazySection :key="`fun-${lazyKey}`" skeleton-class="h-44">
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <!-- 打字量 -->
          <div class="glass-card card-lift rounded-2xl p-4">
            <div class="text-xs uppercase tracking-wide text-ink-faint">{{ t('statistics.typing_title') }}</div>
            <div class="mt-1 text-2xl font-semibold text-ink tabular-nums">{{ typingChars }}</div>
            <div class="mt-1 text-xs text-ink-faint">{{ t('statistics.typing_desc') }}</div>
          </div>

          <!-- 复制之王 -->
          <div class="glass-card card-lift rounded-2xl p-4">
            <div class="flex items-center justify-between">
              <span class="text-xs uppercase tracking-wide text-ink-faint">{{ t('statistics.copy_king') }}</span>
              <span v-if="kingClip" class="text-xs text-gold tabular-nums">{{ t('statistics.used_times', { n: kingClip.count }) }}</span>
            </div>
            <div class="mt-1 truncate text-lg font-medium text-ink" v-tip="kingClip?.content ?? ''">
              {{ kingPreview }}
            </div>
            <div class="mt-1 text-xs text-ink-faint">{{ t('statistics.copy_king_desc') }}</div>
          </div>

          <!-- 最长连续使用 -->
          <div class="glass-card card-lift rounded-2xl p-4">
            <div class="text-xs uppercase tracking-wide text-ink-faint">{{ t('statistics.longest_streak') }}</div>
            <div class="mt-1 text-2xl font-semibold text-ink tabular-nums">
              {{ longestStreakLabel }}
            </div>
            <div class="mt-1 text-xs text-ink-faint">{{ isDownsampled ? t('statistics.streak_desc_month') : t('statistics.streak_desc_record') }}</div>
          </div>

          <!-- 时长换算 -->
          <div class="glass-card card-lift rounded-2xl p-4">
            <div class="text-xs uppercase tracking-wide text-ink-faint">{{ t('statistics.duration_equiv') }}</div>
            <div class="mt-1 text-2xl font-semibold text-ink tabular-nums">
              {{ movieEquiv > 0 ? t('statistics.movie_eq', { n: movieEquiv }) : t('statistics.movie_less') }}
            </div>
            <div class="mt-1 text-xs text-ink-faint">{{ movieEquiv > 0 ? t('statistics.movie_desc', { n: movieEquiv }) : t('statistics.movie_desc_less') }}</div>
            </div>
          </div>
        </LazySection>

        <!-- ===== 活跃时段（§7.5）· 流式加载 ===== -->
        <LazySection :key="`period-${lazyKey}`" skeleton-class="h-44">
          <div class="glass-card card-lift rounded-2xl p-4">
            <h2 class="gold-bar mb-3 text-sm font-semibold text-ink">{{ t('statistics.period_title') }}</h2>
          <div class="space-y-2.5">
            <div v-for="p in periodDist" :key="p.name" class="flex cursor-default items-center gap-3" v-tip="p.tip">
              <span class="w-12 shrink-0 truncate text-sm text-ink">{{ p.name }}</span>
              <span class="w-14 shrink-0 truncate text-xs text-ink-faint tabular-nums">{{ p.time }}</span>
              <span class="w-16 shrink-0 text-xs text-ink-faint tabular-nums">{{ t('statistics.count_times', { n: p.value }) }}</span>
              <div class="h-3 flex-1 overflow-hidden rounded-full bg-secondary">
                <div
                  class="h-full rounded-full transition-all duration-500 ease-soft"
                  :class="p.isMax ? 'bg-gradient-to-r from-gold to-gold-soft' : 'bg-accent'"
                  :style="{ width: Math.max(p.pct, 1) + '%' }"
                ></div>
              </div>
              <span class="w-10 shrink-0 text-right text-xs tabular-nums" :class="p.isMax ? 'text-gold font-semibold' : 'text-ink-faint'">
                {{ p.pct.toFixed(0) }}%
              </span>
            </div>
          </div>
            <!-- 星期节奏：周一~周日日均操作量（§7.9 深度优化） -->
            <div class="mt-4 border-t border-accent/60 pt-3">
              <div class="mb-2 flex items-baseline justify-between gap-2">
                <h3 class="text-xs font-medium text-ink-soft">{{ t('statistics.week_title') }}</h3>
                <span class="text-[10px] text-ink-faint">{{ t('statistics.week_desc') }}</span>
              </div>
              <div class="space-y-1.5">
                <div v-for="(v, i) in weekdayDist" :key="i" class="flex cursor-default items-center gap-3"
                     v-tip="t('statistics.week_tip', { day: t(`statistics.weekday_${i + 1}`), n: fmtAvg(v) })">
                  <span class="w-9 shrink-0 text-sm text-ink">{{ t(`statistics.weekday_${i + 1}`) }}</span>
                  <div class="h-3 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      class="h-full rounded-full transition-all duration-500 ease-soft"
                      :class="v > 0 && v === weekdayMax ? 'bg-gradient-to-r from-gold to-gold-soft' : 'bg-accent'"
                      :style="{ width: (weekdayMax > 0 ? Math.max((v / weekdayMax) * 100, v > 0 ? 1 : 0) : 0) + '%' }"
                    ></div>
                  </div>
                  <span class="w-12 shrink-0 text-right text-xs tabular-nums" :class="v > 0 && v === weekdayMax ? 'text-gold font-semibold' : 'text-ink-faint'">
                    {{ fmtAvg(v) }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </LazySection>

        <!-- ===== Tab 访问分布（§7.4 + §7.9 甜甜圈）· 流式加载 ===== -->
        <LazySection :key="`tabs-${lazyKey}`" skeleton-class="h-44">
          <div class="glass-card card-lift rounded-2xl p-4">
            <h2 class="gold-bar mb-3 text-sm font-semibold text-ink">{{ t('statistics.tab_dist_title') }}</h2>
          <div v-if="tabDist.length === 0" class="text-sm text-ink-faint">{{ t('statistics.no_tab_dist') }}</div>
          <div v-else class="flex flex-col items-center gap-5 sm:flex-row">
            <!-- 甜甜圈：hover 分段 ↔ 列表行联动 -->
            <div class="relative h-36 w-36 shrink-0">
              <svg viewBox="0 0 120 120" class="h-full w-full -rotate-90">
                <circle cx="60" cy="60" r="52" fill="none" stroke="rgb(var(--c-secondary))" stroke-width="14" />
                <circle
                  v-for="seg in donut.segs"
                  :key="seg.id"
                  cx="60" cy="60" r="52"
                  fill="none"
                  :stroke="`rgb(var(--c-gold) / ${seg.op})`"
                  :stroke-width="hoveredTab === seg.id ? 18 : 14"
                  :stroke-dasharray="seg.dash"
                  :stroke-dashoffset="seg.dashOffset"
                  class="cursor-default transition-all duration-300 ease-soft"
                  :style="{ opacity: hoveredTab && hoveredTab !== seg.id ? 0.35 : 1 }"
                  v-tip="seg.tip"
                  @mouseenter="hoveredTab = seg.id"
                  @mouseleave="hoveredTab = null"
                />
              </svg>
              <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <div class="text-lg font-semibold text-ink tabular-nums">{{ donutCenter }}</div>
                <div class="max-w-20 truncate text-[10px] text-ink-faint">{{ donutCenterLabel }}</div>
              </div>
            </div>
            <!-- 分布列表（hover 与甜甜圈双向联动） -->
            <div class="min-w-0 flex-1 space-y-2">
              <div
                v-for="tab in tabDist"
                :key="tab.id"
                class="flex cursor-default items-center gap-3 rounded-lg px-1.5 py-0.5 transition-colors duration-300"
                :class="hoveredTab === tab.id ? 'bg-gold/10' : ''"
                v-tip="tab.tip"
                @mouseenter="hoveredTab = tab.id"
                @mouseleave="hoveredTab = null"
              >
                <span class="w-20 shrink-0 text-sm text-ink">{{ tab.name }}</span>
                <span class="w-12 shrink-0 text-right text-xs text-ink-faint tabular-nums">{{ fmtNum(tab.value) }}</span>
                <div class="h-3 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    class="h-full rounded-full bg-gradient-to-r from-gold to-gold-soft transition-all duration-500 ease-soft"
                    :style="{ width: Math.max(tab.pct, 1) + '%' }"
                  ></div>
                </div>
                <span class="w-10 shrink-0 text-right text-xs text-ink-faint tabular-nums">{{ tab.pct.toFixed(0) }}%</span>
              </div>
            </div>
          </div>
          </div>
        </LazySection>

        <!-- ===== 来源应用 Top（§7.9 深度优化：区间内复制来源分布）· 流式加载 ===== -->
        <LazySection :key="`src-${lazyKey}`" skeleton-class="h-40">
          <div class="glass-card card-lift rounded-2xl p-4">
            <div class="mb-3 flex items-baseline justify-between gap-2">
              <h2 class="gold-bar text-sm font-semibold text-ink">{{ t('statistics.src_title') }}</h2>
              <span class="text-xs text-ink-faint">{{ t('statistics.src_desc') }}</span>
            </div>
            <div v-if="srcApps.length === 0" class="text-sm text-ink-faint">{{ t('statistics.src_empty') }}</div>
            <div v-else class="space-y-2">
              <div v-for="(a, i) in srcApps" :key="a.app" class="flex cursor-default items-center gap-3" v-tip="srcTip(a)">
                <span class="w-5 shrink-0 text-xs tabular-nums" :class="i === 0 ? 'font-semibold text-gold' : 'text-ink-faint'">{{ i + 1 }}</span>
                <span class="w-32 shrink-0 truncate text-sm text-ink">{{ a.app }}</span>
                <div class="h-3 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    class="h-full rounded-full bg-gradient-to-r from-gold to-gold-soft transition-all duration-500 ease-soft"
                    :style="{ width: (srcMax > 0 ? Math.max((a.cnt / srcMax) * 100, 1) : 1) + '%' }"
                  ></div>
                </div>
                <span class="w-12 shrink-0 text-right text-xs tabular-nums" :class="i === 0 ? 'text-gold' : 'text-ink-faint'">
                  {{ fmtNum(a.cnt) }}
                </span>
              </div>
            </div>
          </div>
        </LazySection>

        <!-- ===== 每日趋势（§7.6）· 流式加载（「每日」范围仅 1 天，趋势无意义，隐藏）===== -->
        <LazySection v-if="range !== 'day'" :key="`trend-${lazyKey}`" skeleton-class="h-52">
          <div class="glass-card card-lift rounded-2xl p-4">
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <h2 class="gold-bar mr-2 text-sm font-semibold text-ink">{{ t('statistics.daily_trend') }}</h2>
            <button
              v-for="opt in trendOptions"
              :key="opt.key"
              type="button"
              class="rounded-full px-3 py-1 text-xs transition-colors duration-300 ease-soft"
              :class="trendFields.length === opt.fields.length && trendFields.every(f => opt.fields.includes(f)) ? 'bg-gold/15 text-gold' : 'text-ink-soft hover:text-ink'"
              v-tip="opt.desc"
              @click="switchTrend(opt)"
            >
              {{ opt.name }}
            </button>
            <!-- 视图切换：柱状 / 折线 -->
            <div class="ml-auto flex items-center rounded-full border border-accent p-0.5">
              <button
                v-for="m in (['bar', 'line'] as const)"
                :key="m"
                type="button"
                class="rounded-full px-2.5 py-0.5 text-xs transition-colors duration-300 ease-soft"
                :class="trendMode === m ? 'bg-gold/15 text-gold' : 'text-ink-soft hover:text-ink'"
                @click="trendMode = m"
              >
                {{ t(`statistics.trend_view_${m}`) }}
              </button>
            </div>
            <span v-if="isDownsampled" class="text-xs text-ink-faint">
              {{ t('statistics.downsample_hint', { days: TREND_DOWNSAMPLE_DAYS, months: series.length }) }}
            </span>
            <!-- 环比对照图例（幽灵线加载后出现） -->
            <span v-if="ghostSeries.length > 0" class="inline-flex items-center gap-1.5 text-xs text-ink-faint">
              <svg width="18" height="4" class="shrink-0"><line x1="0" y1="2" x2="18" y2="2" stroke="rgb(var(--c-ink) / 0.35)" stroke-width="1.5" stroke-dasharray="4 4" /></svg>
              {{ t('statistics.ghost_legend') }}
            </span>
          </div>
          <div v-if="series.length === 0" class="text-sm text-ink-faint">{{ t('statistics.no_trend_data') }}</div>
          <!-- 折线视图：SVG 面积图 + 峰值点 + 逐点 hover -->
          <div v-else-if="trendMode === 'line' && lineChart" class="overflow-x-auto pb-1">
            <svg
              :viewBox="`0 0 ${lineChart.W} ${lineChart.H}`"
              preserveAspectRatio="none"
              class="h-40 w-full"
              :style="{ minWidth: `${Math.max(lineChart.pts.length * 3, 100)}px` }"
            >
              <defs>
                <linearGradient id="trend-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="rgb(var(--c-gold))" stop-opacity="0.32" />
                  <stop offset="100%" stop-color="rgb(var(--c-gold))" stop-opacity="0" />
                </linearGradient>
              </defs>
              <path :d="lineChart.area" fill="url(#trend-area)" class="line-draw" />
              <!-- 幽灵线：上一等长区间对照（虚线，与主序列同尺度） -->
              <path
                v-if="ghostChart"
                :d="ghostChart.path"
                fill="none"
                stroke="rgb(var(--c-ink) / 0.35)"
                stroke-width="1.5"
                stroke-dasharray="4 4"
                vector-effect="non-scaling-stroke"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
              <path
                :d="lineChart.path"
                fill="none"
                stroke="rgb(var(--c-gold))"
                stroke-width="2"
                vector-effect="non-scaling-stroke"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
              <circle
                :cx="lineChart.peak.x" :cy="lineChart.peak.y" r="3.5"
                fill="rgb(var(--c-gold))" stroke="rgb(var(--c-surface))" stroke-width="1.5"
              />
              <!-- 逐点 hover 命中区（复用 v-tip） -->
              <rect
                v-for="(p, i) in lineChart.pts"
                :key="i"
                :x="p.x - lineChart.step / 2" y="0"
                :width="lineChart.step" :height="lineChart.H"
                fill="transparent"
                v-tip="barTip(i)"
              />
            </svg>
          </div>
          <!-- 柱状视图：入场级联升起动画 + 幽灵对照柱 -->
          <div v-else class="flex h-40 items-end gap-[2px] overflow-x-auto pb-1">
            <div
              v-for="(point, idx) in series"
              :key="idx"
              class="group/bar flex h-full min-w-[3px] flex-1 items-end"
              v-tip="barTip(idx)"
            >
              <div class="relative flex h-full w-full items-end">
                <!-- 幽灵柱：上一等长区间对照（淡色底柱，与主柱同尺度） -->
                <div
                  v-if="ghostBarAt(idx) > 0"
                  class="absolute inset-x-0 bottom-0 rounded-t-sm bg-gold/15 transition-all duration-500 ease-soft"
                  :style="{ height: chartMax > 0 ? Math.max((ghostBarAt(idx) / chartMax) * 100, 2) + '%' : '2%' }"
                ></div>
                <div
                  class="bar-rise relative w-full origin-bottom rounded-t-sm bg-gradient-to-t from-gold/40 to-gold transition-colors duration-300 ease-soft group-hover/bar:from-gold group-hover/bar:to-gold-soft"
                  :style="{
                    height: chartMax > 0 ? Math.max((point.value / chartMax) * 100, 2) + '%' : '2%',
                    animationDelay: `${Math.min(idx * 6, 360)}ms`,
                  }"
                ></div>
              </div>
            </div>
          </div>
          <div class="mt-2 flex justify-between text-[10px] text-ink-faint tabular-nums">
            <span>{{ series[0]?.stat_date ?? '' }}</span>
            <span>{{ t('statistics.peak', { n: fmtNum(trendMax) }) }}</span>
            <span>{{ series[series.length - 1]?.stat_date ?? '' }}</span>
          </div>
          </div>
        </LazySection>
      </template>
    </template>

  </div>
</template>

<style scoped>
/* 指标卡入场级联（配合内联 animation-delay） */
.stat-pop {
  animation: stat-pop 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes stat-pop {
  from { opacity: 0; transform: translateY(12px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
/* 趋势柱条自底部升起（配合内联 animation-delay，origin-bottom 由类提供） */
.bar-rise {
  animation: bar-rise 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes bar-rise {
  from { transform: scaleY(0); }
  to { transform: scaleY(1); }
}
/* 折线面积淡入 */
.line-draw {
  animation: line-fade 0.7s ease-soft both;
}
@keyframes line-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
