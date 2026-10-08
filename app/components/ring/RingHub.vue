<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from '~/composables/useI18n';

/**
 * 环心控制盘（RingOverlay 的中心卡片）：原文预览 + AI 解析中状态条 + 导航行 +
 * 页码点行（仅多页显示）。高度自适应纯 CSS（预览区 max-h 封顶 + 溢出滚动），
 * 无 JS 测量；键盘由 RingOverlay 统一处理，本组件只发按钮意图（nav/pageNav/close）。
 */
const props = defineProps<{
  /** 原文内容（本次拆分的完整 clip） */
  source: string;
  /** 当前选中片段序号（0 起） */
  selected: number;
  total: number;
  page: number;
  /** 总页数（仅 >1 时显示页码点行） */
  pages: number;
  /** AI 解析进行中：状态条随结果/失败到达消失 */
  aiPending: boolean;
}>();

const emit = defineEmits<{
  nav: [delta: number];
  pageNav: [delta: number];
  close: [];
}>();

const { t } = useI18n();

const entered = ref(false);
onMounted(() => {
  requestAnimationFrame(() => requestAnimationFrame(() => { entered.value = true; }));
});
</script>

<template>
  <div
      class="hub-card flex w-60 flex-col gap-1.5 rounded-2xl border border-accent bg-surface/95 px-3 py-2.5 shadow-float backdrop-blur-md"
      :class="entered ? 'ring-hub-in' : 'ring-hub-pre'">

    <div class="hub-source relative min-h-0 overflow-y-auto rounded-lg bg-secondary/60 px-2 py-1"
         :class="aiPending ? 'max-h-[64px]' : 'max-h-[84px]'">
      <span class="whitespace-pre-wrap break-all text-[10px] leading-relaxed text-ink-soft">{{ source || t('bubble.empty_title') }}</span>
      <button
          type="button"
          class="absolute right-0.5 top-0.5 z-10 rounded-md bg-secondary/80 p-0.5 text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger"
          :title="t('bubble.close')"
          @click="emit('close')">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div v-if="aiPending" class="flex shrink-0 items-center gap-1.5 px-0.5">
      <span class="relative flex h-1.5 w-1.5">
        <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold opacity-60" />
        <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-gold" />
      </span>
      <span class="text-[10px] leading-none text-gold">{{ t('bubble.parsing') }}</span>
    </div>

    <div class="flex shrink-0 items-center justify-center gap-3 pt-0.5">
      <button
          type="button"
          class="flex h-6 w-6 items-center justify-center rounded-full border border-line text-ink-soft transition-all duration-200 ease-soft hover:border-gold hover:text-gold hover:shadow-xs disabled:pointer-events-none disabled:opacity-30"
          :title="t('bubble.prev')"
          :disabled="total === 0"
          @click="emit('nav', -1)">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <span class="min-w-[3.5rem] text-center text-[11px] font-medium tabular-nums text-ink-soft">{{ selected + 1 }} / {{ total }}</span>
      <button
          type="button"
          class="flex h-6 w-6 items-center justify-center rounded-full border border-line text-ink-soft transition-all duration-200 ease-soft hover:border-gold hover:text-gold hover:shadow-xs disabled:pointer-events-none disabled:opacity-30"
          :title="t('bubble.next')"
          :disabled="total === 0"
          @click="emit('nav', 1)">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>

    <div v-if="pages > 1" class="flex shrink-0 items-center justify-center gap-1.5">
      <button
          v-for="p in pages"
          :key="p"
          type="button"
          class="h-1.5 rounded-full transition-all duration-200 ease-soft"
          :class="p - 1 === page ? 'w-3.5 bg-gold' : 'w-1.5 bg-ink-faint/35 hover:bg-ink-faint/60'"
          :title="t('bubble.page_n', { n: p })"
          @click="emit('pageNav', p - 1 - page)" />
    </div>
  </div>
</template>

<style scoped>
.ring-hub-pre { opacity: 0; }
.ring-hub-in {
  animation: ring-hub-in 0.32s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes ring-hub-in {
  from { opacity: 0; transform: scale(0.94) translateY(4px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

/* 细滚动条：WebView2 默认滚动条过宽，挤占 240px 环心宽度 */
.hub-source {
  scrollbar-width: thin;
  scrollbar-color: rgba(128, 128, 128, 0.45) transparent;
}
.hub-source::-webkit-scrollbar { width: 4px; }
.hub-source::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.45); border-radius: 2px; }
.hub-source::-webkit-scrollbar-track { background: transparent; }
</style>
