<script setup lang="ts">
/**
 * 优先级等级管理器（供新建表单 PrioritySelect 与任务卡片下拉共用）
 *
 * 挂载即克隆当前等级为本地草稿（数值/名称/颜色 增改删，行内选色板）；
 * 「确认」整表提交（replaceLevels：自动去重/收敛/补默认名）并 emit('commit')
 * 交由宿主收尾（关闭面板 / 当前选中值失效回退）；未确认卸载即放弃草稿。
 */
import { ref, onMounted } from 'vue'
import { useI18n } from '~/composables/useI18n'
import UiColorPicker from '~/components/ui/UiColorPicker.vue'
import {
  useTodoPriorities,
  PRIORITY_COLOR_PALETTE,
  clampLevel,
  type TodoPriorityLevel,
} from '~/composables/useTodoPriorities'

const { t } = useI18n()
const { levels, replaceLevels } = useTodoPriorities()

const emit = defineEmits<{
  (e: 'commit'): void
}>()

/** 管理器的本地草稿（挂载时克隆，点「确认」整表提交） */
const editList = ref<TodoPriorityLevel[]>([])
/** 每行颜色色板的展开状态（以行索引为键） */
const colorRow = ref<number | null>(null)

onMounted(() => {
  editList.value = levels.value.map(p => ({ ...p }))
})

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

/** 确认：整表提交（自动去重/收敛/补默认名），宿主负责关闭面板与失效回退 */
async function commit() {
  await replaceLevels(editList.value)
  emit('commit')
}

const rowLevelInput = (e: Event, idx: number) => {
  const v = Number((e.target as HTMLInputElement).value)
  editList.value[idx]!.level = clampLevel(Number.isFinite(v) ? v : 127)
}
</script>

<template>
  <div class="space-y-1.5">
    <div class="max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
      <div v-for="(row, idx) in editList" :key="idx" class="rounded-lg border border-accent/50 p-1.5">
        <div class="flex items-center gap-1.5">
          <input
              type="number" min="0" max="255"
              :value="row.level"
              class="w-14 shrink-0 rounded-md border border-accent bg-surface-field px-1.5 py-1 text-xs tabular-nums text-ink focus:border-gold focus:outline-hidden"
              @change="rowLevelInput($event, idx)"
          />
          <input
              type="text" maxlength="8" :placeholder="t('todo.level_name', { n: row.level })"
              v-model="row.name"
              class="min-w-0 flex-1 rounded-md border border-accent bg-surface-field px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
          />
          <button
              type="button"
              v-tip="t('common.change_color_short')"
              class="h-6 w-6 shrink-0 rounded-full border border-white/60 shadow-xs transition-transform hover:scale-110"
              :style="{ backgroundColor: row.color }"
              @click="colorRow = colorRow === idx ? null : idx"
          />
          <button
              type="button"
              v-tip="t('common.delete_level')"
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
        {{ t('todo.no_levels') }}
      </p>
    </div>

    <div class="flex items-center justify-between border-t border-accent/60 pt-1.5">
      <button
          type="button"
          class="btn-soft flex items-center gap-1 px-3 py-1 text-xs"
          @click="addRow"
      >
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        {{ t('todo.add_level') }}
      </button>
      <button
          type="button"
          class="btn-gold px-3 py-1 text-xs"
          @click="commit"
      >
        {{ t('common.confirm') }}
      </button>
    </div>
    <p class="px-1 text-[10px] leading-relaxed text-ink-faint">
      {{ t('todo.level_hint') }}
    </p>
  </div>
</template>
