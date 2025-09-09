<template>
  <div
      class="relative group"
      :class="[
      getColorClass(note.color || 'yellow'),
      'p-4 rounded-lg shadow-md hover:shadow-xl transition-all duration-200 cursor-pointer border-2 min-h-[200px] transform hover:scale-105'
    ]"
      @dblclick="startEditing"
  >
    <div class="flex items-center justify-between mb-2">
      <div class="flex items-center space-x-2">
        <button
            @click="startEditing"
            class="btn btn-ghost btn-xs btn-circle opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
          </svg>
        </button>
        <div class="dropdown">
          <label tabindex="0" class="btn btn-ghost btn-xs btn-circle opacity-0 group-hover:opacity-100 transition-opacity">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"></path>
            </svg>
          </label>
          <ul tabindex="0" class="dropdown-content menu p-2 shadow-lg bg-base-100 rounded-box w-32">
            <li v-for="color in colors" :key="color.name">
              <a
                  @click="$emit('color-change', note.id, color.name)"
                  class="flex items-center space-x-2"
              >
                <span class="w-4 h-4 rounded-full" :class="color.class"></span>
                <span class="text-xs">{{ color.name }}</span>
              </a>
            </li>
          </ul>
        </div>
      </div>

      <button
          @click="deleteNote"
          class="btn btn-ghost btn-xs btn-circle opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-700"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
        </svg>
      </button>
    </div>

    <div v-if="!isEditing" class="text-gray-700 whitespace-pre-wrap break-words select-none">
      {{ note.content || '双击编辑内容...' }}
    </div>

    <div v-else class="relative">
      <textarea
          v-model="editContent"
          ref="textareaRef"
          class="w-full h-32 p-2 bg-transparent resize-none outline-none text-gray-700"
          placeholder="输入便签内容..."
          @blur="saveEdit"
          @keydown.ctrl.enter="saveEdit"
      ></textarea>
      <div class="absolute bottom-2 right-2 text-xs text-gray-500">
        Ctrl+Enter 保存
      </div>
    </div>

    <div class="absolute bottom-2 left-2 text-xs text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
      {{ formatDate(parseInt(note.updated_at)) }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue'
import type { Note } from '~/src/Entities';
import {formatDate} from "~/src/utils/formatDate";

const props = defineProps<{
  note: Note
}>()

const emit = defineEmits<{
  (e: 'update', id: string, content: string): void
  (e: 'delete', id: string): void
  (e: 'color-change', id: string, color: string): void
}>()

const isEditing = ref(false)
const editContent = ref('')
const textareaRef = ref<HTMLTextAreaElement>()

const colors = [
  { name: 'blue', class: 'bg-blue-200 border-blue-300' },
  { name: 'yellow', class: 'bg-yellow-200 border-yellow-300' },
  { name: 'pink', class: 'bg-pink-200 border-pink-300' },
  { name: 'green', class: 'bg-green-200 border-green-300' },
  { name: 'purple', class: 'bg-purple-200 border-purple-300' },
  { name: 'orange', class: 'bg-orange-200 border-orange-300' }
]

const getColorClass = (color: string) => {
  const colorObj = colors.find(c => c.name === color)
  return colorObj ? colorObj.class : colors[0]!.class
}

const startEditing = () => {
  isEditing.value = true
  editContent.value = props.note.content
  nextTick(() => {
    textareaRef.value?.focus()
  })
}

const saveEdit = () => {
  if (editContent.value !== props.note.content) {
    emit('update', props.note.id, editContent.value)
  }
  isEditing.value = false
}

const deleteNote = () => {
  emit('delete', props.note.id)
}
</script>
