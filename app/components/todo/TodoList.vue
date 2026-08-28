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
            <div class="min-w-0 flex-1 text-xs uppercase tracking-wide text-ink-faint">总任务</div>
            <div class="text-xl font-semibold text-ink tabular-nums">{{ todos.length }}</div>
          </div>

          <div class="glass-card flex items-center gap-3 rounded-2xl p-4 shadow-soft">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
              </svg>
            </div>
            <div class="min-w-0 flex-1 text-xs uppercase tracking-wide text-ink-faint">完成率</div>
            <div class="text-xl font-semibold text-ink tabular-nums">{{ completionRate }}%</div>
          </div>

          <div class="glass-card flex items-center gap-3 rounded-2xl p-4 shadow-soft">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <div class="min-w-0 flex-1 text-xs uppercase tracking-wide text-ink-faint">准时率</div>
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
                placeholder="搜索任务..."
                class="todo-search-input min-w-0 flex-1 rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
            />

            <UiDropdown align="center" aria-label="筛选" panel-class="glass-card menu w-32 rounded-2xl p-2">
              <template #trigger="{ open }">
                <label class="btn-soft flex cursor-pointer items-center">
                  {{ currentFilterLabel }}
                  <svg class="ml-1 h-4 w-4 transform transition-transform duration-200" :class="{ 'rotate-180': open }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                  </svg>
                </label>
              </template>
              <ul class="menu p-2">
                <li v-for="filter in filters" :key="filter.value">
                  <a @click="setFilter(filter.value)" class="cursor-pointer rounded-lg hover:bg-secondary">{{ filter.label }}</a>
                </li>
              </ul>
            </UiDropdown>

            <UiDropdown align="center" aria-label="排序" panel-class="glass-card menu w-40 rounded-2xl p-2">
              <template #trigger="{ open }">
                <label class="btn-soft flex cursor-pointer items-center">
                  排序
                  <svg class="ml-1 h-4 w-4 transform transition-transform duration-200" :class="{ 'rotate-180': open }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"></path>
                  </svg>
                </label>
              </template>
              <ul class="menu p-2">
                <li v-for="sort in sortOptions" :key="sort.value">
                  <a @click="setSort(sort.value)" class="cursor-pointer rounded-lg hover:bg-secondary">{{ sort.label }}</a>
                </li>
              </ul>
            </UiDropdown>

            <!-- 新增任务：位于搜索框最右侧，点击下拉展开表单（与原先效果一致） -->
            <button
                @click="toggleAddForm"
                class="btn-gold ml-auto flex h-10 items-center gap-1.5 px-3"
                v-tip="showAddForm ? '收起' : '展开新增任务'"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
              </svg>
              <span class="hidden text-sm sm:inline">新增任务</span>
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
                  placeholder="任务标题 *"
                  class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
                  @keyup.enter="newTodo.title ? descriptionInput?.focus() : null"
              />

              <textarea
                  ref="descriptionInput"
                  v-model="newTodo.description"
                  class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
                  placeholder="任务描述（可选）"
                  rows="2"
              ></textarea>

              <!-- 控件 + 操作按钮 同一行：控件在左、按钮靠右；按钮采用纯图标形式 -->
              <div class="flex flex-nowrap items-center justify-between gap-4">
                <div class="flex flex-nowrap items-center gap-4 min-w-0">
                  <div class="flex items-center gap-2">
                    <label class="whitespace-nowrap text-sm text-ink-faint">优先级</label>
                    <PrioritySelect v-model="newTodo.priority" class="w-16" />
                  </div>

                  <div class="flex items-center gap-2">
                    <label class="whitespace-nowrap text-sm text-ink-faint">截止日期</label>
                    <DueTimeSelect v-model="newTodo.dueDate" placeholder="截止时间" class="w-36" />
                  </div>

                  <div class="flex items-center gap-2">
                    <label class="whitespace-nowrap text-sm text-ink-faint">分类</label>
                    <CategorySelect v-model="newTodo.category" placeholder="分类" class="w-28" @category-delete="handleCategoryDelete" />
                  </div>
                </div>

                <div class="flex shrink-0 items-center gap-2">
                  <button
                      type="button"
                      @click="addTodo"
                      v-tip="'添加任务'"
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
                      v-tip="'重置'"
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
            @priority-change="changePriority"
            @category-change="changeCategory"
            @category-delete="handleCategoryDelete"
            @select="selectTodoIndex(index)"
        />
      </div>

      <div v-if="filteredAndSortedTodos.length === 0" class="py-20 text-center">
        <svg class="mx-auto mb-4 h-24 w-24 text-ink-faint/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path>
        </svg>
        <p class="text-lg text-ink-faint">
          {{ todos.length === 0 ? '还没有任务，添加第一个任务吧！' : '没有符合条件的任务' }}
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
import type {Todo} from '~/src/Entities'
import {isTauri} from "~/src/utils/env"
import statsService from "~/src/statistics/statsService"
import DueTimeSelect from '~/components/todo/DueTimeSelect.vue'
import CategorySelect from '~/components/todo/CategorySelect.vue'
import PrioritySelect from '~/components/todo/PrioritySelect.vue'
import { useSearchHighlight } from "~/composables/useSearchHighlight"
import { useCategories } from "~/composables/useCategories"
import { useDueDateMemory } from "~/composables/useDueDateMemory"
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { playNotificationSound } from '~/src/utils/notifySound'
import DeleteConfirm from '~/components/common/DeleteConfirm.vue'
import { useNow } from '~/composables/useNow'
import { todoList, selectedTodoIndex, editSignal, selectTodo } from '~/src/commands/local/todoStore'

const todos = ref<Todo[]>([])
let pollTimer: ReturnType<typeof setInterval> | null = null

const showAddForm = ref(false)
const newTodo = ref({
  title: '',
  description: '',
  priority: 'medium' as Todo['priority'],
  category: '其他',
  dueDate: ''
})

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

const filters = [
  { label: '全部', value: 'all' },
  { label: '进行中', value: 'pending' },
  { label: '已完成', value: 'completed' },
  { label: '高优先级', value: 'high' },
  { label: '已逾期', value: 'overdue' },
  { label: '逾期完成', value: 'overdue-completed' }
]

const sortOptions = [
  { label: '最新创建', value: 'date-desc' },
  { label: '最早创建', value: 'date-asc' },
  { label: '优先级', value: 'priority' },
  { label: '名称', value: 'name' }
]

/** 筛选按钮显示的中文标签：value→label 映射（避免点击后显示英文 value） */
const currentFilterLabel = computed(() => filters.find(f => f.value === currentFilter.value)?.label ?? currentFilter.value)

// 逾期通知调度：为每个"未完成且有截止时间"的待办，精确在截止时刻用 setTimeout 触发一次系统通知。
// 任务新增/更新/删除时维护这些定时器，取代原先的每秒轮询检查。
const overdueTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 首次从数据库加载完成后才进行整体调度，避免轮询刷新时反复重建定时器 */
let scheduleInitialized = false

/** 取消某个任务的逾期通知定时器 */
function clearOverdueTimer(id: string) {
  const t = overdueTimers.get(id)
  if (t !== undefined) {
    clearTimeout(t)
    overdueTimers.delete(id)
  }
}

/** 为单个任务建立/重建逾期通知定时器（completed 或 无截止时间 的任务不建立） */
function scheduleOverdue(todo: Todo) {
  clearOverdueTimer(todo.id)
  if (todo.completed === 1 || !todo.dueDate) return
  const dueTime = new Date(todo.dueDate).getTime()
  const delay = dueTime - Date.now()
  if (delay <= 0) return // 已逾期：不补发历史通知
  const timer = setTimeout(() => {
    overdueTimers.delete(todo.id)
    // 触发时再核一次最新状态（任务可能已被完成 / 截止时间被改）
    const current = todos.value.find(t => t.id === todo.id)
    if (!current || current.completed === 1 || !current.dueDate) return
    const currentDue = new Date(current.dueDate).getTime()
    const remaining = currentDue - Date.now()
    // 若截止时间被改到更远的未来，重新调度；setTimeout 不保证精确到毫秒，
    // 允许最多提前 1 秒触发，避免"时间到了但没通知"。
    if (remaining > 1000) {
      scheduleOverdue(current)
      return
    }
    void sendSystemNotification('任务已逾期', `任务 "${current.title}" 已到达截止时间，请尽快处理。`)
  }, delay)
  overdueTimers.set(todo.id, timer)
}

/** 依据当前任务列表重建全部定时器（仅首次加载后调用一次） */
function rescheduleAll() {
  for (const id of [...overdueTimers.keys()]) clearOverdueTimer(id)
  for (const t of todos.value) scheduleOverdue(t)
}

// 计算属性
const pendingCount = computed(() => todos.value.filter(t => !t.completed).length)
const completedCount = computed(() => todos.value.filter(t => t.completed).length)
const completionRate = computed(() => {
  if (todos.value.length === 0) return 0
  return Math.round((completedCount.value / todos.value.length) * 100)
})

/** 准时率：在「已完成且有截止时间」的任务中，按时（截止前）完成的比例；无样本时显示 0% */
const onTimeRate = computed(() => {
  const finishedWithDue = todos.value.filter(t => t.completed && t.dueDate)
  if (finishedWithDue.length === 0) return 0
  const onTime = finishedWithDue.filter(t => !isOverdueTodo(t)).length
  return Math.round((onTime / finishedWithDue.length) * 100)
})

/** 判断任务是否已逾期：有截止时间且早于当前时间。 */
const isOverdueTodo = (todo: Todo) =>
    !!todo.dueDate && new Date(todo.dueDate).getTime() <= now.value

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
    filtered = filtered.filter(t => t.priority === 'high')
  }

  return [...filtered].sort((a, b) => {
    switch (currentSort.value) {
      case 'date-asc':
        return (parseInt(a.created_at || '0') || 0) - (parseInt(b.created_at || '0') || 0)
      case 'date-desc':
        return (parseInt(b.created_at || '0') || 0) - (parseInt(a.created_at || '0') || 0)
      case 'priority':
        const priorityOrder = { high: 0, medium: 1, low: 2 }
        return priorityOrder[a.priority] - priorityOrder[b.priority]
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
      const titleInput = document.querySelector('input[placeholder="任务标题 *"]') as HTMLInputElement
      titleInput?.focus()
    })
  }
}

const addTodo = async () => {
  if (!newTodo.value.title.trim()) return

  const todo: Todo = {
    id: uuidv4(),
    title: newTodo.value.title.trim(),
    description: newTodo.value.description.trim(),
    completed: 0,
    priority: newTodo.value.priority,
    category: newTodo.value.category,
    dueDate: newTodo.value.dueDate,
    created_at: new Date().toString(),
    updated_at: new Date().toString()
  }

  await clipboardService.insertTodo(todo)
  todos.value.unshift(todo)
  scheduleOverdue(todo)
  resetForm()

  showAddForm.value = false
}

const resetForm = () => {
  newTodo.value = {
    title: '',
    description: '',
    priority: 'medium',
    category: '其他',
    dueDate: ''
  }
}

const toggleTodo = async (id: string) => {
  const todo = todos.value.find(t => t.id === id)
  if (todo) {
    const completing = todo.completed === 0
    todo.completed = todo.completed === 0 ? 1 : 0
    todo.updated_at = new Date().toString()
    await clipboardService.updateTodo(todo)
    // 完成状态变化会影响是否需要逾期通知，重建该任务的定时器
    scheduleOverdue(todo)
    // 统计埋点（fire-and-forget）：仅"切换为完成"时 +1
    if (completing) void statsService.record({ todo_completed: 1 })
  }
}

const updateTodo = async (id: string, updates: Partial<Todo>) => {
  const todo = todos.value.find(t => t.id === id)
  if (todo) {
    Object.assign(todo, updates, { updated_at: new Date().toString() })
    await clipboardService.updateTodo(todo)
    // 截止时间或完成状态可能被修改，重建该任务的逾期通知定时器
    scheduleOverdue(todo)
  }
}

/** 点击待办删除按钮：弹出内联删除确认框 */
const deleteTodo = (id: string, rect?: DOMRect) => {
  deleteConfirmAction = 'todo'
  deleteConfirmId = id
  deleteConfirmMessage.value = '确定要删除该任务吗？'
  deleteConfirmAnchor.value = rect ?? null
  deleteConfirmVisible.value = true
}

/** 确认后真正执行待办删除 */
async function executeTodoDelete(id: string) {
  const todo = todos.value.find(t => t.id === id)
  clearOverdueTimer(id)
  await clipboardService.deleteTodo(id)
  const index = todos.value.findIndex(t => t.id === id)
  if (index > -1) {
    todos.value.splice(index, 1)
  }
}

const changePriority = async (id: string, priority: Todo['priority']) => {
  const todo = todos.value.find(t => t.id === id)
  if (todo) {
    todo.priority = priority
    todo.updated_at = new Date().toString()
    await clipboardService.updateTodo(todo)
  }
}

const changeCategory = async (id: string, category: string) => {
  const todo = todos.value.find(t => t.id === id)
  if (todo) {
    todo.category = category
    todo.updated_at = new Date().toString()
    await clipboardService.updateTodo(todo)
  }
}

/** 分类列表（含用户增删后的状态） */
const { categories, removeCategory } = useCategories()

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
  deleteConfirmMessage.value = '确定要删除该分类吗？'
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
  const fallback = categories.value[0] ?? '其他'
  for (const todo of todos.value) {
    if (todo.category === name) {
      todo.category = fallback
      todo.updated_at = new Date().toString()
      await clipboardService.updateTodo(todo)
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

const fetchTodos = async () => {
  try {
    const fetchedTodos = await clipboardService.fetchTodos({ value: { searchContent: '' } });
    todos.value = fetchedTodos;
    // 首次加载完成后整体调度一次逾期通知定时器（已逾期/已完成的任务不会建立定时器，故不会补发历史通知）
    if (!scheduleInitialized) {
      scheduleInitialized = true
      rescheduleAll()
    }
  } catch (error) {
    console.error("Failed to fetch todos:", error);
  }
}

// 发送系统原生通知（Tauri）+ 自定义提示音
const sendSystemNotification = async (title: string, body: string) => {
  // 始终播放自定义提示音（合成，不依赖系统默认通知音）
  playNotificationSound()

  if (!isTauri()) return

  try {
    let permissionGranted = await isPermissionGranted()
    if (!permissionGranted) {
      const permission = await requestPermission()
      permissionGranted = permission === 'granted'
    }
    if (permissionGranted) {
      sendNotification({ title, body })
    }
  } catch (error) {
    console.error('发送系统通知失败:', error)
  }
}

// 请求通知权限
const requestNotificationPermission = async () => {
  if (!isTauri()) return
  try {
    let permissionGranted = await isPermissionGranted()
    if (!permissionGranted) {
      await requestPermission()
    }
  } catch (error) {
    console.error('请求通知权限失败:', error)
  }
}

// 生命周期
onMounted(async () => {
  void requestNotificationPermission() // 请求通知权限
  await fetchTodos() // 先完成首次加载并调度历史任务的逾期通知

  // Ctrl+F：聚焦待办搜索框
  window.addEventListener('focus-search', onFocusSearch)

  // Ctrl+Enter：进入选中待办的编辑态
  window.addEventListener('todo:edit-request', onEditRequest)

  // 仅在 Tauri 桌面容器内定时从数据库刷新列表（数据同步用；逾期通知由精确定时器负责，不再轮询检查）
  if (isTauri()) {
    pollTimer = setInterval(() => {
      void fetchTodos()
    }, 1000)
  }
})

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  // 清理所有逾期通知定时器，避免组件卸载后误触发
  for (const id of [...overdueTimers.keys()]) clearOverdueTimer(id)
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