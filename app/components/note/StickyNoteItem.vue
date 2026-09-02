<template>
  <div
      class="sticky-note-card glass-card group relative mb-4 flex min-h-[200px] cursor-pointer break-inside-avoid flex-col rounded-2xl border p-4 shadow-soft transition-all duration-300 ease-soft hover:-translate-y-1 hover:shadow-float"
      :class="[selected ? '!border-gold ring-2 ring-gold/60 shadow-[0_0_22px_-2px_rgba(196,167,125,0.6)]' : '', saved ? 'note-saved' : '']"
      :style="noteStyle"
      @click="$emit('select')"
  >
    <!-- 右上角工具栏：悬浮不占用内容空间；编辑态隐藏，避免遮挡 textarea -->
    <div v-if="!editing" class="absolute right-2 top-1 z-10 flex items-center gap-0.5">
      <UiDropdown align="end" :aria-label="t('common.changeColor')" panel-class="glass-card w-fit rounded-2xl p-1.5 shadow-float">
        <template #trigger>
          <div
              v-tip="t('common.changeColor')"
              class="btn-soft flex h-6 w-6 items-center justify-center p-1 text-ink-soft outline-none transition-colors hover:bg-white/40 hover:text-ink focus:outline-none"
          >
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"></path>
            </svg>
          </div>
        </template>
        <div class="w-56 space-y-2 p-1.5">
          <!-- 选择配色 -->
          <div>
            <p class="mb-1 px-1 text-[10px] uppercase tracking-wide text-ink-faint">{{ t('note.colorTip') }}</p>
            <div class="flex flex-wrap gap-1.5 px-0.5">
              <button
                  v-for="c in noteColors"
                  :key="c.name"
                  type="button"
                  v-tip="c.name"
                  class="flex h-7 w-7 items-center justify-center rounded-full border border-white/60 shadow-sm transition-transform hover:scale-110"
                  :style="{ backgroundColor: c.color }"
                  @click="$emit('color-change', note.id, c.color)"
              >
                <svg v-if="noteColorHex === c.color" class="h-3.5 w-3.5 text-white drop-shadow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                </svg>
              </button>
            </div>
          </div>

          <!-- 管理配色：名称 + 颜色选取器，增改删 -->
          <div v-if="managingColors" class="max-h-72 space-y-1.5 overflow-y-auto border-t border-accent/60 pt-1.5" data-dd-keep-open>
            <div v-for="(row, idx) in colorDrafts" :key="idx" class="rounded-lg border border-accent/50 p-1.5">
              <div class="flex items-center gap-1.5">
                <button
                    type="button"
                    v-tip="t('common.changeColorShort')"
                    class="h-5 w-5 shrink-0 rounded-full border border-white/60 shadow-sm transition-transform hover:scale-110"
                    :class="colorRow === idx ? 'ring-2 ring-gold' : ''"
                    :style="{ backgroundColor: row.color }"
                    @click="colorRow = colorRow === idx ? null : idx"
                />
                <input
                    type="text" maxlength="8" :placeholder="t('note.colorNamePlaceholder')"
                    v-model="row.name"
                    class="min-w-0 flex-1 rounded-md border border-accent bg-surface-field px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
                />
                <button
                    type="button"
                    v-tip="t('common.deleteColor')"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger/10"
                    @click="removeColorDraft(idx)"
                >
                  <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div v-if="colorRow === idx" class="mt-1.5">
                <UiColorPicker v-model="row.color" :presets="NOTE_COLOR_PRESETS" />
              </div>
            </div>
            <p v-if="colorDrafts.length === 0" class="px-1 py-1 text-center text-xs text-ink-faint">{{ t('note.noColors') }}</p>
            <div class="flex items-center justify-between pt-0.5">
              <button type="button" class="rounded-lg px-2 py-1 text-xs text-ink-soft transition-colors hover:bg-secondary hover:text-ink" @click="addColorDraft">{{ t('note.addColor') }}</button>
              <button type="button" class="btn-gold px-3 py-1 text-xs" @click="commitColors">{{ t('note.done') }}</button>
            </div>
          </div>
          <div v-else class="border-t border-accent/60 pt-1.5">
            <button
                type="button"
                data-dd-keep-open
                class="w-full rounded-lg px-2 py-1 text-left text-xs text-ink-soft transition-colors hover:bg-secondary hover:text-ink"
                @click="openColorManager"
            >
              {{ t('note.manageColors') }}
            </button>
          </div>
        </div>
      </UiDropdown>
      <button
          type="button"
          @click="$emit('request-delete', $event)"
          v-tip="t('common.delete')"
          class="btn-soft flex h-6 w-6 items-center justify-center p-1 text-danger transition-colors hover:bg-danger/10"
      >
        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
        </svg>
      </button>
    </div>

    <div
        v-if="!editing"
        class="flex-1 whitespace-pre-wrap break-words select-none pr-14 pt-3 text-ink"
        @dblclick="$emit('request-edit')"
    >
      <HighlightText
          v-if="note.content"
          :text="note.content"
          :highlight-string="highlightString"
          :active="highlight"
      />
      <span v-else>{{ t('note.dblClickEdit') }}</span>
    </div>

    <div v-else class="flex-1">
      <textarea
          v-model="editContent"
          ref="textareaRef"
          rows="1"
          class="w-full resize-none overflow-hidden rounded-lg bg-transparent px-1 py-0.5 text-ink outline-none focus:bg-white/30 focus:shadow-[inset_0_0_0_1px_rgba(196,167,125,0.35)] transition-colors"
          :placeholder="t('note.contentPlaceholder')"
          @blur="saveAndClose"
          @input="autoResize"
          @keydown.ctrl.enter="onCtrlEnterSave"
      ></textarea>
    </div>

    <!-- 底部行：日期（左）+ 保存快捷键提示（右），mt-auto 推到底部，水平两端对齐垂直居中 -->
    <div class="mt-auto flex items-center justify-between gap-2 pt-2">
      <div class="text-xs text-ink-faint opacity-0 transition-opacity duration-300 ease-soft group-hover:opacity-100">
        {{ formatDateLocalized(parseInt(note.updated_at)) }}
      </div>
      <div
          v-if="editing && saveShortcut"
          class="pointer-events-none rounded-md bg-white/35 px-2 py-0.5 text-[11px] text-ink-soft backdrop-blur-sm"
      >
        {{ saveShortcut }} {{ t('common.save') }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import UiDropdown from '~/components/ui/UiDropdown.vue';
import UiColorPicker from '~/components/ui/UiColorPicker.vue';
import { useNoteColors, resolveNoteColor, adaptNoteColorToScheme, NOTE_COLOR_PRESETS, type NoteColor } from '~/composables/useNoteColors';
import { useColorScheme } from '~/composables/useColorScheme';
import { useI18n } from '~/composables/useI18n';
import { ref, watch, nextTick, computed, onBeforeUnmount } from 'vue'
import type { Note } from '~/src/entities';
import HighlightText from "~/components/mainpage/HighlightText.vue";
import { useFormatDate } from "~/composables/useFormatDate";
import { shortcuts } from "~/src/commands/shortcuts/InitShortcuts";
import { formatShortcutForDisplay, matchesKeyId } from "~/utils/shortcutFormat";

const { t } = useI18n();
const formatDateLocalized = useFormatDate();

const props = defineProps<{
  note: Note
  selected?: boolean
  editing?: boolean
  highlightString?: string
  highlight?: boolean
}>()

const emit = defineEmits<{
  (e: 'update', id: string, content: string): void
  (e: 'request-delete', event?: MouseEvent): void
  (e: 'color-change', id: string, color: string): void
  (e: 'request-edit'): void
  (e: 'finish-edit'): void
  (e: 'select'): void
}>()

const editContent = ref('')
const textareaRef = ref<HTMLTextAreaElement>()

// 编辑态时让 textarea 高度自适应内容（与展示态文字撑开卡片的效果一致）
const autoResize = () => {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

// 进入编辑态时初始化内容、按内容高度自适应并聚焦光标
watch(() => props.editing, async (editing) => {
  if (editing) {
    editContent.value = props.note.content
    await nextTick()
    autoResize()
    textareaRef.value?.focus()
  }
}, { immediate: true })

/** 显示当前配置的「保存便签」快捷键（可在设置页修改） */
const saveShortcut = computed(() => {
  const s = shortcuts.value.find(x => x.id === 'save_note')
  return s && s.enabled ? formatShortcutForDisplay(s.key) : ''
})

/** 保存快捷键是否为 Ctrl+Enter（默认配置或被污染为无修饰 Enter）——此时由 textarea 兜底直接保存；
 *  用户自定义为其他带修饰键时交还快捷键系统 */
const ctrlEnterIsSaveShortcut = computed(() => {
  const s = shortcuts.value.find(x => x.id === 'save_note')
  if (!s || !s.enabled) return false
  return matchesKeyId(s.key, 'control+enter') || matchesKeyId(s.key, 'enter')
})

/** 响应 ContextEditCommand 派发的保存事件（仅在编辑态保存当前便签）。
 *  监听随编辑态挂载/卸载：此前每张渲染的卡片都向 window 挂一个监听（首屏 40 个） */
const onSaveNote = () => {
  if (props.editing) saveAndClose()
}
watch(() => props.editing, (editing) => {
  if (editing) {
    window.addEventListener('save-note', onSaveNote)
  } else {
    window.removeEventListener('save-note', onSaveNote)
  }
}, { immediate: true })
onBeforeUnmount(() => {
  window.removeEventListener('save-note', onSaveNote)
  if (saveAnimTimer) clearTimeout(saveAnimTimer)
})

// ===== 配色：自定义名称 + 颜色（useNoteColors 统一管理，卡片背景由 hex 动态生成）=====
const { colors: noteColors, replaceColors } = useNoteColors()

/** 卡片着色：低透明底 + 同色描边（旧名称存储自动解析为 hex）。
 *  颜色按主题适配：琥珀原色，浅色/暗黑自动转为灰彩/深色（见 adaptNoteColorToScheme）。
 *  选中态的边框高亮由模板里的选中类（!border-gold + ring）统一处理，与待办选中样式一致 */
const { resolvedScheme } = useColorScheme()
const noteColorHex = computed(() => resolveNoteColor(props.note.color))
const noteStyle = computed(() => {
  const { bg, border } = adaptNoteColorToScheme(noteColorHex.value, resolvedScheme.value)
  return {
    backgroundColor: bg + '8c',
    borderColor: border + '80',
  }
})

// 管理器：本地草稿，完成后整表提交
const managingColors = ref(false)
const colorDrafts = ref<NoteColor[]>([])
/** 当前展开取色器的行（默认全部收起，避免面板超高） */
const colorRow = ref<number | null>(null)

function openColorManager() {
  colorDrafts.value = noteColors.value.map(c => ({ ...c }))
  colorRow.value = null
  managingColors.value = true
}

function addColorDraft() {
  colorDrafts.value.push({ name: '', color: '#dcc88a' })
}

function removeColorDraft(idx: number) {
  colorDrafts.value.splice(idx, 1)
}

async function commitColors() {
  await replaceColors(colorDrafts.value)
  managingColors.value = false
}

const saved = ref(false)
let saveAnimTimer: ReturnType<typeof setTimeout> | null = null

const saveAndClose = () => {
  if (editContent.value !== props.note.content) {
    emit('update', props.note.id, editContent.value)
  }
  // 保存成功动画：金色光晕脉冲后退出编辑态，配合内容淡入上浮
  saved.value = true
  if (saveAnimTimer) clearTimeout(saveAnimTimer)
  saveAnimTimer = setTimeout(() => {
    saved.value = false
    emit('finish-edit')
  }, 420)
}

/** Ctrl+Enter 直接保存（textarea 级兜底）：仅当保存快捷键就是 Ctrl+Enter 时生效；
 *  阻止冒泡避免与快捷键系统 ContextEditCommand 双重触发；若用户自定义成其他键则交还快捷键系统 */
const onCtrlEnterSave = (e: KeyboardEvent) => {
  if (!ctrlEnterIsSaveShortcut.value) return
  e.preventDefault()
  e.stopPropagation()
  saveAndClose()
}
</script>
