import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { isTauri } from '~/utils/env';

/**
 * 图片悬停放大预览：供岛窗口（bubble.vue 胶囊缩略图）与灵动岛历史窗口（island-history.vue
 * 列表缩略图）使用，承载于独立 tooltip 窗口（复用 /tooltip 路由的图片模式）。
 *
 * 必须独立窗口的原因：岛窗口是固定小尺寸 webview，DOM 会被窗口边界裁剪，窗口内浮层无法
 * 越界显示；/tooltip 图片模式已具备所需能力——按原图比例自适应窗口尺寸（img decode 后测量，
 * 上限 460×360）、屏幕边界钳制（优先锚点下方、放不下移上方、极端贴边）、不抢宿主焦点。
 *
 * 与主窗口（index.vue）各自独立管理 tooltip 窗口实例与 hover 生命周期，事件协议共用：
 * tooltip:ready / tooltip:show / tooltip:hide / tooltip:hover-enter / tooltip:hover-leave。
 */

let previewLabel: string | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let hoveringThumb = false; // 鼠标在宿主缩略图上
let hoveringPreview = false; // 鼠标在预览窗口上（tooltip.vue hover-enter/leave 回报）
let latestPayload: { image: string; meta?: string; x: number; y: number; top: number; bottom: number } | null = null;
let readyUnlisten: (() => void) | null = null;
let listenersBound = false;

/** 宿主窗口内 viewport 坐标 → 屏幕物理坐标（tooltip 窗口 setPosition 用物理像素） */
async function toPhysical(x: number, y: number): Promise<{ x: number; y: number }> {
  try {
    const win = getCurrentWindow();
    const pos = await win.outerPosition();
    const scale = await win.scaleFactor();
    return { x: Math.round(pos.x + x * scale), y: Math.round(pos.y + y * scale) };
  } catch {
    return { x: Math.round(x), y: Math.round(y) };
  }
}

/** 补发最新预览内容（复用路径直接发；新建路径由 ready 握手后调用） */
async function emitShow(): Promise<void> {
  if (!latestPayload) return;
  const p = latestPayload;
  const [pt, top, bottom] = await Promise.all([
    toPhysical(p.x, p.y),
    toPhysical(p.x, p.top),
    toPhysical(p.x, p.bottom),
  ]);
  await emit('tooltip:show', { ...p, x: pt.x, y: pt.y, top: top.y, bottom: bottom.y }).catch(() => {});
}

/** 确保 tooltip 窗口存在（单例复用 / 新建 + ready 握手，与主窗口 openTooltipWindow 同套路） */
async function ensurePreviewWindow(): Promise<void> {
  if (previewLabel) {
    const existing = await WebviewWindow.getByLabel(previewLabel).catch(() => null);
    if (existing) return;
    previewLabel = null; // 已销毁，走新建
  }
  const label = `tooltip-${Date.now()}`;
  previewLabel = label;
  // 必须在 new WebviewWindow 之前注册 ready 监听：独立窗口 onMounted 的 emit('tooltip:ready')
  // 可能早于监听注册而丢失，导致首次预览间歇不显示
  readyUnlisten = await listen('tooltip:ready', (ev) => {
    const readyLabel = (ev.payload as string | undefined) ?? '';
    if (readyLabel && readyLabel !== label) return;
    void emitShow();
    if (readyUnlisten) { readyUnlisten(); readyUnlisten = null; }
  });
  // 兜底：5s 内未收到 ready 也释放监听
  setTimeout(() => { if (readyUnlisten) { readyUnlisten(); readyUnlisten = null; } }, 5000);

  const win = new WebviewWindow(label, {
    url: '/tooltip',
    title: 'Image Preview',
    width: 480,
    height: 360,
    resizable: false,
    decorations: false,
    transparent: false, // 与主窗口 tooltip 一致：窗口自带背景
    skipTaskbar: true,
    focus: false, // 不抢焦点：不打断宿主窗口交互
    visible: false, // 尺寸与定位就绪后再 show，避免闪烁/错位
  });
  win.once('tauri://created', () => {
    // 宿主窗口置顶时预览窗口同步置顶，避免被置顶宿主遮挡（后创建者 Z 序更靠前）
    void getCurrentWindow().isAlwaysOnTop()
      .then((onTop) => { if (onTop) void win.setAlwaysOnTop(true); })
      .catch(() => {});
  });
  win.once('tauri://error', () => {
    if (previewLabel === label) previewLabel = null;
  });
}

/** 延迟隐藏：鼠标在缩略图与预览窗口之间移动留 200ms 过渡（与主窗口同策略） */
function scheduleHide(): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (!hoveringThumb && !hoveringPreview) {
      void emit('tooltip:hide').catch(() => {});
    }
  }, 200);
}

/** 一次性绑定预览窗口的 hover 回报监听（tooltip.vue onEnter/onLeave emit） */
function bindPreviewListeners(): void {
  if (listenersBound || !isTauri()) return;
  listenersBound = true;
  void listen('tooltip:hover-enter', () => {
    hoveringPreview = true;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }).catch(() => {});
  void listen('tooltip:hover-leave', () => {
    hoveringPreview = false;
    scheduleHide();
  }).catch(() => {});
}

/**
 * 显示图片放大预览：dataUrl 为完整原图 data URL（缩略图仅是显示形态，预览始终用原图，细节清晰）。
 * el 为缩略图元素，预览窗口锚定其下方（越界时 tooltip 侧自动上翻/贴边）。
 */
export async function showImagePreview(dataUrl: string, el: HTMLElement, meta?: string): Promise<void> {
  if (!isTauri() || !dataUrl.startsWith('data:')) return;
  bindPreviewListeners();
  hoveringThumb = true;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const rect = el.getBoundingClientRect();
  latestPayload = { image: dataUrl, meta, x: rect.left, y: rect.bottom + 4, top: rect.top, bottom: rect.bottom };
  await ensurePreviewWindow();
  await emitShow();
}

/** 离开缩略图：延迟隐藏（若鼠标移入预览窗口则由 hover-enter 保持显示） */
export function hideImagePreview(): void {
  hoveringThumb = false;
  scheduleHide();
}

/** 立即隐藏（宿主窗口隐藏/销毁等场景调用，不走过渡延迟） */
export function dismissImagePreview(): void {
  hoveringThumb = false;
  hoveringPreview = false;
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  void emit('tooltip:hide').catch(() => {});
}
