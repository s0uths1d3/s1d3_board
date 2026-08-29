<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, emit } from '@tauri-apps/api/event';
import { isTauri } from '~/utils/env';

const imgSrc = ref('');
const scale = ref(1);
const rotation = ref(0);
const offsetX = ref(0);
const offsetY = ref(0);
const loading = ref(true);
const error = ref('');

const canvasRef = ref<HTMLElement | null>(null);

let natW = 0;
let natH = 0;
let unlisten: (() => void) | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

/** 当前可切换的图片列表（base64）及序号 */
const images = ref<string[]>([]);
const currentIndex = ref(0);
/** 本窗口 label（防多查看器事件串扰） */
let myLabel = '';

/* ---------------- 缩放 / 旋转 / 复位 ---------------- */

/** 计算让图片完整显示在窗口内容区内的适配比例（不超过 100%） */
function fitScale(): number {
  const canvas = canvasRef.value;
  if (!canvas || !natW || !natH) return 1;
  const pad = 48;
  const rot90 = rotation.value % 180 !== 0;
  const w = rot90 ? natH : natW;
  const h = rot90 ? natW : natH;
  const cw = Math.max(1, canvas.clientWidth - pad);
  const ch = Math.max(1, canvas.clientHeight - pad);
  return Math.min(1, cw / w, ch / h);
}

function applyFit() {
  scale.value = +fitScale().toFixed(3);
  offsetX.value = 0;
  offsetY.value = 0;
}

function setScale(next: number) {
  scale.value = Math.min(8, Math.max(0.05, +next.toFixed(3)));
}

function zoom(delta: number) {
  setScale(scale.value + delta);
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  setScale(scale.value * factor);
}

function rotate(step: number) {
  rotation.value = (rotation.value + step + 360) % 360;
  // 旋转后若内容超出可视区域，自动适配窗口
  const fit = fitScale();
  if (scale.value > fit) {
    scale.value = +fit.toFixed(3);
    offsetX.value = 0;
    offsetY.value = 0;
  }
}

function resetView() {
  applyFit();
}

function onImageLoad(e: Event) {
  const target = e.target as HTMLImageElement;
  natW = target.naturalWidth;
  natH = target.naturalHeight;
  loading.value = false;
  applyFit();
}

function onImageDblClick() {
  // 双击：若已放大则复位，否则放大一倍
  if (scale.value > fitScale() + 0.01) {
    applyFit();
  } else {
    setScale(scale.value * 2);
  }
}

/* ---------------- 图片切换 ---------------- */

function showImage(newIndex: number) {
  if (!images.value.length) return;
  currentIndex.value = (newIndex + images.value.length) % images.value.length;
  const img = images.value[currentIndex.value];
  if (img) imgSrc.value = img;
  applyFit();
}

function prevImage() {
  showImage(currentIndex.value - 1);
}

function nextImage() {
  showImage(currentIndex.value + 1);
}

/** 统一处理主窗口发来的图片数据（payload / switch 共用） */
function applyPayload(payload: unknown) {
  const p = payload as { label?: string; images?: string[]; index?: number } | string | undefined;
  if (!p) return;
  // 只接收本窗口的数据（多查看器防串扰）
  if (typeof p === 'object' && p.label && p.label !== myLabel) return;

  if (typeof p === 'object' && Array.isArray(p.images)) {
    images.value = p.images;
    currentIndex.value = Math.min(Math.max(0, p.index ?? 0), Math.max(0, images.value.length - 1));
    const img = images.value[currentIndex.value];
    if (img) {
      imgSrc.value = img;
      loading.value = false;
      applyFit();
    }
  } else if (typeof p === 'string') {
    // 兼容旧格式：单张 base64
    images.value = [p];
    currentIndex.value = 0;
    imgSrc.value = p;
    loading.value = false;
  }
}

/* ---------------- 拖拽平移 ---------------- */

const isDragging = ref(false);
let dragStartX = 0;
let dragStartY = 0;
let dragOriginX = 0;
let dragOriginY = 0;

function onPointerDown(e: PointerEvent) {
  isDragging.value = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragOriginX = offsetX.value;
  dragOriginY = offsetY.value;
  canvasRef.value?.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (!isDragging.value) return;
  offsetX.value = dragOriginX + e.clientX - dragStartX;
  offsetY.value = dragOriginY + e.clientY - dragStartY;
}

function onPointerUp(e: PointerEvent) {
  if (!isDragging.value) return;
  isDragging.value = false;
  try {
    canvasRef.value?.releasePointerCapture(e.pointerId);
  } catch { /* 忽略释放失败 */ }
}

/* ---------------- 窗口控制 ---------------- */

function closeViewer() {
  if (!isTauri()) return;
  // 通知主窗口本查看器已关闭，释放单例引用
  emit('image-viewer:closed', myLabel).catch(() => {});
  getCurrentWindow().close();
}

onMounted(async () => {
  if (!isTauri()) {
    error.value = '图片查看器仅可在桌面应用中使用';
    loading.value = false;
    return;
  }

  myLabel = getCurrentWindow().label;

  // ESC 关闭；+/- 缩放；0 复位；R 旋转；←/→ 切换上一张/下一张
  keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeViewer();
    } else if (e.key === '+' || e.key === '=') {
      zoom(0.1);
    } else if (e.key === '-' || e.key === '_') {
      zoom(-0.1);
    } else if (e.key === '0') {
      resetView();
    } else if (e.key.toLowerCase() === 'r') {
      rotate(90);
    } else if (e.key === 'ArrowLeft') {
      prevImage();
    } else if (e.key === 'ArrowRight') {
      nextImage();
    }
  };
  window.addEventListener('keydown', keyHandler);

  // 监听主窗口传来的图片数据（首次 payload + 后续 switch 切换）；挂载完成后回执 ready 让主窗口发送
  const unlistenPayload = await listen('image-viewer:payload', (ev) => applyPayload(ev.payload));
  const unlistenSwitch = await listen('image-viewer:switch', (ev) => applyPayload(ev.payload));
  unlisten = () => {
    unlistenPayload();
    unlistenSwitch();
  };

  await emit('image-viewer:ready', myLabel);
});

onBeforeUnmount(() => {
  if (keyHandler) window.removeEventListener('keydown', keyHandler);
  if (unlisten) unlisten();
  // 兜底：窗口被系统关闭（如 Alt+F4）时也通知主窗口释放单例引用
  if (isTauri()) {
    emit('image-viewer:closed', myLabel).catch(() => {});
  }
});
</script>

<template>
  <div class="viewer-root">
    <!-- 标题栏：与主窗口一致（玻璃米白 + 金色竖条 + 窗口控制） -->
    <div class="drag-region flex h-10 shrink-0 items-center justify-between border-b border-line bg-surface px-3">
      <div class="gold-bar flex items-center gap-2 select-none">
        <h1 class="text-sm font-semibold text-ink">图片查看器</h1>
      </div>
      <div class="no-drag flex items-center gap-2">
        <button
            class="flex h-7 w-7 items-center justify-center rounded-full text-danger transition-all duration-300 ease-soft hover:bg-danger/10 hover:shadow-sm"
            v-tip="'关闭 (Esc)'"
            @click="closeViewer"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="error" class="viewer-hint">{{ error }}</div>

    <div
        v-else
        ref="canvasRef"
        class="viewer-canvas"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dblclick="onImageDblClick"
    >
      <div v-if="loading && !imgSrc" class="viewer-hint">加载中…</div>
      <img
          v-if="imgSrc"
          :src="imgSrc"
          alt="clipboard image"
          class="viewer-img"
          :class="{ 'no-transition': isDragging }"
          :style="{
            transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale}) rotate(${rotation}deg)`,
          }"
          @load="onImageLoad"
      />
    </div>

    <div v-if="imgSrc" class="viewer-toolbar no-drag">
      <button class="viewer-btn" v-tip="'上一张 (←)'" :disabled="images.length <= 1" @click="prevImage">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
      </button>
      <button class="viewer-btn" v-tip="'下一张 (→)'" :disabled="images.length <= 1" @click="nextImage">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </button>
      <span class="viewer-count">{{ currentIndex + 1 }} / {{ images.length }}</span>
      <button class="viewer-btn" v-tip="'缩小 (-)'" @click="zoom(-0.1)">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M5 12h14" />
        </svg>
      </button>
      <span class="viewer-scale">{{ Math.round(scale * 100) }}%</span>
      <button class="viewer-btn" v-tip="'放大 (+)'" @click="zoom(0.1)">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M5 12h14M12 5v14" />
        </svg>
      </button>
      <button class="viewer-btn" v-tip="'向左旋转'" @click="rotate(-90)">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </button>
      <button class="viewer-btn" v-tip="'向右旋转 (R)'" @click="rotate(90)">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>
      <button class="viewer-btn" v-tip="'关闭 (Esc)'" @click="closeViewer">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 与主窗口一致的暖色渐变背景 + 圆角 */
.viewer-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: linear-gradient(135deg, rgb(var(--bg-a)) 0%, rgb(var(--bg-b)) 50%, rgb(var(--bg-c)) 100%);
  overflow: hidden;
  border-radius: 1rem;
}
.viewer-canvas {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 16px;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.viewer-canvas:active {
  cursor: grabbing;
}
.viewer-img {
  transform-origin: center center;
  transition: transform 0.12s ease-out;
  max-width: none;
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
  border-radius: 0.5rem;
  box-shadow: 0 4px 16px rgba(74, 64, 52, 0.14);
}
.viewer-img.no-transition {
  transition: none;
}
.viewer-hint {
  color: rgb(var(--c-ink-soft));
  font-size: 14px;
  opacity: 0.8;
}
/* 浅色工具栏：玻璃卡片风格 */
.viewer-toolbar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 16px;
  background-color: rgba(255, 255, 255, 0.45);
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
  border-top: 1px solid #cbbfa9;
}
.viewer-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 2rem;
  width: 2rem;
  border-radius: 0.75rem;
  color: rgb(var(--c-ink-soft));
  border: 1px solid #d4c9b8;
  background: transparent;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.viewer-btn:hover {
  background: #e8e0d5;
  box-shadow: 0 4px 16px rgba(74, 64, 52, 0.14);
}
.viewer-btn:disabled {
  opacity: 0.4;
  cursor: default;
  box-shadow: none;
}
.viewer-btn:disabled:hover {
  background: transparent;
}
.viewer-scale {
  color: rgb(var(--c-ink-soft));
  font-size: 13px;
  min-width: 48px;
  text-align: center;
}
.viewer-count {
  color: #9a9080;
  font-size: 12px;
  min-width: 44px;
  text-align: center;
  margin-right: 4px;
}
</style>
