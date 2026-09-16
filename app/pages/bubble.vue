<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useRoute } from 'vue-router';
import { listen, emit, emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow, cursorPosition, LogicalSize } from '@tauri-apps/api/window';
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from '~/utils/env';
import { useI18n } from '~/composables/useI18n';
import { showImagePreview, hideImagePreview, dismissImagePreview } from '~/composables/useImagePreview';
import type { IslandKind } from '~/composables/useCopyIsland';

/**
 * 智能剪贴板气泡窗口：四种模式（route.query.mode 区分）。
 *
 * - pin（?mode=pin）：单片段常驻钉住卡片，点击复制，不模拟粘贴、不自我隐藏。
 * - island（?mode=island）：灵动岛提示胶囊（复制/粘贴反馈）。创建与定位由
 *   useCopyIsland 管理；窗口显隐、进出场动画与超时自动隐藏由本页控制，
 *   事件流：island:ready 握手 → island:show 推送 → 显示动画 → SHOW_MS 后收起并隐藏窗口。
 * - ring（?mode=ring&index=N）：环形布局中的一只独立气泡窗口。文本由管理器
 *   ready 握手后 emitTo('bubble:ring:data') 投递（窗口级 listen 定向接收，防串台）；
 *   选中高亮来自 ring:state 广播；Ctrl+悬停 / 左键点击 → ring:select-req；
 *   双击 → ring:paste-req（由管理器统一隐藏全部环形窗口并模拟粘贴）。
 * - ring-hub（?mode=ring-hub）：环心控制盘，**持有系统焦点的唯一键盘入口**：
 *   ←↑/→↓ 切换选中（ring:nav）、PgUp/PgDn 翻页（ring:page-nav）、Enter 粘贴选中项
 *   （ring:paste-req）、Esc 整体关闭（ring:close），状态由 ring:state 广播回显。
 *
 * 窗口的创建/定位/分页显隐/层级（选中置顶）全部由 BubbleToggleCommand 管理。
 */

const route = useRoute();
const { t } = useI18n();
const mode = String(route.query.mode ?? 'list');
const isPinMode = mode === 'pin';
const isIsland = mode === 'island';
const isRingBubble = mode === 'ring';
const isRingHub = mode === 'ring-hub';
const ringIndex = Number(route.query.index ?? -1);

// ===== 钉住模式 =====
const pinnedText = ref('');
const pinCopied = ref(false);
let pinCopiedTimer: ReturnType<typeof setTimeout> | null = null;

// ===== 环形气泡 =====
const ringText = ref('');
const ringSelected = ref(false);

// ===== 环心控制盘 =====
const hubSelected = ref(0);
const hubPage = ref(0);
const hubTotal = ref(0);

// ===== 灵动岛提示胶囊（island 模式）=====
// 停留时长由 useCopyIsland 按设置随 island:show 下发（durationMs），此处仅作兜底默认值
const ISLAND_SHOW_MS = 1800;
const ISLAND_OUT_MS = 240;
const ISLAND_W = 360;
const ISLAND_H = 56;
const ISLAND_TOP_OFFSET = 8;       // 窗口顶部留白（与 .island-wrap padding-top 一致）
const ISLAND_PILL_H = 40;          // 胶囊高度（与 .island-pill CSS 一致）
const ISLAND_PANEL_GAP = 8;        // 胶囊与下拉面板间距
const ISLAND_PANEL_PAD_BOTTOM = 12; // 面板底部留白（窗口扩高余量）
const ISLAND_PANEL_MAX_H = 280;    // 下拉面板最大高度：防止占满整屏
const ISLAND_PROXIMITY_PX = 32;    // 鼠标邻近检测阈值（逻辑像素）：进入即暂停自动隐藏
const ISLAND_HOVER_INTENT_MS = 150; // 悬停意图：光标停留在岛区域持续此时长才展开下拉
const islandVisible = ref(false);
const islandKind = ref<IslandKind>('copy');
const islandText = ref('');
const islandTitle = ref('');             // 自定义标签（灵动岛 API 调用可指定；空则用 kind 默认标签）

// 岛窗口隐藏/收起时同步关掉图片放大预览（预览是独立窗口，不随岛 DOM 隐藏）
watch(islandVisible, (v) => { if (!v) dismissImagePreview(); });

/** 岛内缩略图悬停：独立 tooltip 窗口放大预览原图（islandText 即完整 data URL） */
function onIslandImageEnter(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement | null;
  if (el && islandKind.value === 'copy-image' && islandText.value) {
    void showImagePreview(islandText.value, el);
  }
}
const islandPillEl = ref<HTMLElement | null>(null);
const islandTextEl = ref<HTMLElement | null>(null);
const islandPanelInnerEl = ref<HTMLElement | null>(null);
const islandDuration = ref(ISLAND_SHOW_MS);
const islandOverflow = ref(false);        // 内容超出胶囊单行（下拉展开的必要条件）
const islandExpanded = ref(false);        // 下拉面板展开中
const islandPanelMaxH = ref(ISLAND_PANEL_MAX_H);
/** kind → 默认标签 i18n 键（copy-image 与 copy 同标签；title 自定义标签优先） */
const ISLAND_LABEL_KEYS: Record<IslandKind, string> = {
  copy: 'copied', 'copy-image': 'copied', paste: 'pasted', info: 'info', success: 'success', error: 'error',
};
const islandLabel = computed(() => islandTitle.value || t(`island.${ISLAND_LABEL_KEYS[islandKind.value]}`));

// ===== 下拉面板逐行渲染（与 tooltip 窗口一致：行号 + 完整内容 + 行数统计） =====
/** 万行级内容全量渲染会创建海量 DOM 节点（面板可滚动但 DOM 不裁剪），与 tooltip 同一上限 */
const ISLAND_MAX_RENDER_LINES = 400;
const islandLines = computed<string[]>(() => {
  const txt = islandText.value || '';
  if (!txt) return [' '];
  return txt.replace(/\r\n/g, '\n').split('\n').map((l) => (l.length ? l : ' ')); // 空行占位保持行号对齐
});
const islandLineCount = computed(() => (islandText.value ? islandLines.value.length : 0));
const islandHiddenLines = computed(() => Math.max(0, islandLines.value.length - ISLAND_MAX_RENDER_LINES));
const islandRenderedLines = computed(() =>
  islandHiddenLines.value > 0 ? islandLines.value.slice(0, ISLAND_MAX_RENDER_LINES) : islandLines.value);
let islandDomHover = false;   // 光标在岛窗口 DOM 上（mouseenter/leave 精确判定）
let islandProxHover = false;  // 光标在邻近阈值内（窗口外轮询判定）
let islandOutTimer: ReturnType<typeof setTimeout> | null = null;
let islandHideTimer: ReturnType<typeof setTimeout> | null = null;
let islandExpandTimer: ReturnType<typeof setTimeout> | null = null;
let islandCollapseTimer: ReturnType<typeof setTimeout> | null = null;
let islandProxTimer: ReturnType<typeof setInterval> | null = null;
/** 岛窗口矩形缓存（逻辑像素，show/展开/收起时刷新；邻近检测每 tick 只查一次光标 IPC） */
let islandScale = 1;
let islandRect = { x: 0, y: 0, w: ISLAND_W, h: ISLAND_H };

/** 展示灵动岛：窗口 show 后强制回流再切动画类，保证进出场动画可见且首帧即动（隐藏窗口里 transition 会瞬间跑完） */
async function applyIsland(payload: { kind: IslandKind; text?: string; title?: string; durationMs?: number }): Promise<void> {
  islandKind.value = payload.kind;
  islandText.value = payload.text ?? '';
  islandTitle.value = payload.title ?? '';
  islandDuration.value = payload.durationMs ?? ISLAND_SHOW_MS;
  // 复位动画起点与展开态：连续事件到来时从收起态重新展开
  cancelIslandExpand();
  islandExpanded.value = false;
  islandVisible.value = false;
  const win = getCurrentWindow();
  // 复位窗口为收起尺寸（上次展开后可能残留大窗口），再显示
  await win.setSize(new LogicalSize(ISLAND_W, ISLAND_H)).catch(() => {});
  await win.show().catch(() => {});
  await nextTick();
  // 强制回流让浏览器记录收起态（替代双 rAF，节省约 2 帧延迟）
  void islandPillEl.value?.offsetHeight;
  islandVisible.value = true;
  // 溢出检测：胶囊单行截断放不下才允许下拉展开（图片/空内容不展开）
  const el = islandTextEl.value;
  islandOverflow.value = !!el && el.scrollWidth > el.clientWidth + 1; // 1px 容差：略微溢出也可展开
  void refreshIslandRect();
  // 悬停/邻近暂停态保持驻留（清掉上一轮倒计时）；否则按设置的时长启动自动隐藏
  if (islandDomHover) {
    clearIslandTimers();
    scheduleIslandExpand(); // 新内容落下时正悬停：重新走悬停意图展开
  } else if (islandProxHover) {
    clearIslandTimers();
  } else {
    scheduleIslandHide();
  }
  startIslandProximity();
}

/** 启动/重启自动隐藏倒计时（悬停暂停、离开恢复时复用） */
function scheduleIslandHide(): void {
  if (islandOutTimer) clearTimeout(islandOutTimer);
  if (islandHideTimer) clearTimeout(islandHideTimer);
  islandOutTimer = setTimeout(() => { islandVisible.value = false; }, Math.max(0, islandDuration.value - ISLAND_OUT_MS));
  islandHideTimer = setTimeout(() => {
    // 必须隐藏整个窗口：透明区域在 Windows 上仍捕获点击（见项目约定），残留窗口会挡住顶部点击
    stopIslandProximity();
    islandDomHover = false;
    islandProxHover = false;
    void getCurrentWindow().hide().catch(() => {});
  }, islandDuration.value);
}

/** 离开岛区域后恢复隐藏倒计时（岛可见则整段重新计时，已收起则按剩余时长直接隐藏窗口） */
function resumeIslandHide(): void {
  if (islandVisible.value) {
    scheduleIslandHide();
  } else {
    islandHideTimer = setTimeout(() => {
      void getCurrentWindow().hide().catch(() => {});
    }, Math.max(0, islandDuration.value - ISLAND_OUT_MS));
  }
}

// ===== 鼠标邻近检测（窗口外）：轮询全局光标位置，接近岛区域即暂停自动隐藏 =====
function startIslandProximity(): void {
  if (islandProxTimer) { clearInterval(islandProxTimer); islandProxTimer = null; } // 重启轮询但保留悬停状态
  if (!isTauri()) return;
  islandProxTimer = setInterval(() => { void islandProximityTick(); }, 100);
}

function stopIslandProximity(): void {
  if (islandProxTimer) { clearInterval(islandProxTimer); islandProxTimer = null; }
  islandProxHover = false;
}

/** 缓存岛窗口矩形（逻辑像素）：定位由管理器在 show 前完成，此后每 tick 仅一次光标 IPC */
async function refreshIslandRect(): Promise<void> {
  const win = getCurrentWindow();
  const [pos, size, scale] = await Promise.all([
    win.outerPosition().catch(() => null),
    win.outerSize().catch(() => null),
    win.scaleFactor().catch(() => 1),
  ]);
  if (!pos || !scale) return;
  islandScale = scale;
  islandRect = {
    x: pos.x / scale,
    y: pos.y / scale,
    w: (size?.width ?? ISLAND_W * scale) / scale,
    h: (size?.height ?? ISLAND_H * scale) / scale,
  };
}

async function islandProximityTick(): Promise<void> {
  if (!islandVisible.value) return;
  const c = await cursorPosition().catch(() => null);
  if (!c) return;
  // 物理像素 → 逻辑像素：阈值按逻辑像素定义，多屏混用 DPI 时行为一致
  const x = c.x / islandScale;
  const y = c.y / islandScale;
  const dx = Math.max(islandRect.x - x, 0, x - (islandRect.x + islandRect.w));
  const dy = Math.max(islandRect.y - y, 0, y - (islandRect.y + islandRect.h));
  const dist = Math.hypot(dx, dy);
  if (dist <= ISLAND_PROXIMITY_PX) {
    if (!islandProxHover && !islandDomHover) {
      islandProxHover = true; // 邻近视同悬停：暂停自动隐藏，等用户靠近
      clearIslandTimers();
    }
  } else if (islandProxHover && !islandDomHover) {
    islandProxHover = false; // 彻底离开邻近区：收起下拉并恢复倒计时
    if (islandExpanded.value) collapseIsland();
    resumeIslandHide();
  }
}

// ===== 下拉面板展开/收起（窗口随之扩高/收回） =====
/** 悬停意图：进入岛区域持续 ISLAND_HOVER_INTENT_MS 且内容溢出才展开，扫过不误触 */
function scheduleIslandExpand(): void {
  if (islandExpandTimer) clearTimeout(islandExpandTimer);
  islandExpandTimer = setTimeout(() => {
    islandExpandTimer = null;
    void expandIsland();
  }, ISLAND_HOVER_INTENT_MS);
}

function cancelIslandExpand(): void {
  if (islandExpandTimer) { clearTimeout(islandExpandTimer); islandExpandTimer = null; }
}

async function expandIsland(): Promise<void> {
  if (!islandOverflow.value || islandExpanded.value || !islandVisible.value) return;
  if (islandCollapseTimer) { clearTimeout(islandCollapseTimer); islandCollapseTimer = null; } // 收起中途可反转
  const win = getCurrentWindow();
  // 视口边缘：面板高度上限 = 显示器底部 - 岛窗口顶 - 胶囊/间距/留白，且不超过全局上限
  let maxPanel = ISLAND_PANEL_MAX_H;
  try {
    const [mon, pos, scale] = await Promise.all([
      win.currentMonitor().catch(() => null),
      win.outerPosition().catch(() => null),
      win.scaleFactor().catch(() => 1),
    ]);
    if (mon && pos && scale) {
      const avail = (mon.position.y + mon.size.height - pos.y) / scale
        - ISLAND_TOP_OFFSET - ISLAND_PILL_H - ISLAND_PANEL_GAP - ISLAND_PANEL_PAD_BOTTOM - 8;
      maxPanel = Math.max(96, Math.min(ISLAND_PANEL_MAX_H, Math.floor(avail)));
    }
  } catch { /* 取不到显示器信息则用全局上限 */ }
  islandPanelMaxH.value = maxPanel;
  await nextTick();
  const inner = islandPanelInnerEl.value;
  if (!inner) return;
  const panelH = Math.min(inner.offsetHeight, maxPanel); // 内容自适应：仅略微溢出也只轻微扩高
  if (panelH <= 0) return;
  // 先扩窗再展面板：窗口裁剪 DOM，反序会让内容闪现截断（高度 = 顶留白 + 胶囊 + 间距 + 面板 + 底留白）
  const winH = ISLAND_TOP_OFFSET + ISLAND_PILL_H + ISLAND_PANEL_GAP + panelH + ISLAND_PANEL_PAD_BOTTOM;
  await win.setSize(new LogicalSize(ISLAND_W, winH)).catch(() => {});
  void refreshIslandRect();
  islandExpanded.value = true;
}

function collapseIsland(): void {
  if (!islandExpanded.value) return;
  islandExpanded.value = false;
  if (islandCollapseTimer) clearTimeout(islandCollapseTimer);
  // 等面板退场动画播完再收回窗口，避免内容瞬间被窗口裁剪
  islandCollapseTimer = setTimeout(() => {
    islandCollapseTimer = null;
    if (islandExpanded.value) return;
    void getCurrentWindow().setSize(new LogicalSize(ISLAND_W, ISLAND_H)).catch(() => {});
    void refreshIslandRect();
  }, ISLAND_OUT_MS);
}

// ===== 悬停交互（绑定在胶囊+面板的公共容器上，跨间隙移动不丢悬停） =====
function onIslandEnter(): void {
  islandDomHover = true;
  clearIslandTimers();
  scheduleIslandExpand();
}

function onIslandLeave(): void {
  islandDomHover = false;
  cancelIslandExpand();
  if (islandExpanded.value) collapseIsland();
  if (islandProxHover) return; // 仍在邻近阈值内：保持暂停，由 proximity tick 收尾
  resumeIslandHide();
}

function clearIslandTimers(): void {
  if (islandOutTimer) { clearTimeout(islandOutTimer); islandOutTimer = null; }
  if (islandHideTimer) { clearTimeout(islandHideTimer); islandHideTimer = null; }
}

let unlisteners: (() => void)[] = [];

/** 钉住：把当前片段复制为独立常驻小气泡窗（ring 模式与 pin 模式均可触发） */
async function pinCurrent(): Promise<void> {
  const text = isRingBubble ? ringText.value : pinnedText.value;
  if (!isTauri() || !text) return;
  // 习惯记录：钉住也是一次强偏好信号（ring 模式下上报给管理器落库）
  if (isRingBubble) void emit('ring:habit', { index: ringIndex, action: 'pin' });
  const label = `clipboard-bubble-pin-${Date.now()}`;
  (window as any).__childOpeningUntil = Date.now() + 600;
  const unReady = await listen('bubble:pin:ready', (ev) => {
    if ((ev.payload as string | undefined) !== label) return;
    void emitTo(label, 'bubble:pin:data', { text });
    unReady();
  });
  setTimeout(() => unReady(), 5000);
  const win = new WebviewWindow(label, {
    url: '/bubble?mode=pin',
    title: 'Pinned',
    width: 300,
    height: 96,
    resizable: false,
    decorations: false,
    transparent: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focus: false,        // 钉住卡片不抢目标应用焦点
    visible: false,
  });
  win.once('tauri://created', () => {
    (window as any).__childOpeningUntil = Date.now() + 300;
  });
  win.once('tauri://error', () => {
    unReady();
  });
}

/** 钉住卡片：点击 = 复制到剪贴板（带已复制反馈，不模拟粘贴、不自我隐藏） */
async function copyPinned(): Promise<void> {
  if (!pinnedText.value) return;
  try {
    if (isTauri()) await writeTextSafe(pinnedText.value);
    else await navigator.clipboard.writeText(pinnedText.value);
  } catch { /* 忽略写失败 */ }
  pinCopied.value = true;
  if (pinCopiedTimer) clearTimeout(pinCopiedTimer);
  pinCopiedTimer = setTimeout(() => { pinCopied.value = false; }, 1500);
}

async function writeTextSafe(text: string): Promise<void> {
  const mod = await import('tauri-plugin-clipboard-api');
  await mod.writeText(text);
}

function closePin(): void {
  void getCurrentWindow().close();
}

// ===== 环形气泡交互 =====
/** Ctrl+悬停 / 左键点击：请求选中（已选中则不重复发） */
function ringSelect(): void {
  if (!ringSelected.value) void emit('ring:select-req', { index: ringIndex });
}
function ringPointerMove(e: PointerEvent): void {
  if (e.ctrlKey) ringSelect();
}
/** 双击：请求粘贴（管理器统一隐藏全部窗口并模拟粘贴） */
function ringPaste(): void {
  void emit('ring:paste-req', { index: ringIndex });
}
function ringClose(): void {
  void emit('ring:close');
}

// ===== 控制盘指令 =====
function hubNav(delta: number): void {
  void emit('ring:nav', { delta });
}
function hubPageNav(delta: number): void {
  void emit('ring:page-nav', { delta });
}
function hubClose(): void {
  void emit('ring:close');
}

onMounted(async () => {
  if (!isTauri()) return;
  if (isIsland) {
    // 透明窗口：body 渐变背景与光晕必须去除，否则透出灰底（.island-body 规则见样式块）
    document.body.classList.add('island-body');
    unlisteners.push(await listen<{ kind: IslandKind; text?: string; title?: string; durationMs?: number }>('island:show', (ev) => {
      void applyIsland(ev.payload);
    }));
    // ready 握手：通知管理器本窗口已就绪（首次 show 前会等待此信号）
    await emit('island:ready');
    return;
  }
  if (isPinMode) {
    // 窗口级 listen（target 绑定本窗口 label）：管理器 emitTo 定向投递只会命中目标窗口。
    // 全局 listen（target=Any）会收到发往**所有** pin 窗口的投递（tauri v2 对 Any 监听器无条件放行），
    // 多个钉住卡片并存时文本互相覆盖——此前环盘气泡内容全部相同的根因。
    unlisteners.push(await getCurrentWebviewWindow().listen<{ text: string }>('bubble:pin:data', (ev) => {
      pinnedText.value = ev.payload.text;
      void getCurrentWindow().show();
    }));
    // ready 握手：通知创建者本窗口 label（创建者随后 emitTo 定向投递文本）
    await emit('bubble:pin:ready', getCurrentWindow().label);
    return;
  }
  if (isRingBubble) {
    // 透明窗口：body 渐变背景与光晕必须去除，否则透出灰底、圆角卡片四角露方块
    // （复用 .island-body 规则——该规则即"body 透明 + 去全局光晕"，与岛模式共用）
    document.body.classList.add('island-body');
    // 窗口级 listen（同 pin 模式注释）：emitTo 定向投递只命中本窗口，杜绝多气泡文本串台
    unlisteners.push(await getCurrentWebviewWindow().listen<{ text: string }>('bubble:ring:data', (ev) => {
      ringText.value = ev.payload.text;
    }));
    unlisteners.push(await listen<{ selected: number }>('ring:state', (ev) => {
      ringSelected.value = ev.payload.selected === ringIndex;
    }));
    // ready 握手：通知管理器投递本文本
    await emit('bubble:ring:ready', getCurrentWindow().label);
    return;
  }
  if (isRingHub) {
    // 透明窗口：同 ring 气泡，去除 body 背景让圆润卡片直接悬浮于桌面
    document.body.classList.add('island-body');
    unlisteners.push(await listen<{ selected: number; page: number; total: number }>('ring:state', (ev) => {
      hubSelected.value = ev.payload.selected;
      hubPage.value = ev.payload.page;
      hubTotal.value = ev.payload.total;
    }));
    // ready 握手：通知管理器推送初始状态
    await emit('bubble:ring:hub-ready', getCurrentWindow().label);
    // Esc 关闭整个环（控制盘获得焦点时可用）
    window.addEventListener('keydown', onHubKeydown);
    return;
  }
});

/**
 * 控制盘键盘导航（控制盘持有系统焦点，是环形系统的唯一键盘入口）：
 * ←↑/→↓ 切换选中 · Enter 粘贴选中项 · PgUp/PgDn 翻页 · Esc 关闭整环
 */
function onHubKeydown(e: KeyboardEvent): void {
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      e.preventDefault();
      hubNav(-1);
      break;
    case 'ArrowRight':
    case 'ArrowDown':
      e.preventDefault();
      hubNav(1);
      break;
    case 'Enter':
      e.preventDefault();
      void emit('ring:paste-req', { index: hubSelected.value });
      break;
    case 'PageUp':
      e.preventDefault();
      hubPageNav(-1);
      break;
    case 'PageDown':
      e.preventDefault();
      hubPageNav(1);
      break;
    case 'Escape':
      e.preventDefault();
      hubClose();
      break;
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onHubKeydown);
  for (const u of unlisteners) u();
  unlisteners = [];
  if (pinCopiedTimer) clearTimeout(pinCopiedTimer);
  if (isIsland) {
    clearIslandTimers();
    cancelIslandExpand();
    if (islandCollapseTimer) { clearTimeout(islandCollapseTimer); islandCollapseTimer = null; }
    stopIslandProximity();
  }
  // ring / ring-hub 模式挂载时也加了 island-body（body 透明），统一在此移除
  document.body.classList.remove('island-body');
});
</script>

<template>
  <!-- 灵动岛模式：复制/粘贴反馈胶囊（配色随主窗口主题同步，靠窗口透明悬浮于屏幕顶部） -->
  <div v-if="isIsland" class="island-wrap">
    <div class="island-col" @mouseenter="onIslandEnter" @mouseleave="onIslandLeave">
      <div
          ref="islandPillEl"
          class="island-pill bg-surface text-ink border-line shadow-float"
          :class="islandVisible ? 'island-in' : ''"
      >
        <!-- 图标随 kind 变化：粘贴=剪贴板打勾 / 成功=对勾圈 / 失败=叹号圈 / 信息=i圈 / 复制=双层卡片 -->
        <svg v-if="islandKind === 'paste'" class="island-icon text-ink-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="8" y="2" width="8" height="4" rx="1" />
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <path d="m9 14 2 2 4-4" />
        </svg>
        <svg v-else-if="islandKind === 'success'" class="island-icon text-ink-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="m8.5 12.5 2.5 2.5 5-5" />
        </svg>
        <svg v-else-if="islandKind === 'error'" class="island-icon text-ink-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
        <svg v-else-if="islandKind === 'info'" class="island-icon text-ink-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        <svg v-else class="island-icon text-ink-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span class="shrink-0 text-xs font-medium">{{ islandLabel }}</span>
        <!-- 图片复制：缩略图预览（悬停弹出独立窗口放大预览原图，按原图比例适配+屏幕钳制）；文本复制：单行截断预览 -->
        <img
            v-if="islandKind === 'copy-image' && islandText"
            :src="islandText"
            alt=""
            class="h-7 w-7 shrink-0 rounded-md object-cover"
            @mouseenter="onIslandImageEnter"
            @mouseleave="hideImagePreview"
        />
        <span v-else-if="islandText" ref="islandTextEl" class="min-w-0 flex-1 truncate text-xs text-ink-soft">{{ islandText }}</span>
      </div>
      <!-- 悬停展开的下拉面板：仅当内容溢出胶囊时渲染，逐行带行号展示完整内容（超高可滚动，样式与胶囊一致） -->
      <div
          v-if="islandOverflow"
          class="island-panel bg-surface text-ink border-line shadow-float"
          :class="islandExpanded ? 'island-panel-in' : ''"
          :style="{ maxHeight: islandPanelMaxH + 'px' }"
      >
        <div ref="islandPanelInnerEl" class="island-panel-text">
          <div v-for="(line, i) in islandRenderedLines" :key="i" class="island-panel-row">
            <span v-if="islandLineCount > 1" class="island-line-num">{{ i + 1 }}</span>
            <span class="island-line">{{ line }}</span>
          </div>
          <!-- 元信息：总行数；行数被渲染上限截断时附带省略提示（与 tooltip 行为一致） -->
          <div v-if="islandLineCount > 1" class="island-panel-meta">
            {{ islandHiddenLines > 0
                ? `${t('island.line_count', { n: islandLineCount })} · ${t('island.lines_hidden', { n: islandHiddenLines })}`
                : t('island.line_count', { n: islandLineCount }) }}
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 钉住模式：单片段常驻卡片（灵动岛形态） -->
  <div v-else-if="isPinMode" class="h-screen overflow-hidden rounded-xl border border-line bg-surface shadow-soft">
    <div class="flex items-center justify-between px-3 pt-2">
      <span class="text-[10px] uppercase tracking-wide text-ink-faint">{{ t('bubble.pinned_title') }}</span>
      <button type="button" class="text-ink-faint transition-colors hover:text-danger" @click="closePin">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
    <button type="button"
            class="block w-full px-3 pb-2 pt-1 text-left"
            @click="copyPinned">
      <p class="line-clamp-2 text-xs leading-relaxed text-ink">{{ pinnedText }}</p>
      <p class="mt-1 text-[10px]" :class="pinCopied ? 'text-gold' : 'text-ink-faint'">
        {{ pinCopied ? t('bubble.copied') : t('bubble.click_to_copy') }}
      </p>
    </button>
  </div>

  <!-- 环形气泡：独立透明窗口 + 圆润卡片（四周 8px 留白供圆角与阴影渲染，四角透出桌面），
       选中高亮（金边 + 外发光 + 序号徽章），Ctrl+悬停/点击选中，双击粘贴 -->
  <div v-else-if="isRingBubble"
       class="group relative h-screen cursor-pointer rounded-2xl border p-2 shadow-soft transition-all duration-200 ease-soft"
       :class="ringSelected
         ? 'border-gold bg-surface-field ring-2 ring-gold shadow-[0_0_14px_rgb(var(--c-gold)/0.45)]'
         : 'border-line bg-surface-field/95 hover:border-accent'"
       @pointermove="ringPointerMove"
       @click="ringSelect"
       @dblclick="ringPaste">
    <p class="line-clamp-3 text-[11px] leading-relaxed text-ink">{{ ringText }}</p>
    <button type="button"
            class="absolute right-1 top-1 hidden rounded-md bg-surface px-1 text-[10px] text-ink-faint shadow-sm transition-colors hover:text-gold group-hover:block"
            :title="t('bubble.pin')"
            @click.stop="pinCurrent">📌</button>
    <span v-if="ringSelected"
          class="absolute bottom-1 right-2 text-[9px] tabular-nums text-gold">{{ ringIndex + 1 }}</span>
  </div>

  <!-- 环心控制盘：箭头导航 + 翻页 + 关闭（透明窗口 + 圆润卡片，外层 p-1.5 为阴影留白） -->
  <div v-else-if="isRingHub" class="h-screen p-1.5">
    <div class="flex h-full flex-col justify-center gap-2 rounded-2xl border border-accent bg-surface/95 px-3.5 py-2.5 shadow-soft backdrop-blur">
    <div class="flex items-center justify-between gap-2">
      <span class="text-[10px] uppercase tracking-wide text-ink-faint">{{ t('bubble.title') }}</span>
      <button type="button" class="text-ink-faint transition-colors hover:text-danger" :title="t('common.close')"
              @click="hubClose">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div class="flex items-center justify-between gap-2">
      <button type="button" class="btn-soft btn-circle p-1 disabled:opacity-30" :title="t('bubble.prev')"
              @click="hubNav(-1)">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <span class="min-w-[4rem] text-center text-xs tabular-nums text-ink">
        {{ hubTotal ? Math.min(hubSelected + 1, hubTotal) : 0 }} / {{ hubTotal }}
      </span>
      <button type="button" class="btn-soft btn-circle p-1 disabled:opacity-30" :title="t('bubble.next')"
              @click="hubNav(1)">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>

    <div class="flex items-center justify-between gap-2 text-[10px] text-ink-faint">
      <button type="button" class="transition-colors hover:text-gold disabled:opacity-30" :title="t('bubble.prev_page')"
              :disabled="hubTotal === 0" @click="hubPageNav(-1)">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m11 17-5-5 5-5" /><path d="m18 17-5-5 5-5" /></svg>
      </button>
      <span class="tabular-nums">
        {{ hubPage + 1 }} / {{ Math.max(1, Math.ceil(hubTotal / 8)) }}
      </span>
      <button type="button" class="transition-colors hover:text-gold disabled:opacity-30" :title="t('bubble.next_page')"
              :disabled="hubTotal === 0" @click="hubPageNav(1)">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 17 5-5-5-5" /><path d="m14 17 5-5-5-5" /></svg>
      </button>
    </div>

    <!-- 键盘操作提示：控制盘持有焦点，方向键/Enter/Esc 直接可用 -->
    <div class="text-center text-[9px] leading-none text-ink-faint">{{ t('bubble.paste_hint') }}</div>
    </div>
  </div>
</template>

<style>
/* dev 模式下 Nuxt DevTools / Vite overlay 会注入到每个页面的 document，
   悬浮窗（island/ring/hub/pin）必须隐藏，否则黑色胶囊浮层污染气泡视觉（生产构建无此项） */
#nuxt-devtools-container,
[id^="nuxt-devtools"],
.vite-error-overlay,
vue-devtools-anchor {
  display: none !important;
}
</style>

<style>
/* 透明悬浮窗口通用（island / ring / ring-hub 模式经 body class 作用）：
   去除全局 body 渐变与光晕，保持窗口透明以悬浮于桌面 */
body.island-body {
  background: transparent !important;
}
body.island-body::before,
body.island-body::after {
  display: none !important;
}
</style>

<style scoped>
.island-wrap {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  width: 100vw;
  height: 100vh;
  padding-top: 8px;
  overflow: hidden;
}
.island-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}
.island-pill {
  position: relative;
  z-index: 1; /* 胶囊在上：下拉面板从其下方展开，互不遮挡 */
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 40px;
  max-width: 344px;
  padding: 0 1rem;
  border-radius: 9999px;
  /* 配色/文字/阴影走主题 token（模板上的 bg-surface text-ink border-line shadow-float），
     随主窗口配色同步，此处只管布局与进出场动画 */
  border-width: 1px;
  opacity: 0;
  /* 收起态上浮 6px：wrap 顶部留 8px，动画全程不越出窗口裁剪区 */
  transform: translateY(-6px) scale(0.92);
  transition:
    opacity 0.22s ease,
    transform 0.26s cubic-bezier(0.34, 1.4, 0.4, 1);
}
.island-pill.island-in {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.island-icon {
  height: 1rem;
  width: 1rem;
  flex-shrink: 0;
  opacity: 0.85;
}
/* 悬停下拉面板：与胶囊同宽同配色 token（bg-surface/border-line/shadow-float），内容超高时滚动 */
.island-panel {
  z-index: 0;
  width: 344px;
  max-width: calc(100vw - 16px);
  margin-top: 8px;
  padding: 0.625rem 0.875rem;
  border-width: 1px;
  border-radius: 1rem;
  overflow-y: auto;
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
  transform-origin: top center;
  transition:
    opacity 0.22s ease,
    transform 0.26s cubic-bezier(0.34, 1.4, 0.4, 1);
}
.island-panel.island-panel-in {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.island-panel-text {
  font-size: 0.75rem;
  line-height: 1.5;
  user-select: text;
  cursor: default;
}
.island-panel-row {
  /* 每行：左侧行号 + 右侧文本 横向排列（与 tooltip 窗口同构） */
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.island-line-num {
  /* 行号：固定宽度、右对齐，从 1 递增到总行数 */
  flex: none;
  width: 1.6em;
  text-align: right;
  font-size: 0.65rem;
  line-height: inherit;
  color: rgba(150, 120, 90, 0.85);
  white-space: nowrap;
  user-select: none;
}
.island-line {
  /* 完整显示：保留原始空白（tab/连续空格），超长行自动换行展示全部内容 */
  flex: 1;
  min-width: 0;
  display: block;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.island-panel-meta {
  /* 行数统计：面板底部弱化小字，选中文字时不误选 */
  margin-top: 0.375rem;
  font-size: 0.65rem;
  line-height: 1.4;
  color: rgba(150, 120, 90, 0.85);
  user-select: none;
}
</style>
