<template>
  <div class="min-h-screen p-4">
    <div class="max-w-6xl mx-auto">
      <div class="mb-8">

        <div class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div class="glass-card flex items-center gap-3 rounded-2xl p-4 shadow-soft">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>
              </svg>
            </div>
            <div class="min-w-0 flex-1 text-xs uppercase tracking-wide text-ink-faint">{{ t('todo.total') }}</div>
            <div class="text-xl font-semibold text-ink tabular-nums">{{ todos.length }}</div>
          </div>

          <div class="glass-card flex items-center gap-3 rounded-2xl p-4 shadow-soft">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
              </svg>
            </div>
            <div class="min-w-0 flex-1 text-xs uppercase tracking-wide text-ink-faint">{{ t('todo.completionRate') }}</div>
            <div class="text-xl font-semibold text-ink tabular-nums">{{ completionRate }}%</div>
          </div>

          <div class="glass-card flex items-center gap-3 rounded-2xl p-4 shadow-soft">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <div class="min-w-0 flex-1 text-xs uppercase tracking-wide text-ink-faint">{{ t('todo.onTimeRate') }}</div>
            <div class="text-xl font-semibold text-ink tabular-nums">{{ onTimeRate }}%</div>
          </div>
        </div>
      </div>

      <!-- 搜索/筛选栏：relative z-40 提升 stacking context 层级，
           避免下拉菜单被下方 TodoItem 列表（同样 backdrop-filter 的 glass-card）覆盖 -->
      <div class="glass-card relative z-40 mb-6 rounded-2xl p-4 shadow-soft">
        <div class="flex flex-col gap-4 lg:flex-row">
          <div class="flex flex-1 items-center gap-2">
            <input
                ref="todoSearchInput"
                v-model="searchQuery"
                type="text"
                :placeholder="t('todo.searchPlaceholder')"
                class="todo-search-input min-w-0 flex-1 rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
            />

            <UiDropdown align="center" :aria-label="t('todo.filter')" panel-class="glass-card menu w-max min-w-32 rounded-2xl p-2">
              <template #trigger="{ open }">
                <label class="btn-soft flex shrink-0 cursor-pointer items-center">
                  {{ currentFilterLabel }}
                  <svg class="ml-1 h-4 w-4 transform transition-transform duration-200" :class="{ 'rotate-180': open }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                  </svg>
                </label>
              </template>
              <ul class="menu p-2">
                <li v-for="filter in filters" :key="filter.value">
                  <a @click="setFilter(filter.value)" class="cursor-pointer whitespace-nowrap rounded-lg hover:bg-secondary">{{ filter.label }}</a>
                </li>
              </ul>
            </UiDropdown>

            <UiDropdown align="center" :aria-label="t('todo.sort')" panel-class="glass-card menu w-max min-w-40 rounded-2xl p-2">
              <template #trigger="{ open }">
                <label class="btn-soft flex cursor-pointer items-center">
                  {{ t('todo.sort') }}
                  <svg class="ml-1 h-4 w-4 transform transition-transform duration-200" :class="{ 'rotate-180': open }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"></path>
                  </svg>
                </label>
              </template>
              <ul class="menu p-2">
                <li v-for="sort in sortOptions" :key="sort.value">
                  <a @click="setSort(sort.value)" class="cursor-pointer whitespace-nowrap rounded-lg hover:bg-secondary">{{ sort.label }}</a>
                </li>
              </ul>
            </UiDropdown>

            <!-- 新增任务：位于搜索框最右侧，点击下拉展开表单（与原先效果一致） -->
            <button
                @click="toggleAddForm"
                class="btn-gold ml-auto flex h-10 shrink-0 items-center gap-1.5 px-3"
                v-tip="t(showAddForm ? 'todo.collapse' : 'todo.expandAddForm')"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
              </svg>
              <span class="hidden text-sm sm:inline">{{ t('todo.newTaskBtn') }}</span>
            </button>
          </div>
        </div>

        <!-- 新增任务：在搜索框所在卡片内部下拉/收起，与搜索框贴合 -->
        <div
            class="add-form-wrap"
            :class="showAddForm ? 'is-open' : ''"
        >
          <div class="min-h-0">
            <div class="space-y-3 pt-3">
              <input
                  v-model="newTodo.title"
                  type="text"
                  class="todo-title-input w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
                  :placeholder="t('todo.titlePlaceholder') + ' *'"
                  @keyup.enter="newTodo.title ? descriptionInput?.focus() : null"
              />

              <textarea
                  ref="descriptionInput"
                  v-model="newTodo.description"
                  class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
                  :placeholder="t('todo.descPlaceholder')"
                  rows="2"
              ></textarea>

              <!-- 控件 + 操作按钮：响应式布局，窄窗口自动换行不裁切 -->
              <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
                  <div class="flex items-center gap-2">
                    <label class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.priority') }}</label>
                    <PrioritySelect v-model="newTodo.priorityLevel" />
                  </div>

                  <div class="flex items-center gap-2">
                    <label class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.dueDate') }}</label>
                    <DueTimeSelect v-model="newTodo.dueDate" :placeholder="t('todo.dueTime')" />
                  </div>

                  <div class="flex items-center gap-2">
                    <label class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.reminderLabel') }}</label>
                    <ReminderPicker
                        v-model:mode="newTodo.remindMode"
                        v-model:rules="newTodo.remindRules"
                        variant="field"
                        :has-due="!!newTodo.dueDate"
                    />
                  </div>

                  <div class="flex items-center gap-2">
                    <label class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.category') }}</label>
                    <CategorySelect v-model="newTodo.category" :placeholder="t('todo.category')" @category-delete="handleCategoryDelete" />
                  </div>
                </div>

                <div class="flex shrink-0 items-center gap-2">
                  <button
                      type="button"
                      @click="addTodo"
                      v-tip="t('common.addTask')"
                      class="btn-gold flex h-9 w-9 items-center justify-center p-0"
                      :disabled="!newTodo.title.trim()"
                  >
                    <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                    </svg>
                  </button>
                  <button
                      type="button"
                      @click="resetForm"
                      v-tip="t('common.reset')"
                      class="btn-soft flex h-9 w-9 items-center justify-center p-0"
                  >
                    <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div id="todoListContainer" class="space-y-3">
        <TodoItem
            v-for="(todo, index) in filteredAndSortedTodos"
            :key="todo.id"
            :todo="todo"
            :highlight-string="searchHighlightEnabled ? searchQuery : ''"
            :highlight="searchHighlightEnabled && searchQuery.trim() !== ''"
            :selected="index === selectedTodoIndex"
            :edit-signal="editSignal"
            @toggle="toggleTodo"
            @update="updateTodo"
            @delete="deleteTodo"
            @priority-level-change="changePriorityLevel"
            @category-change="changeCategory"
            @reminder-change="changeReminder"
            @category-delete="handleCategoryDelete"
            @select="selectTodoIndex(index)"
        />
      </div>

      <!-- 流式加载：sentinel 进入视口时自动加载下一页；到底后显示"已全部加载" -->
      <div
          v-if="hasMore && todos.length"
          ref="sentinel"
          class="flex items-center justify-center gap-2 py-4 text-xs text-ink-faint"
      >
        <span v-if="loadingMore">{{ t('todo.loadingMore') }}</span>
        <span v-else>{{ t('clip.scrollMore') }}</span>
      </div>
      <div v-else-if="todos.length" class="py-4 text-center text-xs text-ink-faint">{{ t('clip.noMore') }}</div>

      <div v-if="filteredAndSortedTodos.length === 0" class="py-20 text-center">
        <svg class="mx-auto mb-4 h-24 w-24 text-ink-faint/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path>
        </svg>
        <p class="text-lg text-ink-faint">
          {{ !searchQuery.trim() && todos.length === 0 ? t('todo.empty') : t('todo.emptySearch') }}
        </p>
      </div>

      <!-- 删除确认框：与全局一致的 DeleteConfirm 组件（就近定位、键盘操作一致） -->
      <DeleteConfirm
          :visible="deleteConfirmVisible"
          :message="deleteConfirmMessage"
          :anchor="deleteConfirmAnchor"
          @confirm="onDeleteConfirm"
          @cancel="onDeleteCancel"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import TodoItem from './Todoitem.vue'
import clipboardService from '~/src/db/dbService'
import { v4 as uuidv4 } from 'uuid'
import type {Todo, ReminderRule} from '~/src/entities'
import {isTauri} from "~/utils/env"
import statsService from "~/src/statistics/statsService"
import DueTimeSelect from '~/components/todo/DueTimeSelect.vue'
import CategorySelect from '~/components/todo/CategorySelect.vue'
import ReminderPicker from '~/components/todo/ReminderPicker.vue'
import PrioritySelect from '~/components/todo/PrioritySelect.vue'
import { useSearchHighlight } from "~/composables/useSearchHighlight"
import { useCategories } from "~/composables/useCategories"
import { useTodoPriorities } from "~/composables/useTodoPriorities"
import { useDueDateMemory } from "~/composables/useDueDateMemory"
import reminderService from '~/src/todo/reminderService'
import { isTodoOverdue } from '~/src/todo/overdue'
import DeleteConfirm from '~/components/common/DeleteConfirm.vue'
import { useNow } from '~/composables/useNow'
import { useI18n } from '~/composables/useI18n'
import { todoList, selectedTodoIndex, editSignal, selectTodo, setTodoLoadMoreHook } from '~/src/commands/local/todoStore'
import { useInfiniteList } from '~/composables/useInfiniteList'

/** 流式加载：首屏只加载第一页，滚动到底部自动加载下一页；
 *  轮询/操作后仅刷新已加载范围（签名一致时跳过整表替换，避免全列表重渲染） */
const {
  items: todos, hasMore, loading: loadingMore, sentinel,
  loadMore, reload, replace, prepend, remove: removeTodo, refreshLoaded,
} = useInfiniteList<Todo>({
  fetchPage: (offset, limit) =>
    clipboardService.fetchTodos({ value: { searchContent: '' } }, { offset, limit }),
  pageSize: 50,
  signatureOf: (t) => `${t.id}:${t.updated_at}:${t.completed}`,
})

const { t } = useI18n();

/** 全量待办集合（轮询全量查询结果）：仅用于统计卡片与提醒调度，不参与列表渲染 */
const statsTodos = ref<Todo[]>([])
let pollTimer: ReturnType<typeof setInterval> | null = null
/** 轮询请求去重：上一轮未完成时跳过，避免 DB 慢时请求堆积 */
let fetching = false
/** 写库进行中计数：>0 时轮询跳过，防止拿旧数据覆盖乐观更新（竞态根源） */
let pendingWrites = 0

/** 乐观更新同步到统计全量集合（statsTodos 可能比已加载列表大，需单独同步） */
function applyToStats(todo: Todo) {
  const t = statsTodos.value.find(x => x.id === todo.id)
  if (t) Object.assign(t, todo)
}

const showAddForm = ref(false)
const newTodo = ref({
  title: '',
  description: '',
  priorityLevel: 127,
  category: '其他',
  dueDate: '',
  remindMode: 'smart' as 'smart' | 'off' | 'custom',
  remindRules: [] as ReminderRule[]
})

// ===== 优先级等级系统（0-255）：选择/排序/筛选/删除等级后的自动重映射 =====
const { levels: priorityLevels, nearestLevel } = useTodoPriorities()

const searchQuery = ref('')
/** 搜索框 ref：Ctrl+F 聚焦使用 */
const todoSearchInput = ref<HTMLInputElement | null>(null)
/** 全局搜索高亮开关（设置页通用控制） */
const { searchHighlightEnabled } = useSearchHighlight()
/** 任务描述输入框（回车从标题跳转到描述时聚焦） */
const descriptionInput = ref<HTMLTextAreaElement | null>(null)
const currentFilter = ref('pending')
const currentSort = ref('date-desc')

/** 响应式当前时间，用于截止时间到达时自动刷新逾期/筛选状态 */
const now = useNow()

const filters = computed(() => [
  { label: t('todo.all'), value: 'all' },
  { label: t('todo.active'), value: 'pending' },
  { label: t('todo.completed'), value: 'completed' },
  { label: t('todo.highPriority'), value: 'high' },
  { label: t('todo.overdue'), value: 'overdue' },
  { label: t('todo.overdueCompleted'), value: 'overdue-completed' },
])

const sortOptions = computed(() => [
  { label: t('todo.newest'), value: 'date-desc' },
  { label: t('todo.oldest'), value: 'date-asc' },
  { label: t('todo.priority'), value: 'priority' },
  { label: t('todo.name'), value: 'name' },
])

/** 筛选按钮显示的标签：value→label 映射（避免点击后显示英文 value） */
const currentFilterLabel = computed(() => filters.value.find(f => f.value === currentFilter.value)?.label ?? currentFilter.value)

/** 当前等级系统中的最高档位（"高优先级"筛选口径，随用户自定义档位自适应） */
const highLevel = computed(() => {
  const ls = priorityLevels.value.map(l => l.level)
  return ls.length > 0 ? Math.max(...ls) : 255
})

// 提醒调度：统一由 reminderService 负责（智能提前提醒 30/10/5 分钟、自定义提醒、到期通知）。
// 服务挂载在主窗口（app.vue 启动），切换 Tab 卸载本组件不影响定时器；
// 本组件只负责在数据变化后把最新列表同步给服务。

// 计算属性（统计基于全量集合 statsTodos，流式加载下仍保证数字准确）
const completedCount = computed(() => statsTodos.value.filter(t => t.completed).length)
const completionRate = computed(() => {
  if (statsTodos.value.length === 0) return 0
  return Math.round((completedCount.value / statsTodos.value.length) * 100)
})

/** 准时率：在「已完成且有截止时间」的任务中，按时（截止前）完成的比例；无样本时显示 0% */
const onTimeRate = computed(() => {
  const finishedWithDue = statsTodos.value.filter(t => t.completed && t.dueDate)
  if (finishedWithDue.length === 0) return 0
  const onTime = finishedWithDue.filter(t => !isOverdueTodo(t)).length
  return Math.round((onTime / finishedWithDue.length) * 100)
})

/** 判断任务是否已逾期：有截止时间且早于当前时间（共享实现，见 app/src/todo/overdue.ts）。 */
const isOverdueTodo = (todo: Todo) => isTodoOverdue(todo, now.value)

const filteredAndSortedTodos = computed(() => {
  let filtered = todos.value

  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase()
    filtered = filtered.filter(todo =>
        todo.title.toLowerCase().includes(query) ||
        (todo.description && todo.description.toLowerCase().includes(query))
    )
  }

  // "已逾期"筛选仅显示已逾期且未完成的任务；"逾期完成"仅显示已完成且已逾期的任务；
  // 其余筛选（全部/进行中/已完成/高优先级）均包含逾期状态，不单独剔除。
  if (currentFilter.value === 'overdue') {
    filtered = filtered.filter(t => isOverdueTodo(t) && t.completed !== 1)
  } else if (currentFilter.value === 'overdue-completed') {
    filtered = filtered.filter(t => isOverdueTodo(t) && t.completed === 1)
  }

  if (currentFilter.value === 'pending') {
    filtered = filtered.filter(t => !t.completed)
  } else if (currentFilter.value === 'completed') {
    filtered = filtered.filter(t => t.completed)
  } else if (currentFilter.value === 'high') {
    // "高优先级"跟随用户自定义档位：取等级系统中的最高档，
    // 不再硬编码 128（用户只配置 0-100 档位时原写法永远为空）
    filtered = filtered.filter(t => (t.priorityLevel ?? 127) === highLevel.value)
  }

  return [...filtered].sort((a, b) => {
    switch (currentSort.value) {
      case 'date-asc':
        return (parseInt(a.created_at || '0') || 0) - (parseInt(b.created_at || '0') || 0)
      case 'date-desc':
        return (parseInt(b.created_at || '0') || 0) - (parseInt(a.created_at || '0') || 0)
      case 'priority':
        // 数值优先级：越大越优先，降序
        return (b.priorityLevel ?? 127) - (a.priorityLevel ?? 127)
      case 'name':
        return a.title.localeCompare(b.title)
      default:
        return 0
    }
  })
})

// 方法
const { lastDueDate } = useDueDateMemory()

/** 上次选择的截止时间若仍在未来，则作为新增表单默认值；否则留空 */
function defaultDueDate(): string {
  const v = lastDueDate.value
  if (!v) return ''
  const t = new Date(v).getTime()
  if (isNaN(t) || t <= Date.now()) return ''
  return v
}

const toggleAddForm = () => {
  showAddForm.value = !showAddForm.value
  if (showAddForm.value) {
    // 截止时间默认套用上次选择（若仍有效），否则留空
    newTodo.value.dueDate = defaultDueDate()

    nextTick(() => {
      const titleInput = document.querySelector('input.todo-title-input') as HTMLInputElement
      titleInput?.focus()
    })
  }
}

/**
 * 统一 DB 写入包装：失败时 console.error 并返回 false（不产生 unhandled rejection），
 * 写库期间 pendingWrites > 0 使轮询跳过，避免旧数据覆盖乐观更新。
 */
async function withDbWrite(fn: () => Promise<void>): Promise<boolean> {
  pendingWrites++
  try {
    await fn()
    return true
  } catch (error) {
    console.error('[todo] 数据库写入失败:', error)
    return false
  } finally {
    pendingWrites--
  }
}

const addTodo = async () => {
  if (!newTodo.value.title.trim()) return

  const nowMs = Date.now()
  const todo: Todo = {
    id: uuidv4(),
    title: newTodo.value.title.trim(),
    description: newTodo.value.description.trim(),
    completed: 0,
    priorityLevel: newTodo.value.priorityLevel,
    category: newTodo.value.category,
    dueDate: newTodo.value.dueDate,
    remindMode: newTodo.value.remindMode,
    remindRules: newTodo.value.remindRules,
    created_at: String(nowMs),
    updated_at: String(nowMs)
  }

  const ok = await withDbWrite(() => clipboardService.insertTodo(todo))
  if (!ok) return
  prepend(todo)
  statsTodos.value.unshift(todo)
  void reminderService.sync(statsTodos.value)
  resetForm()

  showAddForm.value = false
}

const resetForm = () => {
  newTodo.value = {
    title: '',
    description: '',
    priorityLevel: 127,
    category: '其他',
    dueDate: '',
    remindMode: 'smart',
    remindRules: []
  }
}

const toggleTodo = async (id: string) => {
  const todo = todos.value.find(t => t.id === id)
  if (todo) {
    const prevCompleted = todo.completed
    const prevUpdatedAt = todo.updated_at
    const completing = todo.completed === 0
    todo.completed = completing ? 1 : 0
    todo.updated_at = String(Date.now())
    const ok = await withDbWrite(() => clipboardService.updateTodo(todo))
    if (!ok) {
      // 写库失败：回滚乐观更新，保证 UI 与数据库一致
      todo.completed = prevCompleted
      todo.updated_at = prevUpdatedAt
      return
    }
    // 完成状态变化影响提醒计划，同步给调度服务（完成 → 撤销其全部提醒）
    applyToStats(todo)
    void reminderService.sync(statsTodos.value)
    // 统计埋点（fire-and-forget）：仅"切换为完成"时 +1
    if (completing) void statsService.record({ todo_completed: 1 })
  }
}

const updateTodo = async (id: string, updates: Partial<Todo>) => {
  const todo = todos.value.find(t => t.id === id)
  if (todo) {
    Object.assign(todo, updates, { updated_at: String(Date.now()) })
    const ok = await withDbWrite(() => clipboardService.updateTodo(todo))
    if (!ok) return
    // 截止时间/提醒设置/完成状态可能变化，同步给调度服务重排
    applyToStats(todo)
    void reminderService.sync(statsTodos.value)
  }
}

/** 点击待办删除按钮：弹出内联删除确认框 */
const deleteTodo = (id: string, rect?: DOMRect) => {
  deleteConfirmAction = 'todo'
  deleteConfirmId = id
  deleteConfirmMessage.value = t('todo.deleteTaskConfirm')
  deleteConfirmAnchor.value = rect ?? null
  deleteConfirmVisible.value = true
}

/** 确认后真正执行待办删除 */
async function executeTodoDelete(id: string) {
  const ok = await withDbWrite(() => clipboardService.deleteTodo(id))
  if (!ok) return
  removeTodo(t => t.id === id)
  statsTodos.value = statsTodos.value.filter(t => t.id !== id)
  void reminderService.sync(statsTodos.value)
}

/** 优先级等级变更：持久化后由 sync/徽章响应式跟随 */
const changePriorityLevel = async (id: string, level: number) => {
  const todo = todos.value.find(t => t.id === id)
  if (todo) {
    todo.priorityLevel = level
    todo.updated_at = String(Date.now())
    await withDbWrite(() => clipboardService.updateTodo(todo))
    applyToStats(todo)
  }
}

/** 等级列表被管理器修改后：把引用了已删档位的待办重映射到最近档位 */
watch(priorityLevels, async (levels) => {
  const ls = levels.map(l => l.level)
  const changed: Todo[] = []
  for (const t of todos.value) {
    if (!ls.includes(t.priorityLevel ?? 127)) {
      t.priorityLevel = nearestLevel(t.priorityLevel ?? 127)
      t.updated_at = String(Date.now())
      changed.push(t)
    }
  }
  if (changed.length > 0) {
    await withDbWrite(async () => { await Promise.all(changed.map(t => clipboardService.updateTodo(t))) })
    changed.forEach(applyToStats)
  }
})

const changeCategory = async (id: string, category: string) => {
  const todo = todos.value.find(t => t.id === id)
  if (todo) {
    todo.category = category
    todo.updated_at = String(Date.now())
    await withDbWrite(() => clipboardService.updateTodo(todo))
    applyToStats(todo)
  }
}

/** 提醒设置（智能 / 多闹钟规则 / 不提醒）：持久化后同步调度服务重排 */
const changeReminder = async (id: string, mode?: Todo['remindMode'], rules?: ReminderRule[]) => {
  await updateTodo(id, {
    remindMode: mode || 'smart',
    remindRules: rules || [],
    remindAt: ''
  })
}

/** 分类列表（含用户增删后的状态） */
const { categories, addCategory, removeCategory } = useCategories()

// ===== 删除确认（DeleteConfirm 内联组件，样式/操作与便签一致）=====
const deleteConfirmVisible = ref(false)
const deleteConfirmMessage = ref('')
/** 触发删除按钮的位置（供 DeleteConfirm 就近定位） */
const deleteConfirmAnchor = ref<DOMRect | null>(null)
let deleteConfirmAction: 'todo' | 'category' | null = null
let deleteConfirmId: string | null = null

/** 点击分类 ×：弹出内联删除确认框 */
const handleCategoryDelete = (name: string, rect?: DOMRect) => {
  deleteConfirmAction = 'category'
  deleteConfirmId = name
  deleteConfirmMessage.value = t('todo.deleteCategoryConfirm')
  deleteConfirmAnchor.value = rect ?? null
  deleteConfirmVisible.value = true
}

/** 确认删除：执行对应删除动作并关闭确认框 */
const onDeleteConfirm = () => {
  const action = deleteConfirmAction
  const id = deleteConfirmId
  deleteConfirmVisible.value = false
  deleteConfirmAction = null
  deleteConfirmId = null
  deleteConfirmAnchor.value = null
  if (action === 'todo' && id) void executeTodoDelete(id)
  else if (action === 'category' && id) void executeCategoryDelete(id)
}

/** 取消删除：仅关闭确认框 */
const onDeleteCancel = () => {
  deleteConfirmVisible.value = false
  deleteConfirmAction = null
  deleteConfirmId = null
  deleteConfirmAnchor.value = null
}

/** 确认后真正执行分类删除：持久化 + 清理使用该分类的待办（重置为剩余第一个分类） */
async function executeCategoryDelete(name: string) {
  const ok = await removeCategory(name)
  if (!ok) return
  // 回退分类取剩余的第一个；分类被删光时回退到「其他」并补回列表，
  // 避免待办被赋成一个 CategorySelect 里选不回的悬空分类
  let fallback = categories.value[0] ?? '其他'
  if (!categories.value.includes(fallback)) {
    await addCategory(fallback)
  }
  for (const todo of todos.value) {
    if (todo.category === name) {
      todo.category = fallback
      todo.updated_at = String(Date.now())
      await withDbWrite(() => clipboardService.updateTodo(todo))
      applyToStats(todo)
    }
  }
  if (newTodo.value.category === name) newTodo.value.category = fallback
}

const setFilter = (filter: string) => {
  currentFilter.value = filter
}

const setSort = (sort: string) => {
  currentSort.value = sort
}

// 筛选/排序下拉：UiDropdown 统一管理开关（点击开/关、外部点击与 Escape 收起、选择后自动收起）

const fetchTodos = async (opts?: { force?: boolean }) => {
  // 上一轮未完成不重叠；写库进行中跳过本轮（防止拿旧数据覆盖乐观更新造成复选框回跳/竞态）
  if (fetching) return
  if (!opts?.force && pendingWrites > 0) return
  fetching = true
  try {
    // 确保调度服务已启动（幂等；正常由 app.vue 更早启动，此处兜底覆盖"直达待办 Tab"的场景）
    await reminderService.start()
    // 全量查询（500 条上限）仅用于统计卡片与提醒调度，不参与列表渲染
    const fetchedTodos = await clipboardService.fetchTodos({ value: { searchContent: '' } });
    statsTodos.value = fetchedTodos
    // 把最新列表同步给调度服务（内部按计划 diff，仅增删变化的定时器；首个 sync 处于补发阶段）
    void reminderService.sync(fetchedTodos)
    // 搜索态：保持搜索结果的实时刷新（全量 LIKE 查询，一次性展示全部匹配），不被普通列表覆盖
    const q = searchQuery.value.trim()
    if (q) {
      try {
        const matches = await clipboardService.fetchTodos({ value: { searchContent: q } })
        replace(matches)
      } catch (e) {
        console.error('搜索任务失败:', e)
      }
      return
    }
    // UI 仅刷新已加载范围（与 loadMore/reload 互斥；签名一致时跳过整表替换，避免全列表重渲染）
    await refreshLoaded()
  } catch (error) {
    console.error("Failed to fetch todos:", error);
  } finally {
    fetching = false
  }
}

// ===== 搜索：全量查库一次性展示全部匹配（涵盖未加载任务）；清空搜索重置为流式第一页 =====
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchQuery, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void onSearchQueryChange(q.trim()), 300)
})

async function onSearchQueryChange(q: string) {
  if (!q) {
    // 等待轮询中的全量刷新结束再重置（busy 互斥导致跳过时最多重试 2 秒）
    while (fetching) await new Promise(r => setTimeout(r, 50))
    for (let i = 0; i < 20; i++) {
      if (await reload()) break
      await new Promise(r => setTimeout(r, 100))
    }
    return
  }
  try {
    const matches = await clipboardService.fetchTodos({ value: { searchContent: q } })
    replace(matches)
  } catch (e) {
    console.error('搜索任务失败:', e)
  }
}

// 生命周期
onMounted(async () => {
  await fetchTodos() // 先完成首次加载并进入调度（含启动补发汇总）

  // 方向键下移到已加载末尾时，触发加载下一页（todoStore 由全局方向键命令驱动）
  setTodoLoadMoreHook(() => { if (hasMore.value) void loadMore() })

  // Ctrl+F：聚焦待办搜索框
  window.addEventListener('focus-search', onFocusSearch)

  // Ctrl+Enter：进入选中待办的编辑态
  window.addEventListener('todo:edit-request', onEditRequest)

  // 仅在 Tauri 桌面容器内定时从数据库刷新列表（数据同步用；提醒由调度服务的精确定时器负责）。
  // 3s 粒度 + in-flight 去重 + 签名跳过 + 写库期间挂起；窗口隐藏（托盘驻留）时暂停轮询。
  if (isTauri()) {
    pollTimer = setInterval(() => {
      if (!document.hidden) void fetchTodos()
    }, 3000)
    // 窗口重新可见时立即刷新一次
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
})

/** 窗口从隐藏恢复可见：立即拉取一次，弥补暂停期间的空窗 */
const onVisibilityChange = () => {
  if (!document.hidden) void fetchTodos()
}

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  document.removeEventListener('visibilitychange', onVisibilityChange)
  // 提醒定时器由主窗口的 reminderService 持有，切 Tab 卸载本组件不影响提醒
  setTodoLoadMoreHook(null)
  if (searchTimer) clearTimeout(searchTimer)
  window.removeEventListener('focus-search', onFocusSearch)
  window.removeEventListener('todo:edit-request', onEditRequest)
})

/** 列表同步：过滤排序结果 → todoStore（供方向键选择/编辑使用），并修正越界选中 */
watch(filteredAndSortedTodos, (list) => {
  todoList.value = list
  if (selectedTodoIndex.value >= list.length) {
    selectedTodoIndex.value = Math.max(0, list.length - 1)
  }
  if (selectedTodoIndex.value < 0) {
    selectedTodoIndex.value = 0
  }
}, { immediate: true })

/** Ctrl+Enter：让当前选中的待办进入编辑态 */
const onEditRequest = () => {
  if (todoList.value.length === 0) return
  editSignal.value += 1
}

/** 点击列表行：选中对应索引 */
const selectTodoIndex = (index: number) => {
  selectTodo(index)
}

/** Ctrl+F 聚焦待办搜索框 */
const onFocusSearch = () => {
  nextTick(() => todoSearchInput.value?.focus())
}
</script>