<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { getCurrentWindow, currentMonitor, PhysicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { listen, emit } from '@tauri-apps/api/event';
import { isTauri } from '~/src/utils/env';

interface TooltipPayload {
  /** 文本模式内容（逐行带行号）；图片模式下为空 */
  text?: string;
  /** 主窗口计算出的期望锚点（物理像素，相对整个屏幕坐标系） */
  x: number;
  y: number;
  /** 触发 clip 项的顶部物理坐标（用于避让，避免 tooltip 遮挡悬停项） */
  top?: number;
  /** 触发 clip 项的底部物理坐标 */
  bottom?: number;
  /** 图片模式：base64 内容（放大预览） */
  image?: string;
  /** 图片模式：元信息说明文本（类型/创建时间/使用次数/最后使用） */
  meta?: string;
}

const visible = ref(false);
const text = ref('');
/** 图片模式：base64 内容；为空表示文本模式 */
const image = ref('');
/** 图片模式：元信息文本；为空表示文本模式 */
const meta = ref('');
/** 是否图片模式（image 有值即图片模式，决定渲染分支与尺寸测量） */
const isImage = computed(() => !!image.value);

let unlistenShow: (() => void) | null = null;
let unlistenHide: (() => void) | null = null;

/** 原始文本的真实行数（以换行符计，空文本为 0） */
const lineCount = computed(() => {
  const t = text.value || '';
  if (!t) return 0;
  return t.replace(/\r\n/g, '\n').split('\n').length;
});

/** 全部真实行：按换行拆分，保留行内原始空白（含 tab 等，不过滤特殊字符） */
const lines = computed(() => {
  // 图片模式不走文本逐行渲染
  const t = text.value || '';
  if (!t) return [' '];
  return t
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.length ? l : ' ');
});

/** 尺寸基准（px）：以美观、紧凑、明显小于主窗口(854x480) 为基础 */
const MIN_WIDTH = 280;
const MIN_HEIGHT = 48;
const MAX_WIDTH = 460;
const MAX_HEIGHT = 800;
/** 图片模式尺寸基准：略高于文本，以容纳放大预览图；最小宽度更小以紧凑包裹小图（减少空白） */
const IMG_MAX_WIDTH = 460;
const IMG_MAX_HEIGHT = 360;
const IMG_MIN_WIDTH = 200;

/**
 * 屏幕边界检测：根据期望锚点计算 tooltip 显示位置，避免超出可视区域。
 * 返回物理像素坐标。
 */
async function clampToScreen(
  anchorX: number,
  anchorY: number,
  anchorTop?: number,
  anchorBottom?: number,
): Promise<{ x: number; y: number }> {
  if (!isTauri()) return { x: anchorX, y: anchorY };
  try {
    const win = getCurrentWindow();
    const size = await win.outerSize();
    const w = size.width;
    const h = size.height;

    const monitor = await currentMonitor();
    const originX = monitor ? monitor.position.x : 0;
    const originY = monitor ? monitor.position.y : 0;
    const screenW = monitor ? monitor.size.width : window.screen.width;
    const screenH = monitor ? monitor.size.height : window.screen.height;

    const right = originX + screenW;
    const bottom = originY + screenH;
    const gap = 4;

    // 水平方向：优先右侧，右侧放不下则移到锚点左侧；仍越界则贴边界
    let x = anchorX;
    if (x + w > right) x = anchorX - w;
    if (x < originX) x = originX;

    // 垂直方向：优先 clip 项下方；下方放不下则放其上方（不遮挡悬停的 clip 项）；极端情况贴边
    const topEdge = anchorTop ?? anchorY;
    const bottomEdge = anchorBottom ?? anchorY;
    let y: number;
    if (bottomEdge + gap + h <= bottom) {
      y = bottomEdge + gap;            // 放在 clip 项下方
    } else if (topEdge - gap - h >= originY) {
      y = topEdge - gap - h;           // 放在 clip 项上方
    } else {
      y = Math.min(anchorY, bottom - h);
      if (y < originY) y = originY;    // 极端：贴边（clip 项几乎占满屏幕时不可避免）
    }

    return { x, y };
  } catch {
    return { x: anchorX, y: anchorY };
  }
}

/** 克隆卡片到屏幕外测量真实内容尺寸（不依赖 rAF/渲染循环，隐藏窗口中亦可靠） */
async function fitWindowToContent() {
  if (!isTauri()) return;
  await nextTick();
  const card = document.querySelector('.tooltip-card') as HTMLElement | null;
  if (!card) return;
  // 图片模式：必须等 <img> 解码完成，否则测得 0 尺寸导致窗口错位
  if (isImage.value) {
    const imgEl = card.querySelector('img');
    if (imgEl && !imgEl.complete) {
      try {
        await imgEl.decode();
      } catch { /* 解码失败（损坏图）时退化为当前尺寸，不影响显示 */ }
    }
  }
  try {
    const win = getCurrentWindow();
    const clone = card.cloneNode(true) as HTMLElement;
    clone.style.position = 'fixed';
    clone.style.left = '-99999px';
    clone.style.top = '0';
    clone.style.visibility = 'hidden';
    clone.style.width = 'auto';
    clone.style.height = 'auto';
    clone.style.maxWidth = 'none';
    // 解除卡片 min-width 约束，使小图能测得真实紧凑宽度（否则被 min-width 撑开产生空白）
    clone.style.minWidth = '0';
    document.body.appendChild(clone);
    await nextTick();
    const naturalW = clone.scrollWidth;
    const naturalH = clone.scrollHeight;
    document.body.removeChild(clone);

    // 图片模式使用独立的尺寸上限（略高以容纳预览图），且最小宽度更小以紧凑包裹小图
    const maxW = isImage.value ? IMG_MAX_WIDTH : MAX_WIDTH;
    const maxH = isImage.value ? IMG_MAX_HEIGHT : MAX_HEIGHT;
    const minW = isImage.value ? IMG_MIN_WIDTH : MIN_WIDTH;
    const cssW = Math.min(Math.max(naturalW, minW), maxW);
    const cssH = Math.min(Math.max(naturalH, MIN_HEIGHT), maxH);
    await win.setSize(new LogicalSize(Math.ceil(cssW), Math.ceil(cssH)));
  } catch { /* 尺寸调整失败不影响显示 */ }
}

async function showTooltip(payload: TooltipPayload) {
  // 按模式重置内容：文本模式用 text，图片模式用 image+meta
  text.value = payload.text ?? '';
  image.value = payload.image ?? '';
  meta.value = payload.meta ?? '';
  visible.value = true;
  // 通知主窗口：tooltip 已激活（正在显示/使用），失焦自动隐藏逻辑应跳过
  emit('tooltip:active', getCurrentWindow().label).catch(() => {});

  if (!isTauri()) return;

  await fitWindowToContent();

  const { x, y } = await clampToScreen(payload.x, payload.y, payload.top, payload.bottom);
  await getCurrentWindow()
    .setPosition(new PhysicalPosition(x, y))
    .catch(() => {});
  await getCurrentWindow().show().catch(() => {});
}

async function hideTooltip() {
  visible.value = false;
  // 真正隐藏整个窗口：否则仅隐藏内容卡片时，.tooltip-view 的渐变背景仍残留为"空白"窗口
  await getCurrentWindow().hide().catch(() => {});
  // 通知主窗口：tooltip 已停用，若主窗口当前失焦则可恢复正常后台隐藏
  emit('tooltip:active', null).catch(() => {});
  emit('tooltip:hidden', getCurrentWindow().label).catch(() => {});
}

/** 鼠标进入 tooltip：通知主窗口保持显示，不要因为主窗口 hover 离开而隐藏 */
function onEnter() {
  // 滚动条拖动期间忽略 enter/leave，避免拖拽时鼠标移出窗口误触发隐藏
  if (draggingScroll.value) return;
  emit('tooltip:hover-enter', getCurrentWindow().label).catch(() => {});
}
/** 鼠标离开 tooltip：通知主窗口恢复延迟隐藏逻辑（由主窗口统一决定是否隐藏窗口） */
function onLeave() {
  // 滚动条拖动期间忽略 enter/leave，避免拖拽时鼠标移出窗口误触发隐藏
  if (draggingScroll.value) return;
  emit('tooltip:hover-leave', getCurrentWindow().label).catch(() => {});
}

/**
 * 内部拖拽标志：在 tooltip 窗口内按下鼠标（含滚动条）时置 true。
 * 拖动滚动条时鼠标会移出 <main> 边界甚至窗口外，触发 mouseleave，
 * 此标志期间屏蔽 onEnter/onLeave 的 hover 隐藏通知，避免拖拽时误发 hover-leave。
 * 拖拽结束（全局 mouseup）才复位。窗口整体的显示/隐藏仍由 tooltip:active 生命周期控制。
 */
const draggingScroll = ref(false);
let docMouseUpHandler: ((_e: MouseEvent) => void) | null = null;
function markInteracting() {
  draggingScroll.value = true;
  if (!docMouseUpHandler) {
    docMouseUpHandler = () => {
      draggingScroll.value = false;
      if (docMouseUpHandler) {
        document.removeEventListener('mouseup', docMouseUpHandler);
        docMouseUpHandler = null;
      }
    };
    document.addEventListener('mouseup', docMouseUpHandler);
  }
}

onMounted(async () => {
  if (!isTauri()) return;
  // 独立窗口无需任务栏/装饰，保持轻量；位置与尺寸由主窗口事件驱动
  // 窗口以 visible:false 创建，收到首个 show 事件后再 show()，避免闪烁/错位
  await getCurrentWindow().setSkipTaskbar(true).catch(() => {});

  unlistenShow = await listen('tooltip:show', (ev) => {
    const p = ev.payload as TooltipPayload;
    showTooltip(p);
  });
  unlistenHide = await listen('tooltip:hide', () => {
    hideTooltip();
  });

  // 通知主窗口：本 tooltip 窗口已就绪（监听已注册），可安全接收 show 事件
  // 解决首次创建时主窗口 emit 早于本窗口监听注册导致的事件丢失
  await emit('tooltip:ready', getCurrentWindow().label).catch(() => {});

  // 在 document 级监听 mousedown（原生滚动条交互也能捕获），标记 tooltip 正在交互，
  // 避免拖动滚动条期间因鼠标移出窗口或 WebView 未获焦导致主窗口误隐藏
  document.addEventListener('mousedown', markInteracting);
});

onBeforeUnmount(() => {
  if (unlistenShow) unlistenShow();
  if (unlistenHide) unlistenHide();
  document.removeEventListener('mousedown', markInteracting);
  if (docMouseUpHandler) {
    document.removeEventListener('mouseup', docMouseUpHandler);
    docMouseUpHandler = null;
  }
});
</script>

<template>
  <main class="tooltip-view" @mouseenter="onEnter" @mouseleave="onLeave">
    <div
        v-if="visible"
        class="glass-card tooltip-card rounded-xl px-3 py-2 text-sm leading-relaxed tabular-nums text-ink shadow-float"
    >
      <!-- 图片模式：放大预览图 + 底部单行元信息 -->
      <div v-if="isImage" class="tooltip-image-wrap">
        <img
            :src="image"
            alt="clipboard image preview"
            class="tooltip-image"
        />
      </div>
      <!-- 文本模式：逐行带行号 -->
      <div v-else class="tooltip-lines">
        <div v-for="(line, i) in lines" :key="i" class="tooltip-line-row">
          <span class="tooltip-line-num">{{ i + 1 }}</span>
          <span class="tooltip-line">{{ line }}</span>
        </div>
      </div>
      <!-- 元信息：单行，固定在 tooltip 底部（图片/文本共用） -->
      <div v-if="meta" class="tooltip-meta">{{ meta }}</div>
    </div>
  </main>
</template>

<style scoped>
.tooltip-view {
  /* 与主窗口一致的暖色渐变背景，作为窗口底色，避免透明透出下方主窗口的导航/控件 */
  background: linear-gradient(135deg, rgb(var(--bg-a)) 0%, rgb(var(--bg-b)) 50%, rgb(var(--bg-c)) 100%);
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  /* 注意：此处不能用 border-radius，否则圆角外会透出 Tauri 窗口默认的白色背景（白角） */
}
.tooltip-card {
  /* 卡片填满窗口（width:100%），配合 fitWindowToContent 测得精确窗口尺寸后无空白 */
  width: 100%;
  height: 100%;
  min-width: 280px;
  min-height: 48px;
  max-width: 460px;
  box-sizing: border-box;
  /* 纵向排列：上方内容（图片预览 / 文本行），底部元信息；高度由内容决定，不撑满以免空白 */
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
}
.tooltip-lines {
  flex: 1;
  min-height: 10.875em;
  /* 最多展示 20 行（每行 1.625em，text-sm+leading-relaxed），超出滚动 */
  max-height: 32.5em;
  min-width: 0;
  overflow-y: auto;
  /* 美观的细滚动条 */
  scrollbar-width: thin;
  scrollbar-color: rgba(150, 120, 90, 0.45) transparent;
}
.tooltip-lines::-webkit-scrollbar {
  width: 6px;
}
.tooltip-lines::-webkit-scrollbar-thumb {
  background: rgba(150, 120, 90, 0.45);
  border-radius: 9999px;
}
.tooltip-lines::-webkit-scrollbar-track {
  background: transparent;
}
.tooltip-line-row {
  /* 每行：左侧行号 + 右侧文本 横向排列 */
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.tooltip-line-num {
  /* 行号：固定宽度、右对齐，从 1 递增到总行数 */
  flex: none;
  width: 1.6em;
  text-align: right;
  font-size: 0.7rem;
  line-height: inherit;
  color: rgba(150, 120, 90, 0.85);
  white-space: nowrap;
}
.tooltip-line {
  /* 完整显示：保留原始空白（tab/连续空格），超长行自动换行展示全部内容（不再省略号截断）；
     文本块整体位于行号右侧，换行行与行号后的文本起点自然对齐 */
  flex: 1;
  min-width: 0;
  display: block;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
/* 图片模式：放大预览图，在主区域水平+垂直居中，元信息钉在窗口底部 */
.tooltip-image-wrap {
  /* flex:1 撑满上方区域（测量时克隆 height:auto 使其高度=图片实际高，故窗口仍紧凑无空白） */
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
}
.tooltip-image {
  /* 圆角、阴影，与图片查看器 .viewer-img 视觉一致 */
  /* 仅限制最大尺寸，浏览器按宽高比自动缩放（不拉伸变形）；小图原样展示、窗口紧凑包裹 */
  max-width: 420px;
  max-height: 320px;
  object-fit: contain;
  border-radius: 0.5rem;
  box-shadow: 0 4px 16px rgba(74, 64, 52, 0.14);
  user-select: none;
  -webkit-user-drag: none;
}
.tooltip-meta {
  /* 元信息：单行、始终钉在窗口底部（flex 列布局下 margin-top:auto 推至底），小字低对比 */
  margin-top: auto;
  padding-top: 0.5rem;
  text-align: center;
  font-size: 0.7rem;
  line-height: 1.4;
  opacity: 0.6;
  color: rgb(var(--c-ink-soft));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
