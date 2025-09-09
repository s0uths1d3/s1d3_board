<template>
  <div class="min-h-screen p-4">
    <div class="max-w-6xl mx-auto">
      <div class="mb-8">
        <h1 class="text-4xl font-bold text-base-content mb-4">任务清单</h1>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div class="stat bg-base-200 rounded-lg shadow-md border border-base-300">
            <div class="stat-figure text-primary">
              <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>
              </svg>
            </div>
            <div class="stat-title text-base-content/70">总任务</div>
            <div class="stat-value text-primary">{{ todos.length }}</div>
          </div>

          <div class="stat bg-base-200 rounded-lg shadow-md border border-base-300">
            <div class="stat-figure text-warning">
              <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <div class="stat-title text-base-content/70">进行中</div>
            <div class="stat-value text-warning">{{ pendingCount }}</div>
          </div>

          <div class="stat bg-base-200 rounded-lg shadow-md border border-base-300">
            <div class="stat-figure text-success">
              <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            </div>
            <div class="stat-title text-base-content/70">已完成</div>
            <div class="stat-value text-success">{{ completedCount }}</div>
          </div>

          <div class="stat bg-base-200 rounded-lg shadow-md border border-base-300">
            <div class="stat-figure text-info">
              <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
              </svg>
            </div>
            <div class="stat-title text-base-content/70">完成率</div>
            <div class="stat-value text-info">{{ completionRate }}%</div>
          </div>
        </div>
      </div>

      <div class="bg-base-200 rounded-lg shadow-md p-4 mb-6 border border-base-300">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold text-base-content">添加新任务</h2>
          <button
              @click="toggleAddForm"
              class="btn btn-ghost btn-sm"
          >
            {{ showAddForm ? '收起' : '展开' }}
            <svg
                class="w-4 h-4 ml-1 transform transition-transform"
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
          <div class="form-control">
            <input
                v-model="newTodo.title"
                type="text"
                placeholder="任务标题 *"
                class="input input-bordered w-full bg-base-300 text-base-content placeholder-base-content/50 border-base-400"
                @keyup.enter="newTodo.title ? $refs.descriptionInput?.focus() : null"
            />
          </div>

          <div class="form-control">
            <textarea
                ref="descriptionInput"
                v-model="newTodo.description"
                class="textarea textarea-bordered w-full bg-base-300 text-base-content placeholder-base-content/50 border-base-400"
                placeholder="任务描述（可选）"
                rows="2"
            ></textarea>
          </div>

          <div style="display: flex;justify-content: space-between">
            <div class="form-control">
              <label class="label">
                <span class="label-text text-base-content/70">优先级</span>
              </label>
              <select
                  v-model="newTodo.priority"
                  class="select select-bordered bg-base-300 text-base-content border-base-400"
              >
                <option value="low">低优先级</option>
                <option value="medium">中优先级</option>
                <option value="high">高优先级</option>
              </select>
            </div>

            <div class="form-control">
              <label class="label">
                <span class="label-text text-base-content/70">截止日期</span>
              </label>
              <input
                  v-model="newTodo.dueDate"
                  type="datetime-local"
                  class="input input-bordered w-full bg-base-300 text-base-content border-base-400"
              />
            </div>

            <div class="form-control">
              <label class="label">
                <span class="label-text text-base-content/70">分类</span>
              </label>
              <select
                  v-model="newTodo.category"
                  class="select select-bordered bg-base-300 text-base-content border-base-400"
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
                class="btn btn-primary"
                :disabled="!newTodo.title.trim()"
            >
              <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
              </svg>
              添加任务
            </button>
            <button
                @click="resetForm"
                class="btn btn-ghost hover:bg-base-300"
            >
              重置
            </button>
          </div>
        </div>
      </div>

      <div class="bg-base-200 rounded-lg shadow-md p-4 mb-6 border border-base-300">
        <div class="flex flex-col lg:flex-row gap-4">
          <div class="flex gap-2 flex-1">
            <div class="form-control">
              <input
                  v-model="searchQuery"
                  type="text"
                  placeholder="搜索任务..."
                  class="input input-bordered input-sm w-64 bg-base-300 text-base-content placeholder-base-content/50 border-base-400"
              />
            </div>

            <div class="dropdown dropdown-end">
              <label tabindex="0" class="btn btn-sm btn-outline border-base-400 hover:bg-base-300">
                {{ currentFilter }}
                <svg class="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                </svg>
              </label>
              <ul tabindex="0" class="dropdown-content menu p-2 shadow bg-base-200 rounded-box w-32 border border-base-300">
                <li v-for="filter in filters" :key="filter.value">
                  <a @click="setFilter(filter.value)" class="hover:bg-base-300">{{ filter.label }}</a>
                </li>
              </ul>
            </div>

            <div class="dropdown dropdown-end">
              <label tabindex="0" class="btn btn-sm btn-outline border-base-400 hover:bg-base-300">
                排序
                <svg class="w-4 h-4 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"></path>
                </svg>
              </label>
              <ul tabindex="0" class="dropdown-content menu p-2 shadow bg-base-200 rounded-box w-40 border border-base-300">
                <li v-for="sort in sortOptions" :key="sort.value">
                  <a @click="setSort(sort.value)" class="hover:bg-base-300">{{ sort.label }}</a>
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

      <div v-if="filteredAndSortedTodos.length === 0" class="text-center py-20">
        <svg class="w-24 h-24 mx-auto text-base-content/30 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path>
        </svg>
        <p class="text-base-content/50 text-lg">
          {{ todos.length === 0 ? '还没有任务，添加第一个任务吧！' : '没有符合条件的任务' }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import TodoItem from './Todoitem.vue'
import clipboardService from '~/src/db/dbService'
import { v4 as uuidv4 } from 'uuid'
import type {Todo} from '~/src/Entities'

const todos = ref<Todo[]>([])

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

  // 每秒检查一次截止时间
  setInterval(() => {
    fetchTodos()
    checkDueDateNotifications() // 使用默认配置
  }, 1000)
})
</script>