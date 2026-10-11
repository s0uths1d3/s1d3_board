<script setup lang="ts">
/**
 * 优先级选择器（PrioritySelect）
 *
 * 自定义数值等级系统：等级 = 数值(0-255，越大越优先) + 名称 + 颜色（useTodoPriorities）。
 * 面板 = 等级选择列表 + 管理器（TodoPriorityManager：增/改/删、色板选色），增改删即时持久化。
 * 基于 UiDropdown：面板 Teleport 到 body + fixed 定位、视口收进，交互由组件统一处理。
 */
import { ref, computed } from 'vue'
import { useI18n } from '~/composables/useI18n'
import UiDropdown from '~/components/ui/UiDropdown.vue'
import TodoPriorityManager from '~/components/todo/TodoPriorityManager.vue'
import {
  useTodoPriorities,
  type TodoPriorityLevel,
} from '~/composables/useTodoPriorities'
import { useDisplayNames } from '~/composables/useDisplayNames'

const { t } = useI18n();
const { priorityName } = useDisplayNames()

const props = withDefaults(defineProps<{
  modelValue: number
}>(), {})

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void
}>()

const { levels, getLevelInfo } = useTodoPriorities()

/** 是否处于等级管理模式（切换面板内容） */
const managing = ref(false)

const current = computed(() => getLevelInfo(props.modelValue))

function select(p: TodoPriorityLevel, close: () => void) {
  emit('update:modelValue', p.level)
  close()
}

/** 管理器确认后收尾：退出管理态；数值可能已被收敛（去重/清空回退默认），当前选中值失效时回填中档 */
function onManageCommitted(close: () => void) {
  managing.value = false
  if (!levels.value.some(p => p.level === props.modelValue)) {
    emit('update:modelValue', 127)
  }
  close()
}
</script>

<template>
  <UiDropdown
      align="center"
      :close-on-select="false"
      :aria-label="t('todo.priority')"
      :panel-class="managing ? 'glass-card w-64 rounded-2xl p-2 shadow-float' : 'glass-card w-44 rounded-2xl p-2 shadow-float'"
  >
    <template #trigger="{ open }">
      <label
          class="flex w-full cursor-pointer items-center justify-between gap-2 whitespace-nowrap rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm transition-colors duration-300 ease-soft focus:border-gold focus:outline-hidden"
          :class="open ? 'border-gold' : ''"
      >
        <span class="flex min-w-0 items-center gap-2">
          <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: current.color }" />
          <span class="truncate text-ink">{{ priorityName(current) }}</span>
        </span>
        <svg class="h-4 w-4 shrink-0 text-gold transition-transform duration-200" :class="open ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </label>
    </template>

    <template #default="{ close }">
      <!-- 选择列表 -->
      <div v-if="!managing">
        <ul class="max-h-64 space-y-0.5 overflow-y-auto">
          <li v-for="p in levels" :key="p.level">
            <button
                type="button"
                class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink transition-colors hover:bg-secondary"
                :class="p.level === modelValue ? 'bg-gold/20 font-semibold' : ''"
                @click="select(p, close)"
            >
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: p.color }" />
              <span class="flex-1 truncate text-left">{{ priorityName(p) }}</span>
              <span class="shrink-0 text-xs tabular-nums text-ink-faint">{{ p.level }}</span>
            </button>
          </li>
        </ul>
        <div class="mt-1 border-t border-accent/60 pt-1.5">
          <button
              type="button"
              data-dd-keep-open
              class="w-full rounded-lg px-2 py-1 text-left text-xs text-ink-soft transition-colors hover:bg-secondary hover:text-ink"
              @click="managing = true"
          >
            {{ t('todo.manage_levels') }}
          </button>
        </div>
      </div>

      <!-- 管理器：数值 / 名称 / 颜色 增改删（共用组件） -->
      <TodoPriorityManager v-else @commit="onManageCommitted(close)" />
    </template>
  </UiDropdown>
</template>
