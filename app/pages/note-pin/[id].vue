<script setup lang="ts">
/**
 * 桌面便签窗口页（/note-pin/{id}）
 *
 * 由 StickyNoteItem「钉到桌面」以无边框透明置顶小窗打开（同 note-colors 的
 * 无原生窗口栏模式，app.vue 豁免 TitleBar——窗口即便签本身）：页面自绘便签
 * 卡片，顶部为窗口拖动把手。默认只读渲染与主列表同源（renderNote 轻量渲染），
 * 双击进编辑（textarea 自适应高度）；Ctrl+Enter / 失焦保存，Esc 取消编辑，
 * 全部写回走 dbService.updateNote（主窗口轮询签名去重近实时回流列表）。
 * 3s 轮询同步主窗口的内容/配色/标签修改（签名去重，无变化不重渲染；编辑中
 * 暂停防止覆盖输入）。便签被删除/进回收站后自动关窗。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import clipboardService from '~/src/db/dbService'
import type { Note } from '~/src/entities'
import { renderNote } from '~/src/note/markdown'
import NoteInline from '~/components/note/NoteInline.vue'
import { resolveNoteColor, adaptNoteColorToScheme } from '~/composables/useNoteColors'
import { useColorScheme } from '~/composables/useColorScheme'
import { useI18n } from '~/composables/useI18n'
import { useTransparentWindow } from '~/composables/useTransparentWindow'
import { isTauri } from '~/utils/env'

const { t } = useI18n()
// 弹出窗口沿用全局配色主题（<html data-scheme> 换肤对本窗口同样生效）
useColorScheme()

const route = useRoute()
const noteId = String(route.params.id ?? '')

/** 跟随横条上松手的兜底上报：跟随窗 show 抢焦点等场景下主窗口 webview 失焦、
 *  浏览器暂停鼠标事件派发，主窗口收不到 pointerup——光标松手必然落在横条上，
 *  由跟随窗转发（主窗口收到即结束拖出钉桌流程） */
function emitDragUp() {
  void import('@tauri-apps/api/event').then(({ emit }) => { void emit('note-pin-drag-up', noteId).catch(() => {}) })
}

/** 首次内容渲染完成后广播 ready：桌签窗以隐藏创建，主窗口收到才 show——
 *  加载期任何默认底色帧（body 米色背景等）都不可见 */
let readySent = false
function emitReady() {
  if (readySent) return
  readySent = true
  void import('@tauri-apps/api/event').then(({ emit }) => { void emit('note-pin-ready', noteId).catch(() => {}) })
}

// 内联透明背景：随 HTML 解析即生效（早于 onMounted 的 useTransparentWindow），
// 消除页面加载瞬间 body 米色实底帧——拖出钉桌时跟随窗「出现主窗口背景色小窗
// 随后消失」的根因就是这一帧（全局渐变背景先渲染，mounted 后才被置透明）
useHead({
  style: [{ innerHTML: 'html, body { background: transparent !important; background-image: none !important; }' }],
})

const note = ref<Note | null>(null)
/** 首次加载是否完成（区分「加载中」与「不存在」） */
const loaded = ref(false)
/** 曾成功展示过内容：此后轮询发现便签被删/进回收站 → 自动关窗（桌签不残留空壳） */
let hadNote = false

// ===== 只读渲染（与主列表 StickyNoteItem 同源）=====
const rendered = computed(() => renderNote(note.value?.content || ''))
const tags = computed(() => note.value?.tags ?? [])

/** 卡片着色与主列表同源：主题适配（浅色粉彩纸 / 暗黑同相深彩） */
const { resolvedScheme } = useColorScheme()
const noteStyle = computed(() => {
  const { bg, border, bgAlpha, borderAlpha } = adaptNoteColorToScheme(resolveNoteColor(note.value?.color), resolvedScheme.value)
  return {
    backgroundColor: bg + bgAlpha,
    borderColor: border + borderAlpha,
  }
})

/** 拉取便签（3s 轮询 + 签名去重：主窗口的编辑/改色在此窗口近实时同步） */
let lastSig = ''
async function load() {
  try {
    const fetched = await clipboardService.fetchSingleNote(noteId)
    if (!fetched || fetched.deleted_at) {
      // 便签不存在 / 已进回收站：切缺失态；曾展示过内容的桌签自动收尾
      if (lastSig !== 'missing') {
        lastSig = 'missing'
        note.value = null
        if (hadNote) void closeWindow()
      }
    } else {
      const sig = `${fetched.updated_at}:${fetched.content?.length ?? 0}:${fetched.color ?? ''}`
      if (sig !== lastSig) {
        lastSig = sig
        note.value = fetched
        hadNote = true
      }
    }
  } catch { /* 查询失败保留上次内容 */ } finally {
    loaded.value = true
  }
}

let pollId: ReturnType<typeof setInterval> | null = null

// ===== 跟随态（拖出钉桌移动中）：窗口切迷你横条尺寸 + 渲染幽灵卡同款样式
//  （金钉 + 首行截断文字，与主窗口拖动幽灵一致）；收到 false（松手定格）恢复
//  完整卡片并以 popKey 重建重播入场动画。复用已有桌签窗二次拖出同样生效。
//  初始值取 URL query（跟随模式创建带 ?following=1，页面首帧即横条——事件先于
//  页面 listen 建立会丢失） =====
const following = ref(String(route.query.following ?? '') === '1')
const popKey = ref(0)
let unFollow: (() => void) | null = null

/** 横条文案：首行非空内容截断（与主窗口幽灵卡一致） */
const ghostLine = computed(() => {
  const line = (note.value?.content || '').split('\n').map(l => l.trim()).find(Boolean) || ''
  return line.length > 24 ? `${line.slice(0, 24)}…` : line
})

onMounted(() => {
  // 透明窗口：去除全局 body 渐变与光晕，避免自绘卡片圆角外露实底「白角」
  useTransparentWindow()
  if (isTauri()) {
    void load()
    pollId = setInterval(() => {
      // 编辑中暂停轮询：防止拉取覆盖正在输入的内容
      if (document.hidden || editing.value) return
      void load()
    }, 3000)
    getCurrentWebviewWindow().listen<boolean>('note-pin-follow', (e) => {
      following.value = !!e.payload
      if (!e.payload) popKey.value++
    }).then(un => { unFollow = un }).catch(() => {})
  }
  // 首次数据加载 + 内容渲染完成 → ready（主窗口才 show；轮询触发的后续 load 不再发）
  void load().then(() => void nextTick(emitReady)).catch(() => emitReady())
})
onBeforeUnmount(() => {
  if (pollId) {
    clearInterval(pollId)
    pollId = null
  }
  unFollow?.()
  unFollow = null
})

// ===== 编辑（桌面便签支持直接编辑，对齐主卡片交互：双击进编辑、失焦/Ctrl+Enter 保存）=====
const editing = ref(false)
const editText = ref('')
const editEl = ref<HTMLTextAreaElement | null>(null)

/** 双击进入编辑：轮询暂停（见 pollId 回调）；光标置尾 */
function startEdit() {
  if (!note.value || editing.value) return
  editText.value = note.value.content || ''
  editing.value = true
  void nextTick(() => {
    const el = editEl.value
    if (!el) return
    autoGrow()
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  })
}

/** textarea 自适应内容高度（同主卡片 autoResize 模式） */
function autoGrow() {
  const el = editEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/** 保存编辑：全列写回（updated_at 刷新 → 主窗口轮询签名变化近实时回流列表） */
async function commitEdit() {
  const current = note.value
  if (!current || !editing.value) return
  editing.value = false
  const next = editText.value
  if (next === (current.content || '')) return
  try {
    await clipboardService.updateNote({
      ...current,
      content: next,
      updated_at: String(Date.now()),
    })
    note.value = { ...current, content: next, updated_at: String(Date.now()) }
  } catch { /* 保存失败：轮询/重开会还原为库内内容 */ }
}

/** Esc 取消编辑：丢弃未保存修改，回只读态 */
function cancelEdit() {
  editing.value = false
}

async function closeWindow() {
  await getCurrentWebviewWindow().close().catch(() => {})
}

/** 无边框窗口拖动：API 直调。data-tauri-drag-region 依赖 mousedown target 自带属性，
 *  把手行内的 svg/空白命中不触发（拖不动的根因）；整行任意位置按下即拖 */
async function startDrag() {
  await getCurrentWebviewWindow().startDragging().catch(() => {})
}

/** ESC：编辑态退出编辑（不保存）；只读态关窗 */
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (editing.value) {
    e.preventDefault()
    cancelEdit()
    return
  }
  void closeWindow()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!-- 透明窗口内自绘圆角卡片：外层留白给阴影/圆角，卡片承担视觉层次；
       窗口即便签本身（无导航/标题栏），顶部细把手行负责拖动 -->
  <div class="flex h-screen items-stretch" :class="following ? 'p-2' : 'p-1.5'">
    <!-- 跟随态（拖出钉桌移动中）：迷你横条，与主窗口拖动幽灵卡同款（金钉 + 首行截断、
         轻阴影微倾斜）；窗口已被主窗口切成横条尺寸，松手/拖回由主窗口收尾 -->
    <div v-if="following" class="flex min-h-0 min-w-0 w-full items-center justify-center">
      <div
          v-if="note"
          class="note-ghost-in flex max-w-[92%] rotate-3 scale-95 items-center gap-1.5 rounded-xl border px-3 py-2 opacity-90 shadow-float"
          :style="noteStyle"
          @pointerup="emitDragUp"
      >
        <svg class="h-3.5 w-3.5 shrink-0 text-gold" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
        <span class="min-w-0 truncate text-xs text-ink">{{ ghostLine }}</span>
      </div>
    </div>

    <!-- 定格/常态：完整桌签卡片（无导航/标题栏，顶部细把手行负责拖动） -->
    <div
        v-else
        :key="popKey"
        class="note-pop-in flex min-h-0 min-w-0 w-full flex-col overflow-hidden rounded-2xl border p-3 shadow-2xl"
        :style="noteStyle"
    >
      <!-- 把手行：整行 mousedown 直调 startDragging（任意位置可拖）+ 常显关闭按钮 -->
      <div
          class="relative flex h-6 shrink-0 cursor-grab select-none items-center justify-end"
          @mousedown.left.prevent="startDrag"
      >
        <div class="pointer-events-none absolute left-1/2 flex -translate-x-1/2 text-ink-soft opacity-40" aria-hidden="true">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="5" r="1.8" /><circle cx="15" cy="5" r="1.8" />
            <circle cx="9" cy="12" r="1.8" /><circle cx="15" cy="12" r="1.8" />
            <circle cx="9" cy="19" r="1.8" /><circle cx="15" cy="19" r="1.8" />
          </svg>
        </div>
        <button
            type="button"
            class="flex h-5 w-5 items-center justify-center rounded-md text-ink-soft opacity-70 transition-all hover:bg-white/40 hover:text-ink hover:opacity-100"
            @mousedown.stop
            @click="closeWindow"
        >
          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- 编辑态：textarea 自适应高度，Ctrl+Enter / 失焦保存（快捷键与主卡片一致） -->
      <textarea
          v-if="editing"
          ref="editEl"
          v-model="editText"
          class="min-h-0 min-w-0 flex-1 resize-none overflow-y-auto overflow-x-hidden bg-transparent py-1.5 text-[13px] leading-relaxed text-ink outline-hidden placeholder:text-ink-faint"
          :placeholder="t('note.content_placeholder')"
          @input="autoGrow"
          @blur="commitEdit"
          @keydown.ctrl.enter.prevent="commitEdit"
      />

      <!-- 只读内容：与主列表同源渲染（标题/清单/列表/行内格式）；双击进编辑；min-w-0 + 破词防长串溢出 -->
      <div
          v-else
          class="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5 select-none whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink"
          :title="note ? t('note.dbl_click_edit') : undefined"
          @dblclick="startEdit"
      >
        <template v-if="rendered.lines.length">
          <template v-for="line in rendered.lines" :key="line.srcIndex">
            <div v-if="line.kind === 'empty'" class="h-2" />
            <p
                v-else-if="line.kind === 'heading'"
                class="font-semibold leading-snug"
                :class="line.level === 1 ? 'text-[15px]' : line.level === 2 ? 'text-sm' : 'text-[13px] opacity-90'"
            >
              <NoteInline :tokens="line.tokens" />
            </p>
            <div v-else-if="line.kind === 'checklist'" class="flex items-start gap-1.5">
              <span
                  class="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border"
                  :class="line.checked ? 'border-gold bg-gold text-white' : 'border-ink-faint/60'"
              >
                <svg v-if="line.checked" class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
              </span>
              <span :class="line.checked ? 'text-ink-faint line-through' : ''"><NoteInline :tokens="line.tokens" /></span>
            </div>
            <div v-else-if="line.kind === 'list'" class="flex items-start gap-1.5">
              <span class="mt-px shrink-0 text-ink-faint">•</span>
              <span><NoteInline :tokens="line.tokens" /></span>
            </div>
            <p v-else><NoteInline :tokens="line.tokens" /></p>
          </template>
        </template>
        <span v-else-if="note" class="text-ink-faint">{{ t('note.pin_empty') }}</span>

        <!-- 便签不存在（坏 id / 已彻底删除）：居中缺失态，由用户手动关窗 -->
        <div v-if="loaded && !note" class="flex h-full flex-col items-center justify-center gap-2 text-center">
          <svg class="h-8 w-8 text-ink-faint/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <p class="text-xs text-ink-faint">{{ t('note.pin_missing') }}</p>
        </div>
      </div>

      <!-- 标签徽章（与主列表一致的弱化 chips） -->
      <div v-if="tags.length" class="mt-1.5 flex flex-wrap gap-1">
        <span
            v-for="tag in tags"
            :key="tag"
            class="rounded-full bg-gold/15 px-1.5 py-px text-[10px] text-gold"
        >#{{ tag }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 跟随态横条淡入：柔化「独立小窗」的出现感（末帧与 utility rotate-3/scale-95/opacity-90 一致） */
@keyframes noteGhostIn {
  from { opacity: 0; transform: scale(0.85) rotate(3deg); }
  to { opacity: 0.9; transform: scale(0.95) rotate(3deg); }
}
.note-ghost-in { animation: noteGhostIn 0.18s ease-out both; }
</style>
