<template>
  <div
      ref="cardEl"
      class="sticky-note-card glass-card group relative flex min-h-[200px] flex-col rounded-2xl border p-4 shadow-soft transition-all duration-300 ease-soft hover:-translate-y-1 hover:shadow-float"
      :class="[
        selected ? '!border-gold ring-2 ring-gold/60 shadow-[0_0_22px_-2px_rgba(196,167,125,0.6)]' : '',
        saved ? 'note-saved' : '',
        batchMode && batchSelected ? '!border-gold ring-2 ring-gold/50' : '',
        // 拖出钉桌：拖动中原卡片半透明缩小让位给幽灵卡，光标抓手
        dragActive && !ghostReturning ? 'cursor-grabbing scale-[0.97] opacity-55 shadow-none hover:translate-y-0' : '',
        dragActive ? 'cursor-grabbing' : 'cursor-pointer',
        // 拖动重排源卡：禁用 FLIP move 动画（.note-move.note-drag-source，见 main.css）
        dragSource ? 'note-drag-source' : '',
      ]"
      :style="noteStyle"
      :data-note-id="note.id"
      @click="onCardClick"
      @pointerdown="onCardPointerDown"
  >
    <!-- 批量模式：左上角勾选圆圈（对齐剪贴板/待办批量交互） -->
    <button
        v-if="batchMode"
        type="button"
        class="absolute left-2 top-2 z-20 flex h-5 w-5 items-center justify-center rounded-full border transition-colors"
        :class="batchSelected ? 'border-gold bg-gold text-white' : 'border-ink-faint/50 bg-white/50 text-transparent hover:border-gold'"
        v-tip="batchSelected ? t('clip.batch_cancel') : t('note.select')"
        @click.stop="$emit('toggle-batch-select')"
    >
      <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
    </button>

    <!-- 右上角工具栏：悬浮不占用内容空间；编辑态隐藏，避免遮挡 textarea；回收站态切换为恢复/彻底删除 -->
    <div v-if="!editing && !batchMode" class="absolute right-2 top-1 z-10 flex items-center gap-0.5" data-no-drag>
      <template v-if="trash">
        <!-- 回收站：恢复 / 彻底删除（彻底删除走父级 DeleteConfirm 确认） -->
        <button
            type="button"
            v-tip="t('note.restore')"
            class="btn-soft flex h-6 w-6 items-center justify-center p-1 text-ink-soft transition-colors hover:bg-white/40 hover:text-ink"
            @click="$emit('request-restore', note.id)"
        >
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
        </button>
        <button
            type="button"
            v-tip="t('note.purge')"
            class="btn-soft flex h-6 w-6 items-center justify-center p-1 text-danger transition-colors hover:bg-danger/10"
            @click="$emit('request-purge', note.id)"
        >
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </template>
      <template v-else>
        <!-- 置顶：图钉（金色实心 = 已置顶） -->
        <button
            type="button"
            v-tip="note.pinned === 1 ? t('note.unpin') : t('note.pin')"
            class="btn-soft flex h-6 w-6 items-center justify-center p-1 transition-colors"
            :class="note.pinned === 1 ? 'text-gold' : 'text-ink-soft hover:bg-white/40 hover:text-ink'"
            @click="$emit('toggle-pin', note.id)"
        >
          <svg class="h-3.5 w-3.5" :fill="note.pinned === 1 ? 'currentColor' : 'none'" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
        </button>
        <!-- 钉到桌面：独立置顶小窗常驻显示 -->
        <button
            type="button"
            v-tip="t('note.pin_desktop')"
            class="btn-soft flex h-6 w-6 items-center justify-center p-1 text-ink-soft transition-colors hover:bg-white/40 hover:text-ink"
            @click="$emit('pin-desktop', note.id)"
        >
          <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
        </button>
        <!-- AI 整理：摘要 / 提取待办（依赖设置页 AI 配置，父级校验与执行） -->
        <UiDropdown align="end" :aria-label="t('note.ai_organize')" panel-class="glass-card w-fit rounded-2xl p-1.5 shadow-float">
          <template #trigger>
            <div
                v-tip="t('note.ai_organize')"
                class="btn-soft flex h-6 w-6 items-center justify-center p-1 text-ink-soft outline-hidden transition-colors hover:bg-white/40 hover:text-ink focus:outline-hidden"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.7L19.6 10l-5.7 1.9L12 17.6l-1.9-5.7L4.4 10l5.7-1.3z" /><path d="M19 15l.9 2.6L22.5 18.5l-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z" /></svg>
            </div>
          </template>
          <div class="w-44">
            <button type="button" class="w-full rounded-lg px-2 py-1 text-left text-xs text-ink-soft transition-colors hover:bg-secondary hover:text-ink" @click="$emit('ai-organize', note.id, 'summary')">{{ t('note.ai_summary') }}</button>
            <button type="button" class="w-full rounded-lg px-2 py-1 text-left text-xs text-ink-soft transition-colors hover:bg-secondary hover:text-ink" @click="$emit('ai-organize', note.id, 'extract')">{{ t('note.ai_extract') }}</button>
          </div>
        </UiDropdown>
        <!-- 配色（原逻辑保留：选择 + 管理配色独立窗口） -->
        <UiDropdown align="end" :aria-label="t('common.change_color')" panel-class="glass-card w-fit rounded-2xl p-1.5 shadow-float">
          <template #trigger>
            <div
                v-tip="t('common.change_color')"
                class="btn-soft flex h-6 w-6 items-center justify-center p-1 text-ink-soft outline-hidden transition-colors hover:bg-white/40 hover:text-ink focus:outline-hidden"
            >
              <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"></path>
              </svg>
            </div>
          </template>
          <div class="w-56 space-y-2 p-1.5">
            <div>
              <p class="mb-1 px-1 text-[10px] uppercase tracking-wide text-ink-faint">{{ t('note.color_tip') }}</p>
              <div class="flex flex-wrap gap-1.5 px-0.5">
                <button
                    v-for="c in noteColors"
                    :key="c.name"
                    type="button"
                    v-tip="c.name"
                    class="flex h-7 w-7 items-center justify-center rounded-full border border-white/60 shadow-xs transition-transform hover:scale-110"
                    :style="{ backgroundColor: c.color }"
                    @click="$emit('color-change', note.id, c.color)"
                >
                  <svg v-if="noteColorHex === c.color" class="h-3.5 w-3.5 text-white drop-shadow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                  </svg>
                </button>
              </div>
            </div>
            <div class="border-t border-accent/60 pt-1.5">
              <button
                  type="button"
                  data-dd-keep-open
                  class="w-full rounded-lg px-2 py-1 text-left text-xs text-ink-soft transition-colors hover:bg-secondary hover:text-ink"
                  @click="openColorManager($event)"
              >
                {{ t('note.manage_colors') }}
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
      </template>
    </div>

    <!-- 只读内容：轻量渲染（标题/清单/列表/行内格式），清单勾选即时写回；双击进编辑 -->
    <div
        v-if="!editing"
        class="flex-1 whitespace-pre-wrap break-words select-none pr-14 pt-3 text-[13px] leading-relaxed text-ink"
        @dblclick="!trash && $emit('request-edit')"
    >
      <template v-if="note.content">
        <template v-for="line in rendered.lines" :key="line.srcIndex">
          <div v-if="line.kind === 'empty'" class="h-2" />
          <p
              v-else-if="line.kind === 'heading'"
              class="font-semibold leading-snug"
              :class="line.level === 1 ? 'text-[15px]' : line.level === 2 ? 'text-sm' : 'text-[13px] opacity-90'"
          >
            <NoteInline :tokens="line.tokens" />
          </p>
          <div
              v-else-if="line.kind === 'checklist'"
              class="group/check flex items-start gap-1.5"
              role="button"
              v-tip="line.checked ? t('note.uncheck') : t('note.check')"
              @click.stop="!trash && $emit('toggle-checklist', note.id, line.srcIndex)"
          >
            <span
                class="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors"
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
      <span v-else class="text-ink-faint">{{ t('note.dbl_click_edit') }}</span>
    </div>

    <!-- 编辑态：内容 textarea + 标签输入行 -->
    <div v-else class="flex-1">
      <textarea
          v-model="editContent"
          ref="textareaRef"
          rows="1"
          class="w-full resize-none overflow-hidden rounded-lg bg-transparent px-1 py-0.5 text-ink outline-hidden focus:bg-white/30 focus:shadow-[inset_0_0_0_1px_rgba(196,167,125,0.35)] transition-colors"
          :placeholder="t('note.content_placeholder')"
          @blur="saveAndClose"
          @input="autoResize"
          @keydown.ctrl.enter="onCtrlEnterSave"
      ></textarea>
      <!-- 标签输入：空格/逗号分隔，失焦提交（与待办/常用剪贴板标签交互一致） -->
      <input
          v-model="editTagsText"
          type="text"
          class="mt-1 w-full rounded-lg bg-transparent px-1 py-0.5 text-[11px] text-ink-soft placeholder:text-ink-faint outline-hidden focus:bg-white/30"
          :placeholder="t('note.tags_hint')"
          @blur="commitTags"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
      />
    </div>

    <!-- 标签徽章（只读态）：金色弱化 chips -->
    <div v-if="!editing && tags.length" class="mt-1.5 flex flex-wrap gap-1">
      <span
          v-for="tag in tags"
          :key="tag"
          class="rounded-full bg-gold/15 px-1.5 py-px text-[10px] text-gold"
      >#{{ tag }}</span>
    </div>

    <!-- 底部行：日期 + 提醒 + 字数（左）| 保存快捷键提示（右） -->
    <div class="mt-auto flex items-center justify-between gap-2 pt-2">
      <div class="flex min-w-0 items-center gap-2 text-xs text-ink-faint opacity-0 transition-opacity duration-300 ease-soft group-hover:opacity-100">
        <span class="truncate">{{ formatDateLocalized(parseInt(trash && note.deleted_at ? note.deleted_at : note.updated_at)) }}</span>
        <span v-if="charCount > 0" class="shrink-0 text-[10px]">{{ t('note.chars', { n: charCount }) }}</span>
      </div>
      <div
          v-if="editing && saveShortcut"
          class="pointer-events-none rounded-md bg-white/35 px-2 py-0.5 text-[11px] text-ink-soft backdrop-blur-xs"
      >
        {{ saveShortcut }} {{ t('common.save') }}
      </div>
    </div>
  </div>

  <!-- 拖出钉桌/窗内重排 幽灵卡：跟随光标的迷你便签（Teleport 到 body 避免父级 overflow 裁剪）。
       光标贴近主窗口边缘 → 金色图钉「可钉住」预览；完全出界松手即钉；
       窗内松手 → 快速淡出（ghostFading，卡片已在重排位置合入）；打断 → 飞回原卡片（ghostReturning） -->
  <Teleport to="body">
    <div
        v-if="dragActive && !ghostHidden"
        class="pointer-events-none fixed z-[9999]"
        :class="ghostReturning ? 'opacity-40 transition-all duration-200 ease-out' : ghostFading ? 'scale-105 opacity-0 transition-all duration-150 ease-out' : ''"
        :style="ghostStyle"
    >
      <div
          class="flex items-center gap-1.5 rounded-xl border p-2.5 shadow-float transition-all duration-150"
          :class="dragOutside || dragNearEdge ? 'scale-105 !border-gold ring-2 ring-gold/60' : 'rotate-3 scale-95 opacity-90'"
          :style="noteStyle"
      >
        <svg
            class="h-3.5 w-3.5 shrink-0"
            :class="dragOutside || dragNearEdge ? 'text-gold' : 'text-ink-soft'"
            :fill="dragOutside || dragNearEdge ? 'currentColor' : 'none'"
            stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        ><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
        <span class="min-w-0 truncate text-xs text-ink">{{ ghostLine }}</span>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import UiDropdown from '~/components/ui/UiDropdown.vue';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { resolveNoteColor, adaptNoteColorToScheme, useNoteColors } from '~/composables/useNoteColors';
import { useColorScheme } from '~/composables/useColorScheme';
import { useI18n } from '~/composables/useI18n';
import { ref, watch, nextTick, computed, onBeforeUnmount } from 'vue'
import type { Note } from '~/src/entities';
import { bus } from '~/src/core/events';
import NoteInline from "~/components/note/NoteInline.vue";
import { renderNote, countNoteChars } from '~/src/note/markdown';
import { parseTagsText } from '~/src/todo/tags';
import { useFormatDate } from "~/composables/useFormatDate";
import { shortcuts } from "~/src/commands/shortcuts/InitShortcuts";
import { formatShortcutForDisplay, matchesKeyId } from "~/utils/shortcutFormat";
import { openDesktopPin, followDesktopPin, setDesktopPinFollowing, setDesktopPinFollowState, DESKTOP_PIN_FOLLOW_SIZE } from "~/composables/useDesktopPin";

const { t } = useI18n();
const formatDateLocalized = useFormatDate();

const props = defineProps<{
  note: Note
  selected?: boolean
  editing?: boolean
  highlightString?: string
  highlight?: boolean
  /** 批量多选模式：勾选圆圈替代工具栏，卡片点击即切换选择 */
  batchMode?: boolean
  batchSelected?: boolean
  /** 回收站视图：只读 + 恢复/彻底删除，底部显示删除时间 */
  trash?: boolean
  /** 拖动重排源卡：禁用其 FLIP move 动画（拖动态 scale 与 FLIP inline transform 冲突会缩放跳动；占位卡直接瞬移落位） */
  dragSource?: boolean
}>()

const emit = defineEmits<{
  (e: 'update', id: string, content: string): void
  (e: 'request-delete', event?: MouseEvent): void
  (e: 'color-change', id: string, color: string): void
  (e: 'request-edit'): void
  (e: 'finish-edit'): void
  (e: 'select'): void
  (e: 'toggle-pin', id: string): void
  (e: 'toggle-checklist', id: string, srcIndex: number): void
  (e: 'update-tags', id: string, tags: string[]): void
  (e: 'request-restore', id: string): void
  (e: 'request-purge', id: string): void
  (e: 'pin-desktop', id: string): void
  (e: 'ai-organize', id: string, action: 'summary' | 'extract'): void
  (e: 'toggle-batch-select'): void
  /** 拖动重排（窗内阶段）：光标位置实时上报，父级做 grid 命中检测与让位预览 */
  (e: 'drag-move', payload: { id: string; x: number; y: number }): void
  /** 安全区松手：父级按预览顺序落位（持久化手动排序）；幽灵由本地快速淡出 */
  (e: 'drag-drop', payload: { id: string; x: number; y: number }): void
  /** 拖动被打断（ESC/失焦/系统打断/卸载）：父级还原预览 */
  (e: 'drag-cancel', id: string): void
}>()

const editContent = ref('')
const editTagsText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()

// ===== 轻量渲染（只读态）：renderNote 解析 + 搜索高亮注入；字数随内容实时计算 =====
const rendered = computed(() => renderNote(props.note.content || '', props.highlight && props.highlightString ? props.highlightString : ''))
const charCount = computed(() => countNoteChars(props.note.content || ''))
/** 标签：DB 行已由仓储解析为 string[] */
const tags = computed(() => props.note.tags ?? [])

// 编辑态时让 textarea 高度自适应内容（与展示态文字撑开卡片的效果一致）
const autoResize = () => {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

// 进入编辑态时初始化内容/标签草稿、按内容高度自适应并聚焦光标
watch(() => props.editing, async (editing) => {
  if (editing) {
    editContent.value = props.note.content
    editTagsText.value = (props.note.tags ?? []).join(' ')
    await nextTick()
    autoResize()
    textareaRef.value?.focus()
  }
}, { immediate: true })

/** 标签草稿提交（失焦/回车）：清洗去重后与原值不同才 emit（父级走 updateNote 落库） */
function commitTags() {
  if (!props.editing) return
  const next = parseTagsText(editTagsText.value)
  const prev = props.note.tags ?? []
  if (next.length === prev.length && next.every((tg, i) => tg === prev[i])) return
  emit('update-tags', props.note.id, next)
}

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
    bus.on('save-note', onSaveNote)
  } else {
    bus.off('save-note', onSaveNote)
  }
}, { immediate: true })
onBeforeUnmount(() => {
  bus.off('save-note', onSaveNote)
  if (saveAnimTimer) clearTimeout(saveAnimTimer)
})

// ===== 配色：自定义名称 + 颜色（useNoteColors 统一管理，卡片背景由 hex 动态生成）=====
// colors 供卡片快捷色点渲染；模块级跨窗口同步监听随首次调用挂载（独立窗口提交后重载）
const { colors: noteColors } = useNoteColors()

/** 卡片着色：低透明底 + 同色描边（旧名称存储自动解析为 hex）。
 *  颜色按主题适配：琥珀原色，浅色转为粉彩纸、暗黑转为同相深彩，
 *  透明度随主题由 adaptNoteColorToScheme 一并给出（浅色淡叠/暗黑近实色）。
 *  选中态的边框高亮由模板里的选中类（!border-gold + ring）统一处理，与待办选中样式一致 */
const { resolvedScheme } = useColorScheme()
const noteColorHex = computed(() => resolveNoteColor(props.note.color))
const noteStyle = computed(() => {
  const { bg, border, bgAlpha, borderAlpha } = adaptNoteColorToScheme(noteColorHex.value, resolvedScheme.value)
  return {
    backgroundColor: bg + bgAlpha,
    borderColor: border + borderAlpha,
  }
})

// ===== 配色弹出卡片：无边框透明窗口（无原生窗口栏），锚定点击位置弹出， =====
// 编辑/提交在 app/pages/note-colors.vue 完成，落库后广播事件由 useNoteColors 统一重载
async function openColorManager(e: MouseEvent) {
  // 子窗口打开豁免期：避免创建瞬间抢焦点触发主窗口失焦自动隐藏
  (window as any).__childOpeningUntil = Date.now() + 600;
  const existing = await WebviewWindow.getByLabel('note-colors').catch(() => null);
  if (existing) {
    void existing.show().catch(() => {});
    void existing.setFocus().catch(() => {});
    return;
  }
  // 点击元素矩形必须在同步阶段快照：本函数 async，await 之后按钮随 dropdown 关闭
  // 而卸载（v-if），届时 getBoundingClientRect 全 0，弹窗会错位到主窗口原点。
  // currentTarget 在事件晚到/元素已卸载时为 null → 兜底 target，再失效用点击坐标作锚点
  const el = (e.currentTarget ?? e.target) as HTMLElement | null;
  const rect = el && el.isConnected ? el.getBoundingClientRect() : null;
  // 定位：全程物理像素（创建参数 x/y 存在逻辑/物理歧义，改用 PhysicalPosition 显式定位——
  // 与 bubble 窗口先例同链路）。先隐藏创建，定位完成后再显示，避免闪现在默认位置。
  // 贴点击元素弹出，空间不足时依次翻转到 上 → 左 → 右；弹窗是独立 OS 窗口可超出
  // 主面板边界，空间判定按显示器工作区（而非主窗口视口）计算
  const WIDTH = 320, HEIGHT = 420;
  let px: number | null = null, py: number | null = null;
  try {
    const api = await import('@tauri-apps/api/window');
    const win = api.getCurrentWindow();
    const pos = await win.outerPosition(); // 物理像素
    const scale = await win.scaleFactor();
    const mon = (await api.currentMonitor().catch(() => null)) ?? null;
    const size = await win.outerSize();    // 物理像素（monitor 拿不到时兜底）
    const monX = mon?.position.x ?? pos.x;
    const monY = mon?.position.y ?? pos.y;
    const monW = mon?.size.width ?? size.width;
    const monH = mon?.size.height ?? size.height;
    const POP_W = Math.round(WIDTH * scale), POP_H = Math.round(HEIGHT * scale), GAP = Math.round(8 * scale);
    // 元素矩形（视口逻辑坐标×scale）→ 物理屏幕坐标；rect 不可用时以点击坐标为锚点
    const ax = rect?.left ?? e.clientX;
    const ay = rect?.top ?? e.clientY;
    const aw = rect?.width ?? 0;
    const ah = rect?.height ?? 0;
    const elL = pos.x + Math.round(ax * scale);
    const elT = pos.y + Math.round(ay * scale);
    const elR = pos.x + Math.round((ax + aw) * scale);
    const elB = pos.y + Math.round((ay + ah) * scale);
    const elCX = (elL + elR) / 2;
    const clampX = (x: number) => Math.min(Math.max(x, monX + GAP), monX + monW - POP_W - GAP);
    const clampY = (y: number) => Math.min(Math.max(y, monY + GAP), monY + monH - POP_H - GAP);
    // 下 → 上 → 左 → 右：优先下方居中，该侧放不下才翻转，兜底贴下方并 clamp 进工作区
    if (monY + monH - elB >= POP_H + GAP) {
      px = clampX(elCX - POP_W / 2); py = elB + GAP;
    } else if (elT - monY >= POP_H + GAP) {
      px = clampX(elCX - POP_W / 2); py = elT - GAP - POP_H;
    } else if (elL - monX >= POP_W + GAP) {
      px = elL - GAP - POP_W; py = clampY(elT);
    } else if (monX + monW - elR >= POP_W + GAP) {
      px = elR + GAP; py = clampY(elT);
    } else {
      px = clampX(elCX - POP_W / 2); py = elB + GAP;
    }
  } catch { /* 坐标获取失败保持 null → 系统默认位置显示 */ }
  const win = new WebviewWindow('note-colors', {
    url: '/note-colors',
    width: WIDTH,
    height: HEIGHT,
    minWidth: 288,
    minHeight: 340,
    visible: false,      // 先隐藏创建：PhysicalPosition 定位完成后再显示
    resizable: true,
    decorations: false,  // 无原生窗口栏：页面自绘圆角卡片与拖动把手（同 tooltip/查看器模式）
    transparent: true,   // 透明窗口：卡片自绘圆角，规避 Win11 系统圆角残角
    shadow: false,       // 关 DWM 阴影：无边框窗口阴影黑线难看，层次由卡片阴影承载
    skipTaskbar: true,
    focus: true,         // 需要键盘输入（配色名称编辑）
  });
  win.once('tauri://created', async () => {
    (window as any).__childOpeningUntil = Date.now() + 400;
    try {
      const { PhysicalPosition } = await import('@tauri-apps/api/dpi');
      if (px !== null && py !== null) {
        await win.setPosition(new PhysicalPosition(px, py)).catch(() => {});
      }
      // 任务栏图标双保险：创建参数 skipTaskbar 之外再显式设置一次（Windows 下个别时机不生效）
      await win.setSkipTaskbar(true).catch(() => {});
    } finally {
      void win.show().catch(() => {});
      void win.setFocus().catch(() => {});
    }
  });
}

const saved = ref(false)
let saveAnimTimer: ReturnType<typeof setTimeout> | null = null

const saveAndClose = () => {
  if (editContent.value !== props.note.content) {
    emit('update', props.note.id, editContent.value)
  }
  commitTags()
  // 保存成功动画：金色光晕脉冲后退出编辑态，配合内容淡入上浮
  saved.value = true
  if (saveAnimTimer) clearTimeout(saveAnimTimer)
  saveAnimTimer = setTimeout(() => {
    saved.value = false
    emit('finish-edit')
  }, 420)
}

/** 卸载守卫：编辑态带着未保存改动被销毁（切换标签页等）时自动落库。
 *  组件卸载不会触发 blur（DOM 移除不发 blur 事件），此前仅弹「编辑已丢弃」提示、
 *  内容实际丢失；改为卸载前经 update 事件保存（父组件 updateNote 落库并反馈提示）。
 *  父组件同批卸载时事件处理器仍可执行，异步落库在卸载后继续完成 */
onBeforeUnmount(() => {
  if (props.editing && editContent.value !== props.note.content) {
    emit('update', props.note.id, editContent.value)
  }
})

/** Ctrl+Enter 直接保存（textarea 级兜底）：仅当保存快捷键就是 Ctrl+Enter 时生效；
 *  阻止冒泡避免与快捷键系统 ContextEditCommand 双重触发；若用户自定义成其他键则交还快捷键系统 */
const onCtrlEnterSave = (e: KeyboardEvent) => {
  if (!ctrlEnterIsSaveShortcut.value) return
  e.preventDefault()
  e.stopPropagation()
  saveAndClose()
}

// ===== 拖出钉桌（便签 §11 交互升级）：按住卡片拖出主窗口，松手即钉到桌面。
//  拖起后原卡片半透明缩小、幽灵迷你卡跟随光标；光标贴近窗口边缘进入「可钉住」
//  预览（金色图钉）；完全出界后松手 → emit('pin-desktop')（父级在光标松手点开桌签窗）；
//  窗内松手 → 幽灵飞回。出界判定用 OS 级 cursorPosition 与主窗口 outer 边界比对
//  （60ms 步进），不依赖 webview 窗口外事件；pointer capture 保证出窗后 pointerup 仍可达。
//  6px 移动阈值避免干扰单击选中 / 双击进编辑；拖动结束后的合成 click 抑制选中 =====
const cardEl = ref<HTMLElement | null>(null)
const dragActive = ref(false)
const dragNearEdge = ref(false)
const dragOutside = ref(false)
const ghostReturning = ref(false)
/** 窗内重排落位：幽灵快速淡出（卡片已在目标位置，无需飞回） */
const ghostFading = ref(false)
const ghostX = ref(0)
const ghostY = ref(0)
let dragClickSuppressed = false
let dragWatchTimer: ReturnType<typeof setTimeout> | null = null
let dragMoveHandler: ((ev: PointerEvent) => void) | null = null
let dragUpHandler: (() => void) | null = null
let dragCancelHandler: (() => void) | null = null
let dragOriginRect: DOMRect | null = null
/** 跟随横条松手兜底通道（note-pin-drag-up）的取消监听句柄 */
let dragUpUnlisten: (() => void) | null = null

const DRAG_START_THRESHOLD = 6

/** 幽灵卡文案：首行非空内容截断 */
const ghostLine = computed(() => {
  const line = (props.note.content || '').split('\n').map(l => l.trim()).find(Boolean) || ''
  return line.length > 24 ? `${line.slice(0, 24)}…` : line
})

const ghostStyle = computed(() => {
  const w = Math.min(dragOriginRect?.width ?? 220, 240)
  return {
    left: `${ghostX.value - 18}px`,
    top: `${ghostY.value - 16}px`,
    width: `${w}px`,
  }
})

/** OS 级光标出界监视 + 桌签跟随：主窗口边界拖动期间缓存（窗口不动，豁免自动隐藏），
 *  每帧仅 cursorPosition + setPosition 两次 invoke（33ms ≈ 30fps，丝滑跟随）；
 *  首次出界实体化桌签窗跟随光标（主窗口外 webview 无法渲染，「转移」动画由真实
 *  窗口接管）并通知页面进入跟随态样式；拖动结束自停 */
let followWin: WebviewWindow | null = null
let followFailed = false
let followScale = 1
const ghostHidden = ref(false)

/** 实体化跟随窗（贴边/出界共用）：主窗口 webview 裁剪窗口外区域，幽灵卡无法显示
 *  超出部分——贴边即创建跟随窗（独立窗口不受裁剪），横条跨边界完整可见；跟随窗
 *  置顶覆盖幽灵同位置，幽灵隐藏（双显示无意义） */
async function createFollowWindow(cur: { x: number; y: number }) {
  ;(window as any).__childOpeningUntil = Date.now() + 600
  const { monitorFromPoint } = await import('@tauri-apps/api/window')
  const win = await openDesktopPin(props.note.id, { following: true }).catch(() => null)
  if (!win) {
    followFailed = true // 创建失败：保持幽灵卡原逻辑，松手走父级 pin-desktop 兜底
    return
  }
  followWin = win
  followScale = (await monitorFromPoint(cur.x, cur.y).catch(() => null))?.scaleFactor ?? 1
  setDesktopPinFollowState(props.note.id, true)
  ghostHidden.value = true // 跟随窗置顶覆盖幽灵同位置，双显示无意义
  void win.emit('note-pin-follow', true)
  void followDesktopPin(win, cur, followScale, DESKTOP_PIN_FOLLOW_SIZE)
  // 不主动 show：窗口隐藏创建，页面 ready 广播后由主窗口 show（加载期底色帧不可见）
}

async function startDragWatch() {
  const { cursorPosition } = await import('@tauri-apps/api/window')
  const main = getCurrentWindow()
  const bounds = {
    pos: await main.outerPosition().catch(() => null),
    size: await main.outerSize().catch(() => null),
  }
  let nearSince = 0 // 进入贴边区的时刻：持续 ~130ms 才实体化跟随窗（快速划过不创建）
  const tick = async () => {
    if (!dragActive.value) return
    try {
      const cur = await cursorPosition()
      if (bounds.pos && bounds.size) {
        const outside = cur.x < bounds.pos.x || cur.x >= bounds.pos.x + bounds.size.width
            || cur.y < bounds.pos.y || cur.y >= bounds.pos.y + bounds.size.height
        const near = !outside && (
            cur.x - bounds.pos.x < 28 || bounds.pos.x + bounds.size.width - cur.x < 28
            || cur.y - bounds.pos.y < 28 || bounds.pos.y + bounds.size.height - cur.y < 28)
        dragOutside.value = outside
        dragNearEdge.value = near
        if (near || outside) {
          // 贴边/出界区：桌签横条接管（跨边界完整可见）
          if (followWin) {
            void followDesktopPin(followWin, cur, followScale, DESKTOP_PIN_FOLLOW_SIZE)
          } else if (!followFailed) {
            if (outside) {
              nearSince = 0
              void createFollowWindow(cur)
            } else if (!nearSince) {
              nearSince = Date.now()
            } else if (Date.now() - nearSince > 130) {
              nearSince = 0
              void createFollowWindow(cur)
            }
          }
        } else {
          // 拖回安全区：跟随窗消失，幽灵卡接管（窗内松手即取消）
          nearSince = 0
          if (followWin) {
            setDesktopPinFollowState(props.note.id, null)
            void followWin.close().catch(() => {})
            followWin = null
            ghostHidden.value = false
          }
        }
      }
    } catch { /* 查询失败保持当前状态 */ }
    dragWatchTimer = setTimeout(() => void tick(), 33)
  }
  void tick()
}

function stopDragWatch() {
  if (dragWatchTimer) {
    clearTimeout(dragWatchTimer)
    dragWatchTimer = null
  }
  ;(window as any).__noteDragging = false
}

/** 按住便签期间全局禁选（.note-drag-selecting）：拖动时浏览器默认文本选择会选中卡片文字 */
function endDragSelect() {
  document.body.classList.remove('note-drag-selecting')
}

/** 解除跟随横条松手兜底通道监听（拖动结束统一调用） */
function unlistenDragUp() {
  if (dragUpUnlisten) {
    const un = dragUpUnlisten
    dragUpUnlisten = null
    un()
  }
}

/** 强制取消拖出钉桌（ESC / 主窗口失焦 / 系统打断 / 组件卸载）：销毁跟随窗、
 *  解除全部监听与豁免标记、幽灵飞回——任何打断不留中间态残留 */
function cancelDrag() {
  if (!dragActive.value) return
  endDragSelect()
  unlistenDragUp()
  emit('drag-cancel', props.note.id)
  const follow = followWin
  followWin = null
  if (follow) {
    setDesktopPinFollowState(props.note.id, null)
    void follow.close().catch(() => {})
  }
  if (dragMoveHandler) { window.removeEventListener('pointermove', dragMoveHandler); dragMoveHandler = null }
  if (dragUpHandler) { window.removeEventListener('pointerup', dragUpHandler); dragUpHandler = null }
  if (dragCancelHandler) { window.removeEventListener('pointercancel', dragCancelHandler); dragCancelHandler = null }
  stopDragWatch()
  // 幽灵飞回原卡片（与窗内取消一致）
  ghostHidden.value = false
  ghostReturning.value = true
  if (dragOriginRect) {
    ghostX.value = dragOriginRect.left + dragOriginRect.width / 2
    ghostY.value = dragOriginRect.top + 44
  }
  setTimeout(() => {
    ghostReturning.value = false
    dragActive.value = false
  }, 220)
}

/** 拖动中打断取消：ESC 主动取消；主窗口失焦（Alt-Tab / 其它应用抢焦点）自动取消。
 *  blur 豁免子窗口打开期（跟随窗 show 偶发激活被误判为切走，600ms 内不取消） */
function onDragKeydown(e: KeyboardEvent) {
  if (dragActive.value && e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelDrag()
  }
}
function onDragBlur() {
  if (!dragActive.value) return
  if (Date.now() < ((window as any).__childOpeningUntil ?? 0)) return
  cancelDrag()
}
onMounted(() => {
  window.addEventListener('keydown', onDragKeydown)
  window.addEventListener('blur', onDragBlur)
})

function onCardPointerDown(e: PointerEvent) {
  // 回收站（无钉桌语义）/批量模式（点击即选择）/编辑态不触发拖出
  if (props.trash || props.batchMode || props.editing) return
  if (e.button !== 0) return
  // 工具栏/输入类交互区按下不触发拖出（下拉触发器为 div，靠 data-no-drag 排除）
  if ((e.target as HTMLElement).closest('button, input, textarea, a, select, [data-no-drag]')) return
  const startX = e.clientX
  const startY = e.clientY
  const pointerId = e.pointerId
  let active = false

  // 按住期间全局禁选 + 清掉按下瞬间的选区：拖动时浏览器默认文本选择会把
  // 卡片文字选中（拖出钉桌主诉 bug）；仅按住期间生效，平时仍可正常拖选复制
  document.body.classList.add('note-drag-selecting')
  window.getSelection()?.removeAllRanges()

  const activate = () => {
    active = true
    dragClickSuppressed = true
    dragActive.value = true
    dragOutside.value = false
    dragNearEdge.value = false
    dragOriginRect = cardEl.value?.getBoundingClientRect() ?? null
    ghostX.value = startX
    ghostY.value = startY
    try { cardEl.value?.setPointerCapture(pointerId) } catch { /* 捕获失败仍可窗内拖 */ }
    // 跟随横条上松手的兜底通道：跟随窗 show 抢焦点 → 主窗口 webview 失焦 →
    // 浏览器暂停鼠标事件派发，本窗口收不到 pointerup；光标松手必然落在跟随
    // 横条上，note-pin 页转发 note-pin-drag-up → 此处等效执行 dragUpHandler
    void import('@tauri-apps/api/event').then(({ listen }) => listen<string>('note-pin-drag-up', (e) => {
      if (e.payload === props.note.id && dragActive.value) dragUpHandler?.()
    }).then(un => { dragUpUnlisten = un }).catch(() => {}))
    // 拖动中豁免主窗口失焦自动隐藏（光标出窗必失焦），松手后由 stopDragWatch 解除
    ;(window as any).__noteDragging = true
    startDragWatch()
  }

  dragMoveHandler = (ev: PointerEvent) => {
    if (!active) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_START_THRESHOLD) return
      activate()
      return
    }
    ghostX.value = ev.clientX
    ghostY.value = ev.clientY
    // 窗内重排预览：光标位置实时上报（父级 rAF 节流做 grid 命中检测）
    emit('drag-move', { id: props.note.id, x: ev.clientX, y: ev.clientY })
  }

  dragUpHandler = () => {
    window.removeEventListener('pointermove', dragMoveHandler!)
    window.removeEventListener('pointerup', dragUpHandler!)
    if (dragCancelHandler) window.removeEventListener('pointercancel', dragCancelHandler)
    dragCancelHandler = null
    unlistenDragUp()
    endDragSelect()
    if (!active) return
    // 贴边或出界松手都钉住（贴边金色图钉预览即确认）；安全区松手取消
    const wasPinZone = dragOutside.value || dragNearEdge.value
    // 跟随窗收尾：贴边/出界松手 → 定格显示（父级 pin-desktop 幂等唤起）；
    // 安全区松手 → 销毁跟随窗（取消钉住，幽灵飞回）
    const follow = followWin
    followWin = null
    if (follow) {
      if (wasPinZone) {
        ;(window as any).__childOpeningUntil = Date.now() + 600
        // 登记转正态：若页面 ready 晚于此（快速松手），主窗口 show 时补发退出跟随同步
        setDesktopPinFollowState(props.note.id, false)
        // 定格转正：恢复桌签完整尺寸 + 退出跟随态（页面重播入场动画）。
        // 不在此处 show：未 ready 的窗口提前 show 会闪加载底色帧且又抢主窗口焦点——
        // 统一交由 ready listener show（followStates=false 时附带补发退出跟随同步）
        void setDesktopPinFollowing(follow, false)
        void follow.emit('note-pin-follow', false)
      } else {
        setDesktopPinFollowState(props.note.id, null)
        void follow.close().catch(() => {})
      }
    } else if (wasPinZone) {
      // 无跟随窗（创建失败兜底）：先立子窗口豁免（父级动态导入有间隙）
      ;(window as any).__childOpeningUntil = Date.now() + 600
    }
    stopDragWatch()
    dragMoveHandler = null
    dragUpHandler = null
    if (wasPinZone) {
      // 松手钉桌：金色脉冲反馈 + 复用既有 pin-desktop 链路（桌签已在跟随位置定格）
      dragActive.value = false
      ghostHidden.value = false
      saved.value = true
      if (saveAnimTimer) clearTimeout(saveAnimTimer)
      saveAnimTimer = setTimeout(() => { saved.value = false }, 500)
      emit('pin-desktop', props.note.id)
    } else {
      // 安全区松手：窗内重排落位（父级按预览顺序持久化手动排序；拖动中卡片已通过
      // TransitionGroup 让位到目标位置），幽灵快速淡出即"合入"卡片，无飞回
      emit('drag-drop', { id: props.note.id, x: ghostX.value, y: ghostY.value })
      ghostHidden.value = false
      ghostFading.value = true
      setTimeout(() => {
        ghostFading.value = false
        dragActive.value = false
      }, 140)
    }
  }

  // 系统打断（触摸/笔中断、手势接管等）：整体取消而非按出界松手处理（不误钉）
  dragCancelHandler = () => {
    window.removeEventListener('pointermove', dragMoveHandler!)
    window.removeEventListener('pointerup', dragUpHandler!)
    window.removeEventListener('pointercancel', dragCancelHandler!)
    dragMoveHandler = null
    dragUpHandler = null
    dragCancelHandler = null
    unlistenDragUp()
    endDragSelect()
    cancelDrag()
  }

  window.addEventListener('pointermove', dragMoveHandler)
  window.addEventListener('pointerup', dragUpHandler)
  window.addEventListener('pointercancel', dragCancelHandler)
}

/** 卡片单击：拖动结束的合成 click 不当作选中 */
function onCardClick() {
  if (dragClickSuppressed) {
    dragClickSuppressed = false
    return
  }
  props.batchMode ? emit('toggle-batch-select') : emit('select')
}

onBeforeUnmount(() => {
  // 拖动中组件被卸载（切视图等）：取消整个流程（监听/跟随窗/豁免标记全清）
  unlistenDragUp()
  endDragSelect()
  window.removeEventListener('keydown', onDragKeydown)
  window.removeEventListener('blur', onDragBlur)
  if (dragMoveHandler) window.removeEventListener('pointermove', dragMoveHandler)
  if (dragUpHandler) window.removeEventListener('pointerup', dragUpHandler)
  if (dragCancelHandler) window.removeEventListener('pointercancel', dragCancelHandler)
  dragMoveHandler = null
  dragUpHandler = null
  dragCancelHandler = null
  if (followWin) {
    setDesktopPinFollowState(props.note.id, null)
    void followWin.close().catch(() => {})
    followWin = null
  }
  if (dragActive.value) stopDragWatch()
})
</script>
