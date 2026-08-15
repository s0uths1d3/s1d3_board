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
      class="glass-card fixed z-50 max-w-[66%] whitespace-pre-wrap rounded-xl p-3 text-sm leading-relaxed tabular-nums text-ink"
      :style="{ top: props.y + 'px', left: props.x + 'px' }"
  >
    {{ props.text }}
  </div>
</template>
