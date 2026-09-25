<template>
  <div
      class="sticky-note-card glass-card group relative mb-4 flex min-h-[200px] cursor-pointer break-inside-avoid flex-col rounded-2xl border p-4 shadow-soft transition-all duration-300 ease-soft hover:-translate-y-1 hover:shadow-float"
      :class="[selected ? '!border-gold ring-2 ring-gold/60 shadow-[0_0_22px_-2px_rgba(196,167,125,0.6)]' : '', saved ? 'note-saved' : '']"
      :style="noteStyle"
      @click="$emit('select')"
  >
    <!-- 右上角工具栏：悬浮不占用内容空间；编辑态隐藏，避免遮挡 textarea -->
    <div v-if="!editing" class="absolute right-2 top-1 z-10 flex items-center gap-0.5">
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
          <!-- 选择配色 -->
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

          <!-- 管理配色：独立窗口编辑（app/pages/note-colors.vue），不受主面板尺寸限制；
               提交落库后广播 note-colors:changed，本窗口 useNoteColors 重载全局生效 -->
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
      <span v-else>{{ t('note.dbl_click_edit') }}</span>
    </div>

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
    </div>

    <!-- 底部行：日期（左）+ 保存快捷键提示（右），mt-auto 推到底部，水平两端对齐垂直居中 -->
    <div class="mt-auto flex items-center justify-between gap-2 pt-2">
      <div class="text-xs text-ink-faint opacity-0 transition-opacity duration-300 ease-soft group-hover:opacity-100">
        {{ formatDateLocalized(parseInt(note.updated_at)) }}
      </div>
      <div
          v-if="editing && saveShortcut"
          class="pointer-events-none rounded-md bg-white/35 px-2 py-0.5 text-[11px] text-ink-soft backdrop-blur-xs"
      >
        {{ saveShortcut }} {{ t('common.save') }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import UiDropdown from '~/components/ui/UiDropdown.vue';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { resolveNoteColor, adaptNoteColorToScheme, useNoteColors } from '~/composables/useNoteColors';
import { useColorScheme } from '~/composables/useColorScheme';
import { useI18n } from '~/composables/useI18n';
import { notifyIsland } from '~/composables/useCopyIsland';
import { ref, watch, nextTick, computed, onBeforeUnmount } from 'vue'
import type { Note } from '~/src/entities';
import { bus } from '~/src/core/events';
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
  // 保存成功动画：金色光晕脉冲后退出编辑态，配合内容淡入上浮
  saved.value = true
  if (saveAnimTimer) clearTimeout(saveAnimTimer)
  saveAnimTimer = setTimeout(() => {
    saved.value = false
    emit('finish-edit')
  }, 420)
}

/** 卸载守卫：编辑态带着未保存改动被销毁（切换标签页）时灵动岛提示。
 *  Ctrl+Enter / 失焦 / 快捷键系统三条保存路径都会先落库，走到这里的只有
 *  「改了内容但没经过任何保存路径就被卸载」的情况；无改动卸载不提示 */
onBeforeUnmount(() => {
  if (props.editing && editContent.value !== props.note.content) {
    notifyIsland({ kind: 'info', text: t('note.edit_discarded') })
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
</script>
