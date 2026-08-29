<template>
  <div class="min-h-full p-4">
    <div class="relative max-w-6xl mx-auto">
      <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
        <button
            @click="createNote"
            class="btn-gold flex h-10 items-center shadow-soft transition-all duration-300 ease-soft hover:shadow-float"
        >
          新建便签
          <svg class="ml-2 h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
          </svg>
        </button>

        <!-- 搜索栏：与新建按钮同一行且等高（h-10）；始终高亮匹配；右侧"当前/全部"切换搜索范围 -->
        <div class="glass-card flex h-10 min-w-0 flex-1 items-center gap-2 rounded-2xl px-3 py-0 shadow-soft">
          <svg class="h-5 w-5 shrink-0 text-ink-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.5 4.5a7.5 7.5 0 0012.15 12.15z" />
          </svg>
          <input
              ref="noteSearchInput"
              v-model="noteSearch"
              type="text"
              placeholder="搜索便签内容 · Enter 跳转到首个匹配"
              class="h-full min-w-0 flex-1 bg-transparent text-ink placeholder:text-ink-faint focus:outline-none"
              @keydown.enter.prevent="jumpToFirstMatch"
          />
          <button
              type="button"
              class="btn-soft btn-circle flex h-8 w-8 items-center justify-center p-0"
              v-tip="'清空搜索'"
              @click="noteSearch = ''"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <!-- 当前/全部 分段切换：仅显示数字（当前高亮位置 / 总数），无搜索时显示 — -->
          <UiSegmented
              class="h-8 shrink-0"
              size="sm"
              :model-value="searchScope"
              :options="[
                { value: 'current', label: matchCount > 0 ? `${currentMatchIndex + 1}/${matchCount}` : '—', tip: '仅在当前便签内搜索' },
                { value: 'all', label: matchCount > 0 ? String(matchCount) : '—', tip: '在全部便签中搜索' },
              ]"
              label="搜索范围"
              @update:model-value="searchScope = $event as 'current' | 'all'"
          />
        </div>
      </div>

      <div ref="gridEl" class="columns-1 gap-4 sm:columns-2 md:columns-3 lg:columns-4 xl:columns-5">
        <StickyNoteItem
            v-for="(note, idx) in displayNotes"
            :key="note.id"
            :note="note"
            :selected="selectedIndex === idx"
            :editing="editingId === note.id"
            :highlight-string="highlightActive ? noteSearch : ''"
            :highlight="highlightActive"
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

    <!-- 删除确认框：与全局一致的 DeleteConfirm 组件（就近定位、键盘操作一致） -->
    <DeleteConfirm
        :visible="!!deleteConfirmTarget"
        message="确定要删除吗？"
        :anchor="confirmAnchor"
        @confirm="confirmDelete"
        @cancel="cancelDelete"
    />

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import StickyNoteItem from "./StickyNoteItem.vue";
import { useNoteColors } from "~/composables/useNoteColors";
import DeleteConfirm from "~/components/common/DeleteConfirm.vue";
import clipboardService from '~/src/db/dbService'
import { v4 as uuidv4 } from 'uuid'
import type { Note } from "~/src/Entities";
import {isTauri} from "~/src/utils/env";
import { shortcuts } from "~/src/commands/shortcuts/InitShortcuts";
import { findNearestInDirection } from "~/src/utils/focusNavigation";
import { useSearchHighlight } from "~/composables/useSearchHighlight";

interface StickyNote extends Note {
  position?: { x: number; y: number }
}

const notes = ref<StickyNote[]>([])

// 键盘选择态（响应式网格，列数动态获取）
const selectedIndex = ref(0)
const editingId = ref<string | null>(null)
const gridEl = ref<HTMLElement>()

// ===== 搜索（便签内容）=====
const noteSearch = ref('')
/** 搜索范围：current=在已加载便签中过滤；all=重新查库（涵盖未加载的全部） */
const searchScope = ref<'current' | 'all'>('current')
const noteSearchInput = ref<HTMLInputElement | null>(null)
/** 全局搜索高亮开关（设置页通用控制） */
const { searchHighlightEnabled } = useSearchHighlight()
/** 仅当输入非空且全局高亮开启时高亮匹配 */
const highlightActive = computed(() => !!searchHighlightEnabled.value && noteSearch.value.trim() !== '')
/** 搜索态下：高亮匹配总数（非搜索态为 0，不显示数字） */
const matchCount = computed(() => (noteSearch.value.trim() ? displayNotes.value.length : 0))
/** 当前高亮位置：在匹配结果中的 0-based 索引 */
const currentMatchIndex = computed(() => Math.min(selectedIndex.value, Math.max(0, matchCount.value - 1)))

// ===== 流式/分批渲染：首屏渲染一批，滚动接近底部时追加下一批 =====
const BATCH_SIZE = 40
const visibleCount = ref(BATCH_SIZE)
const displayNotes = computed(() => {
  const q = noteSearch.value.trim().toLowerCase()
  // 搜索态：按范围过滤并一次性展示全部匹配（不分批）
  if (q) {
    const pool = searchScope.value === 'all' ? notes.value : notes.value.slice(0, visibleCount.value)
    return pool.filter(n => (n.content || '').toLowerCase().includes(q))
  }
  // 非搜索态：保持原本的分批流式加载
  return notes.value.slice(0, visibleCount.value)
})
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

/** 搜索范围切换到"全部"时：重新查库，确保涵盖未加载的便签；清空搜索时恢复全量 */
watch([searchScope, noteSearch], async ([scope, q]) => {
  if (q.trim() && scope === 'all') {
    try {
      const fetched = await clipboardService.fetchNotes({ value: { searchContent: q.trim() } })
      notes.value = fetched
      visibleCount.value = fetched.length
      if (selectedIndex.value > fetched.length - 1) {
        selectedIndex.value = Math.max(0, fetched.length - 1)
      }
    } catch (e) {
      console.error('搜索便签失败:', e)
    }
  } else if (!q.trim()) {
    // 清空搜索：恢复全量加载（重置分批）
    await fetchTodos()
  }
})

/** 跳转到首个高亮匹配：选中第一个匹配便签并丝滑滚动到视图中心 */
const jumpToFirstMatch = () => {
  const matches = displayNotes.value
  if (matches.length === 0) return
  selectedIndex.value = 0
  nextTick(() => scrollSelectedIntoView(true))
  // 保持搜索框焦点，便于连续 Enter 跳转（当前实现为跳首个；焦点保留以继续输入）
  nextTick(() => noteSearchInput.value?.focus())
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

// ===== 新建便签：不弹窗，点击即创建（默认第一套配色），并直接进入编辑态 =====
const { colors: noteColors, resolveNoteColor } = useNoteColors()

/** 直接新建便签：写入数据库并插入瀑布流顶部，随后自动进入编辑 */
const createNote = async () => {
  const newNote: StickyNote = {
    id: uuidv4(),
    content: '',
    color: resolveNoteColor(noteColors.value[0]?.color),
    created_at: String(Date.now()),
    updated_at: String(Date.now())
  }
  await clipboardService.insertNote(newNote)
  notes.value.unshift(newNote)
  editingId.value = newNote.id
  nextTick(setupLoadMore)
  showHint('已新建便签，输入内容自动保存')
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

// ===== 删除确认框（DeleteConfirm 组件，样式/操作与全局一致） =====
const deleteConfirmTarget = ref<StickyNote | null>(null)
/** 触发删除按钮的位置（供 DeleteConfirm 就近定位） */
const confirmAnchor = ref<DOMRect | null>(null)

/** 请求删除：弹出确认框并记录触发位置 */
const onRequestDelete = (note: StickyNote, e?: MouseEvent) => {
  deleteConfirmTarget.value = note
  const btn = (e?.target as HTMLElement | undefined)?.closest?.('button') as HTMLElement | null
  confirmAnchor.value = btn?.getBoundingClientRect() ?? null
}

/** 确认删除 */
const confirmDelete = async () => {
  const target = deleteConfirmTarget.value
  if (!target) return
  deleteConfirmTarget.value = null
  confirmAnchor.value = null
  await deleteNote(target.id)
  showHint('已删除')
}

/** 取消删除 */
const cancelDelete = () => {
  deleteConfirmTarget.value = null
  confirmAnchor.value = null
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

/** 把选中卡片滚动到可见区域（smooth=true 时用中心对齐，配合搜索跳转的丝滑滚动） */
async function scrollSelectedIntoView(center = false) {
  await nextTick()
  const grid = gridEl.value
  const cards = grid?.querySelectorAll('.sticky-note-card')
  const el = cards?.[selectedIndex.value] as HTMLElement | undefined
  if (!el) return
  const main = getScrollContainer()
  if (main && center) {
    // 容器（非 window）滚动：先确保卡片渲染，再按容器高度做丝滑居中
    const cRect = main.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const target = main.scrollTop + (eRect.top - cRect.top) - (cRect.height / 2) + (eRect.height / 2)
    main.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: center ? 'center' : 'nearest' })
  }
}

/** 获取便签列表的滚动容器（#app-main），用于丝滑居中滚动 */
function getScrollContainer(): HTMLElement | null {
  return document.getElementById('app-main')
}

/** 键盘交互：方向键移动选择，Delete 删除选中项；Ctrl+←/→ 交还全局切换标签；Ctrl+Enter 保存由快捷键系统处理 */
async function onKeydown(e: KeyboardEvent) {
  const active = document.activeElement
  const isEditingField = !!active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')

  // 删除确认框打开时：键盘操作（Enter/Esc/方向键）由 DeleteConfirm 组件统一处理，
  // 这里直接交还控制权，避免与组件键盘监听冲突。
  if (deleteConfirmTarget.value) {
    return
  }

  // Ctrl+Enter：非编辑态进入编辑选中项；编辑态放行（由 textarea 兜底 / 快捷键系统保存）
  if (e.ctrlKey && e.key === 'Enter') {
    // 已有便签在编辑（无论焦点是否在输入框）：放行给保存逻辑，避免拦截后无法保存
    if (isEditingField || editingId.value !== null) return
    e.preventDefault()
    e.stopPropagation()
    const note = notes.value[selectedIndex.value]
    if (note) {
      editingId.value = note.id
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

  let handled = true
  switch (e.key) {
    // 方向键：几何最近邻导航（适配网格与任意布局，按下切到该方向上距离最近的便签）
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      const cards = gridEl.value?.querySelectorAll('.sticky-note-card')
      if (cards && cards.length > 0) {
        const dirMap = {
          ArrowUp: 'up', ArrowDown: 'down',
          ArrowLeft: 'left', ArrowRight: 'right',
        } as const
        const next = findNearestInDirection(
          Array.from(cards) as HTMLElement[],
          selectedIndex.value,
          dirMap[e.key as keyof typeof dirMap],
        )
        if (next >= 0) selectedIndex.value = next
      }
      break
    }
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
    // 轮询时也应用当前搜索条件，避免覆盖搜索结果（全部模式下按搜索词查库）
    const q = noteSearch.value.trim()
    const fetchedNotes = await clipboardService.fetchNotes({ value: { searchContent: q } })
    notes.value = fetchedNotes
    if (!q) visibleCount.value = BATCH_SIZE
    else visibleCount.value = fetchedNotes.length
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
  // Ctrl+F：聚焦便签搜索框（FocusSearchCommand 派发）
  window.addEventListener('focus-search', onFocusSearch)
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
  window.removeEventListener('focus-search', onFocusSearch);
});

/** Ctrl+F 聚焦便签搜索框 */
const onFocusSearch = () => {
  nextTick(() => noteSearchInput.value?.focus())
}
</script>
