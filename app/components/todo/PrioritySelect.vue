<script setup lang="ts">
/**
 * 优先级选择器（PrioritySelect）
 *
 * 下拉通过 <Teleport to="body"> + fixed 定位，避免被调用方容器
 * （典型场景：TodoList 新建表单的 overflow-hidden 折叠动画）裁切。
 */
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
import type { Todo } from '~/src/Entities'

const props = withDefaults(defineProps<{
  modelValue: Todo['priority']
  placeholder?: string
}>(), {
  placeholder: '优先级'
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: Todo['priority']): void
}>()

const labels: Record<Todo['priority'], string> = { high: '高', medium: '中', low: '低' }

const open = ref(false)
const rootEl = ref<HTMLDivElement | null>(null)
const panelEl = ref<HTMLUListElement | null>(null)
const panelStyle = ref<Record<string, string>>({})

const PANEL_WIDTH = 128
const MARGIN = 8

function positionPanel() {
  if (!rootEl.value) return
  const rect = rootEl.value.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = rect.left
  if (left + PANEL_WIDTH > vw - MARGIN) left = Math.max(MARGIN, vw - PANEL_WIDTH - MARGIN)

  const panelRect = panelEl.value?.getBoundingClientRect()
  const panelHeight = panelRect?.height ?? 160

  const spaceBelow = vh - rect.bottom - MARGIN
  const spaceAbove = rect.top - MARGIN

  let top: number
  let up = false
  if (spaceBelow >= panelHeight || spaceBelow >= spaceAbove) {
    top = rect.bottom + 4
  } else {
    top = rect.top - panelHeight - 4
    up = true
  }

  panelStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${PANEL_WIDTH}px`,
    '--pop-origin': up ? 'bottom' : 'top',
    '--pop-shift': up ? '-6px' : '6px',
  }
}

const select = (p: Todo['priority']) => {
  emit('update:modelValue', p)
  open.value = false
}

const onDocClick = (e: MouseEvent) => {
  const t = e.target as Node
  if (rootEl.value?.contains(t) || panelEl.value?.contains(t)) return
  open.value = false
}

watch(open, (v) => {
  if (v) {
    nextTick(() => {
      positionPanel()
      panelEl.value?.querySelector<HTMLElement>('a')?.focus()
    })
    window.addEventListener('resize', positionPanel)
    document.addEventListener('scroll', positionPanel, true)
    document.addEventListener('click', onDocClick)
  } else {
    window.removeEventListener('resize', positionPanel)
    document.removeEventListener('scroll', positionPanel, true)
    document.removeEventListener('click', onDocClick)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', positionPanel)
  document.removeEventListener('scroll', positionPanel, true)
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div ref="rootEl" class="relative">
    <label
      tabindex="0"
      class="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm transition-colors duration-300 ease-soft focus:border-gold focus:outline-none"
      :class="open ? 'border-gold' : ''"
      @click="open = !open"
      @keydown.enter.prevent="open = !open"
      @keydown.space.prevent="open = !open"
      @keydown.escape="open = false"
    >
      <span class="text-ink">{{ labels[modelValue] }}</span>
      <svg class="h-4 w-4 shrink-0 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </label>

    <Teleport to="body">
      <Transition name="check-pop">
        <ul
          v-if="open"
          ref="panelEl"
          tabindex="0"
          class="glass-card fixed z-[9999] menu w-32 rounded-2xl p-2"
          :style="panelStyle"
        >
          <li v-for="(label, priority) in labels" :key="priority">
            <a
              class="flex items-center gap-2 rounded-lg hover:bg-secondary"
              :class="modelValue === priority ? 'bg-gold/20 font-semibold' : ''"
              @click="select(priority)"
            >
              <span class="h-2 w-2 rounded-full" :class="{
                'bg-[rgba(176,92,92,1)]': priority === 'high',
                'bg-gold': priority === 'medium',
                'bg-[#6f8a55]': priority === 'low'
              }"></span>
              {{ label }}
            </a>
          </li>
        </ul>
      </Transition>
    </Teleport>
  </div>
</template>
