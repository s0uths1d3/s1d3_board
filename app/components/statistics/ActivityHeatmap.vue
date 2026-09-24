<script setup lang="ts">
/**
 * 活跃热力图（ActivityHeatmap）
 *
 * GitHub 风格贡献格：区间每日总操作量按五档金色深度着色（列数随跨度自适应，
 * 仅当所选区间跨度大于一年时由页面层展示）；数据由页面层用
 * chartMath.buildHeatmapCells 预计算（纯函数，本组件不查询）。
 * - hover 任意格显示「日期 · 次数」（v-tip）；
 * - 点击某格 emit('select-day', date)，页面层把范围切换为该日的自定义区间；
 * - level→颜色类必须用完整字面量数组（Tailwind v4 源码扫描，拼接类名会静默丢样式）。
 */
import { computed } from 'vue';
import { useI18n } from '~/composables/useI18n';
import { toDateString } from '~/utils/datetime';
import type { HeatmapCell, HeatmapMonth } from '~/src/statistics/chartMath';

const props = defineProps<{
  /** 热力图单元格（含 level 档位与周列坐标） */
  cells: HeatmapCell[];
  /** 月份标注（月初所在周列 + 文案） */
  months: HeatmapMonth[];
  /** 里程碑日（区间峰值日）：金色描边 + 悬浮标注，讲述"最忙碌的一天" */
  highlightDate?: string;
}>();

const emit = defineEmits<{
  (e: 'select-day', date: string): void;
}>();

const { t } = useI18n();

/** 五档颜色（完整字面量，Tailwind v4 扫描依赖源码中出现完整类名）：
 *  空档用 accent（三主题均比卡片底深/浅一档，保证空格可见），
 *  活跃档从 gold/25 起步——多数活跃天落在 level 1，/15 在米色底上几乎不可辨 */
const LEVEL_CLASS = ['bg-accent', 'bg-gold/25', 'bg-gold/45', 'bg-gold/70', 'bg-gold'] as const;

/** 今天的日期串：末列 endDate 之后的占位格（未来日期）不响应 hover/点击 */
const todayStr = toDateString(new Date());

function isFuture(cell: HeatmapCell | null): boolean {
  return !!cell && cell.date > todayStr;
}

/** 按周列分组（每列 7 格，dayIdx 升序；占位格补 null 保持列高一致） */
const weeks = computed<(HeatmapCell | null)[][]>(() => {
  if (props.cells.length === 0) return [];
  const maxWeek = props.cells[props.cells.length - 1]!.weekIdx;
  const grid: (HeatmapCell | null)[][] = Array.from({ length: maxWeek + 1 }, () => Array.from({ length: 7 }, () => null));
  for (const c of props.cells) grid[c.weekIdx]![c.dayIdx] = c;
  return grid;
});

/** 周列 → 月份标注（同列取第一条） */
const monthByWeek = computed<Map<number, string>>(() => {
  const m = new Map<number, string>();
  for (const mo of props.months) if (!m.has(mo.idx)) m.set(mo.idx, mo.label);
  return m;
});

function cellTip(cell: HeatmapCell | null): string {
  if (!cell) return '';
  return cell.date === props.highlightDate ? `${cell.date} · ${cell.value} · ${t('statistics.heat_peak_tip')}` : `${cell.date} · ${cell.value}`;
}
</script>

<template>
  <div class="glass-card card-lift rounded-2xl p-4">
    <div class="mb-3 flex items-baseline justify-between gap-2">
      <h2 class="gold-bar text-sm font-semibold text-ink">{{ t('statistics.heatmap_title') }}</h2>
      <span class="text-xs text-ink-faint">{{ t('statistics.heatmap_desc') }}</span>
    </div>

    <div v-if="weeks.length === 0" class="text-sm text-ink-faint">{{ t('statistics.no_stats_data') }}</div>
    <!-- 区间跨度可大于一年（列数 >53）：内容超宽时整体横向滚动 -->
    <div v-else class="min-w-0 overflow-x-auto">
      <!-- 月份标注行：列宽固定 11px 与主体严格一致（固定宽同时关闭 flex 拉伸——
           列数少时 flex-1 会把唯一一列拉满整行，aspect-square 放大成全屏巨块），
           标签不截断、溢出绘制到后续列（GitHub 式——月份间隔 ≥4 列不会碰撞） -->
      <div class="mb-1 flex gap-[2px] pl-6">
        <div v-for="(week, wi) in weeks" :key="`m-${wi}`" class="w-[11px] shrink-0 whitespace-nowrap text-[10px] leading-3 text-ink-faint">
          {{ monthByWeek.get(wi) ?? '' }}
        </div>
      </div>
      <!-- 主体：列宽固定 11px（≤1 年约 53 列在宽屏铺开，跨年横向滚动，列数少时靠左排列），每列 7 格；末列未来占位格灰显且不可交互 -->
      <div class="flex gap-[2px] pl-6">
        <div v-for="(week, wi) in weeks" :key="wi" class="flex w-[11px] shrink-0 flex-col gap-[2px]">
          <div
            v-for="(cell, di) in week"
            :key="di"
            class="aspect-square rounded-[3px] transition-all duration-200 ease-soft"
            :class="[
              cell && !isFuture(cell) ? LEVEL_CLASS[cell.level] : 'bg-transparent',
              cell && !isFuture(cell) ? 'cursor-pointer hover:scale-110' : '',
              // 里程碑日（区间峰值）：金色描边 + 外扩，与普通格区分
              cell && cell.date === props.highlightDate ? 'ring-2 ring-gold ring-offset-1' : '',
            ]"
            v-tip="cell && !isFuture(cell) ? cellTip(cell) : ''"
            @click="cell && !isFuture(cell) && emit('select-day', cell.date)"
          ></div>
        </div>
      </div>
      <!-- 图例：少 → 多 -->
      <div class="mt-2 flex items-center justify-end gap-1 text-[10px] text-ink-faint">
        <span>{{ t('statistics.heatmap_legend_less') }}</span>
        <span
          v-for="lv in 5"
          :key="lv"
          class="h-2.5 w-2.5 rounded-[3px]"
          :class="LEVEL_CLASS[lv - 1]"
        ></span>
        <span>{{ t('statistics.heatmap_legend_more') }}</span>
      </div>
    </div>
  </div>
</template>
