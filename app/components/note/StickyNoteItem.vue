<template>
  <div
      class="glass-card group relative min-h-[200px] cursor-pointer rounded-2xl p-4 shadow-soft transition-all duration-300 ease-soft hover:-translate-y-1 hover:shadow-float"
      :class="getColorClass(note.color || 'yellow')"
      @dblclick="startEditing"
  >
    <div class="mb-2 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <button
            @click="startEditing"
            class="btn-soft btn-circle p-2 opacity-0 transition-opacity duration-300 ease-soft group-hover:opacity-100"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
          </svg>
        </button>
        <div class="dropdown">
          <label tabindex="0" class="btn-soft btn-circle p-2 opacity-0 transition-opacity duration-300 ease-soft group-hover:opacity-100">
            <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"></path>
            </svg>
          </label>
          <ul tabindex="0" class="dropdown-content glass-card menu w-32 rounded-2xl p-2">
            <li v-for="color in colors" :key="color.name">
              <a
                  @click="$emit('color-change', note.id, color.name)"
                  class="flex items-center gap-2 rounded-lg hover:bg-secondary"
              >
                <span class="h-4 w-4 rounded-full" :class="color.class"></span>
                <span class="text-xs">{{ color.name }}</span>
              </a>
            </li>
          </ul>
        </div>
      </div>

      <button
          @click="deleteNote"
          class="btn-soft btn-circle p-2 text-[rgba(176,92,92,1)] opacity-0 transition-opacity duration-300 ease-soft hover:bg-[rgba(196,122,122,0.12)] group-hover:opacity-100"
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
        </svg>
      </button>
    </div>

    <div v-if="!isEditing" class="whitespace-pre-wrap break-words select-none text-ink">
      {{ note.content || '双击编辑内容...' }}
    </div>

    <div v-else class="relative">
      <textarea
          v-model="editContent"
          ref="textareaRef"
          class="h-32 w-full resize-none bg-surface-field p-2 text-ink outline-none rounded-lg"
          placeholder="输入便签内容..."
          @blur="saveEdit"
          @keydown.ctrl.enter="saveEdit"
      ></textarea>
      <div class="absolute bottom-2 right-2 text-xs text-ink-faint">
        Ctrl+Enter 保存
      </div>
    </div>

    <div class="absolute bottom-2 left-2 text-xs text-ink-faint opacity-0 transition-opacity duration-300 ease-soft group-hover:opacity-100">
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
  { name: 'blue', class: 'bg-[rgba(186,206,224,0.55)] border border-[rgba(140,170,200,0.5)]' },
  { name: 'yellow', class: 'bg-[rgba(224,212,170,0.55)] border border-[rgba(200,180,120,0.5)]' },
  { name: 'pink', class: 'bg-[rgba(224,196,200,0.55)] border border-[rgba(200,150,160,0.5)]' },
  { name: 'green', class: 'bg-[rgba(196,214,186,0.55)] border border-[rgba(150,180,140,0.5)]' },
  { name: 'purple', class: 'bg-[rgba(206,196,224,0.55)] border border-[rgba(170,150,200,0.5)]' },
  { name: 'orange', class: 'bg-[rgba(224,200,176,0.55)] border border-[rgba(200,160,120,0.5)]' }
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
