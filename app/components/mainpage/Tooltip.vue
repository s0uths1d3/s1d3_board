<script setup lang="ts">
import { computed } from 'vue';

interface TooltipProps {
  visible: boolean;
  text: string;
  x: number;
  y: number;
}

const props = defineProps<TooltipProps>();

/** 按行分割文本，供行号与内容逐行渲染 */
const lines = computed(() => props.text.split('\n'));

/** 悬停 tooltip 本身时保持显示；鼠标移到内部滚动区域时不清空 */
function onSelfEnter() {
  // 通过自定义事件通知父级：tooltip 区域被悬停，保持 visible
  window.dispatchEvent(new CustomEvent('tooltip-hover-enter'));
}
function onSelfLeave() {
  window.dispatchEvent(new CustomEvent('tooltip-hover-leave'));
}
</script>

<template>
  <div
      v-if="props.visible"
      class="glass-card fixed z-50 max-w-[66%] rounded-xl p-3 text-sm leading-relaxed tabular-nums text-ink shadow-float"
      :style="{ top: props.y + 'px', left: props.x + 'px' }"
      @mouseenter="onSelfEnter"
      @mouseleave="onSelfLeave"
  >
    <div class="tooltip-scroll max-h-[60vh] overflow-y-auto">
      <!-- 左侧行号 + 右侧内容逐行渲染，滚动时保持对齐 -->
      <div v-for="(line, i) in lines" :key="i" class="flex gap-3">
        <span class="line-num shrink-0 select-none text-right text-ink-faint">{{ i + 1 }}</span>
        <span class="line-content min-w-0 whitespace-pre-wrap break-words">{{ line || ' ' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.line-num {
  min-width: 2em;
}
.tooltip-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(196, 167, 125, 0.6) transparent;
}
.tooltip-scroll::-webkit-scrollbar {
  width: 6px;
}
.tooltip-scroll::-webkit-scrollbar-thumb {
  background: rgba(196, 167, 125, 0.6);
  border-radius: 9999px;
}
</style>
