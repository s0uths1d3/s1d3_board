<script setup lang="ts">
import { computed } from 'vue';

/**
 * 标准胶囊开关（ui 组件库）
 *
 * 统一外观（金色开启态滑块）、无障碍（role/aria-checked/disabled）与提示文案。
 * 替代各处手写的 role="switch" 胶囊按钮——新代码禁止再手写开关结构。
 */
const props = withDefaults(defineProps<{
  /** 开关状态（v-model） */
  modelValue: boolean;
  /** 尺寸：md = h-6 w-11（表单行），sm = h-5 w-9（紧凑行内） */
  size?: 'md' | 'sm';
  /** 禁用：不可切换、轨道恒为 accent 色 */
  disabled?: boolean;
  /** 提示文案：开启时 / 关闭时 / 禁用时（禁用优先） */
  tipOn?: string;
  tipOff?: string;
  disabledTip?: string;
  /** 无障碍标签（读屏用） */
  label?: string;
}>(), {
  size: 'md',
  disabled: false,
  tipOn: '',
  tipOff: '',
  disabledTip: '',
  label: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'change', v: boolean): void;
}>();

const track = computed(() => [
  props.size === 'sm' ? 'h-5 w-9' : 'h-6 w-11',
  'relative inline-flex shrink-0 items-center rounded-full transition-colors duration-300 ease-soft',
  props.disabled ? 'cursor-not-allowed opacity-60 bg-accent' : props.modelValue ? 'bg-gold' : 'bg-accent',
]);
const knob = computed(() => [
  props.size === 'sm' ? 'h-4 w-4' : 'h-5 w-5',
  'inline-block transform rounded-full bg-white shadow-soft transition-transform duration-300 ease-soft',
  props.modelValue && !props.disabled
    ? (props.size === 'sm' ? 'translate-x-[1.125rem]' : 'translate-x-5')
    : 'translate-x-0.5',
]);
const tip = computed(() => {
  if (props.disabled) return props.disabledTip || props.label || undefined;
  return (props.modelValue ? props.tipOn : props.tipOff) || props.label || undefined;
});

function onClick() {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
  emit('change', !props.modelValue);
}
</script>

<template>
  <button
      type="button"
      role="switch"
      :aria-checked="modelValue"
      :aria-label="label || undefined"
      :disabled="disabled"
      v-tip="tip"
      :class="track"
      @click="onClick"
  >
    <span :class="knob" />
  </button>
</template>
