<script setup lang="ts">
/**
 * 待办日历视图（待办 §6）：月网格 + 任务按截止日期分桶。
 * - 逾期未完成任务并入「今天」格显示（红色标识），与「今天」聚合视图同口径；
 * - 拖拽任务片到目标日期格改期（保留原时刻，仅改日期）→ emit change-due 由父级走既有更新链路；
 * - 任务片直接可交互：左侧完成圆点点击切换完成（emit toggle），点任务片定位到下方明细行；
 * - 上月/下月/今天导航，点击日期格在下方明细区查看当日任务。
 */
import { ref, computed, nextTick } from 'vue'
import type { Todo } from '~/src/entities'
import { useI18n } from '~/composables/useI18n'
import { useTodoPriorities } from '~/composables/useTodoPriorities'
import { describeRecurrence } from '~/src/todo/recurrence'
import { beginElementDrag, endElementDrag } from '~/src/core/dragState'

const props = defineProps<{ todos: Todo[] }>()

const emit = defineEmits<{
  (e: 'change-due', id: string, dueDate: string): void
  (e: 'toggle', id: string): void
}>()

const { t } = useI18n()
/** 优先级等级颜色：任务片/明细行的色点（随用户自定义档位） */
const { getLevelInfo } = useTodoPriorities()

const pad2 = (n: number) => String(n).padStart(2, '0')
/** 本地日期键 'YYYY-MM-DD'（分桶/比较统一口径） */
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** 当前展示月份（以该月 1 号为锚点） */
const monthAnchor = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
const todayKey = ymd(new Date())
const selectedDate = ref(todayKey)
/** 明细区当前聚焦的任务（点任务片定位，行高亮滚动） */
const focusTaskId = ref('')
/** 明细区任务行元素登记（id → el），用于 scrollIntoView */
const detailRowEls = new Map<string, HTMLElement>()

const monthTitle = computed(() =>
  t('todo.cal_month', { y: monthAnchor.value.getFullYear(), m: monthAnchor.value.getMonth() + 1 }),
)

function shiftMonth(delta: number) {
  monthAnchor.value = new Date(monthAnchor.value.getFullYear(), monthAnchor.value.getMonth() + delta, 1)
}
function goToday() {
  const now = new Date()
  monthAnchor.value = new Date(now.getFullYear(), now.getMonth(), 1)
  selectedDate.value = todayKey
}

/** 月网格：从锚点月历法周首（周日）开始，整 6 行 42 格（含前后月补位） */
interface CalCell { key: string; day: number; inMonth: boolean; isToday: boolean }
const cells = computed<CalCell[]>(() => {
  const first = monthAnchor.value
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay())
  const out: CalCell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const key = ymd(d)
    out.push({ key, day: d.getDate(), inMonth: d.getMonth() === first.getMonth(), isToday: key === todayKey })
  }
  return out
})

/** 任务分桶：按 dueDate 日期部分；逾期未完成并入今天（红色标识）；返回桶与当日逾期标记 */
interface DayBucket { tasks: Todo[]; hasOverdueCarry: boolean }
const buckets = computed(() => {
  const map = new Map<string, DayBucket>()
  const ensure = (k: string) => {
    let b = map.get(k)
    if (!b) { b = { tasks: [], hasOverdueCarry: false }; map.set(k, b) }
    return b
  }
  for (const todo of props.todos) {
    if (!todo.dueDate) continue
    const time = new Date(todo.dueDate).getTime()
    if (Number.isNaN(time)) continue
    const dayKey = ymd(new Date(todo.dueDate))
    if (todo.completed !== 1 && dayKey < todayKey) {
      // 逾期顺延：显示在今天格（与「今天」视图同口径）
      const today = ensure(todayKey)
      today.tasks.push(todo)
      today.hasOverdueCarry = true
    } else {
      ensure(dayKey).tasks.push(todo)
    }
  }
  return map
})

const selectedBucket = computed(() => buckets.value.get(selectedDate.value) ?? { tasks: [], hasOverdueCarry: false })

// ===== 拖拽改期：dragstart 携带任务 id，drop 到日期格后保留原时刻仅改日期 =====
const dragOverKey = ref('')
let dragTodoId = ''

function onChipDragStart(e: DragEvent, todo: Todo) {
  beginElementDrag()
  dragTodoId = todo.id
  e.dataTransfer?.setData('text/plain', todo.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
/** 拖拽结束（落点/取消均触发）：归还全局拖拽计数并清理拖拽源 id */
function onChipDragEnd() {
  endElementDrag()
  dragTodoId = ''
}
function onCellDrop(e: DragEvent, cell: CalCell) {
  e.preventDefault()
  dragOverKey.value = ''
  const id = dragTodoId || e.dataTransfer?.getData('text/plain') || ''
  dragTodoId = ''
  if (!id) return
  const todo = props.todos.find(x => x.id === id)
  if (!todo?.dueDate) return
  const old = new Date(todo.dueDate)
  // 保留原时刻仅改日期；原时刻非法则落 09:00
  const timePart = Number.isNaN(old.getTime()) ? '09:00' : `${pad2(old.getHours())}:${pad2(old.getMinutes())}`
  if (cell.key === ymd(new Date(todo.dueDate))) return
  emit('change-due', id, `${cell.key}T${timePart}`)
}

const recurrenceText = (todo: Todo) => (todo.recurrence ? describeRecurrence(todo.recurrence, t) : '')

/** 明细区/任务片的截止时刻显示（HH:mm） */
const timeOf = (todo: Todo) => {
  const d = new Date(todo.dueDate ?? '')
  return Number.isNaN(d.getTime()) ? '' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const isCarried = (todo: Todo) => todo.completed !== 1 && !!todo.dueDate && ymd(new Date(todo.dueDate)) < todayKey

// ===== 任务片交互：完成圆点直接切换；点任务片 = 选中该日并滚动高亮明细行 =====
/** 点任务片：选中所在日期格，明细区对应行高亮并滚动到可见 */
function focusTask(cellKey: string, taskId: string) {
  selectedDate.value = cellKey
  focusTaskId.value = taskId
  nextTick(() => detailRowEls.get(taskId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}

/** 明细行登记/注销（模板 ref 回调） */
const setDetailRow = (id: string) => (el: any) => {
  if (el) detailRowEls.set(id, el as HTMLElement)
  else detailRowEls.delete(id)
}

/** 优先级色点颜色（跟随等级系统，异常回退中性灰） */
const levelColor = (todo: Todo) => getLevelInfo(todo.priorityLevel).color
</script>

<template>
  <div class="glass-card rounded-2xl p-4 shadow-soft">
    <!-- 月导航 -->
    <div class="mb-3 flex items-center justify-between">
      <button type="button" class="btn-soft flex h-8 w-8 items-center justify-center p-2" v-tip="t('todo.cal_prev')" @click="shiftMonth(-1)">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <div class="flex items-center gap-2">
        <span class="text-sm font-semibold text-ink tabular-nums">{{ monthTitle }}</span>
        <button type="button" class="btn-soft px-2 py-0.5 text-xs" @click="goToday">{{ t('todo.cal_today') }}</button>
      </div>
      <button type="button" class="btn-soft flex h-8 w-8 items-center justify-center p-2" v-tip="t('todo.cal_next')" @click="shiftMonth(1)">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg>
      </button>
    </div>

    <!-- 星期表头（周日始，与循环规则 weekdays 编号一致） -->
    <div class="mb-1 grid grid-cols-7 gap-1 text-center text-[10px] text-ink-faint">
      <span v-for="d in [0, 1, 2, 3, 4, 5, 6]" :key="d">{{ t(`todo.day_${d}`) }}</span>
    </div>

    <!-- 月网格 -->
    <div class="grid grid-cols-7 gap-1">
      <div
          v-for="cell in cells"
          :key="cell.key"
          class="min-h-20 rounded-xl border p-1 transition-colors"
          :class="[
            cell.inMonth ? 'border-accent/60' : 'border-transparent opacity-40',
            cell.isToday ? 'bg-gold/10 border-gold/60' : '',
            selectedDate === cell.key ? 'ring-2 ring-gold/60' : '',
            dragOverKey === cell.key ? 'bg-gold/20' : '',
          ]"
          @click="selectedDate = cell.key"
          @dragover.prevent="dragOverKey = cell.key"
          @dragleave="dragOverKey === cell.key && (dragOverKey = '')"
          @drop="onCellDrop($event, cell)"
      >
        <div class="mb-0.5 flex items-center justify-between px-0.5">
          <span class="text-xs tabular-nums" :class="cell.isToday ? 'font-bold text-gold' : 'text-ink-soft'">{{ cell.day }}</span>
          <span v-if="buckets.get(cell.key)?.hasOverdueCarry" class="h-1.5 w-1.5 rounded-full bg-danger" v-tip="t('todo.cal_overdue_carry')" />
        </div>
        <!-- 任务片：最多显示 3 条，其余 +N；左侧完成圆点直接切换，点任务片定位明细 -->
        <div class="space-y-0.5">
          <div
              v-for="task in (buckets.get(cell.key)?.tasks ?? []).slice(0, 3)"
              :key="task.id"
              draggable="true"
              class="flex cursor-pointer items-center gap-1 truncate rounded px-1 py-0.5 text-[10px] leading-tight"
              :class="[
                task.completed === 1 ? 'bg-secondary text-ink-faint' : isCarried(task) ? 'bg-danger/15 text-danger' : 'bg-gold/15 text-ink',
                focusTaskId === task.id ? 'ring-1 ring-gold/70' : '',
              ]"
              :title="`${timeOf(task)} ${task.title}${recurrenceText(task) ? ' · ' + recurrenceText(task) : ''}`"
              @dragstart="onChipDragStart($event, task)"
              @dragend="onChipDragEnd"
              @click.stop="focusTask(cell.key, task.id)"
          >
            <!-- 完成圆点：点击直接切换完成/未完成（completed 划线态） -->
            <button
                type="button"
                class="shrink-0 rounded-full transition-colors"
                :class="task.completed === 1
                  ? 'text-ink-faint hover:text-gold'
                  : isCarried(task) ? 'text-danger/70 hover:text-danger' : 'text-gold/60 hover:text-gold'"
                v-tip="task.completed === 1 ? t('todo.island_uncompleted_short') : t('common.mark_complete')"
                @click.stop="$emit('toggle', task.id)"
            >
              <svg v-if="task.completed === 1" class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" /><path d="M7 12.5l3.5 3.5L17 9" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
              <svg v-else class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="9" /></svg>
            </button>
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" :style="{ backgroundColor: levelColor(task) }" />
            <span class="tabular-nums" :class="task.completed === 1 ? 'line-through' : ''">{{ timeOf(task) }}</span>
            <span class="truncate" :class="task.completed === 1 ? 'line-through' : ''">{{ task.title }}</span>
          </div>
          <div v-if="(buckets.get(cell.key)?.tasks ?? []).length > 3" class="px-1 text-[10px] text-ink-faint">
            +{{ (buckets.get(cell.key)?.tasks ?? []).length - 3 }}
          </div>
        </div>
      </div>
    </div>

    <!-- 选中日明细 -->
    <div class="mt-3 border-t border-accent/60 pt-3">
      <p class="mb-1.5 text-xs font-semibold text-ink-soft">
        {{ selectedDate === todayKey ? t('todo.today') : selectedDate }}
        <span class="ml-1 font-normal text-ink-faint">（{{ selectedBucket.tasks.length }}）</span>
      </p>
      <p v-if="selectedBucket.tasks.length === 0" class="py-2 text-center text-xs text-ink-faint">{{ t('todo.cal_no_task') }}</p>
      <ul v-else class="space-y-1">
        <li
            v-for="task in selectedBucket.tasks"
            :key="task.id"
            :ref="setDetailRow(task.id)"
            class="flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition-colors"
            :class="[
              focusTaskId === task.id ? 'bg-gold/15 ring-1 ring-gold/60' : 'hover:bg-secondary',
            ]"
        >
          <!-- 完成圆点 -->
          <button
              type="button"
              class="shrink-0 rounded-full text-ink-faint transition-colors hover:text-gold"
              :class="task.completed === 1 ? 'text-gold' : ''"
              v-tip="task.completed === 1 ? t('todo.island_uncompleted_short') : t('common.mark_complete')"
              @click="$emit('toggle', task.id)"
          >
            <svg v-if="task.completed === 1" class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
            <svg v-else class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9" /></svg>
          </button>
          <span class="h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: levelColor(task) }" v-tip="t('todo.priority')" />
          <span class="tabular-nums text-ink-faint">{{ timeOf(task) }}</span>
          <span class="min-w-0 flex-1 truncate" :class="{ 'line-through text-ink-faint': task.completed === 1, 'text-danger': isCarried(task) }">{{ task.title }}</span>
          <span v-if="recurrenceText(task)" class="shrink-0 rounded-full bg-gold/15 px-1.5 py-0.5 text-[10px] text-gold">{{ recurrenceText(task) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
