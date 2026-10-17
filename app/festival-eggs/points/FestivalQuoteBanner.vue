<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '~/composables/useI18n';
import { useFestivalQuoteBanner } from '../points';

/**
 * 统计页引言横幅（通用挂载点）：哪个节日展示什么台词由 points.ts 的 QUOTE_BANNERS
 * 登记，StatsPage 不含任何节日知识。无节日/总开关关闭时输出空。
 */
const { t } = useI18n();
const banner = useFestivalQuoteBanner();
const quote = computed(() => (banner.value ? t(banner.value.quoteKey) : ''));
</script>

<template>
  <div v-if="banner" class="flex items-center justify-center gap-2 pt-1 text-xs tracking-wide text-ink-faint">
    <svg class="h-3 w-3 text-gold" viewBox="0 0 14 14" fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M7 1l1.5 4.5L13 7l-4.5 1.5L7 13l-1.5-4.5L1 7l4.5-1.5z" />
    </svg>
    <span>{{ quote }}</span>
    <svg class="h-3 w-3 text-gold" viewBox="0 0 14 14" fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M7 3l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" />
    </svg>
  </div>
</template>
