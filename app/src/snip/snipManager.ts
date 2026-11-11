import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors } from '@tauri-apps/api/window';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { isTauri } from '~/utils/env';
import { listen, emitTo, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from 'tauri-plugin-clipboard-api';
import {
  suppressIslandCopy,
  notifyIsland,
  notifySnipIsland,
  setSnipSessionActive,
  toggleIslandHistoryWindow,
} from '~/composables/useCopyIsland';
import { isPrivacyPaused } from '~/composables/usePrivacySettings';
import { useI18n } from '~/composables/useI18n';
import { saveSnipToHistory, suppressSnipCapture, suppressUseCountBump } from '../clipboard/clipboardListener';
import dbService from '../db/dbService';
import {
  ensureSnipSettingsLoaded,
  getSnipCaptureScope,
  getSnipLastRegion,
  isSnipAutoCopy,
  isSnipAutoHistory,
  isSnipCaptureCursor,
  setSnipLastRegion,
  useSnipUploadUrl,
} from './snipSettings';
import { clampPreselect, preselectSource } from './preselect';
import { placeQuickBar, quickBarWidth, QUICKBAR_HEIGHT } from './quickbar';

/**
 * 截图会话管理器（主窗口上下文；全局快捷键 ScreenshotCommand 调用 openSnip）。
 *
 * 常驻预热窗模式（用户实测「快捷键无法即时出现」的修复）：
 *   - 模块加载即隐藏创建 snip-overlay（固定标签，capabilities 白名单精确条目），
 *     页面常驻复用——热键路径只剩「截屏 → 移窗/改尺寸(物理直传) → 投数据 → 显示」；
 *   - 先截屏后显示：自绘遮罩不入镜；截屏与显示之间仅剩百毫秒级，画面不再陈旧；
 *   - closeSnip = hide 不销毁（会话清空，页面状态在下次 snip:data 到达时重置）；
 *   - 会话中再按热键 = 取消（toggle 语义）。
 *
 * 融合时序（confirmSnip，顺序即规格书 P0-T7 ②③④⑤）：
 *   裁剪 → 写系统剪贴板（双抑制先行）→ 入剪贴板历史（saveSnipToHistory 直存，
 *   不依赖 watcher 回捕）→ 岛「已截图」。隐私模式下跳过 ④⑤，保留剪贴板写入
 *   （用户主动操作，watcher 侧自会失明）。
 */

/** ready 握手超时：页面加载异常时放弃本次截图，不留幽灵覆盖窗 */
const READY_TIMEOUT_MS = 8000;

export interface SnipConfirmPayload {
  /** 选区矩形（物理像素，屏幕全局坐标） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 确认动作：copy = 写剪贴板+入历史（默认）；save = 保存到文件；pin = 贴图 */
  action?: 'copy' | 'save' | 'pin';
  /** 标注合成产物（snip 页把标注烘焙进裁剪图后经 save_clipboard_image 落盘）：
   *  存在时裁剪源换用该引用且坐标为图内 0,0 起（规格书 P1-T1） */
  annotatedRef?: string;
}

interface SnipSession {
  ts: number;
  /** 整屏全分辨率截图引用（后台线程落盘完成后经 snip:full-ready 补发；
   *  确认裁剪时通过 fullPromise 等待——用户框选期间早已完成） */
  fileRef: string | null;
  /** 全分辨率引用就绪 promise（openSnip 时创建，full-ready 事件 resolve；
   *  超时 resolve(null)——永不 reject，杜绝未确认/取消场景的 unhandled rejection） */
  fullPromise: Promise<string | null>;
}

let snip: SnipSession | null = null;

/** 显示器清单缓存：热键路径每次 IPC 查询浪费 5~15ms，显示器配置极少变化——
 *  首次查询后缓存复用；查询失败回落空数组（下次重试） */
let monitorsCache: Awaited<ReturnType<typeof availableMonitors>> | null = null;
async function getMonitors(): Promise<Awaited<ReturnType<typeof availableMonitors>>> {
  if (monitorsCache) return monitorsCache;
  monitorsCache = await availableMonitors().catch(() => [] as Awaited<ReturnType<typeof availableMonitors>>);
  return monitorsCache;
}

/** 当次捕获的全分辨率引用补发管道（openSnip 登记 → full-ready 事件消费） */
let pendingFull: { ts: number; resolve: (ref: string | null) => void } | null = null;

/** 会话进行中（覆盖窗可见）：再次触发按取消处理（热键 toggle 语义） */
export function isSnipOpen(): boolean {
  return !!snip;
}

function epochAlive(ts: number): boolean {
  return !!snip && snip.ts === ts;
}

// ===== 常驻覆盖窗（预热）：窗口启动即隐藏创建，热键路径只剩
// 「截屏 → 移窗/改尺寸 → 投数据 → 显示」，消除每次新建 Nuxt 页面的 1~3s 冷启动
// （原实现截屏发生在建窗之前，覆盖窗出现时画面已陈旧数秒——用户实测反馈的主因）。
// 窗口标签固定 snip-overlay（capabilities 白名单含精确条目），页面常驻复用。 =====
const OVERLAY_LABEL = 'snip-overlay';
let overlay: WebviewWindow | null = null;
let overlayReady = false;
let overlayCreating: Promise<WebviewWindow | null> | null = null;
/** 会话级事件监听（cancel/confirm）：常驻窗注册一次，处理器内部校验会话纪元 */
let sessionListenersBound = false;

/** 确保常驻覆盖窗存在（幂等；并发共享同一创建 Promise） */
async function ensureOverlay(): Promise<WebviewWindow | null> {
  if (overlay && overlayReady) return overlay;
  const existing = await WebviewWindow.getByLabel(OVERLAY_LABEL).catch(() => null);
  if (existing) {
    overlay = existing;
    return overlay;
  }
  if (overlayCreating) return overlayCreating;
  overlayCreating = (async () => {
    // ready 监听先于建窗（页面 mount 即 emit，后注册必丢握手——createIslandWindow 教训）；
    // 监听常驻：页面 HMR/重载后再次 emit 同样能刷新 overlayReady
    const unReady = await listen('snip:ready', (ev) => {
      if ((ev.payload as string) !== OVERLAY_LABEL) return;
      overlayReady = true;
    }).catch(() => null);
    const win = new WebviewWindow(OVERLAY_LABEL, {
      url: '/snip',
      title: 'Snip',
      width: 1,
      height: 1,
      x: -32000,
      y: -32000,
      resizable: false,
      decorations: false,
      transparent: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      focus: false,
      focusable: true,
      shadow: false,
      visible: false,
    });
    overlay = win;
    win.once('tauri://error', () => {
      overlayReady = false;
      if (overlay === win) overlay = null;
    });
    // 就绪兜底：页面 8s 未 ready 也放行（透明窗最坏短暂空白，不永久卡死热键）
    setTimeout(() => {
      void safeUnlisten(unReady!);
      if (!overlayReady) overlayReady = true;
    }, READY_TIMEOUT_MS);
    return win;
  })().finally(() => { overlayCreating = null; });
  return overlayCreating;
}

/** 延迟解绑：Tauri listen 注册走 webview eval 宏任务队列，立即解绑会泄漏（照 ring 同款） */
async function safeUnlisten(u: UnlistenFn | null): Promise<void> {
  if (!u) return;
  await new Promise((r) => setTimeout(r, 0));
  try { await u(); } catch { /* ignore */ }
}

/** 收起覆盖窗（常驻不销毁）：会话清空 + 隐藏；焦点自然回落目标应用 */
export async function closeSnip(): Promise<void> {
  snip = null;
  // 会话结束：恢复岛显示（确认截图后的「已截图」岛不被吞）
  setSnipSessionActive(false);
  await overlay?.hide().catch(() => {});
}

// ===== 快速访问条（确认截图后浮现的小工具条：贴图 / OCR / 上传 / 历史） =====
// 与覆盖窗同款预热：WebView 建窗 1~3s，热路径现建会明显滞后于截图完成，
// 因此启动即隐藏创建，显示时只做「改尺寸/改位置/投数据/show」。
const QUICKBAR_LABEL = 'snip-quickbar';
let quickbar: WebviewWindow | null = null;
let quickbarReady = false;
let quickbarCreating: Promise<WebviewWindow | null> | null = null;
/** 本次工具条对应的截图上下文（动作执行用；隐藏后置空防串） */
let quickbarCtx: { crop: SnipCropResult; p: SnipConfirmPayload } | null = null;

async function ensureQuickBar(): Promise<WebviewWindow | null> {
  if (quickbar && quickbarReady) return quickbar;
  const existing = await WebviewWindow.getByLabel(QUICKBAR_LABEL).catch(() => null);
  if (existing) {
    quickbar = existing;
    return quickbar;
  }
  if (quickbarCreating) return quickbarCreating;
  quickbarCreating = (async () => {
    const unReady = await listen('snip-quickbar:ready', (ev) => {
      if ((ev.payload as string) !== QUICKBAR_LABEL) return;
      quickbarReady = true;
    }).catch(() => null);
    const win = new WebviewWindow(QUICKBAR_LABEL, {
      url: '/snip-quickbar',
      title: 'Snip Quick Bar',
      width: 1,
      height: 1,
      x: -32000,
      y: -32000,
      resizable: false,
      decorations: false,
      transparent: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      focus: false,
      focusable: true,
      shadow: false,
      visible: false,
    });
    quickbar = win;
    win.once('tauri://error', () => {
      quickbarReady = false;
      if (quickbar === win) quickbar = null;
    });
    // 被系统/清理流程销毁后重置状态，下次 showQuickBar 重新创建（否则残留失效引用）
    win.once('tauri://destroyed', () => {
      void safeUnlisten(unReady!);
      quickbarReady = false;
      if (quickbar === win) quickbar = null;
      quickbarCtx = null;
    });
    setTimeout(() => {
      void safeUnlisten(unReady!);
      if (!quickbarReady) quickbarReady = true;
    }, READY_TIMEOUT_MS);
    return win;
  })().finally(() => { quickbarCreating = null; });
  return quickbarCreating;
}

/** 收起快速访问条（常驻不销毁） */
async function hideQuickBar(): Promise<void> {
  quickbarCtx = null;
  await quickbar?.hide().catch(() => {});
}

/** 显示快速访问条：贴在选区下方（放不下翻到上方，钳制在显示器内），不抢焦点。 */
async function showQuickBar(crop: SnipCropResult, p: SnipConfirmPayload): Promise<void> {
  const win = await ensureQuickBar();
  if (!win) return;
  const ctx = { crop, p };
  quickbarCtx = ctx;
  const upload = useSnipUploadUrl().value.trim().length > 0;
  // 按钮：贴图 / 历史 + 上传（仅配置地址时）——文字识别只在截图编辑器工具条
  const logicalW = quickBarWidth(upload ? 3 : 2);
  const logicalH = QUICKBAR_HEIGHT;
  const monitors = await getMonitors();
  const mon = monitors.find((mm) =>
    p.x >= mm.position.x && p.x < mm.position.x + mm.size.width &&
    p.y >= mm.position.y && p.y < mm.position.y + mm.size.height) ?? monitors[0];
  const scale = mon?.scaleFactor || 1;
  const monRect = mon
    ? { x: mon.position.x, y: mon.position.y, w: mon.size.width, h: mon.size.height }
    : { x: p.x, y: p.y, w: p.w, h: p.h };
  const bar = { w: Math.round(logicalW * scale), h: Math.round(logicalH * scale) };
  const pos = placeQuickBar({ x: p.x, y: p.y, w: p.w, h: p.h }, monRect, bar);
  // 页面未就绪（预热门窗刚创建/重载）：轮询等待 ready 再投，避免 emitTo 落空
  if (!quickbarReady) {
    const deadline = Date.now() + 1500;
    while (!quickbarReady && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }
  await win.setSize(new LogicalSize(logicalW, logicalH)).catch(() => {});
  await win.setPosition(new PhysicalPosition(pos.x, pos.y)).catch(() => {});
  await emitTo(QUICKBAR_LABEL, 'snip-quickbar:data', {
    fileRef: crop.fileRef,
    width: crop.width,
    height: crop.height,
    upload,
  }).catch(() => {});
  await win.show().catch(() => {});
  // 兜底收起：页面计时器（4s 无交互）失效时主窗口也能收尾
  setTimeout(() => {
    if (quickbarCtx === ctx) void hideQuickBar();
  }, 8000);
}

/** 快速访问条动作（子窗口只发动作名，抑制标记/岛/数据库全部在主窗口执行） */
async function handleQuickBarAction(action: string): Promise<void> {
  const ctx = quickbarCtx;
  if (!ctx) return;
  const { crop, p } = ctx;
  await hideQuickBar();
  const { t } = useI18n();
  if (action === 'pin') {
    await createPinWindow(crop, p);
    return;
  }
  if (action === 'history') {
    await toggleIslandHistoryWindow().catch(() => {});
    return;
  }
  if (action === 'upload') {
    const url = useSnipUploadUrl().value.trim();
    if (!url) return;
    try {
      const link = await invoke<string>('snip_upload_image', { fileRef: crop.fileRef, url });
      suppressIslandCopy();
      await writeText(link);
      notifyIsland({ kind: 'success', text: t('snip.upload_copied') });
    } catch (e) {
      notifyIsland({ kind: 'error', text: `${t('snip.upload_failed')}：${String(e)}` });
    }
  }
}

/** 唤起截图：先截屏后显示（顺序即正确性——自绘遮罩不入镜）。
 *  会话中再按 = 忽略（键盘连击/自动重复不再「开→取消→开」闪烁，用户实测反馈）；
 *  开启中的重复触发同样去重（截屏 200~300ms 窗口内的第二次按下不并发开两条会话）。
 *
 *  entry（多入口快捷键）：
 *   - region：自由框选（默认）
 *   - fullscreen：预选光标所在显示器整屏
 *   - window：预选光标下的窗口
 *   - last：预选上次确认的选区 */
export type SnipEntry = 'region' | 'fullscreen' | 'window' | 'last';

let opening = false;
export async function openSnip(entry: SnipEntry = 'region'): Promise<void> {
  if (snip || opening) return;
  opening = true;
  try {
    await openSnipInner(entry);
  } finally {
    opening = false;
  }
}

interface CaptureInfo {
  previewUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  cursorX: number;
  cursorY: number;
}

interface MonInfo {
  position: { x: number; y: number };
  size: { width: number; height: number };
  scaleFactor: number;
}

/** 计算预选选区（逻辑坐标，相对覆盖窗）。无法确定时返回 null（自由框选）。 */
async function computePreselect(
  entry: SnipEntry,
  cap: CaptureInfo,
  scale: number,
  cursorMon: MonInfo | undefined,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  // 窗口探测：光标下的可见窗口（DWM 扩展边框已排除）
  const windowRect = entry === 'window'
    ? await invoke<{ x: number; y: number; w: number; h: number } | null>(
        'snip_windows_at_point',
        { x: cap.cursorX, y: cap.cursorY },
      ).catch(() => null)
    : null;
  const lastRegion = entry === 'last' ? await getSnipLastRegion() : null;
  const source = preselectSource(
    entry,
    cap,
    cursorMon ? { x: cursorMon.position.x, y: cursorMon.position.y, w: cursorMon.size.width, h: cursorMon.size.height } : null,
    windowRect,
    lastRegion,
  );
  return clampPreselect(source, cap, scale);
}

async function openSnipInner(entry: SnipEntry): Promise<void> {
  const ts = Date.now();
  // 0) 会话与全分辨率等待先行登记，再发起截屏：后台落盘线程会立刻 emit
  //    snip:full-ready（≤2K 屏预览已编码，写盘往往快于大数据量预览 IPC 返回），
  //    若等 capture 返回后才登记 pendingFull/snip，事件会因「无主」被丢弃——
  //    覆盖窗永远拿不到全分辨率引用，OCR/保存随后报「截图数据尚未就绪」（用户实测）。
  //    超时兜底**resolve(null)**（冷盘/大屏首编偶发慢，宽容到 8s），不用 reject——
  //    取消/未确认时的超时触发会产生 unhandled rejection；确认路径对 null 判错即可。
  let resolveFull!: (ref: string | null) => void;
  const fullPromise = new Promise<string | null>((resolve) => {
    resolveFull = resolve;
    setTimeout(() => {
      if (pendingFull?.ts === ts) pendingFull = null;
      resolve(null);
    }, 8000);
  });
  pendingFull = { ts, resolve: resolveFull };
  snip = { ts, fileRef: null, fullPromise };
  // 会话开始：岛（alwaysOnTop）立刻让位，避免压住截图覆盖窗；期间反馈走覆盖窗内 toast
  setSnipSessionActive(true);
  // 上次截图残留的快速访问条先收起（新会话优先，避免两条浮层叠在屏幕上）
  void hideQuickBar();
  // 子窗口显示瞬间豁免主窗口失焦连带（照 BubbleToggleCommand.openRing :194）
  (window as any).__childOpeningUntil = Date.now() + 600;

  // 1. 先截屏（物理像素；捕获光标按设置）。即时返回预览（≤2K 缩小快编），
  //    全分辨率 PNG 后台落盘经 snip:full-ready 补发——热路径不等它（打开慢的根因）。
  //    失败自动重试一次（GDI / 剪贴板插件锁的偶发竞争）
  //    scope：默认虚拟桌面并集（跨屏框选），设置可回退单屏；全屏/窗口入口必须
  //    用并集（窗口可能跨屏，预选后仍需完整覆盖）
  const includeCursor = await isSnipCaptureCursor();
  const scope = entry === 'region' ? await getSnipCaptureScope() : 'all';
  const captureOnce = () => invoke<CaptureInfo | null>(
    'snip_capture_screen',
    { includeCursor, scope },
  ).catch(() => null);
  let cap = await captureOnce();
  if (!cap?.previewUrl) {
    await new Promise((r) => setTimeout(r, 120));
    cap = await captureOnce();
  }
  const { t } = useI18n();
  if (!cap?.previewUrl || !cap.previewUrl.startsWith('data:')) {
    // 未进入覆盖窗：先清会话（否则 isSnipOpen 恒真、后续热键全被吞），恢复岛显示
    snip = null;
    pendingFull = null;
    setSnipSessionActive(false);
    notifyIsland({ kind: 'error', text: t('snip.capture_failed') });
    return;
  }
  // 2. 求 scale：捕获矩形可能是虚拟桌面并集（无法与单显示器矩形比对），
  //    改用「捕获瞬间光标坐标落在哪个显示器」判定——光标所在屏的 scaleFactor
  //    即覆盖窗内容的 DPI 基准（混合 DPI 多屏下非光标屏内容会有缩放开销，
  //    见 spec 平台限制说明；同 DPI 多屏完全精确）
  const monitors = await getMonitors();
  const cursorMon = monitors.find((mm) =>
    cap.cursorX >= mm.position.x && cap.cursorX < mm.position.x + mm.size.width &&
    cap.cursorY >= mm.position.y && cap.cursorY < mm.position.y + mm.size.height);
  const scale = cursorMon?.scaleFactor || 1;
  const preselect = await computePreselect(entry, cap, scale, cursorMon as MonInfo | undefined);

  // 3. 常驻窗移到目标显示器（物理像素直传，避免除法取整误差）→ 投数据 → 显示取焦
  const win = await ensureOverlay();
  if (!win) {
    // 覆盖窗创建失败：同样清会话 + 恢复岛显示
    snip = null;
    pendingFull = null;
    setSnipSessionActive(false);
    notifyIsland({ kind: 'error', text: t('snip.capture_failed') });
    return;
  }
  await win.setSize(new PhysicalSize(cap.width, cap.height)).catch(() => {});
  await win.setPosition(new PhysicalPosition(cap.x, cap.y)).catch(() => {});
  if (!epochAlive(ts)) return;
  // 页面未就绪（如常驻窗刚创建/重载）：轮询等待 ready 再投，最多 3s——
  // 原固定 80ms 在慢启动时 emitTo 会打进未监听的页面，数据丢失（用户实测黑屏）
  if (!overlayReady) {
    const deadline = Date.now() + 3000;
    while (!overlayReady && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      if (!epochAlive(ts)) return;
    }
  }
  if (!epochAlive(ts)) return;
  // originX/Y：显示器物理原点——页面把窗口探测的全局物理坐标换算回页面坐标用；
  // width/height 显式下发（隐藏窗刚 setSize，viewport 可能尚未同步，window.innerWidth
  // 存在仍为旧尺寸 1×1 的竞态——选区钳制边界必须用会话真实值）；
  // dataUrl = 预览图直达（页面免读盘免二次 IPC，冻结画面随事件即刻渲染）
  await emitTo(OVERLAY_LABEL, 'snip:data', {
    dataUrl: cap.previewUrl,
    scale,
    originX: cap.x,
    originY: cap.y,
    width: cap.width / scale,
    height: cap.height / scale,
    preselect,
  }).catch(() => {});
  // 全分辨率引用可能先于 snip:data 到达（后台落盘快于预览 IPC）——页面在
  // startSession 里会把它清空。数据投递后补发一次已就绪的引用（同引用重复投递
  // 无害，页面幂等覆盖），保证 OCR/保存一定能拿到原图。
  if (snip && snip.ts === ts && snip.fileRef) {
    const readyRef = snip.fileRef;
    await emitTo(OVERLAY_LABEL, 'snip:full-ref', { fileRef: readyRef }).catch(() => {});
  }
  const shown = await win.show().then(() => true, () => false);
  if (!shown) {
    // 覆盖窗显示失败：先清会话，不留在「会话进行中」（否则岛会一直被抑制）
    snip = null;
    pendingFull = null;
    setSnipSessionActive(false);
    notifyIsland({ kind: 'error', text: t('snip.capture_failed') });
    return;
  }
  await win.setFocus().catch(() => {});
}

/** 绑定会话事件（常驻窗一次性）：cancel / confirm（确认含 pin 动作分流） */
async function bindSessionListeners(): Promise<void> {
  if (sessionListenersBound) return;
  sessionListenersBound = true;
  await listen('snip:cancel', () => { if (snip) void closeSnip(); });
  // 后台全分辨率落盘完成：按会话纪元校验后 resolve（旧会话的迟到事件丢弃），
  // 同时把引用转发给覆盖窗页面——保存动作在页面内自闭环执行（裁剪/写盘/弹岛
  // 全部页面直连 Rust 与灵动岛，不经主窗口事件链；此前页面→主窗口的
  // snip:confirm 事件链在运行时存在静默断点，保存无文件无提示，用户实测）
  await listen<{ fileRef: string }>('snip:full-ready', (ev) => {
    const p = pendingFull;
    if (!p || !snip || snip.ts !== p.ts) return;
    pendingFull = null;
    snip.fileRef = ev.payload.fileRef;
    p.resolve(ev.payload.fileRef);
    void emitTo(OVERLAY_LABEL, 'snip:full-ref', { fileRef: ev.payload.fileRef }).catch(() => {});
  });
  await listen('snip:confirm', (ev) => {
    const p = ev.payload as SnipConfirmPayload;
    if (!snip) return;
    const ts = snip.ts;
    if (p.action === 'pin') void pinSnip(p, ts);
    else void confirmSnip(p, ts);
  });
  // OCR 结果已由覆盖窗写入剪贴板并回读校验：这里只负责收起截图（结束会话）+ 弹岛确认
  await listen<{ text?: string }>('snip:ocr-copied', async (ev) => {
    const text = (ev.payload?.text ?? '').trim();
    if (!text) return;
    const { t } = useI18n();
    // 抑制剪贴板 watcher 的「已复制」岛：正文已写，避免与下面这条重复弹
    suppressIslandCopy(1500);
    // 先结束会话再反馈：会话期间岛被抑制（让位截图 UI），关闭后岛才能正常弹出
    if (snip) await closeSnip();
    notifyIsland({ kind: 'success', text: t('snip.ocr_copied', { n: text.length }) });
  });
  // 长截图拼接完成：由主窗口统一写剪贴板 + 入历史（页面所在覆盖窗无数据库连接）
  await listen<{ fileRef: string; frames?: number }>('snip:long-done', async (ev) => {
    const ref = ev.payload?.fileRef;
    if (!ref) return;
    // 长截图完成：会话已结束（页面随后 emit cancel），先恢复岛显示再反馈
    setSnipSessionActive(false);
    const { t } = useI18n();
    const privacy = isPrivacyPaused();
    // 与 confirmSnip 同语义：写剪贴板（开关 + 双抑制先行）→ 入历史 → 岛
    if (await isSnipAutoCopy()) {
      suppressIslandCopy();
      dbService.suppressUseCountBump();
      suppressSnipCapture(1500);
      const ok = await invoke('snip_write_clipboard_dib', { fileRef: ref }).then(
        () => true,
        () => false,
      );
      if (!ok) {
        notifyIsland({ kind: 'error', text: t('snip.clipboard_failed') });
        return;
      }
    }
    if (!privacy && (await isSnipAutoHistory())) {
      await saveSnipToHistory(ref, null).catch(() => {});
    }
    if (!privacy) {
      void import('~/src/statistics/statsService').then(m => m.default.record({ clip_screenshot: 1 }).catch(() => {}));
      notifyIsland({ kind: 'success', text: t('snip.long_done', { n: ev.payload.frames ?? 0 }) });
    }
  });
  // 快速访问条：自动收起请求 + 动作（子窗口无数据库/抑制标记，动作统一回主窗口执行）
  await listen('snip-quickbar:hide', () => { void hideQuickBar(); });
  await listen<{ action?: string }>('snip-quickbar:action', (ev) => {
    const action = ev.payload?.action;
    if (action) void handleQuickBarAction(action);
  });
}

// 模块加载即预热（主窗口上下文）：会话监听先于常驻窗创建绑定（首秒热键也要能确认/取消），
// 设置项 + 常驻窗随后——热键路径零冷启动
if (isTauri() && getCurrentWindow().label === 'main') {
  void ensureSnipSettingsLoaded().catch(() => {});
  void bindSessionListeners();
  void ensureOverlay().catch(() => {});
  void ensureQuickBar().catch(() => {});
}

/** 裁剪结果（写入系统剪贴板 / 入库 / 导出 / 贴图共用的中间产物） */
interface SnipCropResult {
  fileRef: string;
  thumb: string | null;
  qrText: string | null;
  /** 裁剪图原图 data URL（贴图窗显示直达用） */
  dataUrl: string;
  width: number;
  height: number;
}

async function cropSelection(p: SnipConfirmPayload, fileRef: string): Promise<SnipCropResult | null> {
  return await invoke<SnipCropResult | null>('snip_crop_region', {
    fileRef,
    x: Math.round(p.x),
    y: Math.round(p.y),
    w: Math.round(p.w),
    h: Math.round(p.h),
  }).catch(() => null);
}

/** 确认处理：裁剪 →（写剪贴板 / 入历史）→ 岛，或保存到文件。 */
async function confirmSnip(p: SnipConfirmPayload, ts: number): Promise<void> {
  const session = snip;
  if (!session || session.ts !== ts) return;
  // 记录本次选区（多入口「上次区域」快捷键复用；物理像素原始值）
  void setSnipLastRegion({ x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h) });
  await closeSnip(); // ① 先关覆盖窗（焦点归还；保存对话框在覆盖窗收起后打开，不被置顶窗遮挡）
  const { t } = useI18n();

  // ② 裁剪源：标注合成产物（annotatedRef）已是"选区大小的成图"，恒等裁剪换缩略
  //    图与二维码；否则用全分辨率原图——后台落盘在用户框选期间完成，此处 await
  //    通常瞬时命中；超时/失败给可见错误（产物必须无损，不回退预览图裁剪）
  const srcRef = p.annotatedRef
    ?? await session.fullPromise.then(r => r).catch(() => null);
  if (!srcRef) {
    notifyIsland({ kind: 'error', text: t('snip.crop_failed') });
    return;
  }
  const crop = p.annotatedRef
    ? await cropSelection({ ...p, x: 0, y: 0 }, p.annotatedRef)
    : await cropSelection(p, srcRef);
  if (!crop?.fileRef) {
    notifyIsland({ kind: 'error', text: t('snip.crop_failed') });
    return;
  }
  const privacy = isPrivacyPaused();

  // ③ 保存已改由覆盖窗页面自闭环执行（doSave，见页面）；此处仅兜底——
  //    万一旧版页面仍 emit save，给出可见错误而非静默返回
  if (p.action === 'save') {
    notifyIsland({ kind: 'error', text: t('snip.save_failed') });
    return;
  }

  // ④ 写系统剪贴板：三重抑制先行——写入会触发自身监听（回捕 upsert + island:copy +
  //    watcher 再存一遍历史），不抑制则「已复制」误报弹岛、计数双计、且
  //    auto_history=off 时历史仍被回捕写进（违背用户设置，规格书禁止事项 #4）
  if (await isSnipAutoCopy()) {
    suppressIslandCopy();
    dbService.suppressUseCountBump();
    suppressSnipCapture(1500);
    const ok = await invoke('snip_write_clipboard_dib', { fileRef: crop.fileRef }).then(
      () => true,
      () => false,
    );
    if (!ok) notifyIsland({ kind: 'error', text: t('snip.clipboard_failed') });
  }

  // ⑤ 入剪贴板历史：type='image' + source_app='s1d3-board'（列表/统计/融合能力全自动生效）。
  //    隐私模式跳过（watcher 侧本就失明，此处也不直存）
  if (!privacy && (await isSnipAutoHistory())) {
    await saveSnipToHistory(crop.fileRef, crop.qrText).catch(() => {});
  }

  // ⑥ 岛「已截图」（kind=screenshot：缩略图直显 + 二维码链接；隐私模式不弹）
  if (!privacy) {
    // 截图动作计数：独立于入库（auto_history 关闭也计），画像/统计页消费
    void import('~/src/statistics/statsService').then(m => m.default.record({ clip_screenshot: 1 }).catch(() => {}));
    notifySnipIsland({ thumb: crop.thumb ?? undefined, qrText: crop.qrText ?? undefined, imageRef: crop.fileRef });
    // ⑦ 快速访问条：贴图 / OCR / 上传 / 历史（4 秒无交互自动收起，不抢焦点）
    void showQuickBar(crop, p);
  }
}

// 注：保存动作已改由覆盖窗页面自闭环执行（页面 doSave：full-ref 转发 → 页内
// 裁剪/写盘/弹岛），管理器不再持有保存管线——原跨窗口 snip:confirm 事件链
// 在运行时存在静默断点（无文件无提示），页面直连后零事件跳板
const pinSessions: WebviewWindow[] = [];

/** 贴图：裁剪结果以置顶小窗钉在桌面（会话级，不持久化；双击关闭）。 */
async function pinSnip(p: SnipConfirmPayload, ts: number): Promise<void> {
  const session = snip;
  if (!session || session.ts !== ts) return;
  void setSnipLastRegion({ x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h) });
  await closeSnip();
  const { t } = useI18n();
  // 裁剪源同 confirmSnip：合成产物直用；否则等全分辨率后台落盘（框选期间早已完成）
  const srcRef = p.annotatedRef
    ?? await session.fullPromise.then(r => r).catch(() => null);
  if (!srcRef) {
    notifyIsland({ kind: 'error', text: t('snip.crop_failed') });
    return;
  }
  const crop = p.annotatedRef
    ? await cropSelection({ ...p, x: 0, y: 0 }, p.annotatedRef)
    : await cropSelection(p, srcRef);
  if (!crop?.fileRef) {
    notifyIsland({ kind: 'error', text: t('snip.crop_failed') });
    return;
  }
  await createPinWindow(crop, p);
}

/** 由裁剪结果创建/复用置顶贴图窗（工具条贴图与快速访问条共用） */
async function createPinWindow(crop: SnipCropResult, p: SnipConfirmPayload): Promise<void> {
  const { t } = useI18n();
  const hash8 = crop.fileRef.replace('imgfile:', '').slice(0, 8);
  const label = `snip-pin-${hash8}`;
  // 同内容重复贴图：复用已有贴图窗（置顶提醒即可）
  const existing = await WebviewWindow.getByLabel(label).catch(() => null);
  if (existing) {
    await existing.show().catch(() => {});
    await existing.setFocus().catch(() => {});
    notifyIsland({ kind: 'success', text: t('snip.pinned') });
    return;
  }
  notifyIsland({ kind: 'success', text: t('snip.pinned') });
  // 窗口尺寸 = 裁剪图物理尺寸 / scale（钳制屏内 80%），位置 = 选区左上角
  const monitors = await getMonitors();
  const mon = monitors.find((mm) => p.x >= mm.position.x && p.x < mm.position.x + mm.size.width &&
    p.y >= mm.position.y && p.y < mm.position.y + mm.size.height);
  const monScale = mon?.scaleFactor || 1;
  const logicalW = p.w / monScale;
  const logicalH = p.h / monScale;
  const maxW = mon ? (mon.size.width / monScale) * 0.8 : logicalW;
  const maxH = mon ? (mon.size.height / monScale) * 0.8 : logicalH;
  // 关键：先注册 ready 监听再建窗（页面 mount 后立即 emit，后注册必丢握手——
  // 同 createIslandWindow 注释的时序教训）
  let ready = false;
  const unReady = await listen('snip-pin:ready', (ev) => {
    if ((ev.payload as string) !== label) return;
    ready = true;
    // dataUrl 随事件直达（贴图窗读盘链路同样不可靠，与覆盖窗同策略）
    void emitTo(label, 'snip-pin:data', { fileRef: crop.fileRef, dataUrl: crop.dataUrl }).catch(() => {});
    void pin?.show().catch(() => {});
  }).catch(() => null);
  const pin = new WebviewWindow(label, {
    url: `/snip-pin/${hash8}`,
    title: 'Snip Pin',
    width: Math.min(logicalW, maxW),
    height: Math.min(logicalH, maxH),
    x: p.x / monScale,
    y: p.y / monScale,
    resizable: true,
    decorations: false,
    transparent: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focus: false,
    shadow: false,
    visible: false,
    backgroundColor: [0, 0, 0, 0],
  });
  pinSessions.push(pin);
  pin.once('tauri://destroyed', () => {
    void safeUnlisten(unReady!);
    const i = pinSessions.indexOf(pin);
    if (i >= 0) pinSessions.splice(i, 1);
  });
  // 握手超时兜底：页面 8s 未就绪直接 show（透明窗，最坏短暂空白）
  setTimeout(() => {
    void safeUnlisten(unReady!);
    if (!ready) void pin.show().catch(() => {});
  }, 8000);
}
