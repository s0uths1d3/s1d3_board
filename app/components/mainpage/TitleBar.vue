<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "~/src/utils/env";
import { activeTab, setActiveTab, tabItems } from "~/composables/useTabs";
import { useAlwaysOnTop } from "~/composables/useAlwaysOnTop";

// 窗口控制仅在 Tauri 桌面容器内可用；纯 Web 预览无窗口，按钮不显示
async function minimize() {
  if (!isTauri()) return;
  await getCurrentWindow().minimize();
}

async function toggleMaximize() {
  if (!isTauri()) return;
  await getCurrentWindow().toggleMaximize();
}

async function close() {
  if (!isTauri()) return;
  await getCurrentWindow().close();
}

// 窗口控制：始终置顶（pin）—— 共享状态/逻辑，供标题栏按钮与 Ctrl+T 快捷键共用
const { alwaysOnTop, toggleAlwaysOnTop } = useAlwaysOnTop();
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
          v-for="tab in tabItems"
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
          title="最小化"
          @click="minimize"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <path d="M5 12h14" />
        </svg>
      </button>

      <button
          class="flex h-7 w-7 items-center justify-center rounded-full text-ink-soft transition-all duration-300 ease-soft hover:bg-secondary hover:shadow-sm"
          title="最大化"
          @click="toggleMaximize"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
      </button>

      <button
          class="flex h-7 w-7 items-center justify-center rounded-full transition-all duration-300 ease-soft hover:shadow-sm"
          :class="alwaysOnTop ? 'text-gold bg-gold/15 hover:bg-gold/25' : 'text-ink-soft hover:bg-secondary'"
          :title="alwaysOnTop ? '取消置顶（点击取消）' : '窗口始终置顶'"
          @click="toggleAlwaysOnTop"
      >
        <svg class="h-3.5 w-3.5" :class="alwaysOnTop ? 'rotate-45' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 17v5" />
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </svg>
      </button>

      <button
          class="flex h-7 w-7 items-center justify-center rounded-full text-[rgba(176,92,92,1)] transition-all duration-300 ease-soft hover:bg-[rgba(196,122,122,0.14)] hover:shadow-sm"
          title="关闭"
          @click="close"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  </div>
</template>
