<script setup lang="ts">
/**
 * 优先级选择器（PrioritySelect）
 *
 * 自定义数值等级系统：等级 = 数值(0-255，越大越优先) + 名称 + 颜色（useTodoPriorities）。
 * 面板 = 等级选择列表 + 内置管理器（增/改/删、色板选色），增改删即时持久化。
 * 基于 UiDropdown：面板 Teleport 到 body + fixed 定位、视口收进，交互由组件统一处理。
 */
import { ref, computed } from 'vue'
import UiDropdown from '~/components/ui/UiDropdown.vue'
import UiColorPicker from '~/components/ui/UiColorPicker.vue'
import {
  useTodoPriorities,
  PRIORITY_COLOR_PALETTE,
  clampLevel,
  type TodoPriorityLevel,
} from '~/composables/useTodoPriorities'

const props = withDefaults(defineProps<{
  modelValue: number
}>(), {})

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void
}>()

const { levels, getLevelInfo, replaceLevels } = useTodoPriorities()

const managing = ref(false)
/** 管理器的本地草稿（进入管理模式时克隆，点「完成」整表提交） */
const editList = ref<TodoPriorityLevel[]>([])
/** 每行颜色色板的展开状态（以行索引为键） */
const colorRow = ref<number | null>(null)

const current = computed(() => getLevelInfo(props.modelValue))

function select(p: TodoPriorityLevel, close: () => void) {
  emit('update:modelValue', p.level)
  close()
}

/** 进入管理：克隆当前等级为草稿 */
function openManager() {
  editList.value = levels.value.map(p => ({ ...p }))
  colorRow.value = null
  managing.value = true
}

/** 新增一行：取未被占用的最小「10 的倍数」数值，默认中性灰 */
function addRow() {
  const used = new Set(editList.value.map(p => p.level))
  let level = 0
  while (used.has(level) && level <= 255) level += 10
  editList.value.push({ level: Math.min(level, 255), name: '', color: '#8a8a8a' })
}

function removeRow(idx: number) {
  editList.value.splice(idx, 1)
}

/** 完成：整表提交（自动去重/收敛/补默认名），回到选择列表 */
async function commitManage(close: () => void) {
  await replaceLevels(editList.value)
  managing.value = false
  // 数值可能已被收敛（去重/清空回退默认），当前选中值失效时回填中档
  if (!levels.value.some(p => p.level === props.modelValue)) {
    emit('update:modelValue', 127)
  }
  close()
}

const rowLevelInput = (e: Event, idx: number) => {
  const v = Number((e.target as HTMLInputElement).value)
  editList.value[idx]!.level = clampLevel(Number.isFinite(v) ? v : 127)
}
</script>

<template>
  <UiDropdown
      align="center"
      :close-on-select="false"
      aria-label="优先级"
      panel-class="glass-card w-64 rounded-2xl p-2 shadow-float"
  >
    <template #trigger="{ open }">
      <label
          class="flex w-full cursor-pointer items-center justify-between gap-2 whitespace-nowrap rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm transition-colors duration-300 ease-soft focus:border-gold focus:outline-none"
          :class="open ? 'border-gold' : ''"
      >
        <span class="flex min-w-0 items-center gap-2">
          <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: current.color }" />
          <span class="truncate text-ink">{{ current.name }}</span>
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
              <span class="flex-1 truncate text-left">{{ p.name }}</span>
              <span class="shrink-0 text-xs tabular-nums text-ink-faint">{{ p.level }}</span>
            </button>
          </li>
        </ul>
        <div class="mt-1 border-t border-accent/60 pt-1.5">
          <button
              type="button"
              data-dd-keep-open
              class="w-full rounded-lg px-2 py-1 text-left text-xs text-ink-soft transition-colors hover:bg-secondary hover:text-ink"
              @click="openManager"
          >
            管理等级…
          </button>
        </div>
      </div>

      <!-- 管理器：数值 / 名称 / 颜色 增改删 -->
      <div v-else class="space-y-1.5">
        <div class="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
          <div v-for="(row, idx) in editList" :key="idx" class="rounded-lg border border-accent/50 p-1.5">
            <div class="flex items-center gap-1.5">
              <input
                  type="number" min="0" max="255"
                  :value="row.level"
                  class="w-14 shrink-0 rounded-md border border-accent bg-surface-field px-1.5 py-1 text-xs tabular-nums text-ink focus:border-gold focus:outline-none"
                  @change="rowLevelInput($event, idx)"
              />
              <input
                  type="text" maxlength="8" :placeholder="`等级${row.level}`"
                  v-model="row.name"
                  class="min-w-0 flex-1 rounded-md border border-accent bg-surface-field px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
              />
              <button
                  type="button"
                  v-tip="'修改颜色'"
                  class="h-6 w-6 shrink-0 rounded-full border border-white/60 shadow-sm transition-transform hover:scale-110"
                  :style="{ backgroundColor: row.color }"
                  @click="colorRow = colorRow === idx ? null : idx"
              />
              <button
                  type="button"
                  v-tip="'删除该等级'"
                  class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger/10"
                  @click="removeRow(idx)"
              >
                <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <!-- 颜色选取器：预设色板 + 自定义取色 -->
            <div v-if="colorRow === idx" class="mt-1.5" data-dd-keep-open>
              <UiColorPicker v-model="row.color" :presets="PRIORITY_COLOR_PALETTE" />
            </div>
          </div>
          <p v-if="editList.length === 0" class="px-1 py-2 text-center text-xs text-ink-faint">
            暂无等级，点击下方新增
          </p>
        </div>

        <div class="flex items-center justify-between border-t border-accent/60 pt-1.5">
          <button
              type="button"
              class="rounded-lg px-2 py-1 text-xs text-ink-soft transition-colors hover:bg-secondary hover:text-ink"
              @click="addRow"
          >
            + 新增等级
          </button>
          <button
              type="button"
              class="btn-gold px-3 py-1 text-xs"
              @click="commitManage(close)"
          >
            完成
          </button>
        </div>
        <p class="px-1 text-[10px] leading-relaxed text-ink-faint">
          数值 0-255，越大越优先；删除等级后，使用它的待办会自动移到最近的档位。
        </p>
      </div>
    </template>
  </UiDropdown>
</template>
