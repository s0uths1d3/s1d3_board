import { ref, watch } from 'vue';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, cursorPosition, PhysicalPosition } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { readText } from 'tauri-plugin-clipboard-api';
import dbService from '~/src/db/dbService';
import { createBooleanSetting } from './useBooleanSetting';
import { isTauri } from '~/utils/env';

/**
 * 灵动岛提示：复制 / 粘贴时在屏幕顶部弹出的胶囊反馈（设置 → 通用 → 灵动岛提示）。
 * - 复制：双通道检测——快速通道（80ms 轻量轮询，仅灵动岛使用）+ dbService.saveClipboard
 *   派发的 'island:copy' 事件（驱动入库与图片复制），同内容短期去重不重复弹岛；
 * - 粘贴：pasteUtil 粘贴流程主动调用 notifyIslandPaste（写剪贴板前先 suppressIslandCopy，
 *   避免程序写入被剪贴板监听误报为"已复制"）；
 * - 开关：KV island_enabled（默认开）；关闭时本模块 watch 收起并关闭岛窗口。
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

export type IslandKind = 'copy' | 'copy-image' | 'paste' | 'info' | 'success' | 'error';

/** 弹岛载荷：kind 图标与默认标签 / title 自定义标签（API 调用） / durationMs 单次停留时长覆盖 */
export interface IslandShowPayload {
  kind: IslandKind;
  text?: string;
  title?: string;
  durationMs?: number;
}

const ISLAND_LABEL = 'clipboard-bubble-island';
const ISLAND_W = 360;
const ISLAND_H = 56;
/** 文本预览长度上限（页面内还会做单行 truncate） */
const PREVIEW_MAX = 120;

let islandWin: WebviewWindow | null = null;
let islandReady = false;
let suppressUntil = 0;
let inited = false;

// ===== 快速检测通道 =====
// 剪贴板插件原生 watcher（clipboard-rs）在 Windows 上以 200ms 停等轮询，检测平均 ~100ms、最差 ~200ms，
// 是灵动岛延迟的下限。这里叠加一条仅服务灵动岛的轻量轮询（只读文本、不写库、不影响数据层），
// 让文本复制在 ≤80ms 内触发胶囊；随后原生路径的 saveClipboard → island:copy（同内容）按内容去重跳过。
const ISLAND_POLL_MS = 80;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastPollText: string | null = null;
/** 最近一次由快速通道显示的复制内容（短期内同内容的原生事件不再重复弹岛） */
let lastShownCopy: { content: string; until: number } | null = null;

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
      lastShownCopy = { content: text, until: Date.now() + 900 };
      void showIsland({ kind: 'copy', text: text.slice(0, PREVIEW_MAX) });
    }).catch(() => { /* 非文本内容（图片等）读取失败：交给原生路径 */ });
  }, ISLAND_POLL_MS);
}

function stopIslandPoller(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  lastPollText = null;
  lastShownCopy = null;
}

/** 抑制"已复制"提示：本应用主动写剪贴板（粘贴流程）时调用 */
export function suppressIslandCopy(ms = 900): void {
  suppressUntil = Date.now() + ms;
}

/** 粘贴提示：显示"已粘贴"胶囊（pasteUtil 写剪贴板后调用） */
export function notifyIslandPaste(content: string, type: 'text' | 'image'): void {
  void showIsland({
    kind: 'paste',
    text: type === 'image' ? '' : String(content).slice(0, PREVIEW_MAX),
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

/** 单例复用：首次惰性创建，之后 show/hide（避免每次复制都新建 WebView） */
async function ensureIsland(): Promise<WebviewWindow | null> {
  if (islandWin) return islandWin;
  // 复用已存在的同名窗口：每个 webview 有独立 JS 上下文（便签等窗口调用本模块时 islandWin 必为 null），
  // HMR/重载也会丢失模块状态——此时重复创建同名窗口会触发 tauri://error 且 island:ready 不会重发，
  // 通知随之静默丢失。故先按 label 查找存活窗口直接接管（其页面早已就绪并注册了 island:show 监听）。
  const existing = await WebviewWindow.getByLabel(ISLAND_LABEL).catch(() => null);
  if (existing) {
    islandWin = existing;
    islandReady = true;
    return islandWin;
  }
  islandReady = false;

  // 关键：先注册 ready 监听再创建窗口，避免页面早于监听注册 emit 而丢失握手
  const unReady = await listen('island:ready', () => { islandReady = true; }).catch(() => null);
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
  win.once('tauri://error', () => {
    if (islandWin === win) islandWin = null;
  });

  // 等待岛页面 ready（最多 3s），确保 show 前事件监听已就绪
  const t0 = Date.now();
  while (!islandReady && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 40));
  }
  try { unReady?.(); } catch { /* ignore */ }
  return islandWin;
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
  const win = await ensureIsland();
  if (!win) return;
  try {
    await positionIsland(win);
  } catch { /* 定位失败用默认位置 */ }
  await emit('island:show', {
    kind: payload.kind,
    text: payload.text,
    title: payload.title,
    durationMs: payload.durationMs ?? islandDurationMs.value,
  }).catch(() => {});
}

let pendingShowTimer: ReturnType<typeof setTimeout> | null = null;

/** 弹岛（按设置的出现延迟排队；连续事件以最后一次为准），并把停留时长一并下发 */
async function showIsland(payload: IslandShowPayload): Promise<void> {
  if (!setting.enabled.value || !isTauri()) return;
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
  // 复制文本 / 复制图片：任何应用里 Ctrl+C 都会走到这里（saveClipboard 派发）。
  // 快速通道已显示的同一内容（900ms 内）不重复弹岛。
  window.addEventListener('island:copy', (ev) => {
    const d = (ev as CustomEvent<{ content: string; type: 'text' | 'image' }>).detail;
    if (!d || Date.now() < suppressUntil) return;
    if (d.type === 'text' && lastShownCopy && lastShownCopy.content === d.content && Date.now() < lastShownCopy.until) return;
    lastShownCopy = d.type === 'text' ? { content: d.content, until: Date.now() + 900 } : lastShownCopy;
    void showIsland(d.type === 'image'
      ? { kind: 'copy-image', text: d.content }
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
