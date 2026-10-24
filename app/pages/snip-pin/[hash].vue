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
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useHead } from '#imports'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi'
import { emit } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { resolveImageContent } from '~/src/core/db/imageRef'
import { useTransparentWindow } from '~/composables/useTransparentWindow'
import { isTauri } from '~/utils/env'

useHead({
  style: [{ innerHTML: 'html, body { background: transparent !important; background-image: none !important; }' }],
})

const route = useRoute()
const hash = String(route.params.hash ?? '')

const dataUrl = ref('')
const opacity = ref(1)
const pulse = ref(false)
let unlisteners: Array<() => void> = []

async function closeWindow() {
  await getCurrentWebviewWindow().close().catch(() => {})
}

/** 悬停把手行拖动（与 note-pin 同款 API 直调） */
async function startDrag() {
  await getCurrentWebviewWindow().startDragging().catch(() => {})
}

/** 滚轮缩放：窗口尺寸绕中心缩放（逻辑尺寸 × factor，位置反向平移半个差值） */
async function onWheel(e: WheelEvent) {
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

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') void closeWindow();
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
      <button
          type="button"
          class="flex h-4 w-4 items-center justify-center rounded bg-black/40 text-white/80 hover:bg-black/60"
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
        @dblclick="closeWindow"
        @contextmenu="onContextMenu"
    >
      <img
          v-if="dataUrl"
          :src="dataUrl"
          class="h-full w-full select-none"
          style="object-fit: fill;"
          draggable="false"
          :style="{ opacity }"
          alt=""
      />
    </div>
  </div>
</template>
