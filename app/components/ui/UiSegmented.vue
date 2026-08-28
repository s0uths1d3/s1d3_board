<script setup lang="ts">
import { computed } from 'vue';

/**
 * 标准分段选择（ui 组件库）
 *
 * 一组互斥选项的胶囊分段控件：选中项金色高亮，支持逐项悬停提示。
 * 替代各处手写的分段按钮组——新代码禁止再手写同类结构。
 */
export interface UiSegmentedOption<T = string> {
  value: T;
  label: string;
  /** 悬停提示（可选） */
  tip?: string;
}

const props = withDefaults(defineProps<{
  /** 选项组 */
  options: UiSegmentedOption[];
  /** 当前选中值（v-model） */
  modelValue: string;
  /** 是否撑满整行（各选项 flex-1 均分）；false 时按内容自适应 */
  block?: boolean;
  /** 尺寸：md = 表单行默认，sm = 紧凑工具条 */
  size?: 'md' | 'sm';
  /** 禁用整组 */
  disabled?: boolean;
  /** 无障碍标签 */
  label?: string;
}>(), {
  block: false,
  size: 'md',
  disabled: false,
  label: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'change', v: string): void;
}>();

const wrapClass = computed(() => [
  'flex items-center rounded-xl border border-accent bg-surface-field',
  props.size === 'sm' ? 'p-0.5' : 'p-1',
  props.block ? 'w-full' : 'w-fit',
  props.disabled ? 'opacity-60 pointer-events-none' : '',
]);

const btnClass = computed(() => [
  'rounded-lg tabular-nums transition-all duration-200 ease-soft',
  props.size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-2.5 py-1.5 text-xs',
  props.block ? 'flex-1' : '',
]);

function select(v: string) {
  if (props.disabled || v === props.modelValue) return;
  emit('update:modelValue', v);
  emit('change', v);
}
</script>

<template>
  <div :class="wrapClass" role="radiogroup" :aria-label="label || undefined">
    <button
        v-for="opt in options"
        :key="opt.value"
        type="button"
        role="radio"
        :aria-checked="modelValue === opt.value"
        v-tip="opt.tip || undefined"
        class="rounded-lg tabular-nums transition-all duration-200 ease-soft"
        :class="[btnClass, modelValue === opt.value
            ? 'bg-gold text-on-gold shadow-sm'
            : 'text-ink-soft hover:bg-secondary']"
        @click="select(opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>
