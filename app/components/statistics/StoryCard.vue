<script setup lang="ts">
/**
 * 数据故事卡（StoryCard）
 *
 * 把当前区间的统计聚合转成叙事句 + 个性化洞察：
 * - 故事行：页面层用 t() 拼好、以 [[...]] 标记金色高亮数字，本组件拆分渲染；
 * - 洞察 chips：命中规则取前 2 条每日轮换，首条加"今日洞察"高亮徽标；
 * - 阶段增长徽章：环比上一等长区间的操作总量变化（正增长金色脉冲）。
 * 纯展示组件，不做查询。
 */
import { computed } from 'vue';
import { useI18n } from '~/composables/useI18n';

const { t } = useI18n();

const props = defineProps<{
  /** 叙事行（[[...]] 包裹的部分渲染为金色高亮） */
  storyLines: string[];
  /** 命中的洞察 id 列表（已按每日轮换排序，首条为今日洞察） */
  insights: string[];
  /** 环比上一等长区间：pct 为变化百分比（null = 上一阶段无数据），diff 为绝对增量 */
  growth: { pct: number | null; diff: number };
  /** 相伴天数（最早统计日 → 今天；0 = 无数据不显示开篇行） */
  days?: number;
}>();

/** 把 [[...]] 标记拆为 { text, gold } 片段 */
function splitSegs(line: string): { text: string; gold: boolean }[] {
  const segs: { text: string; gold: boolean }[] = [];
  const re = /\[\[(.+?)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index), gold: false });
    segs.push({ text: m[1] ?? '', gold: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) segs.push({ text: line.slice(last), gold: false });
  return segs.length > 0 ? segs : [{ text: line, gold: false }];
}

const lines = computed(() => props.storyLines.map(splitSegs));

/** 相伴开篇（同一 [[...]] 金色分段语法，字号更大） */
const openSegs = computed(() => (props.days && props.days > 0 ? splitSegs(t('statistics.story_open', { n: String(props.days) })) : []));

/** 增长徽章文案与样式 */
const growthView = computed(() => {
  const { pct, diff } = props.growth;
  if (pct === null) return null; // 上一阶段无数据，不展示
  if (diff <= 0 && pct <= 0) {
    return { text: t('statistics.story_growth_flat'), cls: 'border-accent bg-secondary text-ink-faint', pulse: false };
  }
  const sign = pct > 0 ? '+' : '';
  return {
    text: t('statistics.story_growth_up', { pct: `${sign}${pct.toFixed(0)}%` }),
    cls: 'border-gold/50 bg-gradient-to-r from-gold/25 to-gold/10 text-gold',
    pulse: pct > 0,
  };
});
</script>

<template>
  <div class="glass-card card-lift rounded-2xl p-4">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h2 class="gold-bar text-sm font-semibold text-ink">{{ t('statistics.story_title') }}</h2>
      <span
        v-if="growthView"
        class="rounded-full border px-2.5 py-0.5 text-xs tabular-nums"
        :class="growthView.cls"
      >
        <span v-if="growthView.pulse" class="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-gold align-middle pulse-dot"></span>
        {{ growthView.text }}
      </span>
    </div>

    <!-- 相伴开篇：把冷数据变成陪伴叙事（天数来自全历史最早统计日 → 今天） -->
    <p v-if="openSegs.length > 0" class="mb-2.5 border-l-2 border-gold/60 pl-3 text-base font-semibold leading-relaxed text-ink">
      <template v-for="(seg, j) in openSegs" :key="j">
        <b v-if="seg.gold" class="font-semibold text-gold tabular-nums">{{ seg.text }}</b>
        <template v-else>{{ seg.text }}</template>
      </template>
    </p>

    <!-- 叙事行 -->
    <div class="space-y-1.5">
      <p v-for="(segs, i) in lines" :key="i" class="text-sm leading-relaxed text-ink-soft">
        <template v-for="(seg, j) in segs" :key="j">
          <b v-if="seg.gold" class="font-semibold text-gold tabular-nums">{{ seg.text }}</b>
          <template v-else>{{ seg.text }}</template>
        </template>
      </p>
    </div>

    <!-- 个性化洞察 -->
    <div v-if="insights.length > 0" class="mt-3 space-y-2">
      <div
        v-for="(id, i) in insights"
        :key="id"
        class="flex items-start gap-2 rounded-xl px-3 py-2 text-sm transition-colors duration-300"
        :class="i === 0 ? 'bg-gold/10 text-ink' : 'bg-secondary/60 text-ink-soft'"
      >
        <svg class="mt-0.5 h-4 w-4 shrink-0 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
        </svg>
        <span class="min-w-0 flex-1">{{ t(`statistics.${id}`) }}</span>
        <span v-if="i === 0" class="shrink-0 rounded-full bg-gold/15 px-2 py-0.5 text-[10px] text-gold">
          {{ t('statistics.insight_today') }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 正增长徽章的呼吸脉冲点 */
.pulse-dot {
  animation: story-pulse 1.6s ease-in-out infinite;
}
@keyframes story-pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1.15); }
}
</style>
