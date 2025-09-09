<template>
  <div class="bg-base-200 rounded-lg shadow-md hover:shadow-lg transition-all duration-200 overflow-hidden border border-base-300 group">
    <div class="p-4">
      <div class="flex items-start gap-3">
        <div class="pt-1">
          <input
              type="checkbox"
              :checked="todo.completed"
              @change="$emit('toggle', todo.id)"
              class="checkbox checkbox-primary checkbox-sm"
          />
        </div>

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <h3
                class="font-semibold text-base-content truncate"
                :class="{ 'line-through text-base-content/50': todo.completed }"
            >
              {{ todo.title }}
            </h3>

            <div
                class="badge badge-xs"
                :class="{
                'badge-error': todo.priority === 'high',
                'badge-warning': todo.priority === 'medium',
                'badge-success': todo.priority === 'low'
              }"
            >
              {{ priorityLabels[todo.priority] }}
            </div>

            <div class="badge badge-outline badge-xs border-base-400">
              {{ todo.category }}
            </div>
          </div>

          <p
              v-if="todo.description"
              class="text-sm text-base-content/70 mb-2"
              :class="{ 'line-through text-base-content/40': todo.completed }"
          >
            {{ todo.description }}
          </p>

          <div class="flex items-center justify-between">
            <div class="text-xs text-base-content/50">
              {{ formatDate(parseInt(todo.created_at))}}
            </div>

            <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                  @click="startEditing"
                  class="btn btn-ghost btn-xs btn-circle hover:bg-base-300"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                </svg>
              </button>

              <!-- 优先级选择 -->
              <div class="dropdown dropdown-end">
                <label tabindex="0" class="btn btn-ghost btn-xs btn-circle hover:bg-base-300">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4"></path>
                  </svg>
                </label>
                <ul tabindex="0" class="dropdown-content menu p-2 shadow bg-base-200 rounded-box w-32 border border-base-300">
                  <li v-for="(label, priority) in priorityLabels" :key="priority">
                    <a @click="$emit('priority-change', todo.id, priority)" class="hover:bg-base-300">
                      <span class="badge badge-xs" :class="{
                        'badge-error': priority === 'high',
                        'badge-warning': priority === 'medium',
                        'badge-success': priority === 'low'
                      }"></span>
                      {{ label }}
                    </a>
                  </li>
                </ul>
              </div>

              <div class="dropdown dropdown-end">
                <label tabindex="0" class="btn btn-ghost btn-xs btn-circle hover:bg-base-300">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path>
                  </svg>
                </label>
                <ul tabindex="0" class="dropdown-content menu p-2 shadow bg-base-200 rounded-box w-32 border border-base-300">
                  <li v-for="category in categories" :key="category">
                    <a @click="$emit('category-change', todo.id, category)" class="hover:bg-base-300">{{ category }}</a>
                  </li>
                </ul>
              </div>

              <button
                  @click="deleteTodo"
                  class="btn btn-ghost btn-xs btn-circle text-red-400 hover:text-red-300 hover:bg-red-900/20"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="isEditing" class="mt-4 p-4 bg-base-300 rounded-lg">
        <div class="space-y-3">
          <input
              v-model="editTitle"
              type="text"
              class="input input-bordered input-sm w-full bg-base-200 text-base-content placeholder-base-content/50 border-base-400"
              placeholder="任务标题"
          />
          <textarea
              v-model="editDescription"
              class="textarea textarea-bordered textarea-sm w-full bg-base-200 text-base-content placeholder-base-content/50 border-base-400"
              placeholder="任务描述（可选）"
              rows="2"
          ></textarea>
          <div class="flex gap-2">
            <button @click="saveEdit" class="btn btn-primary btn-sm">
              保存
            </button>
            <button @click="cancelEdit" class="btn btn-ghost btn-sm hover:bg-base-300">
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type {Todo} from "~/src/Entities";
import {formatDate} from "~/src/utils/formatDate";


const props = defineProps<{
  todo: Todo
}>()

const emit = defineEmits<{
  (e: 'toggle', id: string): void
  (e: 'update', id: string, updates: Partial<Todo>): void
  (e: 'delete', id: string): void
  (e: 'priority-change', id: string, priority: Todo['priority']): void
  (e: 'category-change', id: string, category: string): void
}>()

const isEditing = ref(false)
const editTitle = ref('')
const editDescription = ref('')

const priorityLabels = {
  high: '高',
  medium: '中',
  low: '低'
}

const categories = ['工作', '学习', '生活', '娱乐', '其他']

const startEditing = () => {
  isEditing.value = true
  editTitle.value = props.todo.title
  editDescription.value = props.todo.description || ''
}

const saveEdit = () => {
  if (!editTitle.value.trim()) return

  emit('update', props.todo.id, {
    title: editTitle.value.trim(),
    description: editDescription.value.trim()
  })

  isEditing.value = false
}

const cancelEdit = () => {
  isEditing.value = false
}

const deleteTodo = () => {
  emit('delete', props.todo.id)
}
</script>