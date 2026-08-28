<script setup lang="ts">
/**
 * 优先级选择器（PrioritySelect）
 *
 * 基于 UiDropdown teleport 模式：面板 fixed 定位到 body，
 * 避免被调用方容器（典型场景：TodoList 新建表单的 overflow-hidden 折叠动画）裁切；
 * 空间不足自动上翻、越界收进视口，交互（开/关/外部点击/Escape/选择即收）由组件统一处理。
 */
import type { Todo } from '~/src/Entities'

withDefaults(defineProps<{
  modelValue: Todo['priority']
  placeholder?: string
}>(), {
  placeholder: '优先级'
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: Todo['priority']): void
}>()

const labels: Record<Todo['priority'], string> = { high: '高', medium: '中', low: '低' }

const select = (p: Todo['priority']) => {
  emit('update:modelValue', p)
}
</script>

<template>
  <UiDropdown
      teleport
      align="start"
      direction="auto"
      aria-label="优先级"
      panel-class="glass-card menu w-32 rounded-2xl p-2"
  >
    <template #trigger="{ open }">
      <label
          class="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm transition-colors duration-300 ease-soft focus:border-gold focus:outline-none"
          :class="open ? 'border-gold' : ''"
      >
        <span class="text-ink">{{ labels[modelValue] }}</span>
        <svg class="h-4 w-4 shrink-0 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </label>
    </template>
    <ul class="menu p-2">
      <li v-for="(label, priority) in labels" :key="priority">
        <a
            class="flex items-center gap-2 rounded-lg hover:bg-secondary"
            :class="modelValue === priority ? 'bg-gold/20 font-semibold' : ''"
            @click="select(priority)"
        >
          <span class="h-2 w-2 rounded-full" :class="{
            'bg-danger': priority === 'high',
            'bg-gold': priority === 'medium',
            'bg-success': priority === 'low'
          }"></span>
          {{ label }}
        </a>
      </li>
    </ul>
  </UiDropdown>
</template>
