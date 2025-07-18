<!-- Tooltip.vue -->
<script setup lang="ts">

interface TooltipProps {
  visible: boolean;
  text: string;
  x: number;
  y: number;
}

const props = defineProps<TooltipProps>();
</script>

<template>
  <div
      v-if="props.visible"
      class="fixed max-w-[500px] bg-black shadow-lg p-3 rounded-lg text-sm leading-relaxed z-50 whitespace-pre-wrap tabular-nums"
      :style="{ top: props.y + 'px', left: props.x + 'px' }"
  >
    {{ props.text }}
  </div>
</template>
