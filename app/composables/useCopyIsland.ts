import { ref, watch } from 'vue';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, cursorPosition, getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { readImageBase64, readText } from 'tauri-plugin-clipboard-api';
import dbService from '~/src/db/dbService';
import statsService from '~/src/statistics/statsService';
import { createBooleanSetting } from './useBooleanSetting';
import { isTauri } from '~/utils/env';

/**
 * 灵动岛提示：复制 / 粘贴时在屏幕顶部弹出的胶囊反馈（设置 → 通用 → 灵动岛提示）。
 * - 复制：双通道检测——快速通道（80ms 轻量轮询，仅灵动岛使用）+ dbService.saveClipboard
 *   派发的 'island:copy' 事件（驱动入库与图片复制），同内容短期去重不重复弹岛；
 * - 粘贴：pasteUtil 粘贴流程主动调用 notifyIslandPaste（写剪贴板前先 suppressIslandCopy，
 *   避免程序写入被剪贴板监听误报为"已复制"）；
 * - 开关：KV island_enabled（默认开）；关闭时本模块 watch 收起并关闭岛窗口、停掉快速通道——
 *   仅关闭显示，历史落库/剪切统计/出站推送（Webhook/SSE）不受开关影响照常工作。
 * - API：Rust 侧灵动岛 API（island_api.rs，接入文档 .docs/island-api.md）转发的第三方显示
 *   请求走 island-api:show → 同一 showIsland 链路（kind/title/durationMs 可由调用方指定）。
 * - 时机：出现延迟（KV island_delay_ms，默认 0 即显）与停留时长（KV island_duration_ms，
 *   默认 1800ms）可在设置页自由输入（毫秒，范围钳制）；延迟期间连续事件以最后一次为准，
 *   时长随 island:show 下发。
 * 窗口单例 clipboard-bubble-island（命中 clipboard-bubble-* 能力通配），启动时预创建、之后常驻复用；
 * 页面路由 /bubble?mode=island，窗口的 show/hide 由页面自身控制（含胶囊动画与超时自动隐藏）。
 * 胶囊配色使用主题 token（bg-surface/ink/line），由 colorScheme 插件在岛窗口内自动同步配色。
 */

const setting = createBooleanSetting('island_enabled', true);

/** 设置页绑定：灵动岛开关（共享同一状态源） */
export function useIslandEnabled() {
  const islandEnabled = setting.useSetting();
  return { islandEnabled };
}

/** 持久化开关状态（设置页切换时调用；关闭由模块级 watch 收尾） */
export async function setIslandEnabled(v: boolean): Promise<void> {
  await setting.persist(v);
}

// ===== 出现延迟 / 停留时长（KV 持久化，设置页自由输入毫秒值；未设置/非法输入回落默认值） =====
export const ISLAND_DELAY_DEFAULT = 0;
export const ISLAND_DURATION_DEFAULT = 1800;
/** 输入范围钳制：延迟 0–10s，停留 0.6s–60s（低于 0.6s 胶囊几乎不可见） */
export const ISLAND_DELAY_MIN = 0;
export const ISLAND_DELAY_MAX = 10000;
export const ISLAND_DURATION_MIN = 600;
export const ISLAND_DURATION_MAX = 60000;
const ISLAND_DELAY_KEY = 'island_delay_ms';
const ISLAND_DURATION_KEY = 'island_duration_ms';

const islandDelayMs = ref(ISLAND_DELAY_DEFAULT);
const islandDurationMs = ref(ISLAND_DURATION_DEFAULT);

function sanitizeIslandDelay(v: number): number {
  if (!Number.isFinite(v)) return ISLAND_DELAY_DEFAULT;
  return Math.min(ISLAND_DELAY_MAX, Math.max(ISLAND_DELAY_MIN, Math.round(v)));
}
function sanitizeIslandDuration(v: number): number {
  if (!Number.isFinite(v)) return ISLAND_DURATION_DEFAULT;
  return Math.min(ISLAND_DURATION_MAX, Math.max(ISLAND_DURATION_MIN, Math.round(v)));
}

/** 灵动岛出现延迟 / 停留时长（单例 ref，设置页与岛窗口流程共享同一状态源） */
export function useIslandTiming() {
  ensureIslandTimingLoaded();
  return { islandDelayMs, islandDurationMs };
}

let timingLoadPromise: Promise<void> | null = null;

/** 触发首次加载（幂等）并等待落定：resolve 后两个 ref 即为真实持久化值 */
export function ensureIslandTimingLoaded(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (!timingLoadPromise) {
    timingLoadPromise = Promise.all([
      dbService.getKeyValue(ISLAND_DELAY_KEY).catch(() => null),
      dbService.getKeyValue(ISLAND_DURATION_KEY).catch(() => null),
    ]).then(([d, u]) => {
      if (d && d.trim()) islandDelayMs.value = sanitizeIslandDelay(Number(d));
      if (u && u.trim()) islandDurationMs.value = sanitizeIslandDuration(Number(u));
    });
  }
  return timingLoadPromise;
}

/** 设置出现延迟（毫秒，自动钳制到合法范围）并持久化（设置页调用） */
export async function setIslandDelayMs(v: number): Promise<void> {
  islandDelayMs.value = sanitizeIslandDelay(v);
  try { await dbService.setKeyValue(ISLAND_DELAY_KEY, String(islandDelayMs.value)); } catch { /* 写入失败不影响本次会话 */ }
}

/** 设置停留时长（毫秒，自动钳制到合法范围）并持久化（设置页调用） */
export async function setIslandDurationMs(v: number): Promise<void> {
  islandDurationMs.value = sanitizeIslandDuration(v);
  try { await dbService.setKeyValue(ISLAND_DURATION_KEY, String(islandDurationMs.value)); } catch { /* 写入失败不影响本次会话 */ }
}

export type IslandKind = 'copy' | 'copy-image' | 'cut' | 'paste' | 'info' | 'success' | 'error' | 'loading';

/** 弹岛载荷：kind 图标与默认标签 / title 自定义标签（API 调用） / durationMs 单次停留时长覆盖 /
 *  sticky 驻留（过程提示：不按时长收回，直到下一条岛替换；页面侧有兜底超时防残留） /
 *  image 图片内容（data URL，粘贴/剪切图片事件携带，岛内胶囊渲染缩略图，与复制图片一致） /
 *  qrText 图片中识别出的二维码文本（链接等）：胶囊文本直接显示链接，出站事件走 qr_text 字段 */
export interface IslandShowPayload {
  kind: IslandKind;
  text?: string;
  image?: string;
  qrText?: string;
  /** 岛显示级缩略图（Rust 侧剪贴板位图直接 resize，几十 KB）：岛 UI 优先渲染它提速，
   *  出站事件（SSE/Webhook）仍发 image 原图；缺省回退 image 原图渐进渲染 */
  thumb?: string;
  title?: string;
  durationMs?: number;
  sticky?: boolean;
}

const ISLAND_LABEL = 'clipboard-bubble-island';
const ISLAND_W = 360;
const ISLAND_H = 56;
/** 文本预览长度上限（页面内还会做单行 truncate） */
const PREVIEW_MAX = 120;

let islandWin: WebviewWindow | null = null;
let islandReady = false;
let islandCreating: Promise<WebviewWindow | null> | null = null;
let suppressUntil = 0;
let inited = false;

// ===== 快速检测通道 =====
// 剪贴板插件原生 watcher（clipboard-rs）在 Windows 上以 200ms 停等轮询，检测平均 ~100ms、最差 ~200ms，
// 是灵动岛延迟的下限。这里叠加一条仅服务灵动岛的轻量轮询（只读文本、不写库、不影响数据层），
// 让文本复制在 ≤80ms 内触发胶囊；随后原生路径的 saveClipboard → island:copy（同内容）按内容去重跳过。
const ISLAND_POLL_MS = 80;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastPollText: string | null = null;
/** 最近一次由快速通道显示的复制内容（短期内同内容的原生事件不再重复弹岛；文本与图片均生效——
 *  图片路径监听回调先行派发带缩略图的岛事件，saveClipboard 写库后的二次派发据此去重） */
let lastShownCopy: { type: 'text' | 'image'; content: string; until: number } | null = null;

function startIslandPoller(): void {
  if (pollTimer || !isTauri()) return;
  // 记录起点文本，避免启动瞬间把既有剪贴板内容当新复制
  void readText().then((t) => { lastPollText = t ?? ''; }).catch(() => { lastPollText = ''; });
  pollTimer = setInterval(() => {
    void readText().then((t) => {
      const text = t ?? '';
      const changed = text !== lastPollText;
      lastPollText = text;
      if (!changed || !text || Date.now() < suppressUntil) return;
      lastShownCopy = { type: 'text', content: text, until: Date.now() + 900 };
      // Ctrl+X 感知窗口内的剪贴板变化按"已剪切"提示（一次性消费，避免窗口内后续复制误标）
      void showIsland({ kind: consumeCut() ? 'cut' : 'copy', text: text.slice(0, PREVIEW_MAX) });
    }).catch(() => { /* 非文本内容（图片等）读取失败：交给原生路径 */ });
  }, ISLAND_POLL_MS);
}

function stopIslandPoller(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  lastPollText = null;
  lastShownCopy = null;
  cutUntil = 0;
}

/** 抑制"已复制"提示：本应用主动写剪贴板（粘贴流程）时调用 */
export function suppressIslandCopy(ms = 900): void {
  suppressUntil = Date.now() + ms;
}

/** base64/带前缀 data URL 归一为带 data: 前缀的 data URL（无前缀时浏览器会把它当相对路径请求 dev server） */
function normalizeImageDataUrl(src: string): string {
  return src.startsWith('data:') ? src : `data:image/png;base64,${src}`;
}

/** 粘贴提示：显示"已粘贴"胶囊（pasteUtil 写剪贴板后调用）。
 *  图片粘贴携带 image（data URL），岛内胶囊渲染缩略图（与复制图片一致，悬停可放大预览） */
export function notifyIslandPaste(content: string, type: 'text' | 'image'): void {
  void showIsland({
    kind: 'paste',
    text: type === 'image' ? '' : String(content).slice(0, PREVIEW_MAX),
    image: type === 'image' ? normalizeImageDataUrl(String(content)) : undefined,
  });
}

/**
 * 通用反馈弹岛：各窗口内 toast（主窗口 pinnedHint / 便签 / 设置页 hint）统一迁移至此。
 * 三者均为主窗口内组件（同一 webview），直接调用 showIsland；kind 决定图标与标签
 * （success/info/error），text 显示具体消息，可省略（仅显示 kind 默认标签）。
 */
export function notifyIsland(payload: IslandShowPayload): void {
  void showIsland(payload);
}

// ===== 全局粘贴感知（Rust 全局 Ctrl+V 钩子 → island:paste-detected）=====
// 用户在任意应用按 Ctrl+V 粘贴时：文本/图片内容随岛事件下发（与复制一致渲染缩略图/预览），
// 并按文本精确匹配剪贴板历史 +1 使用次数（图片 base64 编码不稳定，无法可靠匹配，不计数）。
// 不受灵动岛总开关门控：开关只关显示，使用计数与出站推送（Webhook/SSE）始终工作。
// 应用自身粘贴流程由 Rust 侧 PASTE_INJECTING 抑制标志拦截（不 emit），不会重复计数/弹岛
listen('island:paste-detected', () => {
  // 仅主窗口上下文响应：岛链路（检测/写入/窗口管理）为单上下文设计，
  // 全局广播会被每个加载本模块的 webview 收到，不限制会重复弹岛、重复写历史、重复计数
  if (getCurrentWindow().label !== 'main') return;
  void (async () => {
    let text = '';
    let image: string | undefined;
    let thumb: string | undefined;
    let qrText: string | undefined;
    try { text = (await readText()) ?? ''; } catch { /* 图片等非文本：转图片读取 */ }
    if (!text) {
      try {
        const base64 = await readImageBase64();
        if (base64) {
          image = normalizeImageDataUrl(base64);
          // 显示级缩略图（Rust 侧剪贴板位图直接 resize）+ 二维码识别（缩略命令顺带扫描）：粘贴图片岛显示与大图解码解耦
          try {
            const info = await invoke<{ thumb: string | null; qrText: string | null } | null>('clipboard_image_thumb', { maxH: 384 });
            thumb = info?.thumb ?? undefined;
            qrText = info?.qrText ?? undefined;
          } catch { /* 非 Windows/命令失败：回退原图渲染 */ }
          if (!thumb && !qrText) {
            // 缩略命令不可用（非 Windows）或剪贴板读取冲突：纯 Rust data URL 解码兜底二维码
            try { qrText = (await invoke<string | null>('clipboard_qr_from_data_url', { dataUrl: image })) ?? undefined; } catch { /* ignore */ }
          }
        }
      } catch { /* 无图片或读取失败：image 保持空 */ }
    }
    // 有效性判定（三平台统一）：文本与图片都为空 = 剪贴板无内容可贴，粘贴必然无效——
    // 不计数、不弹岛（Windows/macOS/Linux 检测事件均汇聚于此；Linux 拦截路径的按键
    // 转发在 Rust 侧独立执行，不受此处 return 影响）。剪贴板非空但目标应用无可粘贴
    // 目标（如焦点在桌面）属系统层不可判定，维持按下即提示的语义
    if (!text && !image) return;
    if (text) void dbService.increaseUseCountByContent(text).catch(() => {});
    // 二维码图片：链接作为胶囊文本显示（缩略图仍在，并存渲染）；使用计数只看剪贴板文本，不受链接影响
    void showIsland({ kind: 'paste', text: (qrText ?? text).slice(0, PREVIEW_MAX), image, thumb, qrText });
  })();
}).catch(() => {});

// ===== 全局剪切感知（Rust 全局 Ctrl+X / Cmd+X 钩子 → island:cut-detected）=====
// Ctrl+X 的剪贴板写入与复制无法区分：钩子事件只标记感知窗口（1.5s，一次性消费），
// 窗口内剪贴板真实变化（快速通道 / 原生 island:copy，文本与图片均可）才弹"已剪切"——
// 无选区剪切失败（剪贴板未变）不弹岛不误报。不受总开关门控（剪切统计/出站推送始终工作）
const CUT_WINDOW_MS = 1500;
let cutUntil = 0;
/** 感知窗口内则消费一次剪切标记（一次性：一次 Ctrl+X 只对应一次剪贴板写入） */
function consumeCut(): boolean {
  if (Date.now() >= cutUntil) return false;
  cutUntil = 0;
  return true;
}
listen('island:cut-detected', () => {
  if (getCurrentWindow().label !== 'main') return;
  cutUntil = Date.now() + CUT_WINDOW_MS;
}).catch(() => {});

// 关闭开关时收起并关闭岛窗口、停掉快速通道；开启时反向恢复（模块级 watch：与设置页共享同一状态源）
watch(setting.enabled, (v) => {
  if (v) {
    void ensureIsland();
    startIslandPoller();
  } else {
    if (pendingShowTimer) { clearTimeout(pendingShowTimer); pendingShowTimer = null; }
    stopIslandPoller();
    closeIsland();
  }
});

// 出现延迟 / 停留时长：模块级加载（isTauri 内部守卫），弹出流程读取共享 ref
useIslandTiming();

function closeIsland(): void {
  void islandWin?.close().catch(() => {});
  islandWin = null;
  islandReady = false;
}

/**
 * 图片缩略图生成：data URL 原图 → 高 maxH 像素的 webp 小图（保透明、体积小）。
 * 两处消费：岛显示/历史落库（默认 56px 历史档）与岛显示级缩略图（384px，跨窗口广播提速）。
 * 解码/绘制失败时 reject，由调用方兜底。
 */
export function makeImageThumb(dataUrl: string, maxH = 56, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxH / Math.max(1, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('canvas 2d context unavailable')); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/webp', quality));
      } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    };
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = dataUrl;
  });
}

/** 单例复用：首次惰性创建，之后 show/hide（避免每次复制都新建 WebView） */
async function ensureIsland(): Promise<WebviewWindow | null> {
  // 就绪快路径：窗口引用有效且页面已注册 island:show 监听
  if (islandWin && islandReady) return islandWin;
  // 创建中（含 ready 未到）：并发调用共享同一创建 Promise，
  // 全部等到 ready 才放行——否则后来者拿到未就绪引用，emit 打进尚未监听的页面静默丢失
  if (islandCreating) return islandCreating;

  const existing = await WebviewWindow.getByLabel(ISLAND_LABEL).catch(() => null);
  if (existing) {
    // 复用已存在的同名窗口：每个 webview 有独立 JS 上下文（便签等窗口调用本模块时 islandWin 必为 null），
    // HMR/重载也会丢失模块状态——此时重复创建同名窗口会触发 tauri://error 且 island:ready 不会重发，
    // 通知随之静默丢失。故先按 label 查找存活窗口直接接管（其页面早已就绪并注册了 island:show 监听）。
    islandWin = existing;
    islandReady = true;
    return islandWin;
  }
  islandCreating = createIslandWindow().finally(() => { islandCreating = null; });
  return islandCreating;
}

/** 创建岛窗口并等待页面 ready（串行化：同一时刻最多一个创建流程在跑） */
async function createIslandWindow(): Promise<WebviewWindow | null> {
  islandReady = false;
  let ready = false;
  let failed = false;
  // 关键：先注册 ready 监听再创建窗口，避免页面早于监听注册 emit 而丢失握手
  const unReady = await listen('island:ready', () => { ready = true; }).catch(() => null);
  const win = new WebviewWindow(ISLAND_LABEL, {
    url: '/bubble?mode=island',
    title: 'Island',
    width: ISLAND_W,
    height: ISLAND_H,
    resizable: false,
    decorations: false,
    transparent: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focus: false,
    shadow: false,
    visible: false,
  });
  islandWin = win;
  win.once('tauri://error', () => { failed = true; });

  // 等待岛页面 ready（最多 3s）；失败立即短路，不空转
  const t0 = Date.now();
  while (!ready && !failed && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 40));
  }
  try { unReady?.(); } catch { /* ignore */ }
  if (ready) {
    islandReady = true;
    return win;
  }
  // 创建失败/超时：清引用允许下次调用重试（getByLabel/新建），绝不返回未就绪窗口
  if (islandWin === win) islandWin = null;
  return null;
}

/** 顶部居中（光标所在显示器）定位岛窗口 */
async function positionIsland(win: WebviewWindow): Promise<void> {
  const [cursor, monitors] = await Promise.all([cursorPosition(), availableMonitors()]);
  const m = monitors.find((mm) => {
    const { x, y } = mm.position;
    return cursor.x >= x && cursor.x < x + mm.size.width && cursor.y >= y && cursor.y < y + mm.size.height;
  }) ?? monitors[0];
  if (!m) return;
  // 物理像素定位：多显示器混用 DPI 时按目标显示器缩放窗口尺寸，避免逻辑坐标错位
  const scale = m.scaleFactor || 1;
  const wPhys = Math.round(ISLAND_W * scale);
  const x = m.position.x + Math.round((m.size.width - wPhys) / 2);
  const y = m.position.y + Math.round(12 * scale);
  await win.setPosition(new PhysicalPosition(x, y));
}

/** 顶部居中（光标所在显示器）定位岛窗口并推送内容；窗口显隐与动画由页面控制 */
async function emitIslandShow(payload: IslandShowPayload): Promise<void> {
  // 显示链路（总开关开启时）：确保窗口就绪并定位；关闭时跳过建窗——
  // 总开关只关显示，下方历史/统计/出站事件（island:show → Rust 桥 → SSE/Webhook）始终工作
  if (setting.enabled.value) {
    const win = await ensureIsland();
    if (win) {
      try {
        await positionIsland(win);
      } catch {
        // 定位失败 = 窗口引用已失效（被外部关闭/系统回收）：重置状态让下次调用走重建，
        // 本次放弃显示（emit 打进死窗口必丢）；事件本身（历史/统计/出站）不受影响
        if (islandWin === win) { islandWin = null; islandReady = false; }
      }
    }
  }
  // 图片内容统一收敛：复制/粘贴/剪切图片事件统一在 image 字段携带原图 data URL
  // （二维码链接走 text/qrText，不再借道 text 传原图）——出站事件统一走 image
  const imgData = payload.image;
  // 岛显示用缩略图（Rust 侧剪贴板位图直接 resize 产出，几十 KB）；复制/剪切路径由
  // 剪贴板监听附带，缺失时回退原图（数 MB 整包广播是复杂图片慢的根因，但保证能显示）。
  // 生成缩略图不在此处 await——对大 PNG 前端解码+编码要数百 ms，反拖慢显示
  const displayImage = payload.thumb ?? imgData;
  // 历史记录：事件发生即写入（全部来源汇聚点），失败静默（不影响弹岛）。
  // loading 过程岛（AI 解析中）不落历史——它只是瞬时过程态，结果岛才值得回溯；
  // 图片事件的 data URL 不直接落历史库——后台降采样为小缩略图（webp 高 56px）再写入，
  // 生成失败写空串兜底，历史窗口按类型显示「[图片]」占位（不阻塞岛显示）
  if (payload.kind !== 'loading') {
    if (imgData) {
      const kind = payload.kind;
      void makeImageThumb(imgData)
        .then((t) => dbService.insertIslandHistory({ kind, text: t }))
        .catch(() => dbService.insertIslandHistory({ kind, text: '' }))
        .catch(() => {});
    } else {
      void dbService.insertIslandHistory({
        kind: payload.kind,
        text: payload.text ?? payload.title ?? '',
      }).catch(() => {});
    }
  }
  // 统计埋点：剪切成功 1 次（daily_stat.clip_cut）——在事件发生时记，延迟排队中被
  // 后续事件丢弃的 payload 不计（快速通道 / 原生事件双路径已由 consumeCut 一次性去重）
  if (payload.kind === 'cut') {
    void statsService.record({ clip_cut: 1 }).catch(() => {});
  }
  // 岛显示事件（小 payload：缩略图）：先发显示再发出站，出站大图序列化不拖慢岛弹出。
  // text 直接透传：二维码图片事件在生产端已把链接写入 text（胶囊与缩略图并存渲染）
  await emit('island:show-ui', {
    kind: payload.kind,
    text: payload.text,
    image: displayImage,
    title: payload.title,
    durationMs: payload.durationMs ?? islandDurationMs.value,
    sticky: payload.sticky ?? false,
  }).catch(() => {});
  // 出站事件（Rust 桥 → SSE/Webhook 广播，image 保持原图语义）：uiHandled 标记岛窗口跳过
  // 本次显示（显示已由 show-ui 负责，否则岛要重复接收并解码数 MB 原图）；
  // Rust 桥 json! 白名单构造天然剥离该标记，出站载荷不含实现细节。
  // qr_text：图片事件解码出的二维码文本（API v1.4.0 新增）；copy-image 的 text 维持 null
  // 语义（v1.3.0：图片事件文本不携带内容，链接走 qr_text 字段）
  await emit('island:show', {
    kind: payload.kind,
    text: payload.kind === 'copy-image' ? undefined : payload.text,
    image: imgData,
    qr_text: payload.qrText,
    title: payload.title,
    durationMs: payload.durationMs ?? islandDurationMs.value,
    sticky: payload.sticky ?? false,
    uiHandled: true,
  }).catch(() => {});
}

let pendingShowTimer: ReturnType<typeof setTimeout> | null = null;

/** 弹岛（按设置的出现延迟排队；连续事件以最后一次为准），并把停留时长一并下发。
 *  不受灵动岛总开关门控：开关关闭时事件照常入历史/统计/出站推送，仅不建窗显示 */
async function showIsland(payload: IslandShowPayload): Promise<void> {
  if (!isTauri()) return;
  if (pendingShowTimer) { clearTimeout(pendingShowTimer); pendingShowTimer = null; }
  if (islandDelayMs.value <= 0) {
    await emitIslandShow(payload);
    return;
  }
  pendingShowTimer = setTimeout(() => {
    pendingShowTimer = null;
    void emitIslandShow(payload);
  }, islandDelayMs.value);
}

/** 主窗口初始化（app.vue 调用）：挂复制事件监听驱动灵动岛，并在开启时预创建岛窗口 */
export function initCopyIsland(): void {
  if (inited || !isTauri()) return;
  inited = true;
  // 复制文本 / 复制图片：任何应用里 Ctrl+C 都会走到这里（saveClipboard 派发；
  // 图片路径监听回调先行派发带缩略图的版本，写库后 saveClipboard 的二次派发按内容去重跳过）。
  // 快速通道已显示的同一内容（900ms 内）不重复弹岛（文本与图片均去重）
  window.addEventListener('island:copy', (ev) => {
    const d = (ev as CustomEvent<{ content: string; type: 'text' | 'image'; thumb?: string | null; qrText?: string | null }>).detail;
    if (!d || Date.now() < suppressUntil) return;
    if (lastShownCopy && lastShownCopy.type === d.type && lastShownCopy.content === d.content && Date.now() < lastShownCopy.until) return;
    // Ctrl+X 感知窗口内的剪贴板变化（文本与图片均可）按"已剪切"提示（快速通道已显示的同一文本内容已被上方去重跳过）
    const cut = consumeCut();
    lastShownCopy = { type: d.type, content: d.content, until: Date.now() + 900 };
    // 二维码图片：链接写入 text（胶囊文本与缩略图并存）并随 qrText 出站；无识别结果维持纯图片语义
    const qr = d.qrText || undefined;
    void showIsland(cut
      ? {
          kind: 'cut',
          text: d.type === 'text' ? d.content.slice(0, PREVIEW_MAX) : (qr ?? ''),
          image: d.type === 'image' ? d.content : undefined,
          thumb: d.type === 'image' && d.thumb ? d.thumb : undefined,
          qrText: d.type === 'image' ? qr : undefined,
        }
      : d.type === 'image'
        ? { kind: 'copy-image', text: qr, image: d.content, thumb: d.thumb ?? undefined, qrText: qr }
        : { kind: 'copy', text: d.content.slice(0, PREVIEW_MAX) });
  });
  // 灵动岛 API：Rust 侧 HTTP 服务（island_api.rs）转发的第三方显示请求。
  // kind 由 Rust 校验过，此处再防御性收敛；durationMs>0 时单次覆盖停留时长（钳制到合法范围）。
  void listen<{ text?: string; kind?: string; title?: string; duration?: number }>('island-api:show', (ev) => {
    const p = ev.payload;
    if (!p || typeof p.text !== 'string' || !p.text) return;
    const kinds: IslandKind[] = ['copy', 'paste', 'info', 'success', 'error'];
    void showIsland({
      kind: kinds.includes(p.kind as IslandKind) ? (p.kind as IslandKind) : 'info',
      text: p.text.slice(0, PREVIEW_MAX),
      title: typeof p.title === 'string' && p.title ? p.title.slice(0, 24) : undefined,
      durationMs: typeof p.duration === 'number' && p.duration > 0
        ? Math.min(ISLAND_DURATION_MAX, Math.max(ISLAND_DURATION_MIN, p.duration))
        : undefined,
    });
  }).catch(() => {});
  // 状态落定后若开启则预创建岛窗口并启动快速检测通道：
  // 首次复制无需等建窗（约 1s 延迟 → 0），文本复制检测 ≤80ms，整链路 ≤0.2s
  void setting.ensureLoaded().then(() => {
    if (!setting.enabled.value) return;
    startIslandPoller();
    void ensureIsland().then((win) => {
      // 预热定位 IPC 链路（首次查询较慢），让真正复制时只做一次定位
      if (win) void positionIsland(win).catch(() => {});
    });
  });
}

const HISTORY_LABEL = 'island-history';
let historyToggleBusy = false;

/**
 * 打开（或聚焦）灵动岛历史窗口（标题栏图标调用，单例）：
 * - 已存在 → 聚焦置前；不存在 → 创建（focus:true 独立前台窗口，主窗口失焦时
 *   tryHideMainWindow 的 childFocused 豁免生效，不会连带隐藏/关闭本窗口）
 * - 主窗口若处于置顶状态，新窗口跟随置顶（syncChildOnTop 同款逻辑）
 */
export async function toggleIslandHistoryWindow(): Promise<void> {
  if (!isTauri() || historyToggleBusy) return;
  historyToggleBusy = true;
  try {
    const existing = await WebviewWindow.getByLabel(HISTORY_LABEL).catch(() => null);
    if (existing) {
      // 聚焦瞬间主窗口失焦：标记子窗口豁免期。Windows 下窗口切前台但 focused 状态未就绪时，
      // tryHideMainWindow 会误判"无子窗口持有焦点"而连带隐藏（image-viewer 同款竞态）
      (window as any).__childOpeningUntil = Date.now() + 600;
      await existing.show().catch(() => {});
      await existing.unminimize().catch(() => {});
      await existing.setFocus().catch(() => {});
      return;
    }
    // 创建期豁免（tooltip/viewer 同款）：新窗口就绪并持焦点前主窗口已失焦，
    // 若不豁免，tryHideMainWindow 的"关闭所有可见子窗口"循环会把刚创建的历史窗口一并关闭
    (window as any).__childOpeningUntil = Date.now() + 600;
    const win = new WebviewWindow(HISTORY_LABEL, {
      url: '/island-history',
      title: 'Island History',
      width: 440,
      height: 600,
      minWidth: 360,
      minHeight: 420,
      center: true,
      resizable: true,
      // 主窗口同款：无边框透明窗口，页面自绘标题栏（drag-region 拖拽 + 窗口控制按钮）
      decorations: false,
      transparent: true,
      focus: true,
      visible: true,
    });
    void win.once('tauri://created', async () => {
      // 窗口已创建，延长豁免期至其稳定聚焦（viewer 同款），避免创建期间的失焦误触发隐藏
      (window as any).__childOpeningUntil = Date.now() + 400;
      try {
        if (await getCurrentWindow().isAlwaysOnTop()) await win.setAlwaysOnTop(true);
      } catch { /* 主窗口置顶状态查询失败不跟随 */ }
    });
  } finally {
    setTimeout(() => { historyToggleBusy = false; }, 400);
  }
}
