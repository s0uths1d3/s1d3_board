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
  CATEGORY_LABEL, type UserTag, type UserTagCategory,
} from '~/src/statistics/userTags';
import { toDateString } from '~/utils/datetime';
import DatePicker from '~/components/common/DatePicker.vue';
import LazySection from '~/components/statistics/LazySection.vue';

const { t, tName } = useI18n();

type RangeKey = 'day' | 'week' | 'month' | 'year' | 'custom';

const rangeOptions = computed<{ key: RangeKey; name: string }[]>(() => [
  { key: 'day', name: t('statistics.day') },
  { key: 'week', name: t('statistics.week') },
  { key: 'month', name: t('statistics.month') },
  { key: 'year', name: t('statistics.year') },
  { key: 'custom', name: t('statistics.custom') },
]);

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

/** 左箭头禁用：自定义范围无"阶段"概念 */
const leftDisabled = computed(() => range.value === 'custom');
/** 右箭头禁用：自定义范围，或已处于当前（最新）阶段不可再往后 */
const rightDisabled = computed(() => range.value === 'custom' || rangeOffset.value >= 0);

function selectRange(key: RangeKey) {
  if (range.value !== key) {
    range.value = key;
    rangeOffset.value = 0;
  }
}

/** 阶段切换：delta=-1 上一阶段，delta=1 下一阶段；不允许进入未来阶段 */
function shiftRange(delta: number) {
  if (range.value === 'custom') return;
  const next = rangeOffset.value + delta;
  if (next > 0) return;
  rangeOffset.value = next;
}

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

const trendOptions = computed<{ key: string; name: string; fields: StatField[] }[]>(() => [
  { key: 'activity', name: t('statistics.trendActivity'), fields: ['clip_text', 'clip_image', 'clip_use'] },
  { key: 'clip_use', name: t('statistics.trendPaste'), fields: ['clip_use'] },
  { key: 'usage', name: t('statistics.trendDuration'), fields: ['usage_seconds'] },
  { key: 'shortcut', name: t('statistics.trendShortcut'), fields: ['shortcut_count'] },
  { key: 'todo', name: t('todo.title'), fields: ['todo_added', 'todo_completed', 'todo_reminded'] },
  { key: 'todo_chars', name: t('statistics.trendTodoChars'), fields: ['todo_chars'] },
  { key: 'note', name: t('note.title'), fields: ['note_added'] },
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
  try {
    const [sum, s, tg, tl, scores] = await Promise.all([
      statsService.getStatsRange(from, to),
      statsService.getDailySeries(from, to, trendFields.value),
      computeTags(from, to),
      computeUniqueTitle(from, to),
      computeTitleScores(from, to),
    ]);
    stats.value = sum;
    series.value = s;
    tags.value = tg;
    title.value = tl;
    titleScores.value = scores;
    // 复制之王（趣味数据，§7.5）：直接查 clipboard 表
    try {
      kingClip.value = await statsService.getTopClipboard();
    } catch {
      kingClip.value = null;
    }
  } catch (e) {
    // 查询失败显式标记：不与"暂无统计数据"空态混淆
    loadError.value = true;
    console.error('统计页加载失败:', e);
  } finally {
    loading.value = false;
  }
}

/** 切换趋势字段后仅重拉趋势序列 */
async function switchTrend(opt: { key: string; name: string; fields: StatField[] }) {
  trendFields.value = opt.fields;
  const { from, to } = rangeDates.value;
  series.value = await statsService.getDailySeries(from, to, opt.fields);
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
  await load({ skeleton: true });
});

// ===== 派生指标 =====

const hasData = computed(() => {
  const s = stats.value;
  return Object.values(s).some(v => (v ?? 0) > 0);
});

/** 使用时长格式化：xx 小时 xx 分 / xx 分钟 / xx 秒（§7.3） */
function formatDuration(seconds: number): string {
  const sec = Math.round(seconds || 0);
  if (sec < 60) return t('statistics.durSec', { n: sec });
  const minutes = Math.floor(sec / 60);
  if (minutes < 60) return t('statistics.durMin', { n: minutes });
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  return restMin > 0 ? t('statistics.durHourMin', { n: hours, m: restMin }) : t('statistics.durHour', { n: hours });
}

const metricCards = computed(() => {
  const s = stats.value;
  return [
    { name: t('statistics.metricClipTotal'), value: (s.clip_text ?? 0) + (s.clip_image ?? 0), hint: t('statistics.metricClipTotalHint'), icon: 'clip' },
    { name: t('statistics.metricImage'), value: s.clip_image ?? 0, hint: t('statistics.metricImageHint'), icon: 'image' },
    { name: t('statistics.metricPaste'), value: s.clip_use ?? 0, hint: t('statistics.metricPasteHint'), icon: 'paste' },
    { name: t('statistics.metricTodoOps'), value: (s.todo_added ?? 0) + (s.todo_completed ?? 0), hint: t('statistics.metricTodoOpsHint'), icon: 'todo' },
    { name: t('statistics.metricTodoChars'), value: fmtNum(s.todo_chars ?? 0), hint: t('statistics.metricTodoCharsHint'), icon: 'todo_text' },
    { name: t('statistics.metricNote'), value: s.note_added ?? 0, hint: t('statistics.metricNoteHint'), icon: 'note' },
    { name: t('statistics.metricFavorite'), value: s.favorite_toggle ?? 0, hint: t('statistics.metricFavoriteHint'), icon: 'star' },
    { name: t('statistics.metricUsage'), value: formatDuration(s.usage_seconds ?? 0), hint: t('statistics.metricUsageHint'), icon: 'clock' },
    { name: t('statistics.metricShortcut'), value: s.shortcut_count ?? 0, hint: t('statistics.metricShortcutHint'), icon: 'keyboard' },
  ];
});

/** Tab 访问分布（§7.4） */
const tabDist = computed(() => {
  const s = stats.value;
  const items = [
    { key: t('titlebar.clip'), value: s.tab_clip ?? 0 },
    { key: t('titlebar.todo'), value: s.tab_todo ?? 0 },
    { key: t('titlebar.note'), value: s.tab_note ?? 0 },
    { key: t('titlebar.pinned'), value: s.tab_pinned ?? 0 },
    { key: t('titlebar.setting'), value: s.tab_setting ?? 0 },
    { key: t('titlebar.statistics'), value: s.tab_statistics ?? 0 },
  ].filter(i => i.value > 0);
  const total = items.reduce((sum, i) => sum + i.value, 0);
  return items.map(i => ({ ...i, pct: total > 0 ? (i.value / total) * 100 : 0 }));
});

// ===== 趣味数据（§7.5）=====

/** 打字量（复制字符总量）→ "约 X 万字" */
const typingChars = computed(() => {
  const chars = stats.value.clip_chars ?? 0;
  return chars > 0 ? t('statistics.typingWan', { n: (chars / 10000).toFixed(1) }) : t('statistics.typingZero');
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
  isDownsampled.value ? t('statistics.streakMonths', { n: longestStreak.value }) : t('statistics.streakDays', { n: longestStreak.value })
);

/** 活跃时段分布（4 段条形，最高高亮，§7.5） */
const periodDist = computed(() => {
  const s = stats.value;
  const items = [
    { name: t('statistics.periodDawn'), time: t('statistics.periodDawnHours'), value: s.active_dawn ?? 0 },
    { name: t('statistics.periodDay'), time: t('statistics.periodDayHours'), value: s.active_day ?? 0 },
    { name: t('statistics.periodEvening'), time: t('statistics.periodEveningHours'), value: s.active_evening ?? 0 },
    { name: t('statistics.periodNight'), time: t('statistics.periodNightHours'), value: s.active_night ?? 0 },
  ];
  const total = items.reduce((sum, i) => sum + i.value, 0);
  const max = Math.max(...items.map(i => i.value), 0);
  return items.map(i => ({
    ...i,
    pct: total > 0 ? (i.value / total) * 100 : 0,
    isMax: i.value === max && max > 0,
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
  return clean.length > 20 ? `${clean.slice(0, 20)}…` : (clean || t('statistics.noCopyRecord'));
});

/** 图标渲染 */
const icons: Record<string, string> = {
  clip: 'M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2M4 8h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z',
  image: 'M4 16l4.586-4.586a2 2 0 0 1 2.828 0L16 16m-2-2 1.586-1.586a2 2 0 0 1 2.828 0L20 14m-6-6h.01M6 20h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z',
  paste: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2',
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

/** 趋势图最大值（归一化柱高） */
const trendMax = computed(() => Math.max(...series.value.map(r => r.value), 0));

</script>

<template>
  <div class="space-y-4 pb-8">
    <!-- ===== 范围切换栏（§7.2）===== -->
    <div class="glass-card card-lift rounded-2xl p-4">
      <!-- 默认窗口尺寸下始终单行：禁用换行，靠紧凑间距 + 日期控件定宽保证 -->
      <div class="flex flex-nowrap items-center gap-2">
        <button
          v-for="opt in rangeOptions"
          :key="opt.key"
          type="button"
          class="btn-soft shrink-0 whitespace-nowrap px-2.5 py-1.5 text-sm"
          :class="range === opt.key ? 'border-gold bg-secondary text-gold' : ''"
          @click="selectRange(opt.key)"
        >
          {{ opt.name }}
        </button>
        <div class="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-ink-faint">
          <span v-if="range === 'custom'" class="flex min-w-0 items-center gap-1">
            <span class="w-36 min-w-0">
              <DatePicker v-model="customFrom" :placeholder="t('statistics.fromDate')" :max="customTo || undefined" />
            </span>
            <span class="text-ink-faint">—</span>
            <span class="w-36 min-w-0">
              <DatePicker v-model="customTo" :placeholder="t('statistics.toDate')" :min="customFrom || undefined" />
            </span>
          </span>
          <!-- 阶段切换箭头：左右选择上一阶段/下一阶段，无可用方向时置灰禁用 -->
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-300 ease-soft"
              :class="leftDisabled ? 'cursor-not-allowed text-ink-faint/40' : 'text-gold hover:bg-secondary'"
              :disabled="leftDisabled"
              v-tip="t('statistics.prevPhase')"
              @click="shiftRange(-1)"
            >
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <span class="min-w-[8.5rem] max-w-full truncate whitespace-nowrap text-center tabular-nums">{{ rangeDates.from }} ~ {{ rangeDates.to }}</span>
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-300 ease-soft"
              :class="rightDisabled ? 'cursor-not-allowed text-ink-faint/40' : 'text-gold hover:bg-secondary'"
              :disabled="rightDisabled"
              v-tip="t('statistics.nextPhase')"
              @click="shiftRange(1)"
            >
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="loading" class="space-y-4">
      <div class="glass-card h-24 animate-pulse rounded-2xl"></div>
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div v-for="i in 8" :key="i" class="glass-card h-24 animate-pulse rounded-2xl"></div>
      </div>
    </div>

    <template v-else>
      <!-- 查询失败态（与"暂无数据"空态区分，提供重试入口） -->
      <div v-if="loadError" class="glass-card rounded-2xl p-12 text-center">
        <p class="text-lg text-ink">{{ t('statistics.loadFailed') }}</p>
        <p class="mt-1 text-sm text-ink-faint">{{ t('statistics.statLoadFailedDesc') }}</p>
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
        <p class="text-lg text-ink">{{ t('statistics.noStatsData') }}</p>
        <p class="mt-1 text-sm text-ink-faint">{{ t('statistics.noStatsDataDesc') }}</p>
      </div>

      <template v-else>
        <!-- ===== 专属大标签横幅（§7.8.4）===== -->
        <div v-if="title" class="glass-card overflow-hidden rounded-2xl">
          <div class="relative flex items-center gap-4 bg-gradient-to-r from-gold/25 via-gold/10 to-transparent p-5">
            <div class="gold-bar min-w-0">
              <div class="text-xs uppercase tracking-widest text-gold">{{ t('statistics.uniqueTitle') }} · Unique Title</div>
              <div class="mt-0.5 text-2xl font-bold text-ink">{{ tName(title.name) }}</div>
              <div class="mt-0.5 text-xs text-ink-faint">{{ t('statistics.uniqueTitleDesc') }}</div>
            </div>
            <button
              v-if="titleScores.length > 0"
              type="button"
              class="btn-soft ml-auto shrink-0 px-3 py-1.5 text-xs"
              @click="showTitleScores = !showTitleScores"
            >
              {{ showTitleScores ? t('statistics.hideScores') : t('statistics.scoreDetails') }}
            </button>
          </div>
          <div v-if="showTitleScores && titleScores.length > 0" class="border-t border-accent/60 px-5 py-3">
            <div class="flex flex-wrap gap-3">
              <div
                v-for="(sc, idx) in titleScores"
                :key="sc.name"
                class="rounded-full border px-3 py-1 text-xs tabular-nums"
                :class="idx === 0 ? 'border-gold bg-gold/15 text-gold' : 'border-accent bg-surface-field text-ink-soft'"
              >
                {{ tName(sc.name) }}
                <span class="font-semibold">{{ sc.score.toFixed(1) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== 我的标签（§7.8，受区间跨度门槛控制：跨度 < 15 天时整块不显示）===== -->
        <div v-if="tagSpanOK" class="glass-card card-lift rounded-2xl p-4">
          <h2 class="gold-bar mb-3 text-sm font-semibold text-ink">{{ t('statistics.myTags') }}</h2>
          <div v-if="tags.length === 0" class="rounded-xl border border-dashed border-accent px-4 py-3 text-sm text-ink-faint">
            {{ t('statistics.noTags') }}
          </div>
          <div v-else class="space-y-3">
            <div v-for="group in tagsByCategory" :key="group.cat">
              <div class="mb-1.5 text-xs font-medium text-ink-soft">{{ tName(group.label) }}</div>
              <div class="flex flex-wrap gap-2">
                <span
                  v-for="t in group.items"
                  :key="t.id"
                  class="inline-flex items-center rounded-full border border-gold/40 bg-gradient-to-r from-gold/20 to-gold/5 px-3 py-1 text-sm text-ink"
                >
                  {{ tName(t.name) }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- ===== 核心指标卡片网格（§7.3）===== -->
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <div
            v-for="card in metricCards"
            :key="card.name"
            class="glass-card card-lift group rounded-2xl p-4"
          >
            <div class="mb-2 flex items-center justify-between">
              <svg class="h-5 w-5 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                   stroke-linecap="round" stroke-linejoin="round">
                <path :d="iconPath(card.icon)" />
              </svg>
              <span class="text-xs text-ink-faint">{{ card.hint }}</span>
            </div>
            <div class="text-xl font-semibold text-ink tabular-nums">{{ card.value }}</div>
            <div class="mt-0.5 text-xs uppercase tracking-wide text-ink-faint">{{ card.name }}</div>
          </div>
        </div>

        <!-- ===== 趣味数据（§7.5）· 流式加载 ===== -->
        <LazySection :key="`fun-${lazyKey}`" skeleton-class="h-44">
          <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <!-- 打字量 -->
          <div class="glass-card card-lift rounded-2xl p-4">
            <div class="text-xs uppercase tracking-wide text-ink-faint">{{ t('statistics.typingTitle') }}</div>
            <div class="mt-1 text-2xl font-semibold text-ink tabular-nums">{{ typingChars }}</div>
            <div class="mt-1 text-xs text-ink-faint">{{ t('statistics.typingDesc') }}</div>
          </div>

          <!-- 复制之王 -->
          <div class="glass-card card-lift rounded-2xl p-4">
            <div class="flex items-center justify-between">
              <span class="text-xs uppercase tracking-wide text-ink-faint">{{ t('statistics.copyKing') }}</span>
              <span v-if="kingClip" class="text-xs text-gold tabular-nums">{{ t('statistics.usedTimes', { n: kingClip.count }) }}</span>
            </div>
            <div class="mt-1 truncate text-lg font-medium text-ink" v-tip="kingClip?.content ?? ''">
              {{ kingPreview }}
            </div>
            <div class="mt-1 text-xs text-ink-faint">{{ t('statistics.copyKingDesc') }}</div>
          </div>

          <!-- 最长连续使用 -->
          <div class="glass-card card-lift rounded-2xl p-4">
            <div class="text-xs uppercase tracking-wide text-ink-faint">{{ t('statistics.longestStreak') }}</div>
            <div class="mt-1 text-2xl font-semibold text-ink tabular-nums">
              {{ longestStreakLabel }}
            </div>
            <div class="mt-1 text-xs text-ink-faint">{{ isDownsampled ? t('statistics.streakDescMonth') : t('statistics.streakDescRecord') }}</div>
          </div>

          <!-- 时长换算 -->
          <div class="glass-card card-lift rounded-2xl p-4">
            <div class="text-xs uppercase tracking-wide text-ink-faint">{{ t('statistics.durationEquiv') }}</div>
            <div class="mt-1 text-2xl font-semibold text-ink tabular-nums">
              {{ movieEquiv > 0 ? t('statistics.movieEq', { n: movieEquiv }) : t('statistics.movieLess') }}
            </div>
            <div class="mt-1 text-xs text-ink-faint">{{ movieEquiv > 0 ? t('statistics.movieDesc', { n: movieEquiv }) : t('statistics.movieDescLess') }}</div>
            </div>
          </div>
        </LazySection>

        <!-- ===== 活跃时段（§7.5）· 流式加载 ===== -->
        <LazySection :key="`period-${lazyKey}`" skeleton-class="h-44">
          <div class="glass-card card-lift rounded-2xl p-4">
            <h2 class="gold-bar mb-3 text-sm font-semibold text-ink">{{ t('statistics.periodTitle') }}</h2>
          <div class="space-y-2.5">
            <div v-for="p in periodDist" :key="p.name" class="flex items-center gap-3">
              <span class="w-12 shrink-0 truncate text-sm text-ink">{{ p.name }}</span>
              <span class="w-14 shrink-0 truncate text-xs text-ink-faint tabular-nums">{{ p.time }}</span>
              <span class="w-16 shrink-0 text-xs text-ink-faint tabular-nums">{{ t('statistics.countTimes', { n: p.value }) }}</span>
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
          </div>
        </LazySection>

        <!-- ===== Tab 访问分布（§7.4）· 流式加载 ===== -->
        <LazySection :key="`tabs-${lazyKey}`" skeleton-class="h-44">
          <div class="glass-card card-lift rounded-2xl p-4">
            <h2 class="gold-bar mb-3 text-sm font-semibold text-ink">{{ t('statistics.tabDistTitle') }}</h2>
          <div v-if="tabDist.length === 0" class="text-sm text-ink-faint">{{ t('statistics.noTabDist') }}</div>
          <div v-else class="space-y-2">
            <div v-for="tab in tabDist" :key="tab.key" class="flex items-center gap-3">
              <span class="w-20 shrink-0 text-sm text-ink">{{ tab.key }}</span>
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
        </LazySection>

        <!-- ===== 每日趋势（§7.6）· 流式加载（「每日」范围仅 1 天，趋势无意义，隐藏）===== -->
        <LazySection v-if="range !== 'day'" :key="`trend-${lazyKey}`" skeleton-class="h-52">
          <div class="glass-card card-lift rounded-2xl p-4">
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <h2 class="gold-bar mr-2 text-sm font-semibold text-ink">{{ t('statistics.dailyTrend') }}</h2>
            <button
              v-for="opt in trendOptions"
              :key="opt.key"
              type="button"
              class="rounded-full px-3 py-1 text-xs transition-colors duration-300 ease-soft"
              :class="trendFields.length === opt.fields.length && trendFields.every(f => opt.fields.includes(f)) ? 'bg-gold/15 text-gold' : 'text-ink-soft hover:text-ink'"
              @click="switchTrend(opt)"
            >
              {{ opt.name }}
            </button>
            <span v-if="isDownsampled" class="ml-auto text-xs text-ink-faint">
              区间超 {{ TREND_DOWNSAMPLE_DAYS }} 天，已按月聚合（{{ series.length }} 个月）
            </span>
          </div>
          <div v-if="series.length === 0" class="text-sm text-ink-faint">{{ t('statistics.noTrendData') }}</div>
          <div v-else class="flex h-40 items-end gap-[2px] overflow-x-auto pb-1">
            <div
              v-for="(point, idx) in series"
              :key="idx"
              class="group/bar flex h-full min-w-[3px] flex-1 items-end"
              v-tip="`${point.stat_date} · ${fmtNum(point.value)}`"
            >
              <div
                class="w-full rounded-t-sm bg-gradient-to-t from-gold/40 to-gold transition-colors duration-300 ease-soft group-hover/bar:from-gold group-hover/bar:to-gold-soft"
                :style="{ height: trendMax > 0 ? Math.max((point.value / trendMax) * 100, 2) + '%' : '2%' }"
              ></div>
            </div>
          </div>
          <div class="mt-2 flex justify-between text-[10px] text-ink-faint tabular-nums">
            <span>{{ series[0]?.stat_date ?? '' }}</span>
            <span>峰值 {{ fmtNum(trendMax) }}</span>
            <span>{{ series[series.length - 1]?.stat_date ?? '' }}</span>
          </div>
          </div>
        </LazySection>
      </template>
    </template>

  </div>
</template>
