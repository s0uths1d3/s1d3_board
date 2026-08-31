<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "~/utils/env";
import { activeTab, setActiveTab, getVisibleTabItems, reorderTab, persistNavConfig, type TabKey } from "~/composables/useTabs";
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import { useLongPressReorder } from "~/composables/useLongPressReorder";
import { cycleColorScheme, COLOR_SCHEME_LABELS, COLOR_SCHEME_ORDER, useColorScheme, type ColorSchemeMode } from "~/composables/useColorScheme";

/** 标题栏导航项：仅渲染当前可见的 tab（统计 Tab 受解锁门槛控制，§7.9，解锁后动态出现） */
const visibleTabs = computed(() => getVisibleTabItems());
import { useAlwaysOnTop } from "~/composables/useAlwaysOnTop";

// ===== 导航图标长按拖拽排序：左键按住 0.5s 进入拖拽，移动到目标位置实时重排，松开持久化 =====
const draggingTabKey = ref<string | null>(null);
const navReorder = useLongPressReorder({
  container: '[data-nav-bar]',
  holdMs: 500,
  items: '.nav-tab',
  axis: 'x',
  onReorder: (from, to) => reorderTab(from as TabKey, to as TabKey),
  onDrop: () => { void persistNavConfig(); },
  onStateChange: (k) => { draggingTabKey.value = k; },
});

/** 点击导航图标：拖拽结束后的 click 抑制切换（长按拖动 ≠ 点击） */
function onNavTabClick(key: TabKey) {
  if (navReorder.consumeDragged()) return;
  setActiveTab(key);
}

// 窗口控制仅在 Tauri 桌面容器内可用；纯 Web 预览无窗口，按钮不显示
async function minimize() {
  if (!isTauri()) return;
  await getCurrentWindow().minimize();
}

/** 窗口是否最大化（驱动最大化/还原按钮的名称、图标与激活态） */
const isMaximized = ref(false);

async function updateMaximized() {
  if (!isTauri()) return;
  try {
    isMaximized.value = await getCurrentWindow().isMaximized();
  } catch { /* 忽略单次查询失败 */ }
}

async function toggleMaximize() {
  if (!isTauri()) return;
  await getCurrentWindow().toggleMaximize();
  await updateMaximized();
}

async function close() {
  if (!isTauri()) return;
  await getCurrentWindow().close();
}

// 窗口控制：始终置顶（pin）—— 共享状态/逻辑，供标题栏按钮与 Ctrl+T 快捷键共用
const { alwaysOnTop, toggleAlwaysOnTop } = useAlwaysOnTop();

// ===== 快速切换配色：标题栏按钮循环 跟随系统→琥珀→浅色→深色，与配色快捷键（默认不绑定）共用同一状态 =====
const { scheme, resolvedScheme } = useColorScheme();
/** 各模式的小色点预览；system 为深浅对半，直观表达"跟随系统" */
const schemeDot: Record<ColorSchemeMode, string> = {
  system: 'linear-gradient(90deg, #f0e9e1 50%, #3a352e 50%)',
  default: '#c4a77d',
  light: '#dfe3ea',
  dark: '#3a352e',
};
const nextSchemeLabel = computed(() => {
  const next = COLOR_SCHEME_ORDER[(COLOR_SCHEME_ORDER.indexOf(scheme.value) + 1) % COLOR_SCHEME_ORDER.length]!;
  return COLOR_SCHEME_LABELS[next];
});
const currentSchemeLabel = computed(() => COLOR_SCHEME_LABELS[scheme.value]);
/** system 模式下提示里附带当前解析到的配色，避免"看起来没反应"的困惑 */
const schemeTip = computed(() => {
  const base = `配色：${currentSchemeLabel.value}`;
  const resolved = scheme.value === 'system' ? `（当前${COLOR_SCHEME_LABELS[resolvedScheme.value]}）` : '';
  return `${base}${resolved}，点击切换为${nextSchemeLabel.value}`;
});
async function onSchemeClick() {
  await cycleColorScheme();
}

let unlistenResized: (() => void) | null = null;

onMounted(async () => {
  // 初始读取最大化状态，并监听窗口尺寸变化（最大化/还原/拖拽调整都会触发）
  await updateMaximized();
  if (isTauri()) {
    unlistenResized = await getCurrentWindow().onResized(() => updateMaximized());
  }
});

onBeforeUnmount(() => {
  unlistenResized?.();
  unlistenResized = null;
});
</script>

<template>
  <div
      class="drag-region flex h-10 shrink-0 items-center justify-between border-b border-line bg-surface px-3"
  >
    <!-- 左侧：标题（可拖拽窗口） -->
    <div class="gold-bar flex items-center gap-2 select-none">
      <h1 class="text-sm font-semibold text-ink">S1d3 Board</h1>
    </div>

    <!-- 中部：顶层导航（窗口之上）；左键长按 0.5s 可拖动图标调整顺序，松开自动持久化。
         no-drag 豁免 drag-region；图标 pointerdown 内 preventDefault 双保险阻止窗口拖拽启动 -->
    <nav class="no-drag flex items-center gap-2" data-nav-bar>
      <TransitionGroup name="reorder-nav" tag="div" class="flex items-center gap-2">
        <button
            v-for="tab in visibleTabs"
            :key="tab.key"
            v-tip="tab.name"
            :data-reorder-key="tab.key"
            class="nav-tab gold-underline flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium transition-all duration-300 ease-soft"
            :class="[
              activeTab === tab.key ? 'is-active text-gold' : 'text-ink-soft hover:text-ink',
              draggingTabKey === tab.key ? 'relative z-10 scale-110 opacity-60 cursor-grabbing shadow-float' : ''
            ]"
            @pointerdown="navReorder.pressStart(tab.key, $event)"
            @click="onNavTabClick(tab.key)"
        >
        <!-- 剪贴板 -->
        <svg v-if="tab.key === 'clip'" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
          <rect x="9" y="3" width="6" height="4" rx="1" />
          <path d="M9 12h6M9 16h4" />
        </svg>
        <!-- 待办 -->
        <svg v-else-if="tab.key === 'todo'" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="17" rx="2" />
          <path d="M8 2v4M16 2v4M3 10h18" />
          <path d="M9 15l2 2 4-4" />
        </svg>
        <!-- 便签 -->
        <svg v-else-if="tab.key === 'note'" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 4a2 2 0 0 1 2-2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
          <path d="M14 2v5h5" />
          <path d="M8 12h8M8 16h6" />
        </svg>
        <!-- 常用剪贴板 -->
        <svg v-else-if="tab.key === 'pinned'" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 4h6M10 4v6l-4 5a1 1 0 0 0 .8 1.6h10.4a1 1 0 0 0 .8-1.6l-4-5V4" />
          <path d="M5 21h14" />
        </svg>
        <!-- 设置 -->
        <svg v-else-if="tab.key === 'setting'" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <!-- 统计 -->
        <svg v-else-if="tab.key === 'statistics'" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 3v18h18" />
          <rect x="7" y="12" width="3" height="6" rx="0.5" />
          <rect x="12.5" y="8" width="3" height="10" rx="0.5" />
          <rect x="18" y="5" width="3" height="13" rx="0.5" />
        </svg>
        </button>
      </TransitionGroup>
    </nav>

    <!-- 右侧：快速切换配色（跟随系统→琥珀→浅色→深色循环）+ 窗口控制按钮 -->
    <div class="no-drag flex items-center gap-2">
      <button
          class="relative flex h-7 w-7 items-center justify-center rounded-full transition-all duration-300 ease-soft hover:bg-secondary hover:shadow-sm"
          v-tip="schemeTip"
          aria-label="切换配色"
          @click="onSchemeClick"
      >
        <!-- 调色盘图标 + 当前配色小色点 -->
        <svg class="h-3.5 w-3.5 text-ink-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
        </svg>
        <span
            class="pointer-events-none absolute h-2 w-2 -translate-x-3 translate-y-2.5 rounded-full ring-1 ring-line"
            :style="{ background: schemeDot[scheme] }"
        />
      </button>

      <div v-if="isTauri()" class="flex items-center gap-2">
      <button
          class="flex h-7 w-7 items-center justify-center rounded-full text-ink-soft transition-all duration-300 ease-soft hover:bg-secondary hover:shadow-sm"
          v-tip="'最小化'"
          @click="minimize"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <path d="M5 12h14" />
        </svg>
      </button>

      <button
          class="flex h-7 w-7 items-center justify-center rounded-full transition-all duration-300 ease-soft hover:shadow-sm"
          :class="isMaximized ? 'text-gold bg-gold/15 hover:bg-gold/25' : 'text-ink-soft hover:bg-secondary'"
          v-tip="isMaximized ? '还原' : '最大化'"
          @click="toggleMaximize"
      >
        <!-- 最大化：单个方框；还原：重叠方框 + 回折角 -->
        <svg v-if="!isMaximized" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
        <svg v-else class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M4 14V6a2 2 0 0 1 2-2h8" />
        </svg>
      </button>

      <button
          class="flex h-7 w-7 items-center justify-center rounded-full transition-all duration-300 ease-soft hover:shadow-sm"
          :class="alwaysOnTop ? 'text-gold bg-gold/15 hover:bg-gold/25' : 'text-ink-soft hover:bg-secondary'"
          v-tip="alwaysOnTop ? '取消置顶（点击取消）' : '窗口始终置顶'"
          @click="toggleAlwaysOnTop"
      >
        <svg class="h-3.5 w-3.5" :class="alwaysOnTop ? 'rotate-45' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 17v5" />
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </svg>
      </button>

      <button
          class="flex h-7 w-7 items-center justify-center rounded-full text-danger transition-all duration-300 ease-soft hover:bg-danger/10 hover:shadow-sm"
          v-tip="'关闭'"
          @click="close"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      </div>
    </div>
  </div>
</template>
