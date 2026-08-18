<template>
  <div class="min-h-screen p-4">
    <div class="max-w-6xl mx-auto">
      <div class="mb-8">
        <div class="gold-bar mb-4 inline-block">
          <h1 class="text-4xl font-bold text-ink">任务清单</h1>
        </div>

        <div class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
          <div class="glass-card rounded-2xl p-4 shadow-soft">
            <div class="mb-1 text-gold">
              <svg class="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>
              </svg>
            </div>
            <div class="text-xs uppercase tracking-wide text-ink-faint">总任务</div>
            <div class="text-2xl font-semibold text-ink">{{ todos.length }}</div>
          </div>

          <div class="glass-card rounded-2xl p-4 shadow-soft">
            <div class="mb-1 text-gold">
              <svg class="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <div class="text-xs uppercase tracking-wide text-ink-faint">进行中</div>
            <div class="text-2xl font-semibold text-ink">{{ pendingCount }}</div>
          </div>

          <div class="glass-card rounded-2xl p-4 shadow-soft">
            <div class="mb-1 text-gold">
              <svg class="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <div class="text-xs uppercase tracking-wide text-ink-faint">已完成</div>
            <div class="text-2xl font-semibold text-ink">{{ completedCount }}</div>
          </div>

          <div class="glass-card rounded-2xl p-4 shadow-soft">
            <div class="mb-1 text-gold">
              <svg class="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
              </svg>
            </div>
            <div class="text-xs uppercase tracking-wide text-ink-faint">完成率</div>
            <div class="text-2xl font-semibold text-ink">{{ completionRate }}%</div>
          </div>
        </div>
      </div>

      <div class="glass-card mb-6 rounded-2xl p-4 shadow-soft">
        <div class="mb-3 flex items-center justify-between">
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

        <div v-show="showAddForm" class="space-y-3">
          <input
              v-model="newTodo.title"
              type="text"
              placeholder="任务标题 *"
              class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
              @keyup.enter="newTodo.title ? $refs.descriptionInput?.focus() : null"
          />

          <textarea
              ref="descriptionInput"
              v-model="newTodo.description"
              class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
              placeholder="任务描述（可选）"
              rows="2"
          ></textarea>

          <div style="display: flex;justify-content: space-between">
            <div>
              <label class="mb-1 block text-ink-faint">优先级</label>
              <select
                  v-model="newTodo.priority"
                  class="rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none"
              >
                <option value="low">低优先级</option>
                <option value="medium">中优先级</option>
                <option value="high">高优先级</option>
              </select>
            </div>

            <div>
              <label class="mb-1 block text-ink-faint">截止日期</label>
              <input
                  v-model="newTodo.dueDate"
                  type="datetime-local"
                  class="rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none"
              />
            </div>

            <div>
              <label class="mb-1 block text-ink-faint">分类</label>
              <select
                  v-model="newTodo.category"
                  class="rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none"
              >
                <option v-for="category in categories" :key="category" :value="category">
                  {{ category }}
                </option>
              </select>
            </div>
          </div>

          <div class="flex gap-2">
            <button
                @click="addTodo"
                class="btn-gold flex items-center"
                :disabled="!newTodo.title.trim()"
            >
              <svg class="mr-2 h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
              </svg>
              添加任务
            </button>
            <button
                @click="resetForm"
                class="btn-soft"
            >
              重置
            </button>
          </div>
        </div>
      </div>

      <div class="glass-card mb-6 rounded-2xl p-4 shadow-soft">
        <div class="flex flex-col gap-4 lg:flex-row">
          <div class="flex flex-1 gap-2">
            <input
                v-model="searchQuery"
                type="text"
                placeholder="搜索任务..."
                class="w-64 rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
            />

            <div class="dropdown dropdown-end">
              <label tabindex="0" class="btn-soft flex items-center">
                {{ currentFilter }}
                <svg class="ml-1 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              <label tabindex="0" class="btn-soft flex items-center">
                排序
                <svg class="ml-1 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
            @toggle="toggleTodo"
            @update="updateTodo"
            @delete="deleteTodo"
            @priority-change="changePriority"
            @category-change="changeCategory"
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
const currentFilter = ref('全部')
const currentSort = ref('date-desc')

const filters = [
  { label: '全部', value: 'all' },
  { label: '进行中', value: 'pending' },
  { label: '已完成', value: 'completed' },
  { label: '高优先级', value: 'high' }
]

const sortOptions = [
  { label: '最新创建', value: 'date-desc' },
  { label: '最早创建', value: 'date-asc' },
  { label: '优先级', value: 'priority' },
  { label: '名称', value: 'name' }
]

const categories = ['工作', '学习', '生活', '娱乐', '其他']

// 通知相关
const notificationShown = ref(new Set()) // 用于记录已通知的任务ID
const notificationConfig = ref({
  allowMultiple: false, // 默认单次通知
  timeWindow: 1000 // ±1秒的时间窗口
})

// 辅助函数：格式化日期为datetime-local格式
const formatDateTimeForInput = (date = new Date()) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')

  return `${year}-${month}-${day}T${hours}:${minutes}`
}

// 计算属性
const pendingCount = computed(() => todos.value.filter(t => !t.completed).length)
const completedCount = computed(() => todos.value.filter(t => t.completed).length)
const completionRate = computed(() => {
  if (todos.value.length === 0) return 0
  return Math.round((completedCount.value / todos.value.length) * 100)
})

const filteredAndSortedTodos = computed(() => {
  let filtered = todos.value

  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase()
    filtered = filtered.filter(todo =>
        todo.title.toLowerCase().includes(query) ||
        (todo.description && todo.description.toLowerCase().includes(query))
    )
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
    // 设置默认截止日期为当前时间
    newTodo.value.dueDate = formatDateTimeForInput()

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
    dueDate: formatDateTimeForInput()
  }
}

const toggleTodo = async (id: string) => {
  const todo = todos.value.find(t => t.id === id)
  if (todo) {
    todo.completed = todo.completed === 0 ? 1 : 0
    todo.updated_at = new Date().toString()
    await clipboardService.updateTodo(todo)
  }
}

const updateTodo = async (id: string, updates: Partial<Todo>) => {
  const todo = todos.value.find(t => t.id === id)
  if (todo) {
    Object.assign(todo, updates, { updated_at: new Date().toString() })
    await clipboardService.updateTodo(todo)
  }
}

const deleteTodo = async (id: string) => {
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

const setFilter = (filter: string) => {
  currentFilter.value = filter
}

const setSort = (sort: string) => {
  currentSort.value = sort
}

const fetchTodos = async () => {
  try {
    const fetchedTodos = await clipboardService.fetchTodos({ value: { searchContent: '' } });
    todos.value = fetchedTodos;
  } catch (error) {
    console.error("Failed to fetch todos:", error);
  }
}

// 通知检查函数，接收配置参数
const checkDueDateNotifications = (config = notificationConfig.value) => {
  const now = new Date()
  const oneSecondBefore = new Date(now.getTime() - config.timeWindow)
  const oneSecondAfter = new Date(now.getTime() + config.timeWindow)

  todos.value.forEach(todo => {
    if (!todo.dueDate) return

    const dueDate = new Date(todo.dueDate)

    // 检查截止时间是否在当前时间的±1秒范围内
    if (dueDate >= oneSecondBefore && dueDate <= oneSecondAfter) {
      // 如果不允许多次通知，且已经通知过，则跳过
      if (!config.allowMultiple && notificationShown.value.has(todo.id)) {
        return
      }

      console.log('任务提醒:', todo)

      // 记录已通知（仅在单次通知模式下）
      if (!config.allowMultiple) {
        notificationShown.value.add(todo.id)
      }

      // 可选：显示浏览器通知
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('任务提醒', {
          body: `任务 "${todo.title}" 即将到期！`,
          icon: '/path/to/icon.png' // 可选：添加图标路径
        })
      }
    }
  })
}

// 请求通知权限
const requestNotificationPermission = () => {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

// 生命周期
onMounted(async () => {
  requestNotificationPermission() // 请求通知权限
  fetchTodos()

  // 仅在 Tauri 桌面容器内启用轮询（Web 端无数据，避免空转）
  if (isTauri()) {
    pollTimer = setInterval(() => {
      fetchTodos()
      checkDueDateNotifications() // 使用默认配置
    }, 1000)
  }
})

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})
</script>