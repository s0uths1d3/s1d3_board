<template>
  <div class="min-h-screen p-4">
    <div class="max-w-6xl mx-auto">
      <div class="mb-8">

        <div class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
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
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <div class="min-w-0 flex-1 text-xs uppercase tracking-wide text-ink-faint">进行中</div>
            <div class="text-xl font-semibold text-ink tabular-nums">{{ pendingCount }}</div>
          </div>

          <div class="glass-card flex items-center gap-3 rounded-2xl p-4 shadow-soft">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <div class="min-w-0 flex-1 text-xs uppercase tracking-wide text-ink-faint">已完成</div>
            <div class="text-xl font-semibold text-ink tabular-nums">{{ completedCount }}</div>
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
        </div>
      </div>

      <div
          class="glass-card mb-6 rounded-2xl shadow-soft transition-all duration-300 ease-soft"
          :class="showAddForm ? 'p-4' : 'p-4 pb-2.5'"
      >
        <div
            class="flex items-center justify-between"
            :class="showAddForm ? 'mb-3' : ''"
        >
          <h2 class="text-lg font-semibold text-ink">添加新任务</h2>
          <button
              @click="toggleAddForm"
              class="btn-soft flex items-center"
          >
            {{ showAddForm ? '收起' : '展开' }}
            <svg
                class="ml-1 h-4 w-4 transform transition-transform duration-300 ease-soft"
                :class="{ 'rotate-180': showAddForm }"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
            </svg>
          </button>
        </div>

        <div
            class="add-form-wrap overflow-hidden transition-all duration-300 ease-soft"
            :class="showAddForm ? 'is-open' : ''"
        >
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
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="flex flex-wrap items-center gap-4">
              <div class="flex items-center gap-2">
                <label class="whitespace-nowrap text-sm text-ink-faint">优先级</label>
                <select
                    v-model="newTodo.priority"
                    class="rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink focus:border-gold focus:outline-none"
                >
                  <option value="low">低优先级</option>
                  <option value="medium">中优先级</option>
                  <option value="high">高优先级</option>
                </select>
              </div>

              <div class="flex items-center gap-2">
                <label class="whitespace-nowrap text-sm text-ink-faint">截止日期</label>
                <DueTimeSelect v-model="newTodo.dueDate" />
              </div>

              <div class="flex items-center gap-2">
                <label class="whitespace-nowrap text-sm text-ink-faint">分类</label>
                <CategorySelect v-model="newTodo.category" @category-delete="handleCategoryDelete" />
              </div>
            </div>

            <div class="flex items-center gap-2">
              <button
                  type="button"
                  @click="addTodo"
                  title="添加任务"
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
                  title="重置"
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
                class="min-w-0 flex-1 rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
            />

            <div class="dropdown dropdown-end">
              <label tabindex="0" class="btn-soft flex items-center" @focusin="isFilterOpen = true" @focusout="isFilterOpen = false">
                {{ currentFilterLabel }}
                <svg class="ml-1 h-4 w-4 transform transition-transform duration-200" :class="{ 'rotate-180': isFilterOpen }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                </svg>
              </label>
              <ul tabindex="0" class="dropdown-content glass-card menu w-32 rounded-2xl p-2">
                <li v-for="filter in filters" :key="filter.value">
                  <a @click="setFilter(filter.value)" class="rounded-lg hover:bg-secondary">{{ filter.label }}</a>
                </li>
              </ul>
            </div>

            <div class="dropdown dropdown-end">
              <label tabindex="0" class="btn-soft flex items-center" @focusin="isSortOpen = true" @focusout="isSortOpen = false">
                排序
                <svg class="ml-1 h-4 w-4 transform transition-transform duration-200" :class="{ 'rotate-180': isSortOpen }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"></path>
                </svg>
              </label>
              <ul tabindex="0" class="dropdown-content glass-card menu w-40 rounded-2xl p-2">
                <li v-for="sort in sortOptions" :key="sort.value">
                  <a @click="setSort(sort.value)" class="rounded-lg hover:bg-secondary">{{ sort.label }}</a>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      <div class="space-y-3">
        <TodoItem
            v-for="todo in filteredAndSortedTodos"
            :key="todo.id"
            :todo="todo"
            :highlight-string="searchHighlightEnabled ? searchQuery : ''"
            :highlight="searchHighlightEnabled && searchQuery.trim() !== ''"
            @toggle="toggleTodo"
            @update="updateTodo"
            @delete="deleteTodo"
            @priority-change="changePriority"
            @category-change="changeCategory"
            @category-delete="handleCategoryDelete"
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
import { useSearchHighlight } from "~/composables/useSearchHighlight"
import { useCategories } from "~/composables/useCategories"
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import DeleteConfirm from '~/components/common/DeleteConfirm.vue'

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
const currentFilter = ref('全部')
const currentSort = ref('date-desc')

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

// 通知相关
const notificationShown = ref(new Set()) // 用于记录已通知的任务ID
const notificationConfig = ref({
  allowMultiple: false, // 默认单次通知
  timeWindow: 1000 // ±1秒的时间窗口
})

// 计算属性
const pendingCount = computed(() => todos.value.filter(t => !t.completed).length)
const completedCount = computed(() => todos.value.filter(t => t.completed).length)
const completionRate = computed(() => {
  if (todos.value.length === 0) return 0
  return Math.round((completedCount.value / todos.value.length) * 100)
})

/** 判断任务是否已逾期：有截止时间且早于当前时间。 */
const isOverdueTodo = (todo: Todo) =>
    !!todo.dueDate && new Date(todo.dueDate).getTime() < Date.now()

const filteredAndSortedTodos = computed(() => {
  let filtered = todos.value

  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase()
    filtered = filtered.filter(todo =>
        todo.title.toLowerCase().includes(query) ||
        (todo.description && todo.description.toLowerCase().includes(query))
    )
  }

  // 默认视图（全部/进行中/已完成/高优先级）不显示已逾期任务；
  // "已逾期"筛选显示所有已逾期任务，"逾期完成"筛选仅显示已完成且已逾期的任务。
  if (currentFilter.value === 'overdue') {
    filtered = filtered.filter(isOverdueTodo)
  } else if (currentFilter.value === 'overdue-completed') {
    filtered = filtered.filter(t => isOverdueTodo(t) && t.completed === 1)
  } else {
    filtered = filtered.filter(t => !isOverdueTodo(t))
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
const toggleAddForm = () => {
  showAddForm.value = !showAddForm.value
  if (showAddForm.value) {
    // 截止时间默认留空，由用户在快捷选择器中按需选择未来时间
    newTodo.value.dueDate = ''

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
    // 统计埋点（fire-and-forget）：仅"切换为完成"时 +1
    if (completing) void statsService.record({ todo_completed: 1 })
  }
}

const updateTodo = async (id: string, updates: Partial<Todo>) => {
  const todo = todos.value.find(t => t.id === id)
  if (todo) {
    Object.assign(todo, updates, { updated_at: new Date().toString() })
    await clipboardService.updateTodo(todo)
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
  await clipboardService.deleteTodo(id)
  const index = todos.value.findIndex(t => t.id === id)
  if (index > -1) {
    todos.value.splice(index, 1)
  }
  if (todo) {
    await sendSystemNotification('任务已删除', `任务 "${todo.title}" 已删除`)
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
  isFilterOpen.value = false
}

const setSort = (sort: string) => {
  currentSort.value = sort
  isSortOpen.value = false
}

// 下拉展开态：仅用于控制箭头旋转方向（展开动画本身由 CSS :focus-within 驱动）
const isFilterOpen = ref(false)
const isSortOpen = ref(false)

const fetchTodos = async () => {
  try {
    const fetchedTodos = await clipboardService.fetchTodos({ value: { searchContent: '' } });
    todos.value = fetchedTodos;
  } catch (error) {
    console.error("Failed to fetch todos:", error);
  }
}

// 发送系统原生通知（Tauri）
const sendSystemNotification = async (title: string, body: string) => {
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

// 通知检查函数，接收配置参数
const checkDueDateNotifications = async (config = notificationConfig.value) => {
  const now = new Date()
  const oneSecondBefore = new Date(now.getTime() - config.timeWindow)
  const oneSecondAfter = new Date(now.getTime() + config.timeWindow)

  for (const todo of todos.value) {
    if (!todo.dueDate) continue

    const dueDate = new Date(todo.dueDate)

    // 检查截止时间是否在当前时间的±1秒范围内
    if (dueDate >= oneSecondBefore && dueDate <= oneSecondAfter) {
      // 如果不允许多次通知，且已经通知过，则跳过
      if (!config.allowMultiple && notificationShown.value.has(todo.id)) {
        continue
      }

      console.log('任务提醒:', todo)

      // 记录已通知（仅在单次通知模式下）
      if (!config.allowMultiple) {
        notificationShown.value.add(todo.id)
      }

      // 发送系统原生通知
      await sendSystemNotification('任务提醒', `任务 "${todo.title}" 即将到期！`)
    }
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
  requestNotificationPermission() // 请求通知权限
  fetchTodos()

  // Ctrl+F：聚焦待办搜索框
  window.addEventListener('focus-search', onFocusSearch)

  // 仅在 Tauri 桌面容器内启用轮询（Web 端无数据，避免空转）
  if (isTauri()) {
    pollTimer = setInterval(() => {
      void fetchTodos()
      void checkDueDateNotifications().catch((error) => console.error('通知检查失败:', error))
    }, 1000)
  }
})

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  window.removeEventListener('focus-search', onFocusSearch)
})

/** Ctrl+F 聚焦待办搜索框 */
const onFocusSearch = () => {
  nextTick(() => todoSearchInput.value?.focus())
}
</script>