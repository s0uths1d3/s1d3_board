<script setup lang="ts">
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { writeText } from 'tauri-plugin-clipboard-api';
import dbService from '~/src/db/dbService';
import { useI18n } from '~/composables/useI18n';
import { useFormatDate } from '~/composables/useFormatDate';
import { useColorScheme } from '~/composables/useColorScheme';
import { notifyIsland, useIslandEnabled, makeImageThumb } from '~/composables/useCopyIsland';
import { showImagePreview, hideImagePreview, dismissImagePreview } from '~/composables/useImagePreview';
import { isTauri } from '~/utils/env';
import type { IslandKind } from '~/composables/useCopyIsland';

/**
 * 灵动岛历史窗口（单例 label island-history，标题栏时钟图标打开；无边框透明窗口，主窗口同款自绘标题栏）：
 * - 展示全部弹岛来源（复制/粘贴/AI/设置操作/第三方 API）的最近 500 条记录；
 * - 打开时全量查询（表 FIFO 上限 500）；存活期间监听 island:show 实时把新消息插到列表头部（与岛同步收）；
 * - 流式渲染：首屏只渲染第一页（60 条），滚动到底 sentinel 触发渲染下一批（与待办列表同策略）；
 * - 类型筛选：按消息类型即时过滤（下拉选择，附计数）；
 * - 导出：CSV / TXT 两种格式，范围可选「当前筛选 / 全部」，save 对话框选保存路径，
 *   完成后经灵动岛提示结果（尊重灵动岛开关设置）。
 */

interface IslandHistoryItem {
  id: number;
  kind: IslandKind;
  text: string;
  createdAt: number;
}

const { t, locale } = useI18n();
const formatLocalized = useFormatDate();
useColorScheme(); // 配色跟随：读持久化模式 + 监听 scheme:changed 广播（与主窗口实时同步）
useIslandEnabled(); // 触发岛开关 KV 加载：导出结果提示尊重「灵动岛提示」开关

const items = ref<IslandHistoryItem[]>([]);
const loading = ref(true);
const confirmClear = ref(false);

/** kind → 色点/类型文案（i18n 键；仅类型名随界面语言，消息内容保持原始存储）。
 *  loading 过程岛不落历史（emitIslandShow 跳过），此条目仅为满足 Record 完整性 */
const kindMeta: Record<IslandKind, { dot: string; labelKey: string }> = {
  copy: { dot: 'bg-gold', labelKey: 'island_history.type_copy' },
  'copy-image': { dot: 'bg-gold', labelKey: 'island_history.type_copy_image' },
  cut: { dot: 'bg-gold', labelKey: 'island_history.type_cut' },
  paste: { dot: 'bg-blue', labelKey: 'island_history.type_paste' },
  info: { dot: 'bg-ink-soft', labelKey: 'island_history.type_info' },
  success: { dot: 'bg-green', labelKey: 'island_history.type_success' },
  error: { dot: 'bg-danger', labelKey: 'island_history.type_error' },
  loading: { dot: 'bg-gold', labelKey: 'island_history.type_info' },
};
const KIND_ORDER: IslandKind[] = ['copy', 'copy-image', 'cut', 'paste', 'info', 'success', 'error'];

// ===== 类型筛选：单选即时过滤，下拉面板附各类型计数 =====
type FilterKind = IslandKind | 'all';
const filter = ref<FilterKind>('all');

const kindCounts = computed(() => {
  const c: Partial<Record<IslandKind, number>> = {};
  for (const it of items.value) c[it.kind] = (c[it.kind] ?? 0) + 1;
  return c;
});

const filteredByKind = computed(() =>
  filter.value === 'all' ? items.value : items.value.filter((it) => it.kind === filter.value),
);

// ===== 日期筛选：全部时间 / 今天 / 昨天 / 近 7 天 / 指定日期（本地时区按日切界） =====
type DateFilter = 'all' | 'today' | 'yesterday' | 'week' | 'date';
const dateFilter = ref<DateFilter>('all');
const pickedDate = ref(''); // YYYY-MM-DD（input[type=date] 值；仅 dateFilter==='date' 时参与过滤）

const dateOptions = computed(() => [
  { value: 'all' as DateFilter, label: t('island_history.date_all') },
  { value: 'today' as DateFilter, label: t('island_history.today') },
  { value: 'yesterday' as DateFilter, label: t('island_history.yesterday') },
  { value: 'week' as DateFilter, label: t('island_history.date_week') },
]);
const dateFilterLabel = computed(() => {
  if (dateFilter.value === 'date') return pickedDate.value || t('island_history.date_pick');
  if (dateFilter.value === 'all') return t('island_history.date_all');
  return dateOptions.value.find((o) => o.value === dateFilter.value)?.label ?? t('island_history.date_all');
});

/** 本地时区某天 00:00 的毫秒时间戳（'YYYY-MM-DD' 不能直接 new Date——那是 UTC 解析） */
function localDayStart(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d).getTime();
}
const DAY_MS = 24 * 60 * 60 * 1000;
const dateRange = computed<[number, number]>(() => {
  const now = new Date();
  if (dateFilter.value === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(pickedDate.value)) {
    const [y = 0, m = 1, d = 1] = pickedDate.value.split('-').map(Number);
    const start = localDayStart(y, m, d);
    return [start, start + DAY_MS];
  }
  const todayStart = localDayStart(now.getFullYear(), now.getMonth() + 1, now.getDate());
  if (dateFilter.value === 'today') return [todayStart, todayStart + DAY_MS];
  if (dateFilter.value === 'yesterday') return [todayStart - DAY_MS, todayStart];
  if (dateFilter.value === 'week') return [todayStart - 6 * DAY_MS, todayStart + DAY_MS];
  return [0, Number.MAX_SAFE_INTEGER];
});

watch(pickedDate, (v) => {
  if (v) dateFilter.value = 'date'; // 选了具体日期即切到日期模式
});

const filteredItems = computed(() =>
  filteredByKind.value.filter((it) => it.createdAt >= dateRange.value[0] && it.createdAt < dateRange.value[1]),
);

// ===== 流式渲染（与待办列表同策略）：首屏只渲染第一页，列表底部 sentinel 进入视口
// （提前 200px）再渲染下一批；类型/日期筛选变化重置回第一页。数据仍一次性查库
// （表 FIFO 上限 500 条），流式的是渲染量——大列表首屏不卡、滚动渐进上屏 =====
const RENDER_PAGE = 60;
const renderLimit = ref(RENDER_PAGE);
const sentinel = ref<HTMLElement | null>(null);
const visibleItems = computed(() => filteredItems.value.slice(0, renderLimit.value));
const hasMoreToRender = computed(() => renderLimit.value < filteredItems.value.length);

function renderMore(): void {
  if (!hasMoreToRender.value) return;
  renderLimit.value = Math.min(renderLimit.value + RENDER_PAGE, filteredItems.value.length);
}

/** sentinel 挂载/卸载后重建观察（v-if 随 loading/hasMoreToRender 切换） */
let renderObserver: IntersectionObserver | null = null;
function setupRenderObserver(): void {
  renderObserver?.disconnect();
  renderObserver = null;
  const el = sentinel.value;
  if (!el) return;
  renderObserver = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting) renderMore();
  }, { rootMargin: '200px 0px' });
  renderObserver.observe(el);
}
watch(sentinel, () => setupRenderObserver());
// 筛选变化从头渲染（组折叠/条目展开状态保留，不受影响）
watch([filter, dateFilter, pickedDate], () => { renderLimit.value = RENDER_PAGE; });
onBeforeUnmount(() => {
  renderObserver?.disconnect();
  renderObserver = null;
});

// ===== 日期分组：今天/昨天/日期 吸顶分隔（扫视 500 条流水的锚点） =====
interface HistoryGroup { key: string; label: string; items: IslandHistoryItem[] }

function groupLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yd = new Date(now);
  yd.setDate(now.getDate() - 1);
  if (same(d, now)) return t('island_history.today');
  if (same(d, yd)) return t('island_history.yesterday');
  const zh = locale.value === 'zh-cn';
  const base = zh ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getMonth() + 1}/${d.getDate()}`;
  if (d.getFullYear() === now.getFullYear()) return base;
  return zh ? `${d.getFullYear()}年${base}` : `${d.getFullYear()}/${base}`;
}

const groupedItems = computed<HistoryGroup[]>(() => {
  const groups: HistoryGroup[] = [];
  const byKey = new Map<string, HistoryGroup>();
  for (const it of visibleItems.value) {
    const d = new Date(it.createdAt);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: groupLabel(it.createdAt), items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(it);
  }
  return groups;
});

// ===== 长文本：默认收起 3 行，点击条目展开/收起（防 2000 字长内容撑爆列表） =====
const expandedIds = ref(new Set<number>());
function toggleExpand(id: number): void {
  const s = new Set(expandedIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  expandedIds.value = s; // 重新赋值保证响应性
}

// ===== 日期组折叠：点击组头收起/展开该组 =====
const collapsedGroups = ref(new Set<string>());
function toggleGroup(key: string): void {
  const s = new Set(collapsedGroups.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  collapsedGroups.value = s;
}

/** 点击复制条目文本到剪贴板（图片条目不提供；结果走灵动岛提示） */
async function copyItem(item: IslandHistoryItem): Promise<void> {
  try {
    if (isTauri()) await writeText(item.text);
    else await navigator.clipboard.writeText(item.text);
    notifyIsland({ kind: 'success', text: t('island_history.copied') });
  } catch {
    notifyIsland({ kind: 'error', text: t('island_history.copy_failed') });
  }
}

const filterOptions = computed(() => [
  { value: 'all' as FilterKind, label: t('island_history.type_all'), dot: '', count: items.value.length },
  ...KIND_ORDER.map((k) => ({
    value: k as FilterKind,
    label: t(kindMeta[k].labelKey),
    dot: kindMeta[k].dot,
    count: kindCounts.value[k] ?? 0,
  })),
]);

const filterLabel = computed(() =>
  filter.value === 'all' ? t('island_history.type_all') : t(kindMeta[filter.value].labelKey),
);

/** 列表内容渲染：图片类条目（复制/粘贴/剪切图片，DB 存的是降采样缩略图 data URL）→ <img> 渲染；
 * 其他条目显示文本。缩略图生成失败回退空串 → 显示「[图片]」占位；其他空内容条目回退类型标签 */
const IMAGE_KINDS: ReadonlySet<IslandKind> = new Set<IslandKind>(['copy-image', 'paste', 'cut']);
function isThumb(item: IslandHistoryItem): boolean {
  return IMAGE_KINDS.has(item.kind) && item.text.startsWith('data:');
}
function fallbackText(item: IslandHistoryItem): string {
  if (IMAGE_KINDS.has(item.kind)) return t('island_history.image_placeholder');
  return t(kindMeta[item.kind].labelKey);
}

/** 缩略图悬停：独立 tooltip 窗口放大预览原图（按原图比例适配 + 屏幕钳制），元信息=类型 · 时间 */
function onThumbEnter(item: IslandHistoryItem, e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement | null;
  if (el && isThumb(item)) {
    void showImagePreview(item.text, el, `${t(kindMeta[item.kind].labelKey)} · ${formatLocalized(item.createdAt)}`);
  }
}

// ===== 导出：格式 / 范围 / 进度与结果反馈 =====
const exportOpen = ref(false);
const exportFormat = ref<'csv' | 'txt'>('csv');
const exportScope = ref<'filtered' | 'all'>('filtered');
const exporting = ref(false);

/** 导出范围选项：计数单独成徽标（不塞进标签文案，避免 segmented/选项内换行） */
const scopeOptions = computed(() => [
  { value: 'filtered' as const, label: t('island_history.scope_filtered'), count: filteredItems.value.length },
  { value: 'all' as const, label: t('island_history.scope_all'), count: items.value.length },
]);

/** 绝对时间（本地时区 yyyy-MM-dd HH:mm:ss）：导出文件用可读存档时间 */
function formatAbs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** CSV 字段转义：含逗号/引号/换行时加双引号包裹，内部引号翻倍（RFC 4180） */
function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function buildCsv(rows: IslandHistoryItem[]): string {
  const lines = [t('island_history.csv_header')];
  for (const r of rows) {
    // 缩略图 data URL 不进导出文件（无意义），图片条目导出「[图片]」占位
    lines.push([t(kindMeta[r.kind].labelKey), csvField(isThumb(r) ? t('island_history.image_placeholder') : r.text || fallbackText(r)), formatAbs(r.createdAt)].map(csvField).join(','));
  }
  // BOM：Excel 直接打开中文不乱码；CRLF：Windows 记事本/Excel 友好
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function buildTxt(rows: IslandHistoryItem[]): string {
  const lines = [t('island_history.txt_header', { time: formatAbs(Date.now()), n: rows.length }), ''];
  for (const r of rows) {
    lines.push(`[${formatAbs(r.createdAt)}] ${t(kindMeta[r.kind].labelKey)}`, isThumb(r) ? t('island_history.image_placeholder') : r.text || fallbackText(r), '');
  }
  return lines.join('\r\n');
}

async function doExport(close: () => void): Promise<void> {
  if (exporting.value) return;
  const rows = exportScope.value === 'filtered' ? filteredItems.value : items.value;
  if (rows.length === 0) return;
  exporting.value = true;
  try {
    const path = await save({
      title: t('island_history.export'),
      defaultPath: `island-history-${formatAbs(Date.now()).replace(/[: ]/g, '-')}.${exportFormat.value}`,
      filters: [exportFormat.value === 'csv'
        ? { name: 'CSV', extensions: ['csv'] }
        : { name: 'TXT', extensions: ['txt'] }],
    });
    if (!path) return; // 用户取消保存，静默
    await writeTextFile(path, exportFormat.value === 'csv' ? buildCsv(rows) : buildTxt(rows));
    close();
    notifyIsland({ kind: 'success', text: t('island_history.exported', { n: rows.length }) });
  } catch (e) {
    notifyIsland({ kind: 'error', text: t('island_history.export_failed', { error: String(e).slice(0, 120) }) });
  } finally {
    exporting.value = false;
  }
}

async function loadHistory(): Promise<void> {
  try {
    const rows = await dbService.getIslandHistory(500);
    items.value = rows.map((r) => ({ ...r, kind: (r.kind as IslandKind) in kindMeta ? (r.kind as IslandKind) : 'info' }));
  } catch { /* 查询失败保持空态 */ }
  loading.value = false;
}

async function onClear(): Promise<void> {
  if (!confirmClear.value) {
    confirmClear.value = true;
    setTimeout(() => { confirmClear.value = false; }, 4000);
    return;
  }
  confirmClear.value = false;
  await dbService.clearIslandHistory().catch(() => {});
  items.value = [];
}

// ===== 自绘标题栏窗口控制（无边框窗口，与主窗口 TitleBar 同款交互） =====
async function minimizeWin(): Promise<void> {
  await getCurrentWindow().minimize().catch(() => {});
}
async function closeWin(): Promise<void> {
  await getCurrentWindow().close().catch(() => {});
}

onMounted(() => {
  void loadHistory();
  if (!isTauri()) return;
  // 历史窗口存活期间与岛同步接收：新消息实时插到列表头部（限长 500 与 DB 一致）。
  // copy-image 的 text 是完整 base64（岛内缩略图用），与 DB 写入点同规则：先插空占位条目，
  // 缩略图（webp 小图）生成后回填，原图 base64 不进列表内存
  void listen<{ kind?: string; text?: string }>('island:show', (ev) => {
    const p = ev.payload;
    if (!p || !p.kind) return;
    const kind = (p.kind in kindMeta ? p.kind : 'info') as IslandKind;
    if (kind === 'copy-image') {
      const id = -Date.now();
      items.value = [{ id, kind, text: '', createdAt: Date.now() }, ...items.value].slice(0, 500);
      if (typeof p.text === 'string' && p.text.startsWith('data:')) {
        void makeImageThumb(p.text).then((thumb) => {
          const it = items.value.find((i) => i.id === id);
          if (it) it.text = thumb;
        }).catch(() => {});
      }
      return;
    }
    const text = typeof p.text === 'string' ? p.text : '';
    items.value = [{ id: -Date.now(), kind, text, createdAt: Date.now() }, ...items.value].slice(0, 500);
  }).catch(() => {});
});

// 窗口销毁兜底：关闭历史窗口时立即收掉图片预览窗口（DOM 卸载后 mouseleave 不再触发）
onBeforeUnmount(() => dismissImagePreview());
</script>

<template>
  <!-- 根容器不加背景：与主窗口同款——body 的三段渐变 + 双光晕氛围背景透出（main.css），
       随配色主题联动；盖 bg-surface 实色会变成一块与主窗口风格割裂的纯色面板 -->
  <div class="flex h-screen flex-col overflow-hidden rounded-2xl text-ink">
    <!-- 自绘标题栏：主窗口同款（拖拽区 + gold-bar 标题 + 窗口控制） -->
    <div class="drag-region flex h-10 shrink-0 items-center justify-between border-b border-line bg-surface px-3">
      <div class="gold-bar flex items-center gap-2 select-none">
        <h1 class="text-sm font-semibold text-ink">{{ t('island_history.title') }}</h1>
      </div>
      <div class="no-drag flex items-center gap-2">
        <button
            class="flex h-7 w-7 items-center justify-center rounded-full text-ink-soft transition-all duration-300 ease-soft hover:bg-secondary hover:shadow-sm"
            v-tip="t('titlebar.minimize')"
            @click="minimizeWin"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
            class="flex h-7 w-7 items-center justify-center rounded-full text-danger transition-all duration-300 ease-soft hover:bg-danger/10 hover:shadow-sm"
            v-tip="t('titlebar.close')"
            @click="closeWin"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 工具条：类型筛选（左） · 导出 / 清空（右） -->
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
      <UiDropdown
          align="start"
          panel-class="glass-card w-44 rounded-2xl p-1.5"
          :aria-label="t('island_history.filter')"
      >
        <template #trigger="{ open }">
          <button
              type="button"
              tabindex="-1"
              class="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-ink-soft transition-all duration-300 ease-soft hover:bg-secondary hover:text-ink"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 4h18l-7 8.5V19l-4 2v-8.5L3 4z" />
            </svg>
            <span :class="filter === 'all' ? '' : 'text-ink'">{{ filterLabel }}</span>
            <span class="rounded-full bg-secondary px-1.5 text-[10px] tabular-nums text-ink-soft">{{ filteredItems.length }}</span>
            <svg class="h-3 w-3 opacity-60 transition-transform duration-200" :class="open ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </template>
        <ul class="p-1">
          <li v-for="opt in filterOptions" :key="opt.value">
            <button
                type="button"
                class="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-xs transition-colors duration-200"
                :class="filter === opt.value ? 'bg-gold/15 text-gold' : 'text-ink hover:bg-secondary'"
                @click="filter = opt.value"
            >
              <span class="flex items-center gap-2">
                <span v-if="opt.dot" class="h-2 w-2 rounded-full" :class="opt.dot" />
                {{ opt.label }}
              </span>
              <span class="text-[10px] tabular-nums text-ink-soft">{{ opt.count }}</span>
            </button>
          </li>
        </ul>
      </UiDropdown>

      <!-- 日期筛选：快捷范围 + 指定日期（input[type=date] 本地选择） -->
      <UiDropdown
          align="start"
          panel-class="glass-card w-48 rounded-2xl p-1.5"
          :aria-label="t('island_history.date_filter')"
      >
        <template #trigger="{ open }">
          <button
              type="button"
              tabindex="-1"
              class="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-ink-soft transition-all duration-300 ease-soft hover:bg-secondary hover:text-ink"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            <span :class="dateFilter === 'all' ? '' : 'text-ink'">{{ dateFilterLabel }}</span>
            <svg class="h-3 w-3 opacity-60 transition-transform duration-200" :class="open ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </template>
        <ul class="p-1">
          <li v-for="opt in dateOptions" :key="opt.value">
            <button
                type="button"
                class="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors duration-200"
                :class="dateFilter === opt.value ? 'bg-gold/15 text-gold' : 'text-ink hover:bg-secondary'"
                @click="dateFilter = opt.value"
            >
              {{ opt.label }}
              <span v-if="dateFilter === opt.value" class="text-gold">✓</span>
            </button>
          </li>
          <li class="mt-1 border-t border-line/60 px-2.5 pt-2 pb-1">
            <p class="mb-1 text-[10px] text-ink-faint">{{ t('island_history.date_pick') }}</p>
            <input
                v-model="pickedDate"
                type="date"
                class="w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
            />
          </li>
        </ul>
      </UiDropdown>

      <div class="flex-1" />

      <!-- 导出：格式 + 范围选项面板 -->
      <UiDropdown
          v-model:open="exportOpen"
          align="end"
          direction="up"
          :close-on-select="false"
          panel-class="glass-card w-60 rounded-2xl p-3"
          :aria-label="t('island_history.export')"
      >
        <template #trigger>
          <button
              type="button"
              tabindex="-1"
              class="flex h-7 w-7 items-center justify-center rounded-full text-ink-soft transition-all duration-300 ease-soft hover:bg-secondary hover:shadow-sm"
              v-tip="t('island_history.export')"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="m7 10 5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
          </button>
        </template>
        <template #default="{ close }">
          <div class="space-y-3">
            <div>
              <p class="mb-1.5 text-[11px] font-medium text-ink-soft">{{ t('island_history.export_format') }}</p>
              <UiSegmented
                  v-model="exportFormat"
                  size="sm"
                  block
                  :options="[{ value: 'csv', label: 'CSV' }, { value: 'txt', label: 'TXT' }]"
              />
            </div>
            <div>
              <p class="mb-1.5 text-[11px] font-medium text-ink-soft">{{ t('island_history.export_scope') }}</p>
              <div class="space-y-1">
                <button
                    v-for="opt in scopeOptions"
                    :key="opt.value"
                    type="button"
                    class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors duration-200"
                    :class="exportScope === opt.value ? 'bg-gold/15 text-gold' : 'text-ink hover:bg-secondary'"
                    @click="exportScope = opt.value"
                >
                  <span
                      class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
                      :class="exportScope === opt.value ? 'border-gold' : 'border-line'"
                  >
                    <span v-if="exportScope === opt.value" class="h-1.5 w-1.5 rounded-full bg-gold" />
                  </span>
                  <span class="flex-1 text-left">{{ opt.label }}</span>
                  <span class="tabular-nums text-[10px] text-ink-soft">{{ opt.count }}</span>
                </button>
              </div>
            </div>
            <button
                type="button"
                class="flex h-8 w-full items-center justify-center gap-1.5 rounded-xl bg-gold text-xs font-medium text-on-gold transition-all duration-300 ease-soft hover:shadow-sm disabled:pointer-events-none disabled:opacity-60"
                :disabled="exporting || items.length === 0"
                @click="doExport(close)"
            >
              <svg v-if="exporting" class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                <path d="M21 12a9 9 0 1 1-6.2-8.56" />
              </svg>
              {{ exporting ? t('island_history.exporting') : t('island_history.export_do') }}
            </button>
          </div>
        </template>
      </UiDropdown>

      <!-- 清空（二次点击确认） -->
      <button
          class="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-all duration-300 ease-soft"
          :class="confirmClear
              ? 'bg-danger/15 text-danger'
              : 'text-ink-soft hover:bg-secondary hover:text-ink'"
          @click="onClear"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        </svg>
        {{ t(confirmClear ? 'island_history.confirm_clear' : 'island_history.clear') }}
      </button>
    </div>

    <!-- 列表：加载 / 空态（区分无数据与筛选无结果）/ 按日期分组的数据 -->
    <div v-if="loading" class="flex flex-1 items-center justify-center text-sm text-ink-soft">
      {{ t('island_history.loading') }}
    </div>
    <div v-else-if="items.length === 0" class="flex flex-1 flex-col items-center justify-center gap-3 text-ink-soft">
      <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary/70">
        <svg class="h-7 w-7 text-ink-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="8" width="18" height="8" rx="4" />
          <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="13" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="17" cy="12" r="1" fill="currentColor" stroke="none" />
        </svg>
      </div>
      <p class="text-sm">{{ t('island_history.empty') }}</p>
    </div>
    <div v-else-if="filteredItems.length === 0" class="flex flex-1 items-center justify-center text-sm text-ink-soft">
      {{ t('island_history.filter_empty') }}
    </div>
    <div v-else class="flex-1 overflow-y-auto">
      <section v-for="group in groupedItems" :key="group.key">
        <!-- 日期分组头：点击折叠/展开该组（整组可折叠；展开后吸顶） -->
        <button
            type="button"
            class="sticky top-0 z-10 flex w-full items-center justify-between border-b border-line/60 bg-surface/70 px-4 py-1 text-left text-[10px] font-medium tracking-wider text-ink-soft backdrop-blur-md transition-colors duration-200 hover:text-ink"
            @click="toggleGroup(group.key)"
        >
          <span class="flex items-center gap-1.5">
            <svg class="h-2.5 w-2.5 transition-transform duration-200" :class="collapsedGroups.has(group.key) ? '' : 'rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="m9 6 6 6-6 6" />
            </svg>
            {{ group.label }}
          </span>
          <span class="tabular-nums">{{ group.items.length }}</span>
        </button>
        <!-- 折叠动画：grid-rows 0fr/1fr 过渡（高度自适应内容，无需 JS 测量；overflow-hidden 裁切内容） -->
        <div
            class="grid transition-[grid-template-rows] duration-200 ease-out"
            :class="collapsedGroups.has(group.key) ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'"
        >
          <ul class="min-h-0 divide-y divide-line/60 overflow-hidden">
          <li
              v-for="item in group.items"
              :key="item.id"
              class="group/item flex items-start gap-3 px-4 py-2.5 transition-colors duration-200 hover:bg-secondary/50"
          >
            <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full" :class="kindMeta[item.kind].dot" />
            <div class="min-w-0 flex-1">
              <!-- 图片条目：直接渲染缩略图（DB 存的是降采样 webp 小图），悬停弹出独立窗口放大预览原图 -->
              <img
                  v-if="isThumb(item)"
                  :src="item.text"
                  alt=""
                  class="h-10 w-14 shrink-0 cursor-zoom-in rounded-md object-cover ring-1 ring-line"
                  @mouseenter="onThumbEnter(item, $event)"
                  @mouseleave="hideImagePreview"
              />
              <!-- 文本条目：默认收起 3 行，点击展开/收起 -->
              <p
                  v-else
                  class="break-all text-xs leading-relaxed text-ink transition-colors duration-200"
                  :class="expandedIds.has(item.id) ? 'cursor-zoom-out' : 'cursor-pointer line-clamp-3'"
                  @click="toggleExpand(item.id)"
              >{{ item.text || fallbackText(item) }}</p>
              <p class="mt-0.5 text-[10px] text-ink-soft">
                <span class="rounded-full bg-secondary px-1.5 py-px">{{ t(kindMeta[item.kind].labelKey) }}</span>
              </p>
            </div>
            <!-- 右侧：悬停出现复制按钮 + 相对时间 -->
            <div class="flex shrink-0 items-center gap-1 self-start">
              <button
                  v-if="!isThumb(item) && item.text"
                  type="button"
                  tabindex="-1"
                  class="flex h-5 w-5 items-center justify-center rounded-md text-ink-soft opacity-0 transition-all duration-200 hover:bg-secondary hover:text-ink focus-visible:opacity-100 group-hover/item:opacity-100"
                  v-tip="t('island_history.type_copy')"
                  @click.stop="copyItem(item)"
              >
                <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="12" height="12" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
              <span class="text-[10px] tabular-nums text-ink-faint">{{ formatLocalized(item.createdAt) }}</span>
            </div>
          </li>
          </ul>
        </div>
      </section>

      <!-- 流式渲染：sentinel 进入视口时渲染下一批；全部渲染完显示「没有更多了」 -->
      <div
          v-if="hasMoreToRender && visibleItems.length"
          ref="sentinel"
          class="py-4 text-center text-xs text-ink-faint"
      >{{ t('island_history.scroll_more') }}</div>
      <div v-else-if="visibleItems.length" class="py-4 text-center text-xs text-ink-faint">{{ t('island_history.no_more') }}</div>
    </div>
  </div>
</template>
