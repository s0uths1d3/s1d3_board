<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { getCurrentWindow, currentMonitor, PhysicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { listen, emit } from '@tauri-apps/api/event';
import { isTauri } from '~/src/utils/env';

interface TooltipPayload {
  text: string;
  /** 主窗口计算出的期望锚点（物理像素，相对整个屏幕坐标系） */
  x: number;
  y: number;
}

const visible = ref(false);
const text = ref('');

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
const MAX_HEIGHT = 300;

/**
 * 屏幕边界检测：根据期望锚点计算 tooltip 显示位置，避免超出可视区域。
 * 返回物理像素坐标。
 */
async function clampToScreen(anchorX: number, anchorY: number): Promise<{ x: number; y: number }> {
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

    let x = anchorX;
    let y = anchorY;

    // 水平方向：右侧超出则左移到锚点左侧；仍越界则贴左边界
    if (x + w > right) x = anchorX - w;
    if (x < originX) x = originX;
    // 垂直方向：底部超出则上移到锚点上方；仍越界则贴顶边界
    if (y + h > bottom) y = anchorY - h;
    if (y < originY) y = originY;

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
  try {
    const win = getCurrentWindow();
    const clone = card.cloneNode(true) as HTMLElement;
    clone.style.position = 'fixed';
    clone.style.left = '-99999px';
    clone.style.top = '0';
    clone.style.visibility = 'hidden';
    clone.style.width = 'auto';
    clone.style.maxWidth = 'none';
    document.body.appendChild(clone);
    await nextTick();
    const naturalW = clone.scrollWidth;
    const naturalH = clone.scrollHeight;
    document.body.removeChild(clone);

    const cssW = Math.min(Math.max(naturalW, MIN_WIDTH), MAX_WIDTH);
    const cssH = Math.min(Math.max(naturalH, MIN_HEIGHT), MAX_HEIGHT);
    await win.setSize(new LogicalSize(Math.ceil(cssW), Math.ceil(cssH)));
  } catch { /* 尺寸调整失败不影响显示 */ }
}

async function showTooltip(payload: TooltipPayload) {
  text.value = payload.text ?? '';
  visible.value = true;
  // 通知主窗口：tooltip 已激活（正在显示/使用），失焦自动隐藏逻辑应跳过
  emit('tooltip:active', getCurrentWindow().label).catch(() => {});

  if (!isTauri()) return;

  await fitWindowToContent();

  const { x, y } = await clampToScreen(payload.x, payload.y);
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
      <div class="tooltip-lines">
        <div v-for="(line, i) in lines" :key="i" class="tooltip-line-row">
          <span class="tooltip-line-num">{{ i + 1 }}</span>
          <span class="tooltip-line">{{ line }}</span>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.tooltip-view {
  /* 与主窗口一致的暖色渐变背景，作为窗口底色，避免透明透出下方主窗口的导航/控件 */
  background: linear-gradient(135deg, #faf6f2 0%, #f5ede4 50%, #ebe0d4 100%);
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  /* 注意：此处不能用 border-radius，否则圆角外会透出 Tauri 窗口默认的白色背景（白角） */
}
.tooltip-card {
  /* 卡片填满窗口（width:100%），配合 fitWindowToContent 测得精确窗口宽度后无右侧空白 */
  width: 100%;
  height: 100%;
  min-width: 280px;
  min-height: 48px;
  max-width: 460px;
  box-sizing: border-box;
  /* 左侧行数标签 + 右侧多行文本 横向排列，标签居顶 */
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}
.tooltip-lines {
  /* 多行容器：占满剩余宽度，行数超出窗口高度时出现滚动条 */
  flex: 1;
  min-width: 0;
  max-height: 100%;
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
  /* 单行显示：不换行、保留原始空白（tab/连续空格），过长以省略号截断 */
  flex: 1;
  min-width: 0;
  display: block;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
