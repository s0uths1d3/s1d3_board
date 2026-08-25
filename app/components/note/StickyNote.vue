<template>
  <div class="min-h-full p-4">
    <div class="relative max-w-6xl mx-auto">
      <div class="mb-6 flex items-center">
        <button
            @click="createNote"
            class="btn-gold flex items-center shadow-soft transition-all duration-300 ease-soft hover:shadow-float"
        >
          新建便签
          <svg class="ml-2 h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
          </svg>
        </button>
      </div>

      <div ref="gridEl" class="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        <StickyNoteItem
            v-for="(note, idx) in displayNotes"
            :key="note.id"
            :note="note"
            :selected="selectedIndex === idx"
            :editing="editingId === note.id"
            @update="updateNote"
            @request-delete="onRequestDelete(note)"
            @color-change="changeNoteColor"
            @request-edit="editingId = note.id"
            @finish-edit="editingId = null"
            @select="selectedIndex = idx"
        />
      </div>

      <!-- 流式加载 sentinel：滚动接近底部时加载下一批便签 -->
      <div
          v-if="visibleCount < notes.length"
          ref="loadMoreEl"
          class="flex items-center justify-center py-6 text-xs text-ink-faint"
      >
        加载更多…
      </div>

      <div v-if="notes.length === 0" class="py-20 text-center">
        <svg class="mx-auto mb-4 h-24 w-24 text-ink-faint/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
        </svg>
        <p class="text-lg text-ink-faint">还没有便签，点击上方按钮创建第一个便签吧！</p>
      </div>
    </div>

    <!-- 即时反馈提示（toast） -->
    <div
        v-if="hint"
        class="pointer-events-none fixed left-1/2 top-20 z-[90] -translate-x-1/2 rounded-full border border-accent bg-surface-field/95 px-4 py-2 text-sm text-ink shadow-float backdrop-blur"
    >
      {{ hint }}
    </div>

    <!-- 删除确认框（复用 DeleteConfirmation.vue 设计） -->
    <div
        v-if="deleteConfirmTarget"
        role="alert"
        class="glass-card fixed top-1/2 left-1/2 z-50 flex w-[400px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-2xl p-6 shadow-float"
    >
      <div class="mb-4 flex w-full items-start gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
             class="mt-1 h-6 w-6 shrink-0 text-gold">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <div class="flex-1 font-bold text-ink">
          确定要删除吗？
        </div>
      </div>
      <div class="flex w-full justify-center gap-4">
        <button
            ref="confirmCancelBtn"
            class="btn-soft outline-none focus:ring-2 focus:ring-gold/60"
            @click="deleteConfirmTarget = null"
        >取消</button>
        <button
            ref="confirmOkBtn"
            class="btn-gold outline-none focus:ring-2 focus:ring-gold/60"
            @click="confirmDelete"
        >确定</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import StickyNoteItem from "./StickyNoteItem.vue";
import clipboardService from '~/src/db/dbService'
import { v4 as uuidv4 } from 'uuid'
import type { Note } from "~/src/Entities";
import {isTauri} from "~/src/utils/env";
import { shortcuts } from "~/src/commands/shortcuts/InitShortcuts";

interface StickyNote extends Note {
  position?: { x: number; y: number }
}

const notes = ref<StickyNote[]>([])

// 键盘选择态（响应式网格，列数动态获取）
const selectedIndex = ref(0)
const editingId = ref<string | null>(null)
const gridEl = ref<HTMLElement>()

// ===== 流式/分批渲染：首屏渲染一批，滚动接近底部时追加下一批 =====
const BATCH_SIZE = 40
const visibleCount = ref(BATCH_SIZE)
const displayNotes = computed(() => notes.value.slice(0, visibleCount.value))
const loadMoreEl = ref<HTMLElement>()
let loadMoreObserver: IntersectionObserver | null = null

/** 观察底部 sentinel，进入视口时加载下一批 */
function setupLoadMore() {
  loadMoreObserver?.disconnect()
  loadMoreObserver = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting) {
      visibleCount.value = Math.min(notes.value.length, visibleCount.value + BATCH_SIZE)
    }
  }, { rootMargin: '300px 0px' })
  if (loadMoreEl.value) loadMoreObserver.observe(loadMoreEl.value)
}

// 选中项移动时确保其卡片已渲染（未加载则扩展可见数量）
watch(selectedIndex, (idx) => {
  if (idx + 1 > visibleCount.value) {
    visibleCount.value = Math.min(notes.value.length, idx + 1)
  }
})

/** 新建便签快捷键是否为 Ctrl+N（默认配置或被污染为无修饰 N）——此时由页面捕获兜底直接新建 */
const ctrlNIsCreateShortcut = computed(() => {
  const s = shortcuts.value.find(x => x.id === 'create_note')
  if (!s || !s.enabled) return false
  const k = s.key.toLowerCase().replace(/\s+/g, '')
  return k === 'control+n' || k === 'n'
})

const colors = [
  { name: 'yellow', class: 'bg-[rgba(224,212,170,0.55)] border border-[rgba(200,180,120,0.5)]' },
  { name: 'pink', class: 'bg-[rgba(224,196,200,0.55)] border border-[rgba(200,150,160,0.5)]' },
  { name: 'blue', class: 'bg-[rgba(186,206,224,0.55)] border border-[rgba(140,170,200,0.5)]' },
  { name: 'green', class: 'bg-[rgba(196,214,186,0.55)] border border-[rgba(150,180,140,0.5)]' },
  { name: 'purple', class: 'bg-[rgba(206,196,224,0.55)] border border-[rgba(170,150,200,0.5)]' },
  { name: 'orange', class: 'bg-[rgba(224,200,176,0.55)] border border-[rgba(200,160,120,0.5)]' }
]

const createNote = async () => {
  const newNote: StickyNote = {
    id: uuidv4(),
    content: '',
    color: 'orange',
    created_at: new Date().toString(),
    updated_at: new Date().toString()
  }
  await clipboardService.insertNote(newNote)
  notes.value.unshift(newNote)
  nextTick(setupLoadMore)
  showHint('已新建便签')
}

/** Ctrl+N 新建便签（CreateNoteCommand 派发 create-note 事件） */
const onCreateNote = () => createNote()

// ===== 即时反馈提示（toast，复用主剪贴板 pinnedHint 样式） =====
const hint = ref('')
let hintTimer: ReturnType<typeof setTimeout> | null = null
const showHint = (msg: string) => {
  hint.value = msg
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = setTimeout(() => { hint.value = '' }, 2000)
}

// ===== 删除确认框（复用 DeleteConfirmation.vue 设计） =====
const deleteConfirmTarget = ref<StickyNote | null>(null)
const confirmOkBtn = ref<HTMLButtonElement>()
const confirmCancelBtn = ref<HTMLButtonElement>()

/** 请求删除：弹出确认框 */
const onRequestDelete = (note: StickyNote) => {
  deleteConfirmTarget.value = note
}

/** 确认删除 */
const confirmDelete = async () => {
  const target = deleteConfirmTarget.value
  if (!target) return
  deleteConfirmTarget.value = null
  await deleteNote(target.id)
  showHint('已删除')
}

/** 确认框打开时默认聚焦「确定」按钮，关闭后清空 ref */
watch(deleteConfirmTarget, (target) => {
  if (target) {
    nextTick(() => confirmOkBtn.value?.focus())
  }
})

const updateNote = async (id: string, content: string) => {
  const note = notes.value.find(n => n.id === id)
  if (note) {
    note.content = content
    note.updated_at = new Date().toString()
    await clipboardService.updateNote(note)
  }
}

const deleteNote = async (id: string) => {
  const index = notes.value.findIndex(n => n.id === id)
  await clipboardService.deleteNote(id)
  if (index > -1) {
    notes.value.splice(index, 1)
  }
  // 若删除的是正在编辑的项，退出编辑态
  if (editingId.value === id) editingId.value = null
  // 删除后修正选中索引，避免越界
  if (selectedIndex.value > notes.value.length - 1) {
    selectedIndex.value = Math.max(0, notes.value.length - 1)
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

/** 动态获取当前网格列数（响应式断点：1/2/3/4/5 列） */
function getColumnCount(): number {
  if (!gridEl.value) return 1
  const cols = getComputedStyle(gridEl.value).gridTemplateColumns
  const count = cols.split(' ').filter(Boolean).length
  return count > 0 ? count : 1
}

/** 把选中卡片滚动到可见区域 */
async function scrollSelectedIntoView() {
  await nextTick()
  const grid = gridEl.value
  const cards = grid?.querySelectorAll('.sticky-note-card')
  const el = cards?.[selectedIndex.value] as HTMLElement | undefined
  el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

/** 键盘交互：方向键移动选择，Delete 删除选中项；Ctrl+←/→ 交还全局切换标签；Ctrl+Enter 保存由快捷键系统处理 */
async function onKeydown(e: KeyboardEvent) {
  const active = document.activeElement
  const isEditingField = !!active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')

  // 删除确认框打开时：方向键/Tab 在「取消/确定」间切换焦点，Enter 触发当前按钮，Esc 取消，
  // Delete/Backspace 忽略（避免误触发重新弹框）。键盘操作作用于确认框，不作用于列表。
  if (deleteConfirmTarget.value) {
    const ok = confirmOkBtn.value
    const cancel = confirmCancelBtn.value
    const focusOnOk = document.activeElement === ok
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      if (focusOnOk) cancel?.focus()
      else ok?.focus()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (document.activeElement === cancel) deleteConfirmTarget.value = null
      else confirmDelete()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      deleteConfirmTarget.value = null
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      return
    }
  }

  // Ctrl+Enter：非编辑态进入编辑选中项；编辑态放行（由 textarea 兜底 / 快捷键系统保存）
  if (e.ctrlKey && e.key === 'Enter') {
    // 已有便签在编辑（无论焦点是否在输入框）：放行给保存逻辑，避免拦截后无法保存
    if (isEditingField || editingId.value !== null) return
    e.preventDefault()
    e.stopPropagation()
    if (notes.value[selectedIndex.value]) {
      editingId.value = notes.value[selectedIndex.value].id
    }
    return
  }

  // Ctrl+N：新建便签（页面兜底，快捷键系统未注册/未重启时也生效）
  if (e.ctrlKey && e.key.toLowerCase() === 'n' && ctrlNIsCreateShortcut.value) {
    e.preventDefault()
    e.stopPropagation()
    createNote()
    return
  }

  // 正在编辑文本时，其余按键交给输入框处理
  if (isEditingField) return
  // 其它 Ctrl/Meta/Alt 组合（如 Ctrl+←/→ 切换标签）不在此处理
  if (e.ctrlKey || e.metaKey || e.altKey) return

  const total = notes.value.length
  if (total === 0) return

  const columns = getColumnCount()
  let handled = true
  switch (e.key) {
    case 'ArrowUp':
      if (selectedIndex.value >= columns) selectedIndex.value -= columns
      break
    case 'ArrowDown':
      if (selectedIndex.value + columns < total) selectedIndex.value += columns
      break
    case 'ArrowLeft':
      if (selectedIndex.value > 0) selectedIndex.value -= 1
      break
    case 'ArrowRight':
      if (selectedIndex.value < total - 1) selectedIndex.value += 1
      break
    case 'Delete':
    case 'Backspace': {
      const note = notes.value[selectedIndex.value]
      if (note) onRequestDelete(note)
      break
    }
    default:
      handled = false
  }

  if (handled) {
    e.preventDefault()
    e.stopPropagation()
    if (e.key !== 'Delete' && e.key !== 'Backspace') await scrollSelectedIntoView()
  }
}

const fetchTodos = async () => {
  try {
    const fetchedNotes = await clipboardService.fetchNotes({ value: { searchContent: '' } })
    notes.value = fetchedNotes
    // 修正选中索引，避免列表刷新后越界
    if (selectedIndex.value > notes.value.length - 1) {
      selectedIndex.value = Math.max(0, notes.value.length - 1)
    }
    // 数据刷新后 sentinel 可能重新出现/消失，重新建立观察
    nextTick(setupLoadMore)
  } catch (error) {
    console.error("Failed to fetch todos:", error);
  }
};

let intervalId: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  // 仅在 Tauri 桌面容器内：进入便签页立即加载首屏数据（不必等待 1s 后的首次轮询），并保持轮询
  if (isTauri()) {
    fetchTodos();
    intervalId = setInterval(fetchTodos, 1000);
  }
  window.addEventListener('keydown', onKeydown, true)
  // Ctrl+N 新建便签（CreateNoteCommand 派发）
  window.addEventListener('create-note', onCreateNote)
  nextTick(setupLoadMore)
});

onBeforeUnmount(() => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (hintTimer) clearTimeout(hintTimer)
  loadMoreObserver?.disconnect();
  loadMoreObserver = null;
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('create-note', onCreateNote);
});
</script>
