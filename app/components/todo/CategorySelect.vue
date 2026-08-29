<script setup lang="ts">
/**
 * 分类选择器（CategorySelect）
 *
 * 基于 UiDropdown：面板 Teleport 到 body + fixed 定位，避免被调用方容器裁切；
 * 空间不足自动上翻、越界收进视口。
 * 面板含删除按钮与新增输入框（交互中不应收起），故 close-on-select=false，
 * 选择/新增成功后通过受控 open 收起。
 */
import { ref, watch, nextTick } from 'vue'
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

const { categories, addCategory } = useCategories()

const open = ref(false)
const newName = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

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

// 展开时聚焦新增输入框；收起时清空未提交内容
watch(open, (v) => {
  if (v) {
    nextTick(() => inputEl.value?.focus())
  } else {
    newName.value = ''
  }
})
</script>

<template>
  <UiDropdown
      v-model:open="open"
      class="w-40"
      align="start"
      :close-on-select="false"
      aria-label="分类"
      panel-class="glass-card w-40 rounded-xl p-1 shadow-float"
  >
    <template #trigger="{ open: isOpen }">
      <label
          class="flex w-full cursor-pointer items-center justify-between gap-2 rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm transition-colors duration-300 ease-soft focus:border-gold focus:outline-none"
          :class="isOpen ? 'border-gold' : ''"
      >
        <span class="truncate" :class="modelValue ? 'text-ink' : 'text-ink-faint'">{{ modelValue || placeholder }}</span>
        <svg class="h-4 w-4 shrink-0 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
        </svg>
      </label>
    </template>
    <ul class="p-1">
      <li v-for="c in categories" :key="c">
        <div
            class="flex w-full items-center rounded-md text-sm text-ink transition-colors hover:bg-secondary"
            :class="c === modelValue ? 'bg-gold/20 font-semibold' : ''"
        >
          <button
              type="button"
              class="flex-1 whitespace-nowrap px-2 py-1.5 text-left"
              @click="select(c)"
          >
            {{ c }}
          </button>
          <button
              type="button"
              v-tip="'删除分类'"
              class="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger/10"
              @click.stop="onDelete(c, $event)"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </li>
      <li class="mt-1 border-t border-accent/60 pt-1" data-dd-keep-open>
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
  </UiDropdown>
</template>
