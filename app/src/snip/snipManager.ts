import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors } from '@tauri-apps/api/window';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';
import { isTauri } from '~/utils/env';
import { join } from '@tauri-apps/api/path';
import { listen, emitTo, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { suppressIslandCopy, notifyIsland, notifySnipIsland } from '~/composables/useCopyIsland';
import { isPrivacyPaused } from '~/composables/usePrivacySettings';
import { useI18n } from '~/composables/useI18n';
import { saveSnipToHistory, suppressSnipCapture, suppressUseCountBump } from '../clipboard/clipboardListener';
import dbService from '../db/dbService';
import {
  ensureSnipSettingsLoaded,
  isSnipAutoCopy,
  isSnipAutoHistory,
  isSnipCaptureCursor,
  useSnipFormat,
  useSnipJpegQuality,
  useSnipSaveDir,
} from './snipSettings';

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
  /** 全分辨率引用就绪 promise（openSnip 时创建，full-ready 事件 resolve） */
  fullPromise: Promise<string>;
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
let pendingFull: { ts: number; resolve: (ref: string) => void } | null = null;

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
  await overlay?.hide().catch(() => {});
}

/** 唤起截图：先截屏后显示（顺序即正确性——自绘遮罩不入镜）。
 *  会话中再按 = 忽略（键盘连击/自动重复不再「开→取消→开」闪烁，用户实测反馈）；
 *  开启中的重复触发同样去重（截屏 200~300ms 窗口内的第二次按下不并发开两条会话）。 */
let opening = false;
export async function openSnip(): Promise<void> {
  if (snip || opening) return;
  opening = true;
  try {
    await openSnipInner();
  } finally {
    opening = false;
  }
}

async function openSnipInner(): Promise<void> {
  const ts = Date.now();
  // 子窗口显示瞬间豁免主窗口失焦连带（照 BubbleToggleCommand.openRing :194）
  (window as any).__childOpeningUntil = Date.now() + 600;

  // 1. 先截屏（物理像素；捕获光标按设置）。即时返回预览（≤2K 缩小快编），
  //    全分辨率 PNG 后台落盘经 snip:full-ready 补发——热路径不等它（打开慢的根因）。
  //    失败自动重试一次（GDI / 剪贴板插件锁的偶发竞争）
  const includeCursor = await isSnipCaptureCursor();
  const captureOnce = () => invoke<{ previewUrl: string; x: number; y: number; width: number; height: number } | null>(
    'snip_capture_screen',
    { includeCursor },
  ).catch(() => null);
  let cap = await captureOnce();
  if (!cap?.previewUrl) {
    await new Promise((r) => setTimeout(r, 120));
    cap = await captureOnce();
  }
  const { t } = useI18n();
  if (!cap?.previewUrl || !cap.previewUrl.startsWith('data:')) {
    notifyIsland({ kind: 'error', text: t('snip.capture_failed') });
    return;
  }
  // 2. 匹配显示器求 scale：capture 的 rect 与该屏 position/size 物理像素比对。
  //    容差 ±2px（个别驱动/虚拟屏上报的矩形有 1px 舍入差，精确相等会失配回退
  //    scale=1 导致多屏混合 DPI 坐标偏移——审查发现）
  const monitors = await getMonitors();
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  const m = monitors.find((mm) =>
    near(mm.position.x, cap.x) && near(mm.position.y, cap.y) &&
    near(mm.size.width, cap.width) && near(mm.size.height, cap.height));
  const scale = m?.scaleFactor || 1;

  // 3. 常驻窗移到目标显示器（物理像素直传，避免除法取整误差）→ 投数据 → 显示取焦
  // 全分辨率引用等待 promise：full-ready 事件 resolve（带会话纪元校验，防旧事件
  // 串会话）；8s 超时兜底拒绝（冷盘/大屏首编偶发慢，宽容到 8s 才判失败并清理
  // pendingFull——审查发现原 3.5s 硬失败 + 陈旧引用未清）
  let resolveFull!: (ref: string) => void;
  const fullPromise = new Promise<string>((resolve, reject) => {
    resolveFull = resolve;
    setTimeout(() => {
      if (pendingFull?.ts === ts) pendingFull = null;
      reject(new Error('full-timeout'));
    }, 8000);
  });
  pendingFull = { ts, resolve: resolveFull };
  snip = { ts, fileRef: null, fullPromise };
  const win = await ensureOverlay();
  if (!win) {
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
  }).catch(() => {});
  await win.show().catch(() => {});
  await win.setFocus().catch(() => {});
}

/** 绑定会话事件（常驻窗一次性）：cancel / confirm（确认含 pin 动作分流） */
async function bindSessionListeners(): Promise<void> {
  if (sessionListenersBound) return;
  sessionListenersBound = true;
  await listen('snip:cancel', () => { if (snip) void closeSnip(); });
  // 后台全分辨率落盘完成：按会话纪元校验后 resolve（旧会话的迟到事件丢弃）
  await listen<{ fileRef: string }>('snip:full-ready', (ev) => {
    const p = pendingFull;
    if (!p || !snip || snip.ts !== p.ts) return;
    pendingFull = null;
    snip.fileRef = ev.payload.fileRef;
    p.resolve(ev.payload.fileRef);
  });
  await listen('snip:confirm', (ev) => {
    const p = ev.payload as SnipConfirmPayload;
    if (!snip) return;
    const ts = snip.ts;
    if (p.action === 'pin') void pinSnip(p, ts);
    else void confirmSnip(p, ts);
  });
}

// 模块加载即预热（主窗口上下文）：会话监听先于常驻窗创建绑定（首秒热键也要能确认/取消），
// 设置项 + 常驻窗随后——热键路径零冷启动
if (isTauri() && getCurrentWindow().label === 'main') {
  void ensureSnipSettingsLoaded().catch(() => {});
  void bindSessionListeners();
  void ensureOverlay().catch(() => {});
}

/** 裁剪结果（写入系统剪贴板 / 入库 / 导出 / 贴图共用的中间产物） */
interface SnipCropResult {
  fileRef: string;
  thumb: string | null;
  qrText: string | null;
  /** 裁剪图原图 data URL（贴图窗显示直达用） */
  dataUrl: string;
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
  await closeSnip(); // ① 先关覆盖窗（焦点归还目标应用）
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

  // ③ 保存到文件：与复制互斥动作（裁剪产物经导出后由磁盘清理回收孤儿文件）
  if (p.action === 'save') {
    await exportToFile(crop, t);
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
  }
}

/** 保存到文件：默认目录 → 保存对话框 → Rust 导出（png 直拷 / jpeg 重编码） */
async function exportToFile(crop: SnipCropResult, t: (k: string, p?: Record<string, string | number>) => string): Promise<void> {
  const fmt = useSnipFormat().value;
  const dir = useSnipSaveDir().value;
  const ext = fmt === 'jpeg' ? 'jpeg' : 'png';
  const name = `Snip_${stamp()}.${ext}`;
  const defaultPath = dir ? await join(dir, name).catch(() => name) : name;
  const path = await saveDialog({
    defaultPath,
    filters: [{ name: fmt === 'jpeg' ? 'JPEG' : 'PNG', extensions: [ext] }],
  }).catch(() => null);
  if (!path) return; // 用户取消
  const quality = useSnipJpegQuality().value;
  await invoke('snip_export_file', { fileRef: crop.fileRef, destPath: path, format: ext, quality }).then(
    () => notifyIsland({ kind: 'success', text: t('snip.saved', { path }) }),
    () => notifyIsland({ kind: 'error', text: t('snip.save_failed') }),
  );
}

/** 文件名时间戳：Snip_20261024_153000 */
function stamp(): string {
  const d = new Date();
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ===== P1-T2 贴图（snip-pin 窗口）：与 confirmSnip 同构，落地于 P1 批次 =====
const pinSessions: WebviewWindow[] = [];

/** 贴图：裁剪结果以置顶小窗钉在桌面（会话级，不持久化；双击关闭）。 */
async function pinSnip(p: SnipConfirmPayload, ts: number): Promise<void> {
  const session = snip;
  if (!session || session.ts !== ts) return;
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
