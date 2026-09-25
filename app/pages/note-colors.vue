<script setup lang="ts">
/**
 * 独立弹出卡片页：便签配色管理（/note-colors）
 *
 * 由 StickyNoteItem「管理配色」以无边框透明窗口打开（decorations:false + 页面自绘
 * 圆角卡片，无原生窗口栏/标题栏），窗口锚定在点击位置弹出——编辑空间不受主面板
 * 尺寸限制。本地草稿编辑（色环 / 预设 / hex 三入口）→「完成」整表提交
 * useNoteColors → 广播 note-colors:changed（主窗口模块级监听重载）→ 关闭窗口。
 * ESC 关闭；失焦自关（popup 语义，点击卡片外任何位置即收起）；标题行可拖动窗口。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emit } from '@tauri-apps/api/event'
import UiColorPicker from '~/components/ui/UiColorPicker.vue'
import { useNoteColors, NOTE_COLOR_PRESETS, type NoteColor } from '~/composables/useNoteColors'
import { useColorScheme } from '~/composables/useColorScheme'
import { useI18n } from '~/composables/useI18n'
import { isTauri } from '~/utils/env'

const { t } = useI18n()
// 弹出卡片沿用全局配色主题（<html data-scheme> 换肤对本窗口同样生效）
useColorScheme()
const { colors, replaceColors } = useNoteColors()

/** 本地草稿：打开时快照当前配色，「完成」才整表提交 */
const drafts = ref<NoteColor[]>([])
/** 展开取色器的行（默认收起） */
const openRow = ref<number | null>(null)
/** 提交中：防止重复点「完成」双发事件 */
const committing = ref(false)

onMounted(() => {
  drafts.value = colors.value.map(c => ({ ...c }))
  startFocusWatcher()
})

function addDraft() {
  drafts.value.push({ name: '', color: '#dcc88a' })
}

function removeDraft(idx: number) {
  drafts.value.splice(idx, 1)
}

/** 提交整表 → 通知主窗口重载 → 关闭自身窗口 */
async function commitAndClose() {
  if (committing.value) return
  committing.value = true
  try {
    await replaceColors(drafts.value)
    await emit('note-colors:changed').catch(() => {})
    await closeWindow()
  } finally {
    committing.value = false
  }
}

async function closeWindow() {
  await getCurrentWebviewWindow().close().catch(() => {})
}

/** 失焦自关：popup 语义（点击卡片外任意位置收起）。
 *  延迟启用——窗口创建初期存在 focus false→true 的过渡事件序列，立即监听会误关 */
let focusUnlisten: (() => void) | null = null
async function startFocusWatcher() {
  if (!isTauri()) return
  setTimeout(async () => {
    try {
      focusUnlisten = await getCurrentWebviewWindow().onFocusChanged((focused) => {
        if (!focused) void closeWindow()
      })
    } catch { /* 监听失败仅损失失焦自关，不影响功能 */ }
  }, 500)
}

/** ESC 关窗（未提交的草稿丢弃，与原下拉面板行为一致） */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') void closeWindow()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  focusUnlisten?.()
})
</script>

<template>
  <!-- 透明窗口内自绘圆角卡片：外层留白给阴影/圆角，卡片承担视觉层次 -->
  <div class="flex min-h-screen items-start justify-center p-1.5">
    <div class="w-full max-w-[352px] rounded-2xl border border-accent/60 bg-surface p-3 shadow-2xl">
      <!-- 标题行：data-tauri-drag-region 无边框窗口拖动把手 -->
      <div class="mb-2.5 flex items-center justify-between" data-tauri-drag-region>
        <p class="cursor-grab text-sm font-medium select-none" data-tauri-drag-region>{{ t('note.manage_colors') }}</p>
        <button
            type="button"
            class="flex h-6 w-6 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-secondary hover:text-ink"
            @click="closeWindow"
        >
          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- 配色行：色点（展开取色器）+ 名称 + 删除 -->
      <div class="max-h-[288px] space-y-1.5 overflow-y-auto">
        <div v-for="(row, idx) in drafts" :key="idx" class="rounded-xl border border-accent/50 p-2">
          <div class="flex items-center gap-2">
            <button
                type="button"
                v-tip="t('common.change_color_short')"
                class="h-6 w-6 shrink-0 rounded-full border border-white/60 shadow-xs transition-transform hover:scale-110"
                :class="openRow === idx ? 'ring-2 ring-gold' : ''"
                :style="{ backgroundColor: row.color }"
                @click="openRow = openRow === idx ? null : idx"
            />
            <input
                type="text" maxlength="8" :placeholder="t('note.color_name_placeholder')"
                v-model="row.name"
                class="min-w-0 flex-1 rounded-md border border-accent bg-surface-field px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
            />
            <button
                type="button"
                v-tip="t('common.delete_color')"
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger/10"
                @click="removeDraft(idx)"
            >
              <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div v-if="openRow === idx" class="mt-2">
            <UiColorPicker v-model="row.color" :presets="NOTE_COLOR_PRESETS" />
          </div>
        </div>
        <p v-if="drafts.length === 0" class="py-2 text-center text-xs text-ink-faint">{{ t('note.no_colors') }}</p>
      </div>

      <div class="mt-2 flex items-center justify-between">
        <button type="button" class="rounded-lg px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-secondary hover:text-ink" @click="addDraft">{{ t('note.add_color') }}</button>
        <button type="button" class="btn-gold px-4 py-1.5 text-sm" :disabled="committing" @click="commitAndClose">{{ t('note.done') }}</button>
      </div>
    </div>
  </div>
</template>

<style>
/* 透明窗口：全局 body 渐变背景与光晕伪元素会使自绘卡片圆角外露底（同 bubble 的
   .island-body 目的），本页整窗置透明，视觉层次完全由卡片圆角+描边+阴影承载 */
body {
  background: transparent !important;
}
body::before,
body::after {
  display: none !important;
}
</style>
