<template>
  <div>
    <!-- 边距与宽度由外壳统一提供（main px-4 + max-w-6xl），各模块保持一致 -->
    <div class="relative">
      <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
        <button
            @click="createNote"
            class="btn-gold flex h-10 items-center shadow-soft transition-all duration-300 ease-soft hover:shadow-float"
        >
          {{ t('note.new_note') }}
          <svg class="ml-2 h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
          </svg>
        </button>

        <!-- 搜索栏：与新建按钮同一行且等高（h-10）；通用 SearchInputBar（与剪贴板/全局搜索同款按钮样式：
             高级词法魔棒 + 大小写区分 Aa + 语法说明 ?），排序/回收站/批量等便签专属按钮经尾部 slot 注入 -->
        <div class="flex h-10 min-w-0 flex-1 items-center">
          <SearchInputBar
              ref="noteSearchInput"
              v-model="noteSearch"
              :placeholder="t('note.search_placeholder')"
              :advanced="noteAdvanced"
              :case-sensitive="noteCaseSensitive"
              :show-help="false"
              :tip-clear="t('note.clear_search')"
              class="glass-card h-full min-w-0 flex-1 rounded-2xl px-3 py-0 shadow-soft"
              @update:advanced="noteAdvanced = $event"
              @update:case-sensitive="noteCaseSensitive = $event"
              @enter="jumpToFirstMatch"
              @clear="noteSearch = ''"
          >
            <!-- 排序下拉：最近更新 / 创建时间 / 颜色（置顶区不受排序影响） -->
            <UiDropdown align="end" :aria-label="t('note.sort')" panel-class="glass-card w-40 rounded-2xl p-1.5 shadow-float">
              <template #trigger>
                <div class="icon-ghost text-ink-soft hover:bg-secondary hover:text-ink" v-tip="t('note.sort')">
                  <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h13M3 12h9M3 18h5M18 10v9m0 0 3-3m-3 3-3-3" /></svg>
                </div>
              </template>
              <button
                  v-for="opt in sortOptions"
                  :key="opt.value"
                  type="button"
                  class="flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs transition-colors"
                  :class="currentSort === opt.value ? 'bg-gold/15 text-gold' : 'text-ink-soft hover:bg-secondary hover:text-ink'"
                  @click="currentSort = opt.value as SortKey"
              >
                {{ opt.label }}
                <svg v-if="currentSort === opt.value" class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
              </button>
            </UiDropdown>
            <!-- 回收站视图切换（再次点击返回） -->
            <button
                type="button"
                class="icon-ghost"
                :class="view === 'trash' ? 'text-gold hover:bg-gold/10' : 'text-ink-soft hover:bg-secondary hover:text-ink'"
                v-tip="t('note.trash')"
                @click="toggleTrash"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>
            </button>
            <!-- 批量管理（回收站视图不提供） -->
            <button
                v-if="view === 'list'"
                type="button"
                class="icon-ghost"
                :class="batchMode ? 'text-gold hover:bg-gold/10' : 'text-ink-soft hover:bg-secondary hover:text-ink'"
                v-tip="t('note.batch')"
                @click="toggleBatchMode"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8" /><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /></svg>
            </button>
          </SearchInputBar>
        </div>
      </div>

      <!-- 批量操作栏：已选数量 + 批量改色（选色即应用）+ 批量删除 + 全选/退出（回收站视图不提供） -->
      <div v-if="batchMode && view === 'list'" class="mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-secondary/80 px-3 py-2 shadow-soft">
        <span class="text-xs font-medium text-ink">{{ t('note.batch_selected', { n: batchSelectedIds.size }) }}</span>
        <button type="button" class="btn-soft h-7 rounded-lg px-2 text-xs" @click="toggleSelectAll">{{ allSelected ? t('note.batch_unselect_all') : t('note.batch_select_all') }}</button>
        <div class="flex items-center gap-1">
          <button
              v-for="c in noteColors"
              :key="'batch-' + c.name"
              type="button"
              v-tip="t('note.batch_color_to', { name: c.name })"
              class="h-5 w-5 rounded-full border border-white/60 shadow-xs transition-transform hover:scale-110"
              :style="{ backgroundColor: c.color }"
              @click="batchSetColor(c.color)"
          />
        </div>
        <button type="button" class="btn-soft h-7 rounded-lg px-2 text-xs text-danger hover:bg-danger/10" @click="batchDelete">{{ t('note.batch_delete') }}</button>
        <button type="button" class="btn-soft h-7 rounded-lg px-2 text-xs" @click="exitBatch">{{ t('note.batch_exit') }}</button>
      </div>

      <!-- Grid 行优先布局（从左到右、从上到下）：原 columns 多列为列优先填充，
           便签顺序视觉跳跃（右侧列空缺、后续跑到下一行）；items-start 保证同行卡片顶对齐、高度独立。
           TransitionGroup（name=note → move 类 .note-move）：拖动重排时其余卡片 FLIP 让位/落位动画 -->
      <TransitionGroup
          ref="gridEl"
          tag="div"
          name="note"
          class="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      >
        <!-- 置顶区分隔行：仅列表视图且存在置顶便签时显示（置顶卡片紧随其后，同网格列对齐） -->
        <div v-if="view === 'list' && pinnedNotes.length" key="pinned-header" class="col-span-full flex items-center gap-2 pb-1 text-xs text-ink-faint">
          <svg class="h-3.5 w-3.5 text-gold" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
          {{ t('note.pinned_section', { n: pinnedNotes.length }) }}
        </div>
        <StickyNoteItem
            v-for="(note, idx) in renderNotes"
            :key="note.id"
            :note="note"
            :selected="!batchMode && selectedIndex === idx"
            :editing="editingId === note.id"
            :highlight-string="highlightActive ? noteSearch : ''"
            :highlight="highlightActive"
            :batch-mode="batchMode"
            :batch-selected="batchSelectedIds.has(note.id)"
            :trash="view === 'trash'"
            :drag-source="draggingId === note.id"
            @update="updateNote"
            @request-delete="onRequestDelete(note)"
            @color-change="changeNoteColor"
            @request-edit="editingId = note.id"
            @finish-edit="editingId = null"
            @select="onCardSelect(idx, $event)"
            @toggle-pin="togglePin"
            @toggle-checklist="toggleChecklist"
            @update-tags="updateTags"
            @request-restore="restoreNote"
            @request-purge="onRequestPurge"
            @pin-desktop="pinToDesktop"
            @ai-organize="onAiOrganize"
            @copy-content="copyNoteContent"
            @to-todo="noteToTodo"
            @toggle-batch-select="toggleBatchSelect(note.id, idx)"
            @drag-move="onNoteDragMove"
            @drag-drop="onNoteDragDrop"
            @drag-cancel="onNoteDragCancel"
        />
      </TransitionGroup>

      <!-- 流式加载：sentinel 进入视口时自动加载下一页；到底后显示"已全部加载"（回收站视图不分页） -->
      <div
          v-if="view === 'list' && hasMore && notes.length"
          ref="sentinel"
          class="flex items-center justify-center gap-2 py-6 text-xs text-ink-faint"
      >
        <span v-if="loading">{{ t('note.loading_more') }}</span>
        <span v-else>{{ t('clip.scroll_more') }}</span>
      </div>

      <div v-if="gridNotes.length === 0" class="py-20 text-center">
        <svg class="mx-auto mb-4 h-24 w-24 text-ink-faint/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" :d="view === 'trash' ? 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6' : 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'"></path>
        </svg>
        <p class="text-lg text-ink-faint">{{ view === 'trash' ? t('note.trash_empty') : t('note.empty') }}</p>
        <!-- 批量快捷键提示（仅列表视图；对齐剪贴板空态的 shortcut_hints 引导位） -->
        <p v-if="view === 'list'" class="text-xs text-ink-faint/70">{{ t('note.batch_hints') }}</p>
      </div>
    </div>

    <!-- 删除确认框：仅回收站「彻底删除」需要确认（主列表删除直接软删可恢复） -->
    <DeleteConfirm
        :visible="!!purgeConfirmTarget"
        @confirm="confirmPurge"
        @cancel="cancelPurge"
    />

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import StickyNoteItem from "./StickyNoteItem.vue";
import { useNoteColors, resolveNoteColor } from "~/composables/useNoteColors";
import { writeText } from 'tauri-plugin-clipboard-api';
import { clipToTodos } from '~/src/commands/local/dispatchClip';
import DeleteConfirm from "~/components/common/DeleteConfirm.vue";
import SearchInputBar from '~/components/common/SearchInputBar.vue';
import clipboardService from '~/src/db/dbService'
import { matchesSearch } from '~/src/core/db/sql'
import { v4 as uuidv4 } from 'uuid'
import type { Note } from "~/src/entities";
import { bus, type GlobalSearchJumpDetail } from '~/src/core/events';
import {isTauri} from "~/utils/env";
import { shortcuts } from "~/src/commands/shortcuts/InitShortcuts";
import { matchesKeyId } from "~/utils/shortcutFormat";
import { useI18n } from "~/composables/useI18n";
import { findNearestInDirection } from "~/utils/focusNavigation";
import { useInfiniteList } from "~/composables/useInfiniteList";
import { notifyIsland, type IslandKind } from "~/composables/useCopyIsland";
import { toggleChecklistLine } from "~/src/note/markdown";
import { loadAiConfig, aiComplete } from "~/src/smart-clip/aiClient";

interface StickyNote extends Note {
  position?: { x: number; y: number }
}

/** 流式加载：首屏只加载第一页，滚动到底部自动加载下一页；
 *  轮询/操作后仅刷新已加载范围（签名一致时跳过整表替换，避免无谓重渲染） */
const {
  items: notes, loading, hasMore, sentinel,
  loadMore, reload, refreshLoaded, replace, prepend, remove: removeNote,
} = useInfiniteList<StickyNote>({
  // 分页始终不带搜索词：搜索由前端过滤"已加载范围"（current 范围语义），
  // 避免带 LIKE 的分页 offset 与已加载条数错位导致跳过/重复匹配项
  fetchPage: (offset, limit) =>
    clipboardService.fetchNotes({ value: { searchContent: '' } }, { offset, limit }),
  pageSize: 40,
  signatureOf: (n) => `${n.id}:${n.updated_at}`,
})

const { t } = useI18n();

// 键盘选择态（响应式网格，列数动态获取）
const selectedIndex = ref(0)
const editingId = ref<string | null>(null)
/** TransitionGroup 组件实例（$el 为 grid 容器）：键盘导航命中 + 拖动重排命中检测共用 */
const gridEl = ref<{ $el: HTMLElement } | null>(null)

// ===== 搜索（便签内容）=====
const noteSearch = ref('')
/** 搜索范围：current=在已加载便签中过滤；all=重新查库（涵盖未加载的全部） */
const searchScope = ref<'current' | 'all'>('current')
/** 高级词法 / 大小写区分开关（与剪贴板/全局搜索同套语义，纯前端内存态） */
const noteAdvanced = ref(true)
const noteCaseSensitive = ref(false)
const noteSearchInput = ref<InstanceType<typeof SearchInputBar> | null>(null)
/** 仅当输入非空时高亮匹配（搜索命中即高亮，常开） */
const highlightActive = computed(() => noteSearch.value.trim() !== '')

/** 展示列表：搜索态按关键词前端过滤（current=已加载范围；all=notes 已是全库搜索结果）；非搜索态=已加载全部。
 *  匹配走共享 matchesSearch（与 DB 词法同源：组内 OR/组间 AND/通配符/大小写语义） */
const displayNotes = computed(() => {
  const q = noteSearch.value.trim()
  if (q) {
    return notes.value.filter(n => matchesSearch(n.content || '', q, noteAdvanced.value, noteCaseSensitive.value))
  }
  return notes.value
})

// ===== 排序（便签 §6）：置顶区不受排序影响；规则应用于其余便签 =====
type SortKey = 'updated' | 'created' | 'color' | 'manual'
const currentSort = ref<SortKey>('updated')
const sortOptions = computed(() => [
  { label: t('note.sort_updated'), value: 'updated' },
  { label: t('note.sort_created'), value: 'created' },
  { label: t('note.sort_color'), value: 'color' },
  { label: t('note.sort_manual'), value: 'manual' },
])
/** 排序比较：updated/created 时间倒序；color 按当前配色顺序（noteColors 索引，自定义配色排后）；
 *  manual 按 sort_order 升序（拖动重排持久化），未回填过的存量（同值 0）以 updated_at 稳定兜底 */
function compareNotes(a: StickyNote, b: StickyNote): number {
  if (currentSort.value === 'manual') {
    const diff = (a.sort_order ?? 0) - (b.sort_order ?? 0)
    if (diff !== 0) return diff
    return (parseInt(b.updated_at || '0') || 0) - (parseInt(a.updated_at || '0') || 0)
  }
  if (currentSort.value === 'color') {
    const idx = (color?: string) => noteColors.value.findIndex(c => c.color === resolveNoteColor(color))
    const ca = idx(a.color), cb = idx(b.color)
    if (ca !== cb) return (ca < 0 ? 999 : ca) - (cb < 0 ? 999 : cb)
    return (parseInt(b.updated_at || '0') || 0) - (parseInt(a.updated_at || '0') || 0)
  }
  const key = currentSort.value === 'created' ? 'created_at' : 'updated_at'
  return (parseInt(b[key] || '0') || 0) - (parseInt(a[key] || '0') || 0)
}

/** 置顶便签（列表视图置顶区，updated_at 倒序稳定展示） */
const pinnedNotes = computed(() =>
  displayNotes.value.filter(n => n.pinned === 1).sort(compareNotes))
/** 主网格渲染列表：列表视图 = 置顶区 + 其余（按排序）；回收站视图 = 回收站列表（搜索过滤同口径） */
const gridNotes = computed(() => {
  if (view.value === 'trash') {
    const q = noteSearch.value.trim()
    return trashNotes.value.filter(n => !q || matchesSearch(n.content || '', q, noteAdvanced.value, noteCaseSensitive.value))
  }
  const rest = displayNotes.value.filter(n => n.pinned !== 1).sort(compareNotes)
  return [...pinnedNotes.value, ...rest]
})

// ===== 拖动重排（便签 §12）：与"拖出钉桌"同一手势——窗内松手 = 落位重排，拖出窗口 = 钉桌 =====
/** 拖动中的让位预览：把拖动卡插入基准槽位后的临时渲染列表（TransitionGroup FLIP 动画呈现让位） */
const dragPreview = ref<StickyNote[] | null>(null)
/** 当前拖动源卡 id：模板标记 .note-drag-source（禁用其 FLIP move 动画，见 main.css） */
const draggingId = ref<string | null>(null)
/** 渲染列表：拖动中用预览，否则用 gridNotes */
const renderNotes = computed(() => dragPreview.value ?? gridNotes.value)
let dragRafId = 0
let dragPending: { id: string; x: number; y: number } | null = null

/** grid 命中检测（基准列表算法，根治让位振荡）：
 *  判定基准 = 去掉拖动卡后的列表——其余卡让位后的稳定布局，插入点语义恒定，
 *  不会出现"插入后拖动卡紧邻目标卡 → 判定无变化 → 强制回退 → 又插入"的来回切换；
 *  卡片矩形取 offsetLeft/offsetTop 布局位（FLIP 只用 transform 做视觉偏移，布局位
 *  已是让位后终态），不受 getBoundingClientRect 的动画中间态干扰。
 *  光标命中同区卡 X → 过垂直中线插其后、未过插其前（中线判定自带滞后，临界不抖）；
 *  未命中任何卡 → 区末；光标落在异区卡上 → 跨区不支持返回 null。
 *  返回最终完整列表（含拖动卡）或 null。 */
function computeFinalList(dragId: string, x: number, y: number): StickyNote[] | null {
  const list = renderNotes.value
  const dragNote = list.find(n => n.id === dragId)
  if (!dragNote) return null
  const sameZone = (n: StickyNote) => (n.pinned === 1) === (dragNote.pinned === 1)
  const grid = gridEl.value?.$el as HTMLElement | undefined
  if (!grid) return null
  // 全部卡片（除拖动卡）的布局矩形：offsetParent rect + offsetLeft/Top = 视口坐标（无 transform 干扰）
  const rectById = new Map<string, { left: number; top: number; right: number; bottom: number }>()
  for (const el of grid.querySelectorAll<HTMLElement>('[data-note-id]')) {
    const id = el.dataset.noteId
    if (!id || id === dragId) continue
    const parent = el.offsetParent as HTMLElement | null
    const pr = parent ? parent.getBoundingClientRect() : null
    const left = (pr?.left ?? 0) + el.offsetLeft
    const top = (pr?.top ?? 0) + el.offsetTop
    rectById.set(id, { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight })
  }
  const hit = (r: { left: number; top: number; right: number; bottom: number }) =>
    y >= r.top && y < r.bottom && x < r.right
  // 光标落在异区卡上 → 跨区不支持，预览不动
  for (const n of list) {
    if (n.id === dragId || sameZone(n)) continue
    const r = rectById.get(n.id)
    if (r && hit(r)) return null
  }
  // 基准 = 去掉拖动卡；同区子序列行优先判定插入点
  const base = list.filter(n => n.id !== dragId)
  const zoneIdx: number[] = []
  base.forEach((n, i) => { if (sameZone(n)) zoneIdx.push(i) })
  if (zoneIdx.length === 0) return null
  let insertAt = -1
  for (const bi of zoneIdx) {
    const n = base[bi]
    const r = n ? rectById.get(n.id) : undefined
    if (!n || !r || !hit(r)) continue
    insertAt = x < (r.left + r.right) / 2 ? bi : bi + 1
    break
  }
  if (insertAt < 0) {
    const last = zoneIdx[zoneIdx.length - 1]
    if (last === undefined) return null
    insertAt = last + 1 // 未命中任何卡 → 区末
  }
  const finalList = [...base]
  finalList.splice(insertAt, 0, dragNote)
  return finalList
}

/** 拖动中实时预览（rAF 节流 + 顺序变化才更新，避免高频重排与振荡） */
function onNoteDragMove(payload: { id: string; x: number; y: number }) {
  dragPending = payload
  draggingId.value = payload.id
  if (dragRafId) return
  dragRafId = requestAnimationFrame(() => {
    dragRafId = 0
    const p = dragPending
    if (!p) return
    const finalList = computeFinalList(p.id, p.x, p.y)
    if (!finalList) { dragPreview.value = null; return }
    const cur = dragPreview.value ?? gridNotes.value
    // 顺序未变保持现状（清掉预览会与已让位布局不一致，来回跳）
    const unchanged = cur.length === finalList.length && cur.every((n, i) => n.id === finalList[i]?.id)
    if (unchanged) return
    dragPreview.value = finalList
  })
}

/** 安全区松手落位：按预览顺序整列回填 sort_order（0..n-1，一次事务；分区相对顺序随全列表保留），
 *  并切到手动排序。不触碰 updated_at（时间排序不受影响，轮询签名也不变）。
 *  预览保留到落位数据就绪后释放——期间 gridNotes(manual) 已与预览一致，松手不跳变 */
async function onNoteDragDrop() {
  const finalList = dragPreview.value
  const release = () => {
    dragPreview.value = null
    draggingId.value = null
  }
  if (!finalList) { release(); return }
  try {
    await clipboardService.updateNoteSortOrder(
      finalList.map((n, i) => ({ id: n.id, sortOrder: i })),
    )
    // 本地同步（免 reload）：源列表 sort_order 更新后，manual 排序 computed 自然呈现新顺序
    const orderById = new Map(finalList.map((n, i) => [n.id, i]))
    notes.value = notes.value.map(n => (orderById.has(n.id) ? { ...n, sort_order: orderById.get(n.id)! } : n))
    currentSort.value = 'manual'
    release()
  } catch (e) {
    release()
    console.error('[note] 拖动排序保存失败:', e)
    showHint(t('note.save_failed'), 'error')
  }
}

/** 拖动被打断（ESC/失焦/系统打断）：还原预览，顺序不动 */
function onNoteDragCancel() {
  dragPreview.value = null
  draggingId.value = null
}


/** 搜索范围切换到"全部"时：重新查库，确保涵盖未加载的便签；清空搜索时恢复全量。
 *  加 300ms trailing 防抖：此前每个按键立即查库，连续输入 = 连续 SQL */
let searchFetchTimer: ReturnType<typeof setTimeout> | null = null
watch([searchScope, noteSearch, noteAdvanced, noteCaseSensitive], async ([scope, q]) => {
  if (searchFetchTimer) clearTimeout(searchFetchTimer)
  if (q.trim() && scope === 'all') {
    // "全部"范围搜索：一次性查库全部匹配（涵盖未加载便签），300ms 防抖避免连续输入连续 SQL
    searchFetchTimer = setTimeout(() => {
      searchFetchTimer = null
      void fetchNotesByScope(q.trim())
    }, 300)
  } else if (!q.trim()) {
    // 清空搜索：重置为流式第一页（此前为全量恢复，改为分页重置）
    await reloadNotes()
  }
})

/** 按"全部"范围查库刷新搜索结果（一次性展示全部匹配，不再流式）；词法/大小写开关随搜索框状态透传 */
async function fetchNotesByScope(q: string) {
  try {
    const fetched = await clipboardService.fetchNotes({ value: { searchContent: q, advanced: noteAdvanced.value, caseSensitive: noteCaseSensitive.value } })
    replace(fetched)
    if (selectedIndex.value > fetched.length - 1) {
      selectedIndex.value = Math.max(0, fetched.length - 1)
    }
  } catch (e) {
    console.error('搜索便签失败:', e)
  }
}

/** 重置为流式第一页（清空搜索/切回"当前"范围时），并修正选中索引 */
async function reloadNotes() {
  // 等待轮询中的刷新结束，再重置（busy 互斥导致跳过时最多重试 2 秒）
  while (noteFetching) await new Promise(r => setTimeout(r, 50))
  for (let i = 0; i < 20; i++) {
    if (await reload()) break
    await new Promise(r => setTimeout(r, 100))
  }
  if (selectedIndex.value > notes.value.length - 1) {
    selectedIndex.value = Math.max(0, notes.value.length - 1)
  }
}

/** 跳转到首个高亮匹配：选中第一个匹配便签并丝滑滚动到视图中心 */
const jumpToFirstMatch = () => {
  const matches = displayNotes.value
  if (matches.length === 0) return
  selectedIndex.value = 0
  nextTick(() => scrollSelectedIntoView(true))
  // 保持搜索框焦点，便于连续 Enter 跳转（当前实现为跳首个；焦点保留以继续输入）
  nextTick(() => noteSearchInput.value?.focus())
}

/** 新建便签快捷键是否为 Ctrl+N（默认配置或被污染为无修饰 N）——此时由页面捕获兜底直接新建 */
const ctrlNIsCreateShortcut = computed(() => {
  const s = shortcuts.value.find(x => x.id === 'create_note')
  if (!s || !s.enabled) return false
  return matchesKeyId(s.key, 'control+n') || matchesKeyId(s.key, 'n')
})

// ===== 新建便签：不弹窗，点击即创建（默认第一套配色），并直接进入编辑态 =====
const { colors: noteColors } = useNoteColors()

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
  prepend(newNote)
  editingId.value = newNote.id
  showHint(t('note.new_created_hint'))
}

/** Ctrl+N 新建便签（CreateNoteCommand 派发 create-note 事件） */
const onCreateNote = () => createNote()

/** 便签 → 系统剪贴板（跨模块分发）：内容原文写入，灵动岛反馈 */
const copyNoteContent = async (id: string) => {
  const note = notes.value.find(n => n.id === id)
  if (!note?.content) return
  try {
    await writeText(note.content)
    showHint(t('note.copied'))
  } catch (e) {
    console.error('便签内容复制失败:', e)
    showHint(t('note.copy_failed'), 'error')
  }
}

/** 便签 → 待办（跨模块分发）：多行清单逐条建待办，灵动岛反馈 */
const noteToTodo = async (id: string) => {
  const note = notes.value.find(n => n.id === id)
  if (!note?.content) return
  try {
    const n = await clipToTodos(note.content)
    showHint(n > 1 ? t('clip.dispatched_todos', { n }) : t('clip.dispatched_todo'))
  } catch (e) {
    console.error('便签转待办失败:', e)
    showHint(t('clip.dispatch_failed'), 'error')
  }
}

// ===== 即时反馈提示 → 灵动岛（屏幕顶部全局胶囊，替代窗口内 toast） =====
const showHint = (msg: string, kind: IslandKind = 'success') => {
  notifyIsland({ kind, text: msg })
}

// ===== 删除（便签 §5 回收站）：主列表删除 = 直接软删（不弹确认，可恢复）；
//  回收站「彻底删除」才弹 DeleteConfirm 确认 =====
const purgeConfirmTarget = ref<StickyNote | null>(null)

const updateNote = async (id: string, content: string) => {
  const idx = notes.value.findIndex(n => n.id === id)
  if (idx >= 0) {
    // 整条替换（splice 数组级响应）：不依赖列表元素深层代理的属性修改，
    // 保证编辑保存后卡片内容必然即时刷新
    const next: StickyNote = { ...notes.value[idx]!, content, updated_at: String(Date.now()) }
    notes.value.splice(idx, 1, next)
    try {
      await clipboardService.updateNote(next)
      // 保存成功灵动岛提示：Ctrl+Enter / 失焦 / 快捷键系统三条保存路径都汇聚于此，单点覆盖
      showHint(t('note.saved'))
      // 立即回读权威数据：不依赖 3s 轮询与签名比对的时序巧合（busy 互斥跳过时由轮询兜底）
      await refreshLoaded()
    } catch (e) {
      console.error('保存便签失败:', e)
      showHint(t('note.save_failed'), 'error')
    }
  }
}

/** 删除便签（主列表）：软删进回收站，本地即时移出；失败提示 */
const deleteNote = async (id: string) => {
  await clipboardService.deleteNote(id)
  removeNote((n) => n.id === id)
  // 若删除的是正在编辑的项，退出编辑态
  if (editingId.value === id) editingId.value = null
  // 删除后修正选中索引，避免越界（selectedIndex 与渲染列表 gridNotes 同口径）
  if (selectedIndex.value > gridNotes.value.length - 1) {
    selectedIndex.value = Math.max(0, gridNotes.value.length - 1)
  }
}

/** 主列表删除请求：直接软删（对齐待办「删除不再二次打断」） */
const onRequestDelete = async (note: StickyNote) => {
  if (batchMode.value) return
  try {
    await deleteNote(note.id)
    showHint(t('note.island_trashed'))
  } catch (e) {
    console.error('删除便签失败:', e)
    showHint(t('note.delete_failed'), 'error')
  }
}

/** 回收站「彻底删除」请求：弹 DeleteConfirm 确认 */
const onRequestPurge = (id: string) => {
  purgeConfirmTarget.value = trashNotes.value.find(n => n.id === id) ?? null
}

/** 确认彻底删除：真 DELETE（失败提示，不恢复弹窗避免卡死交互） */
const confirmPurge = async () => {
  const target = purgeConfirmTarget.value
  if (!target) return
  purgeConfirmTarget.value = null
  try {
    await clipboardService.purgeNote(target.id)
    trashNotes.value = trashNotes.value.filter(n => n.id !== target.id)
    showHint(t('note.purged'))
  } catch (e) {
    console.error('彻底删除便签失败:', e)
    showHint(t('note.delete_failed'), 'error')
  }
}

const cancelPurge = () => {
  purgeConfirmTarget.value = null
}

// ===== 回收站视图（便签 §5）：进入时拉取软删列表 =====
const view = ref<'list' | 'trash'>('list')
const trashNotes = ref<StickyNote[]>([])
const toggleTrash = async () => {
  view.value = view.value === 'list' ? 'trash' : 'list'
  if (view.value === 'trash') {
    try {
      trashNotes.value = await clipboardService.fetchDeletedNotes() as StickyNote[]
    } catch (e) {
      console.error('加载便答回收站失败:', e)
      trashNotes.value = []
    }
  }
}

/** 回收站恢复：清 deleted_at，从回收站列表移出并刷新主列表 */
const restoreNote = async (id: string) => {
  try {
    await clipboardService.restoreNote(id)
    trashNotes.value = trashNotes.value.filter(n => n.id !== id)
    await reloadNotes()
    showHint(t('note.restored'))
  } catch (e) {
    console.error('恢复便签失败:', e)
    showHint(t('note.delete_failed'), 'error')
  }
}

// ===== 置顶（便签 §1）/ 标签（§2）/ 清单勾选（§3）/ 提醒（§4）事件处理 =====
/** 置顶切换：本地即时翻转 + 落库（排序置顶区自动重组） */
const togglePin = async (id: string) => {
  const note = notes.value.find(n => n.id === id)
  if (!note) return
  note.pinned = note.pinned === 1 ? 0 : 1
  note.updated_at = String(Date.now())
  try {
    await clipboardService.updateNote(note)
    showHint(note.pinned === 1 ? t('note.pinned_now') : t('note.unpinned_now'))
  } catch (e) {
    console.error('置顶便签失败:', e)
    showHint(t('note.save_failed'), 'error')
  }
}

/** 清单勾选：改写 content 对应行（[ ] ⇄ [x]）后走既有保存链路；非清单行/越界静默跳过 */
const toggleChecklist = async (id: string, srcIndex: number) => {
  const note = notes.value.find(n => n.id === id)
  if (!note) return
  const next = toggleChecklistLine(note.content, srcIndex)
  if (next === note.content) return
  await updateNote(id, next)
}

/** 标签提交（编辑态失焦/回车）：与内容保存同链路落库 */
const updateTags = async (id: string, tags: string[]) => {
  const note = notes.value.find(n => n.id === id)
  if (!note) return
  note.tags = tags
  note.updated_at = String(Date.now())
  try {
    await clipboardService.updateNote(note)
    showHint(t('note.saved'))
  } catch (e) {
    console.error('保存便签标签失败:', e)
    showHint(t('note.save_failed'), 'error')
  }
}

const changeNoteColor = async (id: string, color: string) => {
  const note = notes.value.find(n => n.id === id)
  if (note) {
    note.color = color
    note.updated_at = String(Date.now())
    try {
      await clipboardService.updateNote(note)
      // 配色修改成功灵动岛提示（与其他便签操作反馈一致）
      showHint(t('note.color_saved'))
    } catch (e) {
      console.error('保存便签配色失败:', e)
      showHint(t('note.color_save_failed'), 'error')
    }
  }
}

// ===== 批量操作（便签 §7）：多选 + 批量改色（选色即应用）/ 批量删除（进回收站） =====
const batchMode = ref(false)
const batchSelectedIds = ref(new Set<string>())
// Shift 范围选锚点：最后一次勾选的行下标（非响应式，仅点击交互内部使用，语义对齐剪贴板）
let batchAnchorIndex = -1
const allSelected = computed(() => gridNotes.value.length > 0 && gridNotes.value.every(n => batchSelectedIds.value.has(n.id)))

const toggleBatchMode = () => {
  batchMode.value = !batchMode.value
  if (!batchMode.value) batchSelectedIds.value = new Set()
  batchAnchorIndex = -1
}
const exitBatch = () => {
  batchMode.value = false
  batchSelectedIds.value = new Set()
  batchAnchorIndex = -1
}
const toggleBatchSelect = (id: string, index?: number) => {
  const next = new Set(batchSelectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  batchSelectedIds.value = next
  // 锚点跟随最后勾选行（Ctrl+点击/勾选圈/空格），供 Shift 范围选为起点；无选中时清锚
  batchAnchorIndex = next.size > 0 && index !== undefined ? index : -1
  if (index !== undefined) selectedIndex.value = index
}
/** Shift+点击：从锚点到当前行范围全选（追加不清空已有勾选；无锚点时以当前选中行为锚） */
const selectBatchRange = (index: number) => {
  if (batchAnchorIndex < 0) batchAnchorIndex = selectedIndex.value
  const lo = Math.min(batchAnchorIndex, index)
  const hi = Math.max(batchAnchorIndex, index)
  const next = new Set(batchSelectedIds.value)
  for (let i = lo; i <= hi; i++) {
    const n = gridNotes.value[i]
    if (n) next.add(n.id)
  }
  batchSelectedIds.value = next
  selectedIndex.value = index
}

/** 卡片点击分流（语义对齐剪贴板列表）：Ctrl/Meta+点击 加选（未开批量自动开启）、
 *  Shift+点击 范围选、批量态普通点击切换勾选、普通态单选；回收站无批量语义只做单选 */
function onCardSelect(idx: number, e?: MouseEvent) {
  const note = gridNotes.value[idx]
  if (!note) return
  if (view.value !== 'list') {
    selectedIndex.value = idx
    return
  }
  if (e?.shiftKey) {
    if (!batchMode.value) toggleBatchMode()
    selectBatchRange(idx)
    return
  }
  if (e?.ctrlKey || e?.metaKey) {
    if (!batchMode.value) toggleBatchMode()
    toggleBatchSelect(note.id, idx)
    return
  }
  if (batchMode.value) {
    toggleBatchSelect(note.id, idx)
    return
  }
  selectedIndex.value = idx
}
const toggleSelectAll = () => {
  batchSelectedIds.value = allSelected.value ? new Set() : new Set(gridNotes.value.map(n => n.id))
}

/** 批量改色：循环 updateNote（选色即应用），失败计数统一提示 */
const batchSetColor = async (color: string) => {
  const ids = [...batchSelectedIds.value]
  if (!ids.length) return
  let fail = 0
  for (const id of ids) {
    const note = notes.value.find(n => n.id === id)
    if (!note) continue
    note.color = color
    note.updated_at = String(Date.now())
    try {
      await clipboardService.updateNote(note)
    } catch {
      fail += 1
    }
  }
  showHint(fail ? t('note.batch_color_failed') : t('note.batch_colored', { n: ids.length - fail }), fail ? 'error' : 'success')
}

/** 批量删除：循环软删进回收站 */
const batchDelete = async () => {
  const ids = [...batchSelectedIds.value]
  if (!ids.length) return
  let fail = 0
  for (const id of ids) {
    try {
      await deleteNote(id)
    } catch {
      fail += 1
    }
  }
  exitBatch()
  showHint(fail ? t('note.delete_failed') : t('note.batch_deleted', { n: ids.length - fail }), fail ? 'error' : 'success')
}

// ===== AI 整理（便签 §10）：摘要 / 提取待办，结果追加到便签末尾走既有保存链路。
//  错误分流对齐待办 NLP：未配置 AI → 引导设置页；其余透传底层错误（reason 截断展示） =====
const AI_NOT_CONFIGURED = 'AI_NOT_CONFIGURED'
const aiBusy = ref(false)

async function onAiOrganize(id: string, action: 'summary' | 'extract') {
  if (aiBusy.value) return
  const note = notes.value.find(n => n.id === id)
  if (!note) return
  const content = (note.content || '').trim()
  if (!content) {
    showHint(t('note.ai_empty'), 'error')
    return
  }
  aiBusy.value = true
  try {
    const cfg = await loadAiConfig()
    if (!cfg.apiKey || !cfg.baseUrl) throw new Error(AI_NOT_CONFIGURED)
    // 提示词要求以便签原语言输出；提取待办用 [ ] 勾选语法（与清单模式渲染一致）
    const system = action === 'summary'
        ? 'You are a note organizer. Summarize the key points of the note below in the note\'s own language, at most 5 lines, each line starting with "- ". Reply with the summary only.'
        : 'You are a note organizer. Extract actionable tasks from the note below in the note\'s own language, at most 10 lines, each line starting with "- [ ] ". Reply with the list only.'
    const result = (await aiComplete(cfg, system, content)).trim()
    if (!result) throw new Error('AI_EMPTY_RESPONSE')
    await updateNote(id, `${note.content.replace(/\s+$/, '')}\n\n${result}`)
    showHint(t('note.ai_done'))
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e)
    const key = code === AI_NOT_CONFIGURED ? 'note.ai_no_ai' : 'note.ai_failed'
    showHint(t(key, { reason: code.slice(0, 60) }), 'error')
  } finally {
    aiBusy.value = false
  }
}

// ===== 桌面便签窗口（便签 §11）：无边框透明置顶小窗常驻显示单条便签，
//  编辑/渲染在 app/pages/note-pin/[id].vue 完成；每条便签独立窗口（label 含 id），
//  重复点击唤起已有窗口。窗口创建/落点/跟随逻辑统一在 useDesktopPin（与
//  「拖出钉桌」跟随动画共用）；位置 = 光标当前位置 + 级联偏移（多条钉住不重叠） =====
async function pinToDesktop(id: string) {
  if (!isTauri()) return
  const exists = gridNotes.value.some(n => n.id === id) || trashNotes.value.some(n => n.id === id)
  if (!exists) return
  // 子窗口打开豁免期：避免创建瞬间抢焦点触发主窗口失焦自动隐藏（同配色窗口先例）
  ;(window as any).__childOpeningUntil = Date.now() + 600
  const { openDesktopPin } = await import('~/composables/useDesktopPin')
  // 隐藏创建：页面渲染完成广播 ready 后由主窗口统一 show（加载期底色帧不可见）
  await openDesktopPin(id).catch(() => null)
  showHint(t('note.pin_desktop_done'))
}

/** 把选中卡片滚动到可见区域（smooth=true 时用中心对齐，配合搜索跳转的丝滑滚动） */
async function scrollSelectedIntoView(center = false) {
  await nextTick()
  const grid = gridEl.value?.$el
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
  if (purgeConfirmTarget.value) {
    return
  }

  // Ctrl+Enter：非编辑态进入编辑选中项；编辑态放行（由 textarea 兜底 / 快捷键系统保存）
  if (e.ctrlKey && e.key === 'Enter') {
    // 已有便签在编辑（无论焦点是否在输入框）：放行给保存逻辑，避免拦截后无法保存
    if (isEditingField || editingId.value !== null) return
    e.preventDefault()
    e.stopPropagation()
    const note = gridNotes.value[selectedIndex.value]
    if (note) {
      editingId.value = note.id
    }
    return
  }

  // Ctrl+N：新建便签（页面兜底，快捷键系统未注册/未重启时也生效）。
  // 编辑中先让当前 textarea 失焦触发保存——组件卸载不会触发 blur，直接切换会丢失未保存内容
  if (e.ctrlKey && e.key.toLowerCase() === 'n' && ctrlNIsCreateShortcut.value) {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    e.preventDefault()
    e.stopPropagation()
    createNote()
    return
  }

  // 正在编辑文本时，其余按键交给输入框处理（编辑态保留原生 Ctrl+A 全选文本，故须在其之前拦截批量多选）
  if (isEditingField) return

  // Ctrl+A：批量多选——未开批量先开启并全选，已开则全选/全不选切换；
  // 仅列表视图提供（回收站无批量操作栏），必须在下方 Ctrl/Meta/Alt 早退之前处理
  if (e.ctrlKey && e.key.toLowerCase() === 'a' && view.value === 'list' && gridNotes.value.length > 0) {
    e.preventDefault()
    e.stopPropagation()
    if (!batchMode.value) toggleBatchMode()
    toggleSelectAll()
    return
  }

  // 其它 Ctrl/Meta/Alt 组合（如 Ctrl+←/→ 切换标签）不在此处理
  if (e.ctrlKey || e.metaKey || e.altKey) return

  const total = gridNotes.value.length
  if (total === 0) return

  let handled = true
  switch (e.key) {
    // 方向键：几何最近邻导航（适配网格与任意布局，按下切到该方向上距离最近的便签）
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      const cards = gridEl.value?.$el?.querySelectorAll('.sticky-note-card')
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
    // 批量模式：空格切换当前选中卡片的勾选（普通模式无此语义，放行给页面滚动）
    case ' ':
      if (batchMode.value && gridNotes.value[selectedIndex.value]) {
        toggleBatchSelect(gridNotes.value[selectedIndex.value]!.id, selectedIndex.value)
      } else {
        handled = false
      }
      break
    case 'Delete':
    case 'Backspace': {
      // 批量模式且有勾选：批量删除（软删进回收站）；否则单删当前选中项
      if (batchMode.value && batchSelectedIds.value.size > 0) {
        void batchDelete()
        break
      }
      const note = gridNotes.value[selectedIndex.value]
      if (note) onRequestDelete(note)
      break
    }
    case 'Escape':
      // 批量模式：Esc 退出批量并清除勾选；非批量态无此语义（放行给全局处理）
      if (batchMode.value) exitBatch()
      else handled = false
      break
    default:
      handled = false
  }

  if (handled) {
    e.preventDefault()
    e.stopPropagation()
    if (e.key !== 'Delete' && e.key !== 'Backspace') {
      // 方向键移动到已加载末尾时预加载下一页（滚动加载之外的无缝衔接）
      if (selectedIndex.value >= notes.value.length - 1 && hasMore.value) {
        void loadMore()
      }
      await scrollSelectedIntoView()
    }
  }
}

/** 轮询/切回刷新：搜索"全部"范围时全量查库；其余情况仅刷新已加载范围（签名一致时跳过整表替换） */
let noteFetching = false
const fetchNotes = async () => {
  if (noteFetching) return
  noteFetching = true
  try {
    const q = noteSearch.value.trim()
    if (q && searchScope.value === 'all') {
      await fetchNotesByScope(q)
      return
    }
    await refreshLoaded()
    // 修正选中索引，避免列表刷新后越界
    if (selectedIndex.value > notes.value.length - 1) {
      selectedIndex.value = Math.max(0, notes.value.length - 1)
    }
  } catch (error) {
    console.error("Failed to fetch notes:", error);
  } finally {
    noteFetching = false
  }
};

let intervalId: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  // 仅在 Tauri 桌面容器内：进入便签页立即加载首屏数据（不必等待首次轮询），并保持轮询。
  // 3s 粒度 + 签名去重 + 窗口隐藏时暂停
  if (isTauri()) {
    fetchNotes();
    intervalId = setInterval(() => {
      if (document.hidden) return
      void fetchNotes()
    }, 3000);
  }
  window.addEventListener('keydown', onKeydown, true)
  // Ctrl+N 新建便签（CreateNoteCommand 派发）
  bus.on('create-note', onCreateNote)
  // Ctrl+F：聚焦便签搜索框（FocusSearchCommand 派发）
  bus.on('focus-search', onFocusSearch)
  // Ctrl+P 全局搜索跳转：切"全部"范围 + 写入搜索词（既有 watcher 查库刷新）
  bus.on('global-search:jump', onGlobalSearchJump)
});

onBeforeUnmount(() => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (dragRafId) { cancelAnimationFrame(dragRafId); dragRafId = 0 }
  if (searchFetchTimer) clearTimeout(searchFetchTimer)
  window.removeEventListener('keydown', onKeydown, true);
  bus.off('create-note', onCreateNote);
  bus.off('focus-search', onFocusSearch);
  bus.off('global-search:jump', onGlobalSearchJump);
});

/** Ctrl+F 聚焦便签搜索框 */
const onFocusSearch = () => {
  nextTick(() => noteSearchInput.value?.focus())
}

/** 全局搜索跳转：切"全部"范围（查库涵盖未加载便签）+ 写入搜索词，既有 watcher 防抖刷新 */
const onGlobalSearchJump = (p: GlobalSearchJumpDetail) => {
  if (p.module !== 'note') return
  searchScope.value = 'all'
  noteSearch.value = p.query
}
</script>
