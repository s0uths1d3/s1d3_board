<script setup lang="ts">
/**
 * 截图贴图窗口页（/snip-pin/{hash}）
 *
 * 由 snipManager「贴图」以无边框透明置顶小窗打开（窗口即图片本身）：管理器按
 * 裁剪图尺寸建窗 → 页面 ready 握手 → emitTo 定向投递 imgfile 引用 → 按需读盘渲染。
 * 交互：顶部悬停把手行拖动/关闭；滚轮缩放（0.25~4×，中心锚点）；Ctrl+滚轮调
 * 不透明度（30~100%）；双击 / Esc 关窗；右键把图片复制到系统剪贴板（边框脉冲反馈）。
 * 会话级语义：不持久化，应用重启后贴图消失（与规格书 P1-T2 一致）。
 */
import { onBeforeUnmount, onMounted, ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useHead } from '#imports'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi'
import { emit } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { writeText } from 'tauri-plugin-clipboard-api'
import { resolveImageContent } from '~/src/core/db/imageRef'
import { useTransparentWindow } from '~/composables/useTransparentWindow'
import { useI18n } from '~/composables/useI18n'
import { isTauri } from '~/utils/env'

useHead({
  style: [{ innerHTML: 'html, body { background: transparent !important; background-image: none !important; }' }],
})

const route = useRoute()
const hash = String(route.params.hash ?? '')
const { t } = useI18n()

const dataUrl = ref('')
const opacity = ref(1)
const pulse = ref(false)
/** 翻转 / 旋转（CSS 变换，不改原图；保存/复制仍输出原始像素） */
const flipX = ref(false)
const flipY = ref(false)
const rotate = ref(0)
/** 锁定：禁止拖动/缩放/双击关闭，防误操作（再次点击解锁） */
const locked = ref(false)
const ocrRunning = ref(false)
/** 原图像素尺寸（OCR 需要全图坐标） */
const naturalW = ref(0)
const naturalH = ref(0)
/** 窗内轻提示（贴图窗无岛链路，操作反馈在这里就地显示） */
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
let unlisteners: Array<() => void> = []

function showToast(text: string): void {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, 1800)
}

const imgStyle = computed(() => ({
  opacity: opacity.value,
  transform: `rotate(${rotate.value}deg) scaleX(${flipX.value ? -1 : 1}) scaleY(${flipY.value ? -1 : 1})`,
}));

async function closeWindow() {
  await getCurrentWebviewWindow().close().catch(() => {})
}

/** 悬停把手行拖动（与 note-pin 同款 API 直调）；锁定时不拖 */
async function startDrag() {
  if (locked.value) return
  await getCurrentWebviewWindow().startDragging().catch(() => {})
}

/** 旋转 90°：图片 CSS 旋转的同时交换窗口宽高（保持显示不裁剪） */
async function rotate90() {
  rotate.value = (rotate.value + 90) % 360
  try {
    const win = getCurrentWebviewWindow();
    const scale = await win.scaleFactor();
    const inner = await win.innerSize();
    const pos = await win.outerPosition();
    const lw = inner.width / scale;
    const lh = inner.height / scale;
    await win.setSize(new LogicalSize(lh, lw));
    await win.setPosition(new PhysicalPosition(
      Math.round(pos.x - ((lh - lw) * scale) / 2),
      Math.round(pos.y - ((lw - lh) * scale) / 2),
    ));
  } catch { /* 尺寸交换失败：仅旋转显示 */ }
}

/** OCR：识别整张贴图文字 → 剪贴板 + 窗内提示（子窗口无岛链路） */
async function runPinOcr(): Promise<void> {
  if (ocrRunning.value) return
  ocrRunning.value = true
  try {
    const res = await invoke<{ text: string; language: string }>('snip_ocr_region', {
      fileRef: `imgfile:${hash}`,
      x: 0, y: 0,
      w: naturalW.value || 1, h: naturalH.value || 1,
      lang: null,
    })
    const text = (res?.text ?? '').trim()
    if (!text) {
      showToast(t('snip.ocr_empty'))
      return
    }
    await writeText(text)
    showToast(t('snip.ocr_copied', { n: text.length }))
    pulse.value = true
    setTimeout(() => { pulse.value = false; }, 450)
  } catch (e) {
    showToast(`${t('snip.ocr_failed')}：${String(e)}`)
  } finally {
    ocrRunning.value = false
  }
}

/** 滚轮缩放：窗口尺寸绕中心缩放（逻辑尺寸 × factor，位置反向平移半个差值） */
async function onWheel(e: WheelEvent) {
  if (locked.value) return
  const win = getCurrentWebviewWindow()
  if (e.ctrlKey) {
    // Ctrl+滚轮：不透明度 30%~100%
    opacity.value = Math.min(1, Math.max(0.3, opacity.value + (e.deltaY < 0 ? 0.05 : -0.05)));
    e.preventDefault();
    return;
  }
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  e.preventDefault();
  try {
    const scale = await win.scaleFactor();
    const inner = await win.innerSize();
    const pos = await win.outerPosition();
    const lw = inner.width / scale;
    const lh = inner.height / scale;
    const nw = Math.min(Math.max(lw * factor, 48), 8000);
    const nh = lh * (nw / lw);
    await win.setSize(new LogicalSize(nw, nh));
    // 中心锚点：物理坐标回移半个尺寸差
    await win.setPosition(new PhysicalPosition(
      Math.round(pos.x - ((nw - lw) * scale) / 2),
      Math.round(pos.y - ((nh - lh) * scale) / 2),
    ));
  } catch { /* 缩放失败保留当前尺寸 */ }
}

/** 右键：把贴图复制到系统剪贴板（CF_DIB；边框金色脉冲反馈，无岛——子窗口无岛链路） */
async function onContextMenu(e: MouseEvent): Promise<void> {
  e.preventDefault();
  const ok = await invoke('snip_write_clipboard_dib', { fileRef: `imgfile:${hash}` }).then(() => true, () => false);
  if (ok) {
    pulse.value = true;
    setTimeout(() => { pulse.value = false; }, 450);
  }
}

/** 图片加载完成：记录原图像素尺寸（OCR 全图坐标；旋转/翻转不改变原图） */
function onImgLoad(e: Event): void {
  const el = e.target as HTMLImageElement;
  naturalW.value = el.naturalWidth;
  naturalH.value = el.naturalHeight;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { void closeWindow(); return; }
  const k = e.key.toLowerCase();
  if (k === 'x') { flipX.value = !flipX.value; return; }
  if (k === 'y') { flipY.value = !flipY.value; return; }
  if (k === 'r') { void rotate90(); return; }
  if (k === 'l') { locked.value = !locked.value; return; }
  if (k === 'o') { void runPinOcr(); }
}

onMounted(() => {
  useTransparentWindow();
  window.addEventListener('keydown', onKeydown);
  if (!isTauri()) return;
  const win = getCurrentWebviewWindow();
  // 窗口级监听（禁止全局 listen：多贴图窗并存互相覆盖，照 note-pin-follow 模式）。
  // dataUrl 优先（随事件直达），缺失回退按引用读盘
  win.listen<{ fileRef: string; dataUrl?: string }>('snip-pin:data', (ev) => {
    const p = ev.payload;
    const load = p.dataUrl && p.dataUrl.startsWith('data:')
      ? Promise.resolve(p.dataUrl)
      : resolveImageContent(p.fileRef);
    void load.then((url) => { dataUrl.value = url; });
  }).then((un) => unlisteners.push(un)).catch(() => {});
  void getCurrentWindow().onFocusChanged(() => { /* 贴图失焦不关窗（常驻语义） */ });
  // ready 握手：管理器收到才 emitTo 数据并 show（隐藏创建不闪白）
  void emit('snip-pin:ready', getCurrentWindow().label).catch(() => {});
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  for (const u of unlisteners) u();
  unlisteners = [];
});
</script>

<template>
  <!-- 窗口即图片：外层留 1px 余量给把手行；把手行常显但弱化（hover 增强） -->
  <div class="flex h-screen flex-col overflow-hidden">
    <div
        class="relative flex h-5 shrink-0 cursor-grab select-none items-center justify-end pr-0.5 opacity-0 transition-opacity duration-150 hover:opacity-100"
        @mousedown.left.prevent="startDrag"
        @dblclick.stop
    >
      <div class="pointer-events-none absolute left-1/2 flex -translate-x-1/2 text-white/70" aria-hidden="true">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="5" r="1.8" /><circle cx="15" cy="5" r="1.8" />
          <circle cx="9" cy="12" r="1.8" /><circle cx="15" cy="12" r="1.8" />
          <circle cx="9" cy="19" r="1.8" /><circle cx="15" cy="19" r="1.8" />
        </svg>
      </div>
      <!-- 功能按钮：OCR / 水平翻转 / 垂直翻转 / 旋转 / 锁定 / 关闭（悬停显示） -->
      <button
          type="button"
          class="flex h-4 w-4 items-center justify-center rounded bg-black/40 text-white/80 hover:bg-black/60 disabled:opacity-40"
          v-tip="t('snip.pin_ocr')"
          :disabled="ocrRunning"
          @mousedown.stop
          @click="runPinOcr"
      >
        <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M8 12h8" />
        </svg>
      </button>
      <button
          type="button"
          class="ml-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/40 text-white/80 hover:bg-black/60"
          v-tip="t('snip.pin_flip_x')"
          @mousedown.stop
          @click="flipX = !flipX"
      >
        <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v18M8 7 4 12l4 5M16 7l4 5-4 5" />
        </svg>
      </button>
      <button
          type="button"
          class="ml-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/40 text-white/80 hover:bg-black/60"
          v-tip="t('snip.pin_flip_y')"
          @mousedown.stop
          @click="flipY = !flipY"
      >
        <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12h18M7 8l5-4 5 4M7 16l5 4 5-4" />
        </svg>
      </button>
      <button
          type="button"
          class="ml-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/40 text-white/80 hover:bg-black/60"
          v-tip="t('snip.pin_rotate')"
          @mousedown.stop
          @click="rotate90"
      >
        <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" />
        </svg>
      </button>
      <button
          type="button"
          class="ml-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/40 text-white/80 hover:bg-black/60"
          :class="locked ? 'text-gold' : ''"
          v-tip="locked ? t('snip.pin_unlock') : t('snip.pin_lock')"
          @mousedown.stop
          @click="locked = !locked"
      >
        <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path :d="locked ? 'M8 11V7a4 4 0 0 1 8 0v4' : 'M8 11V7a4 4 0 0 1 7.5-2'" />
        </svg>
      </button>
      <button
          type="button"
          class="ml-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/40 text-white/80 hover:bg-black/60"
          v-tip="t('snip.pin_close_hint')"
          @mousedown.stop
          @click="closeWindow"
      >
        <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
    <!-- 图片主体：随窗口拉伸（与 Snipaste 一致）；双击关窗；右键复制；Ctrl+滚轮透明度 -->
    <div
        class="relative min-h-0 min-w-0 flex-1"
        :class="pulse ? 'ring-2 ring-gold' : ''"
        @wheel.prevent="onWheel"
        @dblclick="locked ? null : closeWindow()"
        @contextmenu="onContextMenu"
    >
      <img
          v-if="dataUrl"
          :src="dataUrl"
          class="h-full w-full select-none transition-transform duration-150"
          style="object-fit: fill;"
          draggable="false"
          :style="imgStyle"
          alt=""
          @load="onImgLoad"
      />
      <!-- 锁定徽标：贴在左下角，提示当前不可拖动/缩放/双击关闭 -->
      <div
          v-if="locked"
          class="pointer-events-none absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-gold"
      >
        <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      </div>
      <!-- 窗内轻提示：贴图窗是子窗口，无岛链路，操作反馈就地显示 -->
      <div
          v-if="toast"
          class="pointer-events-none absolute bottom-2 left-1/2 max-w-[90%] -translate-x-1/2 truncate rounded bg-black/70 px-2 py-1 text-[11px] text-white shadow"
      >
        {{ toast }}
      </div>
    </div>
  </div>
</template>
