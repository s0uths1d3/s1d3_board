<template>
  <div class="min-h-screen p-4">
    <div class="relative max-w-7xl mx-auto">
      <div class="mb-6 flex items-center justify-between">
        <button
            @click="createNote"
            class="btn btn-primary btn-lg shadow-lg hover:shadow-xl transition-all duration-200"
        >
          新建便签
          <svg class="w-5 h-5 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
          </svg>
        </button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        <StickyNoteItem
            v-for="note in notes"
            :key="note.id"
            :note="note"
            @update="updateNote"
            @delete="deleteNote"
            @color-change="changeNoteColor"
        />
      </div>

      <div v-if="notes.length === 0" class="text-center py-20">
        <svg class="w-24 h-24 mx-auto text-gray-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
        </svg>
        <p class="text-gray-500 text-lg">还没有便签，点击上方按钮创建第一个便签吧！</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import StickyNoteItem from "./StickyNoteItem.vue";
import clipboardService from '~/src/db/dbService'
import { v4 as uuidv4 } from 'uuid'
import type { Note } from "~/src/Entities";

interface StickyNote extends Note {
  position?: { x: number; y: number }
}

const notes = ref<StickyNote[]>([])

const colors = [
  { name: 'yellow', class: 'bg-yellow-200 border-yellow-300' },
  { name: 'pink', class: 'bg-pink-200 border-pink-300' },
  { name: 'blue', class: 'bg-blue-200 border-blue-300' },
  { name: 'green', class: 'bg-green-200 border-green-300' },
  { name: 'purple', class: 'bg-purple-200 border-purple-300' },
  { name: 'orange', class: 'bg-orange-200 border-orange-300' }
]

const createNote = async () => {
  const newNote: StickyNote = {
    id: uuidv4(),
    content: '',
    color: 'green',
    created_at: new Date().toString(),
    updated_at: new Date().toString()
  }
  await clipboardService.insertNote(newNote)
  notes.value.unshift(newNote)
}

const updateNote = async (id: string, content: string) => {
  const note = notes.value.find(n => n.id === id)
  if (note) {
    note.content = content
    note.updated_at = new Date().toString()
    await clipboardService.updateNote(note)
  }
}

const deleteNote = async (id: string) => {
  await clipboardService.deleteNote(id)
  const index = notes.value.findIndex(n => n.id === id)
  if (index > -1) {
    notes.value.splice(index, 1)
  }
}

const changeNoteColor = async (id: string, color: string) => {
  const note = notes.value.find(n => n.id === id)
  if (note) {
    note.color = color
    note.updated_at = new Date().toString()
    await clipboardService.updateNote(note)
  }
}

const fetchTodos = async () => {
  try {
    const fetchedNotes = await clipboardService.fetchNotes({ value: { searchContent: '' } })
    notes.value = fetchedNotes
  } catch (error) {
    console.error("Failed to fetch todos:", error);
  }
};

let intervalId;

onMounted(() => {
  intervalId = setInterval(fetchTodos, 1000);
});
</script>
