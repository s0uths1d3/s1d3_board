<script setup lang="ts">
/**
 * 待办日历视图（待办 §6）：月/周网格 + 任务按截止日期分桶。
 * - 逾期未完成任务并入「今天」格显示（红色标识），与「今天」聚合视图同口径；
 * - 拖拽任务片到目标日期格改期（保留原时刻，仅改日期）→ emit change-due 由父级走既有更新链路；
 * - 任务片直接可交互：左侧完成圆点点击切换完成（emit toggle），点任务片定位到下方明细行；
 * - 农历行：每格显示农历日/节气/传统节日（src/calendar/lunar.ts，表范围外自动隐藏）；
 * - 视图与偏好：月/周视图切换、周起始日（周日/周一）切换，localStorage 记忆；
 * - 键盘导航：网格获得焦点后 ←→ 切换日、↑↓ 切换周（自动跨月）。
 */
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import type { Todo } from '~/src/entities'
import type { LunarDayInfo } from '~/src/calendar/lunar'
import { lunarDayInfo } from '~/src/calendar/lunar'
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
/** 优先级等级颜色：任务片色条/明细行的色点（随用户自定义档位） */
const { getLevelInfo } = useTodoPriorities()

const pad2 = (n: number) => String(n).padStart(2, '0')
/** 本地日期键 'YYYY-MM-DD'（分桶/比较统一口径） */
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const ymdToDate = (key: string) => {
  // ymd() 产出的固定 'YYYY-MM-DD' 格式，按位切片解析避免 split 元素 undefined
  return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))
}
const addDays = (base: Date, n: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + n)

// ===== 视图偏好：月/周视图 + 周起始日（localStorage 记忆，组件级 UI 偏好） =====
const LS_VIEW = 'todo_calendar_view'
const LS_WEEK_START = 'todo_calendar_week_start'
const viewMode = ref<'month' | 'week'>('month')
const weekStart = ref(0)
onMounted(() => {
  viewMode.value = localStorage.getItem(LS_VIEW) === 'week' ? 'week' : 'month'
  weekStart.value = localStorage.getItem(LS_WEEK_START) === '1' ? 1 : 0
})
watch(viewMode, (v) => localStorage.setItem(LS_VIEW, v))
watch(weekStart, (v) => localStorage.setItem(LS_WEEK_START, String(v)))
function toggleWeekStart() {
  weekStart.value = weekStart.value === 0 ? 1 : 0
}

/** 当前展示月份（以该月 1 号为锚点；周视图下仅作 inMonth 判定基准） */
const monthAnchor = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
const todayKey = ymd(new Date())
const selectedDate = ref(todayKey)
/** 明细区当前聚焦的任务（点任务片定位，行高亮滚动） */
const focusTaskId = ref('')
/** 明细区任务行元素登记（id → el），用于 scrollIntoView */
const detailRowEls = new Map<string, HTMLElement>()

/** 标题日期：月视图取锚点月，周视图取选中日所在月 */
const titleDate = computed(() => (viewMode.value === 'week' ? ymdToDate(selectedDate.value) : monthAnchor.value))
const monthTitle = computed(() =>
  t('todo.cal_month', { y: titleDate.value.getFullYear(), m: titleDate.value.getMonth() + 1 }),
)

function shiftMonth(delta: number) {
  monthAnchor.value = new Date(monthAnchor.value.getFullYear(), monthAnchor.value.getMonth() + delta, 1)
}
function goToday() {
  const now = new Date()
  monthAnchor.value = new Date(now.getFullYear(), now.getMonth(), 1)
  selectedDate.value = todayKey
}

/** 前后翻页：月视图翻月，周视图平移一周 */
function navPrev() {
  if (viewMode.value === 'week') moveSelection(-7)
  else shiftMonth(-1)
}
function navNext() {
  if (viewMode.value === 'week') moveSelection(7)
  else shiftMonth(1)
}

/** 周偏移：日期相对周起始日的格距（weekStart 0=周日 / 1=周一） */
const weekOffsetOf = (d: Date) => (d.getDay() - weekStart.value + 7) % 7

/** 网格：月视图 = 锚点月历法周首起整 6 行 42 格（含前后月补位）；周视图 = 选中日所在周 7 格 */
interface CalCell { key: string; day: number; inMonth: boolean; isToday: boolean; lunar: LunarDayInfo | null }
const cells = computed<CalCell[]>(() => {
  const isWeek = viewMode.value === 'week'
  const anchor = isWeek ? ymdToDate(selectedDate.value) : monthAnchor.value
  const start = addDays(anchor, -weekOffsetOf(anchor))
  const total = isWeek ? 7 : 42
  const out: CalCell[] = []
  for (let i = 0; i < total; i++) {
    const day = addDays(start, i)
    const key = ymd(day)
    out.push({
      key,
      day: day.getDate(),
      inMonth: day.getMonth() === monthAnchor.value.getMonth(),
      isToday: key === todayKey,
      lunar: lunarDayInfo(day),
    })
  }
  return out
})

/** 星期表头顺序（随周起始日旋转）；周末列（日/六）弱化着色 */
const weekdayOrder = computed(() => Array.from({ length: 7 }, (_, i) => (weekStart.value + i) % 7))

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

const tasksOf = (key: string) => buckets.value.get(key)?.tasks ?? []
const selectedBucket = computed(() => buckets.value.get(selectedDate.value) ?? { tasks: [], hasOverdueCarry: false })

/** 任务片容量：月格 3 条，周格更宽裕 12 条 */
const chipCap = computed(() => (viewMode.value === 'week' ? 12 : 3))

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

// ===== 键盘导航：网格聚焦后 ←→ 切换日、↑↓ 切换周；跨月自动翻页 =====
const gridEl = ref<HTMLElement | null>(null)
const KEY_DELTAS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
function moveSelection(deltaDays: number) {
  const next = addDays(ymdToDate(selectedDate.value), deltaDays)
  selectedDate.value = ymd(next)
  const anchor = monthAnchor.value
  if (next.getFullYear() !== anchor.getFullYear() || next.getMonth() !== anchor.getMonth()) {
    monthAnchor.value = new Date(next.getFullYear(), next.getMonth(), 1)
  }
}
function onGridKeydown(e: KeyboardEvent) {
  const delta = KEY_DELTAS[e.key]
  if (delta === undefined) return
  e.preventDefault()
  moveSelection(delta)
}
/** 点日期格：选中该日并让网格获得焦点（后续可直接键盘导航） */
function selectCell(cell: CalCell) {
  selectedDate.value = cell.key
  gridEl.value?.focus({ preventScroll: true })
}

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

// ===== 明细区头部：日期本地化 + 农历/节日/节气副行 =====
const detailDate = computed(() => {
  const dt = ymdToDate(selectedDate.value)
  return t('todo.cal_detail_date', { m: dt.getMonth() + 1, d: dt.getDate() })
})
const detailLunar = computed(() => lunarDayInfo(ymdToDate(selectedDate.value)))
</script>

<template>
  <!-- flex 列 + h-full：高度链来自宿主页面，头部/表头定高，网格弹性填充，明细区封顶内滚 → 整卡不超出主窗口 -->
  <div class="glass-card flex h-full min-h-0 flex-col rounded-2xl p-4 shadow-soft">
    <!-- 头部：月导航 + 视图/周起始切换 -->
    <div class="mb-3 flex shrink-0 items-center justify-between gap-2">
      <button type="button" class="btn-soft flex h-8 w-8 items-center justify-center p-2" v-tip="t('todo.cal_prev')" @click="navPrev">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <div class="flex items-center gap-2">
        <span class="text-sm font-bold text-ink tabular-nums">{{ monthTitle }}</span>
        <button type="button" class="btn-soft rounded-full px-2 py-0.5 text-xs" @click="goToday">{{ t('todo.cal_today') }}</button>
      </div>
      <div class="flex items-center gap-1">
        <!-- 月/周视图切换（图标按钮，v-tip 提示全名） -->
        <div class="flex overflow-hidden rounded-lg border border-accent/50">
          <button type="button" class="flex h-7 w-7 items-center justify-center" :class="viewMode === 'month' ? 'bg-gold/15 text-gold' : 'text-ink-faint hover:text-ink-soft'" v-tip="t('todo.cal_view_month')" @click="viewMode = 'month'">
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M8 2v4M16 2v4M3 9h18M9 13h2M13 13h2M9 17h2M13 17h2" /></svg>
          </button>
          <button type="button" class="flex h-7 w-7 items-center justify-center" :class="viewMode === 'week' ? 'bg-gold/15 text-gold' : 'text-ink-faint hover:text-ink-soft'" v-tip="t('todo.cal_view_week')" @click="viewMode = 'week'">
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="9" width="18" height="7" rx="2" /><path d="M9 9v7M15 9v7" /></svg>
          </button>
        </div>
        <!-- 周起始日切换：按钮显示可切换到的目标 -->
        <button type="button" class="btn-soft rounded-full px-2 py-1 text-xs" v-tip="t('todo.cal_week_start')" @click="toggleWeekStart">
          {{ weekStart === 0 ? t('todo.cal_start_mon') : t('todo.cal_start_sun') }}
        </button>
        <button type="button" class="btn-soft flex h-8 w-8 items-center justify-center p-2" v-tip="t('todo.cal_next')" @click="navNext">
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6" /></svg>
        </button>
      </div>
    </div>

    <!-- 星期表头（顺序随周起始日；周末列弱红） -->
    <div class="mb-1 grid shrink-0 grid-cols-7 gap-1 text-center text-[10px]">
      <span v-for="dayNum in weekdayOrder" :key="dayNum" :class="[0, 6].includes(dayNum) ? 'font-medium text-danger/60' : 'text-ink-faint'">{{ t(`todo.day_${dayNum}`) }}</span>
    </div>

    <!-- 月/周网格（可聚焦键盘导航；v-tip 提示快捷键）：
         flex-1 弹性填充剩余高度，行数随视图（月 6 行 / 周 1 行）等分，格子高度随窗口自适应 -->
    <div
        ref="gridEl"
        tabindex="0"
        class="grid min-h-0 flex-1 grid-cols-7 gap-1 outline-none"
        :class="viewMode === 'month' ? 'grid-rows-6' : 'grid-rows-1'"
        v-tip="t('todo.cal_keys_hint')"
        @keydown="onGridKeydown"
    >
      <div
          v-for="cell in cells"
          :key="cell.key"
          class="flex min-h-0 flex-col overflow-hidden rounded-xl border p-1.5 transition-all"
          :class="[
            cell.inMonth ? 'border-accent/40 bg-secondary/20' : 'border-transparent opacity-35',
            cell.isToday ? 'border-gold/70 bg-gold/10' : '',
            selectedDate === cell.key ? 'ring-2 ring-gold/50' : '',
            dragOverKey === cell.key ? 'border-gold/60 bg-gold/20' : '',
          ]"
          @click="selectCell(cell)"
          @dragover.prevent="dragOverKey = cell.key"
          @dragleave="dragOverKey === cell.key && (dragOverKey = '')"
          @drop="onCellDrop($event, cell)"
      >
        <!-- 日号 + 农历行（节日 > 节气 > 农历日）+ 逾期顺延标识 -->
        <div class="mb-1 flex shrink-0 items-center justify-between gap-1 px-0.5">
          <span class="text-xs font-medium tabular-nums" :class="cell.isToday ? 'font-bold text-gold' : 'text-ink-soft'">{{ cell.day }}</span>
          <span class="flex min-w-0 items-center gap-1">
            <span v-if="buckets.get(cell.key)?.hasOverdueCarry" class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" v-tip="t('todo.cal_overdue_carry')" />
            <span v-if="cell.lunar" class="min-w-0 truncate text-[9px] leading-none" :class="cell.lunar.festival ? 'font-semibold text-gold' : cell.lunar.term ? 'text-ink-soft' : 'text-ink-faint/60'">{{ cell.lunar.festival || cell.lunar.term || cell.lunar.lunarText }}</span>
          </span>
        </div>
        <!-- 任务片：月格最多 3 条/周格 12 条，其余 +N；左侧优先级色条，完成圆点直接切换，点任务片定位明细。
             flex-1 + overflow-hidden：格子高度不足时任务片在此裁切（+N 徽章兜底计数），不撑破网格 -->
        <div class="min-h-0 flex-1 space-y-0.5 overflow-hidden">
          <div
              v-for="task in tasksOf(cell.key).slice(0, chipCap)"
              :key="task.id"
              draggable="true"
              class="flex cursor-pointer items-center gap-1 truncate rounded border-l-2 px-1 py-0.5 text-[10px] leading-tight transition-colors"
              :class="[
                task.completed === 1 ? 'bg-secondary text-ink-faint' : isCarried(task) ? 'bg-danger/15 text-danger' : 'bg-gold/10 text-ink',
                focusTaskId === task.id ? 'ring-1 ring-gold/70' : '',
              ]"
              :style="{ borderLeftColor: levelColor(task) }"
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
            <span class="tabular-nums" :class="task.completed === 1 ? 'line-through' : ''">{{ timeOf(task) }}</span>
            <span class="truncate" :class="task.completed === 1 ? 'line-through' : ''">{{ task.title }}</span>
          </div>
          <div v-if="tasksOf(cell.key).length > chipCap" class="px-1">
            <span class="inline-block rounded-full bg-secondary px-1.5 text-[10px] leading-4 text-ink-faint">+{{ tasksOf(cell.key).length - chipCap }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 选中日明细：日期 + 农历副行 + 计数徽章，任务行卡片化；
         shrink-0 + 列表封顶内滚：任务再多也只在此区域滚动，不推高整卡 -->
    <div class="mt-3 shrink-0 border-t border-accent/60 pt-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-baseline gap-1.5">
          <p class="text-sm font-semibold text-ink">{{ selectedDate === todayKey ? t('todo.today') : detailDate }}</p>
          <p v-if="detailLunar" class="min-w-0 truncate text-xs text-ink-faint">{{ detailLunar.festival || detailLunar.term || detailLunar.lunarText }}</p>
        </div>
        <span class="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs tabular-nums text-ink-faint">{{ selectedBucket.tasks.length }}</span>
      </div>
      <p v-if="selectedBucket.tasks.length === 0" class="py-2 text-center text-xs text-ink-faint">{{ t('todo.cal_no_task') }}</p>
      <ul v-else class="max-h-44 space-y-1 overflow-y-auto pr-1">
        <li
            v-for="task in selectedBucket.tasks"
            :key="task.id"
            :ref="setDetailRow(task.id)"
            class="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-all"
            :class="[
              focusTaskId === task.id ? 'border-gold/60 bg-gold/10 ring-1 ring-gold/50' : 'border-accent/30 bg-secondary/40 hover:border-accent/50 hover:bg-secondary/70',
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
