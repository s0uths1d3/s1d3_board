import type { Command } from '../Command';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, cursorPosition } from '@tauri-apps/api/window';
import { listen, emit, emitTo, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from 'tauri-plugin-clipboard-api';
import { getSmartClipEntries, parseClipItem } from '../../smart-clip/smartClip';
import { planAnalysis, type AnalysisOutcome, type AnalysisPlan } from '../../smart-clip/analysis';
import { normalizeSegments, mergeAiSegments, type RingSegment } from '../../smart-clip/ringSegments';
import type { ClipboardData } from '../../entities';
import { recordPaste, recordAiAdoption } from '../../smart-clip/habitProfile';
import { getSelectedItem } from './clipboardStore';
import { notifyIsland, notifyIslandPaste, suppressIslandCopy } from '~/composables/useCopyIsland';
import { useI18n } from '~/composables/useI18n';
import { classifyAiError } from '~/utils/aiError';
import { hashText } from '~/utils/hash';
import dbService from '../../db/dbService';

/**
 * Ctrl+B 环形片段盘（设计文档 §4.4，单窗口版）。
 *
 * 整环（环心控制盘 + 环绕气泡）收口在一只透明 overlay 窗口（components/ring/RingOverlay），
 * 选中 / 导航 / 翻页 / 键盘由页面自治；本命令只负责开关生命周期、解析与 AI 两阶段管线、
 * 写剪贴板 + 模拟粘贴、习惯落库等需要主窗口上下文的副作用。
 *
 * 两阶段上屏：阶段一本地拆分完成即推数据显示（不等 AI）；阶段二 AI 分析完成后把去重
 * 后的新增片段推给页面补位上环。每次会话以 ts 为纪元，await 恢复后先校验 epochAlive，
 * 环被关闭后旧异步流程立即失效。
 */

/** overlay 窗口逻辑尺寸：恰好容纳 8 槽位环（页面按窗口实际尺寸自适应布点） */
const OVERLAY_W = 920;
const OVERLAY_H = 640;
/** ready 握手超时：页面加载异常时放弃开环，不留无响应的幽灵环 */
const READY_TIMEOUT_MS = 8000;

interface RingSession {
  /** 会话纪元：每次开环取时间戳，旧异步流程据此自我失效 */
  ts: number;
  overlay: WebviewWindow;
  unlisteners: UnlistenFn[];
}

let ring: RingSession | null = null;

export class BubbleToggleCommand implements Command {
  async execute(event?: { state: string }): Promise<void> {
    if (event?.state !== 'Pressed') return;
    if (ring) {
      await closeRing(); // toggle off（粘贴后环已销毁，重按即全新开环）
      return;
    }
    await openRing();
  }
}

function epochAlive(ts: number): boolean {
  return !!ring && ring.ts === ts;
}

/** 延迟解绑：Tauri 2.11 的 listen 注册脚本走 webview eval 宏任务队列，listen 返回后
 *  立即解绑会因注册尚未执行而抛 unhandled rejection 且泄漏；先 yield 一次宏任务。 */
async function safeUnlisten(u: UnlistenFn): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  try { await u(); } catch { /* ignore */ }
}

/** 整体关闭：销毁 overlay + 解绑监听（幂等，重入安全） */
async function closeRing(): Promise<void> {
  const current = ring;
  ring = null;
  // 解除主窗口失焦自动隐藏的豁免（app.vue tryHideMainWindow 据此跳过连带隐藏）
  (window as any).__ringActive = false;
  if (!current) return;
  current.unlisteners.forEach((u) => { void safeUnlisten(u); });
  void current.overlay.close().catch(() => {});
}

/** 光标所在显示器正中（逻辑坐标，不跟随鼠标） */
async function ringCenter(): Promise<{ cx: number; cy: number; monitor: { w: number; h: number } }> {
  const FALLBACK = { cx: 200, cy: 200, monitor: { w: 1920, h: 1080 } };
  try {
    const [cursor, monitors] = await Promise.all([cursorPosition(), availableMonitors()]);
    const inside = monitors.find((m) => {
      const { x, y } = m.position;
      return cursor.x >= x && cursor.x < x + m.size.width && cursor.y >= y && cursor.y < y + m.size.height;
    }) ?? monitors[0];
    if (!inside) return FALLBACK;
    const scale = inside.scaleFactor || 1;
    // monitor.position/size 为物理像素；Tauri 窗口 x/y/width/height 均为逻辑像素，需除以缩放
    return {
      cx: (inside.position.x + inside.size.width / 2) / scale,
      cy: (inside.position.y + inside.size.height / 2) / scale,
      monitor: {
        w: inside.size.width / scale,
        h: inside.size.height / scale,
      },
    };
  } catch {
    return FALLBACK;
  }
}

/** ready 握手：等 overlay 页面挂载完监听，超时放行 false */
function waitOverlayReady(label: string): Promise<boolean> {
  return new Promise((resolve) => {
    let un: UnlistenFn | null = null;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (un) void safeUnlisten(un);
      resolve(ok);
    };
    void listen('bubble:ring:ready', (ev) => {
      if ((ev.payload as string) !== label) return;
      finish(true);
    }).then((u) => {
      un = u;
      if (done) void safeUnlisten(u);
    });
    setTimeout(() => finish(false), READY_TIMEOUT_MS);
  });
}

/** 灵动岛失败文案：「类型标识 · 简明原因」 */
function aiErrIslandText(raw: string): string {
  const { t } = useI18n();
  const c = classifyAiError(raw);
  return c.detail ? t(`island.ai_err_${c.kind}`, { error: c.detail }) : t(`island.ai_err_${c.kind}`);
}

/**
 * 阶段一（本地拆分）：按预判分流立刻弹首屏岛；解析「当前选中项」，缓存命中的 AI
 * 产出同步并入（阶段一即得最终片段）；无选中项/解析失败回退最近一条解析结果
 * （不拍平整份历史，避免新旧解析结果混在同一环里）。
 */
async function parseRingSegments(
  selected: ClipboardData | undefined,
  content: string,
  plan: AnalysisPlan | null,
): Promise<{ segments: RingSegment[]; parseError?: string }> {
  const { t } = useI18n();
  const skipIslandText = (o: Extract<AnalysisOutcome, { type: 'skipped' }>): string =>
    o.reason === 'not_configured'
      ? t('island.ai_not_configured')
      : o.reason === 'too_long'
        ? t('island.ai_skipped_long', { n: o.maxChars ?? 1000 })
        : t(`island.ai_skipped_${o.reason}`);

  if (plan?.type === 'skipped') notifyIsland({ kind: 'info', text: skipIslandText(plan.outcome) });
  else if (plan?.type === 'cached') notifyIsland({ kind: 'success', text: t('island.ai_done') });
  else if (plan?.type === 'ai') notifyIsland({ kind: 'loading', text: t('island.parsing'), sticky: true });

  let raw: Array<{ text: string; extractorId?: string }> = [];
  let parseError: string | undefined;
  if (selected && content) {
    try {
      const entry = await parseClipItem(selected.id, content, Date.now(), (e) => {
        parseError ??= String(e); // 降级软错误（首个优先）：灵动岛提示失败原因用
      });
      raw = entry.segments.map((s) => ({ text: s.text, extractorId: s.extractorId }));
    } catch (e) {
      parseError = String(e);
    }
  }
  if (raw.length === 0) {
    const latest = getSmartClipEntries()[0];
    raw = latest ? latest.segments.map((s) => ({ text: s.text, extractorId: s.extractorId })) : [];
  }
  const segments = normalizeSegments(raw);

  // 解析失败：环降级展示最近结果，灵动岛给出错误原因
  if (parseError) {
    notifyIsland({ kind: 'error', text: t('island.parse_failed', { error: aiErrIslandText(parseError) }) });
    return { segments, parseError };
  }
  if (plan?.type === 'cached') {
    segments.push(...mergeAiSegments(segments, plan.outcome));
  }
  return { segments };
}

/**
 * 打开环形。时序：注册握手监听 → 建 overlay 窗 → 挂指令通道 → 阶段一解析 →
 * 推数据 → 显示取焦 → 阶段二 AI。全程纪元校验，环被关闭即中止。
 */
async function openRing(): Promise<void> {
  const ts = Date.now();
  // 环活跃期间豁免主窗口失焦自动隐藏（app.vue），并收掉已显示的主窗口 tooltip
  (window as any).__ringActive = true;
  void emit('tooltip:hide').catch(() => {});
  const label = `clipboard-bubble-ring-${ts}`;
  (window as any).__childOpeningUntil = Date.now() + 600;

  // 预判先行（毫秒级，无 AI 成本）：按下瞬间定分流去向；选中项此刻快照。
  // 二维码图片：解码出的链接当文本走环盘流程；预判异常按无 AI 链路降级
  const selected = getSelectedItem();
  const content = selected && (selected.type ?? 'text') === 'text'
    ? selected.content
    : selected?.type === 'image' ? (selected.qr_text ?? '') : '';
  const planP: Promise<AnalysisPlan | null> = content
    ? planAnalysis(content).catch((e) => {
        console.error('[ring] AI 预判失败，按无 AI 链路处理:', e);
        return null;
      })
    : Promise.resolve(null);

  const readyP = waitOverlayReady(label); // 先注册握手监听再建窗，杜绝握手丢失
  const { cx, cy, monitor } = await ringCenter();
  // 小屏收缩：overlay 不越出光标所在显示器（页面按实际视口自适应收缩环半径）
  const w = Math.min(OVERLAY_W, Math.max(480, monitor.w - 16));
  const h = Math.min(OVERLAY_H, Math.max(360, monitor.h - 16));
  const overlay = new WebviewWindow(label, {
    url: '/bubble?mode=ring',
    title: 'Smart Clipboard',
    width: w,
    height: h,
    x: Math.round(cx - w / 2),
    y: Math.round(cy - h / 2),
    resizable: false,
    decorations: false,
    transparent: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 创建期不取焦点：隐窗持焦会吞掉用户键盘输入；显示后由 setFocus 显式获取
    focus: false,
    focusable: true,
    shadow: false,
    visible: false,
  });
  ring = { ts, overlay, unlisteners: [] };
  overlay.once('tauri://created', () => {
    (window as any).__childOpeningUntil = Date.now() + 400;
  });
  overlay.once('tauri://error', () => {
    if (epochAlive(ts)) void closeRing();
  });

  // 指令通道（页面 → 命令）：粘贴 / 关闭 / 钉住习惯
  const on = async (name: string, handler: (payload: any) => void): Promise<void> => {
    const un = await listen(name, (ev) => handler(ev.payload));
    if (!epochAlive(ts)) { void safeUnlisten(un); return; } // await 期间环已被关闭：防泄漏
    ring!.unlisteners.push(un);
  };
  await on('ring:paste-req', (p) => void pasteRing(p));
  await on('ring:close', () => void closeRing());
  await on('ring:habit', (p) => recordHabit(p));
  if (!epochAlive(ts)) return;

  // ---- 阶段一：本地拆分 → 推数据 → 显示 ----
  const base = await parseRingSegments(selected, content, await planP);
  if (!epochAlive(ts)) return;
  const plan = await planP;
  // 无片段，或仅原文单段且 AI 链路不可用：环盘无分析价值不开环（灵动岛已提示原因）
  if (base.segments.length === 0 || (base.segments.length <= 1 && plan?.type !== 'ai')) {
    await closeRing();
    return;
  }

  const ready = await readyP;
  if (!epochAlive(ts)) return;
  if (!ready) { await closeRing(); return; }
  await emitTo(label, 'ring:data', {
    segments: base.segments,
    source: content,
    contentHash: hashText(selected?.content ?? ''),
    aiPending: plan?.type === 'ai',
  }).catch(() => {});
  await overlay.show().catch(() => {});
  if (!epochAlive(ts)) return;
  await overlay.setFocus().catch(() => {});

  // ---- 阶段二：AI 分析完成 → 新增片段推给页面补位上环 ----
  // 解析失败时跳过：AI 大概率同源失败，且失败弹岛会与 parseError 弹岛重叠
  if (base.parseError || plan?.type !== 'ai') return;
  const outcome = await plan.start();
  if (!epochAlive(ts)) return;
  if (outcome.type === 'failed') {
    // 先熄灭环心"解析中"状态条（环保留时不能残留假进行态），再弹失败岛
    void emitTo(label, 'ring:ai-result', { segments: [], status: 'failed' }).catch(() => {});
    notifyIsland({ kind: 'error', text: aiFailedIsland(String(outcome.error)) });
    if (base.segments.length <= 1) await closeRing(); // 仅原文单段：无增量价值
    return;
  }
  if (outcome.type !== 'done') return;
  notifyIsland({ kind: 'success', text: useI18n().t('island.ai_done') });
  const added = mergeAiSegments(base.segments, outcome);
  if (added.length > 0) {
    void emitTo(label, 'ring:ai-result', { segments: added, status: 'done' }).catch(() => {});
  } else if (base.segments.length <= 1) {
    await closeRing(); // AI 产出与原文全重复且基础仅单段：无增量价值
  }
}

/** AI 阶段失败文案（与解析失败同规范） */
function aiFailedIsland(raw: string): string {
  const { t } = useI18n();
  return t('island.parse_failed', { error: aiErrIslandText(raw) });
}

interface RingIntent {
  text?: string;
  extractorId?: string;
  contentHash?: string;
  action?: string;
  segmentText?: string;
}

/** 粘贴：关环让焦点回目标应用 → 写剪贴板 → 模拟粘贴，并落一条习惯记录（为该提取器投票） */
async function pasteRing(req: RingIntent): Promise<void> {
  const text = String(req?.text ?? '');
  if (!text) return;
  const extractorId = String(req?.extractorId ?? '');
  const contentHash = String(req?.contentHash ?? '');
  await closeRing();
  // 粘贴也会写剪贴板：抑制随之触发的"已复制"误报（入库计数仍由剪贴板监听 bump 承担）
  suppressIslandCopy();
  try {
    await writeText(text);
  } catch {
    return;
  }
  void notifyIslandPaste(text, 'text');
  setTimeout(() => { invoke('paste').catch(() => {}); }, 200);
  if (contentHash) {
    void dbService.insertClipHabit({
      contentHash,
      extractorId,
      action: 'paste',
      segmentText: text.slice(0, 200),
    }).catch(() => {});
  }
  void recordPaste(text, extractorId).catch(() => {});
  if (extractorId === 'ai-analysis') void recordAiAdoption().catch(() => {});
}

/** 钉住习惯记录（钉住也是一次强偏好信号；AI 产出被采纳记分子） */
function recordHabit(req: RingIntent): void {
  const seg = String(req?.segmentText ?? '');
  if (!req?.contentHash || !seg) return;
  const extractorId = String(req?.extractorId ?? '');
  const action = req.action === 'pin' ? 'pin' : 'paste';
  void dbService.insertClipHabit({
    contentHash: String(req.contentHash),
    extractorId,
    action,
    segmentText: seg.slice(0, 200),
  }).catch(() => {});
  void recordPaste(seg, extractorId).catch(() => {});
  if (extractorId === 'ai-analysis') void recordAiAdoption().catch(() => {});
}
