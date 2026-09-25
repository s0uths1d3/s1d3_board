<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "~/utils/env";
import { activeTab, setActiveTab, getVisibleTabItems, reorderTab, persistNavConfig, type TabKey } from "~/composables/useTabs";
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useLongPressReorder } from "~/composables/useLongPressReorder";
import { cycleColorScheme, useColorScheme, type ColorSchemeMode } from "~/composables/useColorScheme";
import { useI18n } from "~/composables/useI18n";
import { notifyIsland, toggleIslandHistoryWindow } from "~/composables/useCopyIsland";

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
  // 拖拽排序开始时收掉按下态预拉伸：长按 0.5s 已进入排序，不该继续挂着"准备去某 Tab"的姿态
  onStateChange: (k) => { draggingTabKey.value = k; if (k) clearPressed(); },
});

/** 点击导航图标：拖拽结束后的 click 抑制切换（长按拖动 ≠ 点击） */
function onNavTabClick(key: TabKey) {
  if (navReorder.consumeDragged()) return;
  setActiveTab(key);
}

// ===== 导航下划线：单元素在 Tab 间移动 =====
const navEl = ref<HTMLElement | null>(null);
/** 下划线区间（相对 nav 左缘 px）；按下目标时取"当前 Tab ∪ 目标 Tab"的并集 */
const underlineSpan = ref({ left: 0, right: 0 });
/** nav 宽度：下划线两端用 left/right 定位，右端点需换算成距 nav 右缘的距离 */
const navWidth = ref(0);
/** 按下但尚未放开的目标 Tab：此期间下划线先拉伸过去（松开/切换完成后清空） */
const pressedTab = ref<string | null>(null);
/** 首次摆放不加过渡，避免启动时从 0 长度长出来 */
const underlineReady = ref(false);

/** 某 Tab 相对 nav 左缘的水平区间（用 rect 相减，不依赖 offsetParent 链） */
function tabSpan(key: string): { left: number; right: number } | null {
  const nav = navEl.value;
  const btn = nav?.querySelector<HTMLElement>(`[data-reorder-key="${key}"]`);
  if (!nav || !btn) return null;
  const navRect = nav.getBoundingClientRect();
  const rect = btn.getBoundingClientRect();
  return { left: rect.left - navRect.left, right: rect.right - navRect.left };
}

/**
 * 重算下划线区间。按下态取当前与目标 Tab 的并集——左右两端谁外扩由两者位置决定，
 * 于是"远侧那条边钉住、朝向目标那条边伸出去"，方向感来自几何本身，
 * 不需要切换 transform-origin（origin 不参与插值，中途换边会跳）。
 */
function syncUnderline() {
  const nav = navEl.value;
  if (!nav) return;
  navWidth.value = nav.getBoundingClientRect().width;
  const current = tabSpan(activeTab.value);
  if (!current) return;
  const target = pressedTab.value && pressedTab.value !== activeTab.value ? tabSpan(pressedTab.value) : null;
  underlineSpan.value = target
    ? { left: Math.min(current.left, target.left), right: Math.max(current.right, target.right) }
    : current;
}

const underlineStyle = computed(() => {
  const { left, right } = underlineSpan.value;
  // 两端各自给值：left 直接是左端点，右端点换算成距 nav 右缘的距离
  return { left: `${left}px`, right: `${navWidth.value - right}px` };
});

/** 按下（未放开）：先把下划线朝目标拉伸过去——并集区间，远侧边钉住 */
function onTabPressStart(key: string) {
  if (key === activeTab.value) return;
  pressedTab.value = key;
  syncUnderline();
}

/** 结束预运动：收缩回当前 Tab（切换成功时由 activeTab watch 接管，这里是同义重算） */
function clearPressed() {
  if (!pressedTab.value) return;
  pressedTab.value = null;
  syncUnderline();
}

/** 松开鼠标：延后一帧再清，避免抢在 click 之前把下划线弹回旧 Tab */
function onWindowPointerUp() {
  requestAnimationFrame(clearPressed);
}

/** 切换 Tab（含 Ctrl+←/→、鼠标侧键等非点击路径）：收缩落位到新 Tab */
watch(activeTab, () => {
  pressedTab.value = null;
  nextTick(() => syncUnderline());
});

/** 图标增删/拖动排序后位置全变，需重新丈量 */
watch(visibleTabs, () => nextTick(() => syncUnderline()));

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
const { scheme } = useColorScheme();
/** 各模式的小色点预览；system 为深浅对半，直观表达"跟随系统" */
const schemeDot: Record<ColorSchemeMode, string> = {
  system: 'linear-gradient(90deg, #f0e9e1 50%, #3a352e 50%)',
  default: '#c4a77d',
  light: '#dfe3ea',
  dark: '#3a352e',
};
const { t } = useI18n();
async function onSchemeClick() {
  const next = await cycleColorScheme();
  // 操作反馈 → 灵动岛（屏幕顶部全局胶囊），文案与设置页配色切换一致；具体切到了哪个模式由胶囊告知
  notifyIsland({ kind: 'success', text: t('setting.general.color_scheme_saved', { name: t(`color_scheme.${next}`) }) });
}

let unlistenResized: (() => void) | null = null;

onMounted(async () => {
  // 初始读取最大化状态，并监听窗口尺寸变化（最大化/还原/拖拽调整都会触发）
  await updateMaximized();
  if (isTauri()) {
    unlistenResized = await getCurrentWindow().onResized(() => updateMaximized());
  }
  // 下划线首次摆放：此刻各 Tab 的尺寸已可量；窗口缩放不需要重算——
  // 区间是相对 nav 左缘取的，整条导航一起移动时相对位置不变
  syncUnderline();
  requestAnimationFrame(() => { underlineReady.value = true; });
  window.addEventListener('pointerup', onWindowPointerUp);
  window.addEventListener('pointercancel', onWindowPointerUp);
});

onBeforeUnmount(() => {
  unlistenResized?.();
  unlistenResized = null;
  window.removeEventListener('pointerup', onWindowPointerUp);
  window.removeEventListener('pointercancel', onWindowPointerUp);
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
    <nav ref="navEl" class="no-drag relative flex items-center gap-2" data-nav-bar>
      <TransitionGroup name="reorder-nav" tag="div" class="flex items-center gap-2">
        <button
            v-for="tab in visibleTabs"
            :key="tab.key"
            v-tip="t('titlebar.' + tab.key)"
            :data-reorder-key="tab.key"
            class="nav-tab flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium transition-all duration-300 ease-soft"
            :class="[
              activeTab === tab.key ? 'is-active text-gold' : 'text-ink-soft hover:text-ink',
              draggingTabKey === tab.key ? 'relative z-10 scale-110 opacity-60 cursor-grabbing shadow-float' : ''
            ]"
            @pointerdown="navReorder.pressStart(tab.key, $event); onTabPressStart(tab.key)"
            @click="onNavTabClick(tab.key)"
        >
        <!-- 图标：通用动效组件，按 tab.key 从 assets/svg/nav/ 取分层 SVG。
             长按进入拖拽排序时 interrupt 置真，图标原路退回而不是顺势转完 -->
        <NavMotionIcon
            :icon="tab.key"
            class="h-3.5 w-3.5 shrink-0"
            :interrupt="draggingTabKey === tab.key"
        />
        </button>
      </TransitionGroup>
      <!-- 单元素下划线：位置/长度由脚本按 Tab 实际几何写入（见 syncUnderline） -->
      <div
        class="nav-underline"
        :class="{ 'is-instant': !underlineReady, 'is-pressing': pressedTab !== null }"
        :style="underlineStyle"
        aria-hidden="true"
      ></div>
    </nav>

    <!-- 右侧：快速切换配色（跟随系统→琥珀→浅色→深色循环）+ 窗口控制按钮 -->
    <div class="no-drag flex items-center gap-2">
      <button
          class="relative flex h-7 w-7 items-center justify-center rounded-full transition-all duration-300 ease-soft hover:bg-secondary hover:shadow-xs"
          v-tip="t('titlebar.switch_color_scheme')"
          :aria-label="t('titlebar.switch_color_scheme')"
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
          class="flex h-7 w-7 items-center justify-center rounded-full text-ink-soft transition-all duration-300 ease-soft hover:bg-secondary hover:shadow-xs"
          v-tip="t('titlebar.island_history')"
          :aria-label="t('titlebar.island_history')"
          @click="toggleIslandHistoryWindow"
      >
        <!-- 历史时钟图标 -->
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 3v5h5" />
          <path d="M3.05 13a9 9 0 1 0 .5-5L3 8" />
          <path d="M12 7v5l4 2" />
        </svg>
      </button>

      <button
          class="flex h-7 w-7 items-center justify-center rounded-full text-ink-soft transition-all duration-300 ease-soft hover:bg-secondary hover:shadow-xs"
          v-tip="t('titlebar.minimize')"
          @click="minimize"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <path d="M5 12h14" />
        </svg>
      </button>

      <button
          class="flex h-7 w-7 items-center justify-center rounded-full transition-all duration-300 ease-soft hover:shadow-xs"
          :class="isMaximized ? 'text-gold bg-gold/15 hover:bg-gold/25' : 'text-ink-soft hover:bg-secondary'"
          v-tip="t(isMaximized ? 'titlebar.restore' : 'titlebar.maximize')"
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
          class="flex h-7 w-7 items-center justify-center rounded-full transition-all duration-300 ease-soft hover:shadow-xs"
          :class="alwaysOnTop ? 'text-gold bg-gold/15 hover:bg-gold/25' : 'text-ink-soft hover:bg-secondary'"
          v-tip="t(alwaysOnTop ? 'titlebar.unpin_window' : 'titlebar.pin_window')"
          @click="toggleAlwaysOnTop"
      >
        <svg class="h-3.5 w-3.5" :class="alwaysOnTop ? 'rotate-45' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 17v5" />
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </svg>
      </button>

      <button
          class="flex h-7 w-7 items-center justify-center rounded-full text-danger transition-all duration-300 ease-soft hover:bg-danger/10 hover:shadow-xs"
          v-tip="t('titlebar.close')"
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
