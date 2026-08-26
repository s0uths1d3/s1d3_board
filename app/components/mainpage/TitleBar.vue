<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "~/src/utils/env";
import { activeTab, setActiveTab, getVisibleTabItems } from "~/composables/useTabs";
import { computed, ref, onMounted, onBeforeUnmount } from "vue";

/** 标题栏导航项：仅渲染当前可见的 tab（统计 Tab 受解锁门槛控制，§7.9，解锁后动态出现） */
const visibleTabs = computed(() => getVisibleTabItems());
import { useAlwaysOnTop } from "~/composables/useAlwaysOnTop";

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
    <!-- 左侧：标题（可拖拽） -->
    <div class="gold-bar flex items-center gap-2 select-none">
      <h1 class="text-sm font-semibold text-ink">S1d3 Board</h1>
    </div>

    <!-- 中部：顶层导航（窗口之上） -->
    <nav class="no-drag flex items-center gap-1">
      <button
          v-for="tab in visibleTabs"
          :key="tab.key"
          class="gold-underline rounded-lg px-3 py-1 text-xs font-medium transition-colors duration-300 ease-soft"
          :class="activeTab === tab.key ? 'is-active text-gold' : 'text-ink-soft hover:text-ink'"
          @click="setActiveTab(tab.key)"
      >
        {{ tab.name }}
      </button>
    </nav>

    <!-- 右侧：窗口控制按钮（不触发拖拽） -->
    <div v-if="isTauri()" class="no-drag flex items-center gap-2">
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
          class="flex h-7 w-7 items-center justify-center rounded-full text-[rgba(176,92,92,1)] transition-all duration-300 ease-soft hover:bg-[rgba(196,122,122,0.14)] hover:shadow-sm"
          v-tip="'关闭'"
          @click="close"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  </div>
</template>
