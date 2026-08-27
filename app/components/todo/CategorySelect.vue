<script setup lang="ts">
/**
 * 分类选择器（CategorySelect）
 *
 * 支持选择已有分类 + 在下方输入新分类名直接新增（用户自定义 / 后续扩展）。
 * 下拉通过 Teleport + fixed 定位，避免被调用方容器裁切。
 */
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { useCategories } from '~/composables/useCategories'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
}>(), {
  placeholder: '选择分类'
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'category-delete', name: string, rect?: DOMRect): void
}>()

const { categories, addCategory, removeCategory } = useCategories()

const open = ref(false)
const rootEl = ref<HTMLDivElement | null>(null)
const panelEl = ref<HTMLUListElement | null>(null)
const panelStyle = ref<Record<string, string>>({})
const newName = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

const PANEL_WIDTH = 160
const MARGIN = 8

function positionPanel() {
  if (!rootEl.value) return
  const rect = rootEl.value.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = rect.left
  if (left + PANEL_WIDTH > vw - MARGIN) left = Math.max(MARGIN, vw - PANEL_WIDTH - MARGIN)

  const panelRect = panelEl.value?.getBoundingClientRect()
  const panelHeight = panelRect?.height ?? 220

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

const select = (c: string) => {
  emit('update:modelValue', c)
  open.value = false
}

/** 删除分类：交由父组件弹确认窗口并持久化（附带触发位置，用于确认窗口就近定位） */
const onDelete = (c: string, e?: MouseEvent) => {
  const btn = (e?.target as HTMLElement | undefined)?.closest?.('button') as HTMLElement | null
  emit('category-delete', c, btn?.getBoundingClientRect())
}

/** 新增分类并选中 */
const submitNew = async () => {
  const name = newName.value.trim()
  if (!name) return
  const ok = await addCategory(name)
  if (ok) {
    emit('update:modelValue', name)
    open.value = false
  }
  newName.value = ''
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
      inputEl.value?.focus()
    })
    window.addEventListener('resize', positionPanel)
    document.addEventListener('scroll', positionPanel, true)
    document.addEventListener('click', onDocClick)
  } else {
    newName.value = ''
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
  <div ref="rootEl" class="relative w-40">
    <label
      tabindex="0"
      class="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm transition-colors duration-300 ease-soft focus:border-gold focus:outline-none"
      :class="open ? 'border-gold' : ''"
      @click="open = !open"
      @keydown.enter.prevent="open = !open"
      @keydown.space.prevent="open = !open"
      @keydown.escape="open = false"
    >
      <span class="truncate" :class="modelValue ? 'text-ink' : 'text-ink-faint'">{{ modelValue || placeholder }}</span>
      <svg class="h-4 w-4 shrink-0 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
      </svg>
    </label>

    <Teleport to="body">
      <Transition name="check-pop">
        <ul
          v-if="open"
          ref="panelEl"
          class="glass-card fixed z-[9999] rounded-xl p-1 shadow-float"
          :style="panelStyle"
        >
          <li v-for="c in categories" :key="c">
            <div
              class="flex w-full items-center rounded-md text-sm text-ink transition-colors hover:bg-secondary"
              :class="c === modelValue ? 'bg-gold/20 font-semibold' : ''"
            >
              <button
                type="button"
                class="flex-1 px-2 py-1.5 text-left"
                @click="select(c)"
              >
                {{ c }}
              </button>
              <button
                type="button"
                title="删除分类"
                class="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[rgba(176,92,92,1)] transition-colors hover:bg-[rgba(196,122,122,0.12)]"
                @click.stop="onDelete(c, $event)"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </li>
          <li class="mt-1 border-t border-accent/60 pt-1">
            <input
              ref="inputEl"
              v-model="newName"
              type="text"
              placeholder="新增分类…"
              maxlength="10"
              class="w-full rounded-md border border-accent bg-surface-field px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
              @keydown.enter.prevent="submitNew"
            />
          </li>
        </ul>
      </Transition>
    </Teleport>
  </div>
</template>
