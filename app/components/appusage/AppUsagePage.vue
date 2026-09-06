<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from '~/composables/useI18n';
import statsService from '~/src/statistics/statsService';
import { toDateString } from '~/utils/datetime';
import UiSegmented from '~/components/ui/UiSegmented.vue';
import { appUsageEnabled, setAppUsageEnabled } from '~/composables/useAppUsage';

/**
 * 应用时长页（独立导航 Tab）
 *
 * 展示按应用聚合的前台使用时长：总量 / 活跃 / 挂机三张汇总卡 + 按总时长降序的
 * 条形列表（活跃/挂机两段叠加）。数据来自 app_usage 表（Rust 前台监听 → 30s 拉取），
 * 开关默认关闭，本页提供引导开启入口；30s 自动刷新跟随拉取节奏。
 */

const { t } = useI18n();

type RangeKey = 'today' | 'week' | 'month';
const range = ref<RangeKey>('today');

const rangeOptions = computed(() => [
  { value: 'today' as const, label: t('appUsage.today') },
  { value: 'week' as const, label: t('appUsage.week') },
  { value: 'month' as const, label: t('appUsage.month') },
]);

/** 范围起止（本地时区 YYYY-MM-DD；周以周一为始） */
const rangeDates = computed(() => {
  const now = new Date();
  const to = toDateString(now);
  if (range.value === 'today') return { from: to, to };
  if (range.value === 'week') {
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return { from: toDateString(monday), to };
  }
  return { from: toDateString(new Date(now.getFullYear(), now.getMonth(), 1)), to };
});

interface UsageRow {
  app: string;
  total: number;
  active: number;
}

const rows = ref<UsageRow[]>([]);
const loading = ref(true);

const totals = computed(() => ({
  total: rows.value.reduce((s, r) => s + r.total, 0),
  active: rows.value.reduce((s, r) => s + r.active, 0),
}));
const idleSecs = computed(() => Math.max(0, totals.value.total - totals.value.active));

/** 条形宽度基准：最大总时长 */
const maxTotal = computed(() => rows.value[0]?.total ?? 0);

function displayName(app: string): string {
  // 进程名全小写（如 chrome）；展示时首字母大写更友好
  return /^[a-z]/.test(app) ? app.charAt(0).toUpperCase() + app.slice(1) : app;
}

function widthPct(row: UsageRow): number {
  return maxTotal.value > 0 ? Math.max(3, Math.round((row.total / maxTotal.value) * 100)) : 0;
}

function activePct(row: UsageRow): number {
  return row.total > 0 ? Math.round((row.active / row.total) * 100) : 0;
}

/** 秒 → 人性化时长（X 小时 Y 分钟 / Y 分钟 / N 秒） */
function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return t('appUsage.durHourMinute', { h, m });
  if (m > 0) return t('appUsage.durMinute', { m });
  return t('appUsage.durSeconds', { s: seconds });
}

async function load(): Promise<void> {
  try {
    rows.value = await statsService.getAppUsageRange(rangeDates.value.from, rangeDates.value.to);
  } catch (e) {
    console.error('[app_usage] 加载应用时长失败:', e);
  } finally {
    loading.value = false;
  }
}

async function onToggle(enabled: boolean): Promise<void> {
  try {
    await setAppUsageEnabled(enabled);
    if (enabled) void load();
  } catch { /* 切换失败：composable 内已回滚 UI，无需额外处理 */ }
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void load();
  // 与 30s 拉取节奏对齐的自动刷新（仅开启时才有新数据）
  refreshTimer = setInterval(() => {
    if (appUsageEnabled.value) void load();
  }, 30_000);
});

onBeforeUnmount(() => {
  if (refreshTimer != null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<template>
  <div class="min-h-screen p-4">
    <div class="mx-auto max-w-6xl">
      <!-- 标题 + 范围切换 -->
      <div class="mb-6 flex items-center justify-between gap-4">
        <h1 class="text-lg font-semibold text-ink">{{ t('appUsage.title') }}</h1>
        <UiSegmented v-model="range" :options="rangeOptions" size="sm" :label="t('appUsage.title')" />
      </div>

      <!-- 未开启：引导开启 -->
      <div
          v-if="!appUsageEnabled"
          class="glass-card flex flex-col items-center gap-4 rounded-2xl p-10 text-center shadow-soft"
      >
        <div class="flex h-14 w-14 items-center justify-center rounded-full bg-gold/15 text-gold">
          <svg class="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3.5 2" />
          </svg>
        </div>
        <div class="text-ink">{{ t('appUsage.disabledTitle') }}</div>
        <div class="max-w-md text-sm text-ink-faint">{{ t('appUsage.disabledHint') }}</div>
        <button type="button" class="btn-gold px-5" @click="onToggle(true)">
          {{ t('appUsage.enableBtn') }}
        </button>
      </div>

      <template v-else>
        <!-- 汇总卡：总时长 / 活跃时长 / 挂机时长 -->
        <div class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div class="glass-card flex items-center gap-3 rounded-2xl p-4 shadow-soft">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3.5 2" />
              </svg>
            </div>
            <div class="min-w-0 flex-1 text-xs uppercase tracking-wide text-ink-faint">{{ t('appUsage.total') }}</div>
            <div class="text-xl font-semibold tabular-nums text-ink">{{ fmt(totals.total) }}</div>
          </div>
          <div class="glass-card flex items-center gap-3 rounded-2xl p-4 shadow-soft">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 2 4.5 12.5H11l-1 8 8.5-10.5H12l1-8Z" />
              </svg>
            </div>
            <div class="min-w-0 flex-1 text-xs uppercase tracking-wide text-ink-faint">{{ t('appUsage.active') }}</div>
            <div class="text-xl font-semibold tabular-nums text-ink">{{ fmt(totals.active) }}</div>
          </div>
          <div class="glass-card flex items-center gap-3 rounded-2xl p-4 shadow-soft">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
              </svg>
            </div>
            <div class="min-w-0 flex-1 text-xs uppercase tracking-wide text-ink-faint">{{ t('appUsage.idle') }}</div>
            <div class="text-xl font-semibold tabular-nums text-ink">{{ fmt(idleSecs) }}</div>
          </div>
        </div>

        <!-- 应用列表：按总时长降序，活跃（金色）/挂机（淡金）两段叠加条形 -->
        <div class="glass-card rounded-2xl p-4 shadow-soft">
          <div class="mb-3 flex items-center justify-between text-xs uppercase tracking-wide text-ink-faint">
            <span>{{ t('appUsage.appCol') }}</span>
            <span>{{ t('appUsage.total') }} · {{ t('appUsage.active') }}</span>
          </div>

          <div v-if="rows.length === 0 && !loading" class="py-12 text-center text-sm text-ink-faint">
            {{ t('appUsage.empty') }}
          </div>

          <div v-for="row in rows" :key="row.app" class="mb-4 last:mb-0">
            <div class="mb-1.5 flex items-center justify-between gap-3 text-xs">
              <span class="truncate font-medium text-ink">{{ displayName(row.app) }}</span>
              <span class="shrink-0 text-ink-faint">
                {{ fmt(row.total) }} · <span class="text-gold">{{ t('appUsage.active') }} {{ fmt(row.active) }}</span>
              </span>
            </div>
            <div class="h-2 w-full overflow-hidden rounded-full bg-surface-field">
              <!-- 总时长条（相对最大值）：内部实心金 = 活跃部分，淡金 = 挂机部分 -->
              <div class="h-full rounded-full bg-gold/25" :style="{ width: widthPct(row) + '%' }">
                <div class="h-full rounded-full bg-gold" :style="{ width: activePct(row) + '%' }"></div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
