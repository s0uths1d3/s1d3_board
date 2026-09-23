<script setup lang="ts">
/**
 * 数字滚动组件（AnimatedNumber）
 *
 * 指标卡数值从旧值补间到新值的 count-up 展示（useCountUp 驱动），
 * 千分位格式化，tabular-nums 防宽度抖动。纯展示组件。
 */
import { useCountUp } from '~/composables/useCountUp';

const props = withDefaults(defineProps<{
  /** 目标数值（变化时从当前显示值滚动到新值） */
  value: number;
  /** 动画时长 ms */
  duration?: number;
}>(), {
  duration: 600,
});

const display = useCountUp(() => props.value, props.duration);
</script>

<template>
  <span class="tabular-nums">{{ Math.round(display).toLocaleString('zh-CN') }}</span>
</template>
