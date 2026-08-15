<template>
  <div class="glass-card group overflow-hidden rounded-2xl p-4 shadow-soft transition-all duration-300 ease-soft hover:-translate-y-1 hover:shadow-float">
    <div class="p-0">
      <div class="flex items-start gap-3">
        <div class="pt-1">
          <input
              type="checkbox"
              :checked="todo.completed"
              @change="$emit('toggle', todo.id)"
              class="h-5 w-5 cursor-pointer rounded border-accent accent-gold"
          />
        </div>

        <div class="min-w-0 flex-1">
          <div class="mb-1 flex items-center gap-2">
            <h3
                class="truncate font-semibold text-ink"
                :class="{ 'text-ink-faint line-through': todo.completed }"
            >
              {{ todo.title }}
            </h3>

            <span
                class="rounded-full px-2 py-0.5 text-xs font-medium"
                :class="{
                'bg-[rgba(200,90,90,0.15)] text-[rgba(176,92,92,1)]': todo.priority === 'high',
                'bg-[rgba(196,167,125,0.2)] text-gold': todo.priority === 'medium',
                'bg-[rgba(140,170,120,0.2)] text-[#6f8a55]': todo.priority === 'low'
              }"
            >
              {{ priorityLabels[todo.priority] }}
            </span>

            <span class="rounded-full border border-accent px-2 py-0.5 text-xs text-ink-soft">
              {{ todo.category }}
            </span>
          </div>

          <p
              v-if="todo.description"
              class="mb-2 text-sm text-ink-soft"
              :class="{ 'text-ink-faint line-through': todo.completed }"
          >
            {{ todo.description }}
          </p>

          <div class="flex items-center justify-between">
            <div class="text-xs text-ink-faint">
              {{ formatDate(parseInt(todo.created_at))}}
            </div>

            <div class="flex items-center gap-1 opacity-0 transition-opacity duration-300 ease-soft group-hover:opacity-100">
              <button
                  @click="startEditing"
                  class="btn-soft btn-circle p-2"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                </svg>
              </button>

              <!-- 优先级选择 -->
              <div class="dropdown dropdown-end">
                <label tabindex="0" class="btn-soft btn-circle p-2">
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4"></path>
                  </svg>
                </label>
                <ul tabindex="0" class="dropdown-content glass-card menu w-32 rounded-2xl p-2">
                  <li v-for="(label, priority) in priorityLabels" :key="priority">
                    <a @click="$emit('priority-change', todo.id, priority)" class="flex items-center gap-2 rounded-lg hover:bg-secondary">
                      <span class="h-2 w-2 rounded-full" :class="{
                        'bg-[rgba(176,92,92,1)]': priority === 'high',
                        'bg-gold': priority === 'medium',
                        'bg-[#6f8a55]': priority === 'low'
                      }"></span>
                      {{ label }}
                    </a>
                  </li>
                </ul>
              </div>

              <div class="dropdown dropdown-end">
                <label tabindex="0" class="btn-soft btn-circle p-2">
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path>
                  </svg>
                </label>
                <ul tabindex="0" class="dropdown-content glass-card menu w-32 rounded-2xl p-2">
                  <li v-for="category in categories" :key="category">
                    <a @click="$emit('category-change', todo.id, category)" class="rounded-lg hover:bg-secondary">{{ category }}</a>
                  </li>
                </ul>
              </div>

              <button
                  @click="deleteTodo"
                  class="btn-soft btn-circle p-2 text-[rgba(176,92,92,1)] hover:bg-[rgba(196,122,122,0.12)]"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="isEditing" class="mt-4 rounded-xl bg-surface-field p-4">
        <div class="space-y-3">
          <input
              v-model="editTitle"
              type="text"
              class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
              placeholder="任务标题"
          />
          <textarea
              v-model="editDescription"
              class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
              placeholder="任务描述（可选）"
              rows="2"
          ></textarea>
          <div class="flex gap-2">
            <button @click="saveEdit" class="btn-gold">
              保存
            </button>
            <button @click="cancelEdit" class="btn-soft">
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