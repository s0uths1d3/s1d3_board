import type { Command } from '../Command';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, cursorPosition } from '@tauri-apps/api/window';
import { listen, emit, emitTo, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from 'tauri-plugin-clipboard-api';
import { getSmartClipEntries, parseClipItem } from '../../smart-clip/smartClip';
import { planAnalysis, type AnalysisOutcome, type AnalysisPlan } from '../../smart-clip/analysis';
import type { ClipboardData } from '../../entities';
import { recordPaste, recordAiAdoption } from '../../smart-clip/habitProfile';
import { getSelectedItem } from './clipboardStore';
import { notifyIsland, notifyIslandPaste, suppressIslandCopy } from '~/composables/useCopyIsland';
import { useI18n } from '~/composables/useI18n';
import { classifyAiError } from '~/utils/aiError';
import { hashText } from '~/utils/hash';
import dbService from '../../db/dbService';

/**
 * 环形多气泡窗口系统（设计文档 §4.4 多窗口交互）：
 *
 * 每条解析片段 = 一只**独立 OS 气泡窗口**，绕光标所在位置排成环形；
 * 屏幕中央（环心）是一只**控制盘窗口**，提供箭头导航 / 翻页 / 关闭。
 *
 * - 环上限 RING_LIMIT=8：片段超出自动分页，翻页时按需创建窗口、非当前页隐藏；
 * - 导航：控制盘 ‹ › 顺序循环切换；键盘 ←↑/→↓ 空间导航（↑↓ 列内上下移动，
 *   ←→ 行内左右移动，行首/行尾越界折转到最近的上方/下方气泡），
 *   选中气泡置顶（alwaysOnTop 重置技巧，不抢目标应用焦点）；
 * - 选择：气泡窗口 Ctrl+悬停 / 左键点击 → ring:select-req；双击 → ring:paste-req；
 * - 粘贴：管理器统一隐藏全部环形窗口 → 写剪贴板 → 模拟粘贴（焦点回到目标应用）；
 * - 生命周期：Ctrl+B toggle——可见时整体关闭，粘贴后隐藏时重建以取最新数据；
 *   事件监听随环形生命周期挂载/卸载，杜绝泄漏。
 */

const RING_LIMIT = 8;
const BUBBLE_W = 190;
const BUBBLE_H = 150;
const HUB_W = 240;
const HUB_H = 192;
const RING_RADIUS = 260;
/** 片段总数上限（3 环），防止极端数据创建过多 WebView */
const MAX_SEGMENTS = 24;

/**
 * 环形槽位布局：先占上下左右四个正位，再占四角（i 越小越先占用），
 * 保证任意数量下环形分布对称美观（1 上 / 2 上下 / 3 上下左 / 4 上下左右 / 5-8 补四角）。
 */
const SLOT_OFFSETS: Array<{ x: number; y: number }> = [
  { x: 0, y: -1 },        // 上
  { x: 0, y: 1 },         // 下
  { x: -1, y: 0 },        // 左
  { x: 1, y: 0 },         // 右
  { x: -0.72, y: -0.72 }, // 左上
  { x: 0.72, y: -0.72 },  // 右上
  { x: -0.72, y: 0.72 },  // 左下
  { x: 0.72, y: 0.72 },   // 右下
];

interface RingSlot {
  label: string;
  index: number;
  win: WebviewWindow;
}

interface RingSegment { text: string; w: number; h: number; extractorId: string }

interface RingState {
  ts: number;
  slots: RingSlot[];
  hub: WebviewWindow;
  /** 片段（index 即槽位），尺寸按文本自适应（逻辑像素） */
  segments: RingSegment[];
  /** 当前选中 / 当前页（跨窗口的单一事实来源，经 ring:state 广播） */
  selected: number;
  page: number;
  /** 源内容哈希：习惯记录用（关联"同类内容 → 用户选择"） */
  contentHash: string;
  center: { x: number; y: number };
  /** 粘贴后整体隐藏：下一次 Ctrl+B 重建而非直接关闭 */
  hidden: boolean;
  /** 环盘是否已显示：显示前控制盘失焦不关闭整环（处理期间焦点抖动不误杀，
   *  保证本地拆分/AI 分析成功后环盘必然显示）；显示后失焦才自动退场 */
  shown: boolean;
  unlisteners: UnlistenFn[];
}

let ring: RingState | null = null;

export class BubbleToggleCommand implements Command {
  async execute(event?: { state: string }): Promise<void> {
    if (event?.state !== 'Pressed') return;
    if (ring) {
      const reopen = ring.hidden; // 粘贴后隐藏：重建以取最新解析数据
      await closeRing();
      if (!reopen) return;        // 可见 → toggle off
    }
    await openRing();
  }
}

/** 光标所在显示器：环盘固定在其正中（不跟随鼠标），返回**逻辑坐标**中心 */
async function ringCenter(): Promise<{ cx: number; cy: number }> {
  try {
    const [cursor, monitors] = await Promise.all([cursorPosition(), availableMonitors()]);
    const inside = monitors.find((m) => {
      const { x, y } = m.position;
      return cursor.x >= x && cursor.x < x + m.size.width && cursor.y >= y && cursor.y < y + m.size.height;
    }) ?? monitors[0];
    if (!inside) return { cx: 200, cy: 200 };
    const scale = inside.scaleFactor || 1;
    // monitor.position/size 为物理像素；Tauri 窗口 x/y/width/height 均为**逻辑像素**，需除以缩放
    return {
      cx: (inside.position.x + inside.size.width / 2) / scale,
      cy: (inside.position.y + inside.size.height / 2) / scale,
    };
  } catch {
    return { cx: 200, cy: 200 };
  }
}

/** 按文本估算气泡窗口尺寸：CJK 全宽、ASCII 半宽折算行宽与换行行数（逻辑像素） */
function measureBubble(text: string): { w: number; h: number } {
  const CHAR = 11;      // 11px 字号下 CJK 字宽
  const ASCII = 6.2;    // ASCII 字宽
  const LINE_H = 17;    // leading-relaxed 行高
  const PAD_X = 20;     // 透明窗口四周留白（p-2 = 8px × 2）+ 边框，余量供圆角阴影渲染
  const PAD_Y = 20;
  const MAX_TEXT_W = 236;
  let lines = 0;
  let maxLineW = 0;
  for (const raw of text.split('\n')) {
    let w = 0;
    for (const ch of raw) w += ch.charCodeAt(0) > 255 ? CHAR : ASCII;
    if (w === 0) w = CHAR;
    maxLineW = Math.max(maxLineW, Math.min(w, MAX_TEXT_W));
    lines += Math.max(1, Math.ceil(w / MAX_TEXT_W));
  }
  return {
    w: Math.round(Math.min(300, Math.max(172, maxLineW + PAD_X))),
    h: Math.round(Math.min(240, Math.max(88, lines * LINE_H + PAD_Y))),
  };
}

/**
 * 阶段一（本地拆分）：首屏岛 + 解析「当前选中项」。
 * 首屏岛由预判决定立刻出现（AI 链路 → 解析中驻留；本地分支 → 对应结果岛直出）；
 * 解析命中内存缓存即时返回；无选中项/解析失败回退**最近一条**解析结果（不再拍平整份
 * 历史，避免新旧解析结果混在同一环里）。缓存命中（cached）的 AI 产出在此同步并入——
 * 阶段一即得最终片段，环盘一次性显示。
 * 返回 null = 处理期间环已被关闭（结果岛随之静默，避免给已关闭的环残留提示）。
 */
async function parseRingSegments(
  selected: ClipboardData | undefined,
  content: string,
  plan: AnalysisPlan | null,
): Promise<{ segments: RingSegment[]; parseError?: string } | null> {
  const { t } = useI18n();
  // 灵动岛失败文案（苹果设计规范式简明）：「解析失败：类型标识 · 简明原因」——
  // 网络中断/超时只有类型标识，接口/模型错误附截断至 60 字的原因；完整报错仍在设置页可查
  const aiErrIslandText = (raw: string): string => {
    const c = classifyAiError(raw);
    return c.detail ? t(`island.ai_err_${c.kind}`, { error: c.detail }) : t(`island.ai_err_${c.kind}`);
  };
  const skipIslandText = (o: Extract<AnalysisOutcome, { type: 'skipped' }>): string =>
    o.reason === 'not_configured'
      ? t('island.ai_not_configured')
      : o.reason === 'too_long'
        ? t('island.ai_skipped_long', { n: o.maxChars ?? 1000 })
        : t(`island.ai_skipped_${o.reason}`);

  // 首屏岛立刻出现：无需等待环盘窗口创建，也不依赖 400ms 计时
  if (plan?.type === 'skipped') notifyIsland({ kind: 'info', text: skipIslandText(plan.outcome) });
  else if (plan?.type === 'cached') notifyIsland({ kind: 'success', text: t('island.ai_done') });
  else if (plan?.type === 'ai') notifyIsland({ kind: 'loading', text: t('island.parsing'), sticky: true });

  let segs: Array<{ text: string; extractorId?: string }> = [];
  let parseError: string | undefined;
  if (selected && content) {
    try {
      const entry = await parseClipItem(selected.id, content, Date.now(), (e) => {
        // AI 提取失败被管道降级吞掉前的回调：记录原因供灵动岛提示（首个错误优先）
        parseError ??= String(e);
      });
      segs = entry.segments.map((s) => ({ text: s.text, extractorId: s.extractorId }));
    } catch (e) {
      parseError = String(e); /* 降级为最近一次解析结果 */
    }
  }
  if (segs.length === 0) {
    const latest = getSmartClipEntries()[0];
    segs = latest ? latest.segments.map((s) => ({ text: s.text, extractorId: s.extractorId })) : [];
  }
  if (!ring) return null;

  // 去重 + 按内容自适应尺寸。
  // 判等键做**空白归一化**（\r、行尾空格、连续空格折叠）：Windows 剪贴板文本常带
  // 不可见的空白差异，精确判等会让"内容相同"的片段成排出现在环上。
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const seen = new Set<string>();
  const out: Array<{ text: string; w: number; h: number; extractorId: string }> = [];
  for (const raw of segs) {
    const text = raw.text.trim();
    if (!text) continue;
    const key = norm(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, extractorId: raw.extractorId ?? '', ...measureBubble(text) });
  }

  // 解析失败（AI 报错/网络异常）：环降级展示最近结果的同时，灵动岛给出错误原因
  if (parseError) {
    notifyIsland({ kind: 'error', text: t('island.parse_failed', { error: aiErrIslandText(parseError) }) });
    return { segments: out.slice(0, MAX_SEGMENTS), parseError };
  }

  if (plan?.type === 'cached') mergeAnalysisInto(plan.outcome, norm, seen, out);
  return { segments: out.slice(0, MAX_SEGMENTS) };
}

/** AI 产出（关键词/总结）并入片段：去重（空白归一化判等）+ 自适应尺寸，cap 封顶 */
function mergeAnalysisInto(
  outcome: Extract<AnalysisOutcome, { type: 'done' }>,
  norm: (s: string) => string,
  seen: Set<string>,
  out: RingSegment[],
  cap: number = MAX_SEGMENTS,
): void {
  for (const text of [...outcome.keywords, ...(outcome.summary ? [outcome.summary] : [])]) {
    if (out.length >= cap) break;
    const key = norm(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ text, extractorId: 'ai-analysis', ...measureBubble(text) });
  }
}

/**
 * 阶段二（AI 分析）：仅散文 AI 链路在此发起**单次**调用（解析失败由调用方跳过——
 * AI 链路刚报错，分析大概率同样失败，且失败提示会与 parseError 弹岛重叠）；
 * 结果岛（成功/失败）替换「解析中」驻留岛平滑切换。
 * 返回新增片段（对基础片段去重后），由调用方补建气泡窗口立刻上环。
 */
async function runRingAnalysis(plan: AnalysisPlan | null, base: RingSegment[]): Promise<RingSegment[]> {
  if (plan?.type !== 'ai') return [];
  const { t } = useI18n();
  const outcome = await plan.start();
  if (!ring) return [];
  if (outcome.type === 'failed') {
    const c = classifyAiError(String(outcome.error));
    const detail = c.detail ? t(`island.ai_err_${c.kind}`, { error: c.detail }) : t(`island.ai_err_${c.kind}`);
    notifyIsland({ kind: 'error', text: t('island.parse_failed', { error: detail }) });
    return [];
  }
  if (outcome.type !== 'done') return [];
  notifyIsland({ kind: 'success', text: t('island.ai_done') });
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const seen = new Set(base.map((s) => norm(s.text)));
  const added: RingSegment[] = [];
  mergeAnalysisInto(outcome, norm, seen, added, Math.max(0, MAX_SEGMENTS - base.length));
  return added;
}

/** 槽位逻辑坐标：按固定槽位表取偏移（先上下左右、再四角），同半径对称分布 */
function slotPosition(index: number): { x: number; y: number } {
  if (!ring) return { x: 0, y: 0 };
  const page = Math.floor(index / RING_LIMIT);
  const i = index - page * RING_LIMIT;
  const off = SLOT_OFFSETS[i % SLOT_OFFSETS.length] ?? { x: 0, y: -1 };
  const seg = ring.segments[index];
  const r = RING_RADIUS;
  return {
    x: ring.center.x + off.x * r - (seg?.w ?? BUBBLE_W) / 2,
    y: ring.center.y + off.y * r - (seg?.h ?? BUBBLE_H) / 2,
  };
}

function isVisibleIndex(index: number): boolean {
  if (!ring) return false;
  return Math.floor(index / RING_LIMIT) === ring.page;
}

/** 确保某槽位的气泡窗口存在（尺寸按文本自适应；ready 握手后投递文本） */
async function ensureBubble(index: number): Promise<void> {
  if (!ring || index < 0 || index >= ring.segments.length) return;
  if (ring.slots.some((s) => s.index === index)) return;

  const seg = ring.segments[index]!;
  const label = `clipboard-bubble-ring-${ring.ts}-${index}`;
  const pos = slotPosition(index);
  const win = new WebviewWindow(label, {
    url: `/bubble?mode=ring&index=${index}`,
    title: 'Bubble',
    width: seg.w,
    height: seg.h,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    resizable: false,
    decorations: false,
    transparent: true,   // 透明窗口：rounded-2xl 卡片四角真正透出桌面，呈现圆润气泡
    skipTaskbar: true,
    alwaysOnTop: true,
    focus: false,        // 不抢目标应用焦点
    focusable: false,    // 点击气泡不转移系统焦点：键盘导航始终留在控制盘
    shadow: false,
    visible: false,
  });
  const slot: RingSlot = { label, index, win };
  ring.slots.push(slot);
  win.once('tauri://created', () => {
    (window as any).__childOpeningUntil = Date.now() + 300;
  });
  win.once('tauri://error', () => {
    if (ring) ring.slots = ring.slots.filter((s) => s.label !== label);
  });

  // ready 握手：投递本文本 + 定向补发当前环形状态（广播可能早于本气泡挂载监听——
  // 显示流程已不等整环握手，防选中态丢失）；若属于当前页且环盘已显示则立即显示。
  // shown 门控：阶段二补建的新气泡在整环显示前握手完成时保持隐藏，
  // 由 openRing 显示循环统一处理，避免窗口抢在环盘之前单独冒出
  let done = false;
  const un = await listen('bubble:ring:ready', (ev) => {
    if (done || (ev.payload as string) !== label) return;
    done = true;
    un();
    void emitTo(label, 'bubble:ring:data', { text: seg.text });
    void emitTo(label, 'ring:state', {
      selected: ring?.selected ?? 0,
      page: ring?.page ?? 0,
      total: ring?.segments.length ?? 0,
    });
    if (ring?.shown && isVisibleIndex(index)) {
      void win.show().catch(() => {});
      if (ring.selected === index) raiseSelected();
    }
  });
  if (!ring) { try { un(); } catch { /* ignore */ } return; } // await 期间环已被关闭
  ring.unlisteners.push(() => { try { un(); } catch { /* ignore */ } });
  setTimeout(() => { try { un(); } catch { /* ignore */ } }, 5000);
}

async function ensurePageBubbles(page: number): Promise<void> {
  if (!ring) return;
  const start = page * RING_LIMIT;
  const count = Math.max(0, Math.min(ring.segments.length - start, RING_LIMIT));
  for (let i = 0; i < count; i++) await ensureBubble(start + i);
}

/** 广播环形状态（选中 / 页码 / 总数），气泡与控制盘据此渲染 */
async function broadcastState(): Promise<void> {
  await emit('ring:state', {
    selected: ring?.selected ?? 0,
    page: ring?.page ?? 0,
    total: ring?.segments.length ?? 0,
  }).catch(() => {});
}

/** 选中气泡置顶：重置 alwaysOnTop 把窗口抬到同层最上，不窃取焦点 */
function raiseSelected(): void {
  if (!ring) return;
  const slot = ring.slots.find((s) => s.index === ring!.selected);
  if (!slot) return;
  void slot.win.setAlwaysOnTop(false).catch(() => {});
  void slot.win.setAlwaysOnTop(true).catch(() => {});
}

/** 顺序循环切换选中（控制盘 ‹ › 按钮），跨页时自动翻页显隐 */
function navSelected(delta: number): void {
  if (!ring || ring.segments.length === 0) return;
  const total = ring.segments.length;
  const next = (ring.selected + delta + total) % total;
  void gotoIndex(next);
}

type NavDir = 'up' | 'down' | 'left' | 'right';

interface NavCell { index: number; x: number; y: number }

/**
 * 方向键空间导航（键盘 ←↑/→↓）：把当前页槽位按 SLOT_OFFSETS 偏移视为 3×3 网格
 * （x/y 偏移的符号划分行/列带：左带 {左上,左,左下}、中带 {上,下}、右带 {右上,右,右下}；
 *  上带 {左上,上,右上}、中带 {左,右}、下带 {左下,下,右下}）。
 * - ↑↓：同列带内移动到最近的上方/下方气泡（左列 左下→左→左上，中列 下↔上，右列对称）；
 * - ←→：同行带内移动到相邻气泡（如上行 右上→上→左上）；行首/行尾越界时折转到
 *   **不同行带**中距离最近的上方（←）/下方（→）气泡——同行带不算"上方/下方"，
 *   顶/底行越界原地不动，杜绝来回振荡的错误跳转；
 * - 全程仅在当前页可见槽位间移动（翻页交给 PgUp/PgDn），焦点始终留在控制盘
 *   （气泡窗口 focusable:false，选中切换不转移系统焦点）。
 */
function navSpatial(dir: NavDir): void {
  if (!ring) return;
  const start = ring.page * RING_LIMIT;
  const count = Math.max(0, Math.min(ring.segments.length - start, RING_LIMIT));
  if (count === 0) return;
  const cells: NavCell[] = [];
  for (let i = 0; i < count; i++) {
    const off = SLOT_OFFSETS[i];
    if (off) cells.push({ index: start + i, x: off.x, y: off.y });
  }
  const cur = cells.find((c) => c.index === ring!.selected) ?? cells[0]!;
  const dist = (c: NavCell): number => Math.hypot(c.x - cur.x, c.y - cur.y);
  let target: NavCell | undefined;
  if (dir === 'up' || dir === 'down') {
    // 同列带（x 同号）内朝方向移动：按 |Δy| 取最近者
    target = cells
      .filter((c) => c !== cur && Math.sign(c.x) === Math.sign(cur.x) && (dir === 'up' ? c.y < cur.y : c.y > cur.y))
      .sort((a, b) => Math.abs(a.y - cur.y) - Math.abs(b.y - cur.y))[0];
  } else {
    // 同行带（y 同号）内相邻者：朝方向取 x 最贴近的
    const row = cells
      .filter((c) => c !== cur && Math.sign(c.y) === Math.sign(cur.y) && (dir === 'left' ? c.x < cur.x : c.x > cur.x))
      .sort((a, b) => Math.abs(a.x - cur.x) - Math.abs(b.x - cur.x));
    if (row.length > 0) {
      target = row[0];
    } else {
      // 行首/行尾越界：折转到不同行带中距离最近的上方（←）/下方（→）气泡；
      // 距离并列时按方向偏好 x（← 取更左、→ 取更右）
      target = cells
        .filter((c) => Math.sign(c.y) !== Math.sign(cur.y) && (dir === 'left' ? c.y < cur.y : c.y > cur.y))
        .sort((a, b) => dist(a) - dist(b) || (dir === 'left' ? a.x - b.x : b.x - a.x))[0];
    }
  }
  if (target) selectIndex(target.index);
}

/** 定位选中：跨页时确保目标页气泡已创建并切换显隐，随后广播状态 + 选中置顶 */
async function gotoIndex(index: number): Promise<void> {
  if (!ring || index < 0 || index >= ring.segments.length) return;
  ring.selected = index;
  const page = Math.floor(index / RING_LIMIT);
  if (page !== ring.page) {
    ring.page = page;
    await ensurePageBubbles(page);
    if (!ring) return; // ensurePageBubbles 期间环可能已被关闭
    for (const s of ring.slots) {
      if (isVisibleIndex(s.index)) void s.win.show().catch(() => {});
      else void s.win.hide().catch(() => {});
    }
  }
  await broadcastState();
  raiseSelected();
}

/** 翻页：按需创建该页窗口，非当前页窗口隐藏待命（保留实例，切回即时显示） */
async function switchPage(delta: number): Promise<void> {
  if (!ring) return;
  const pageCount = Math.max(1, Math.ceil(ring.segments.length / RING_LIMIT));
  ring.page = (ring.page + delta + pageCount) % pageCount;
  const start = ring.page * RING_LIMIT;
  const count = Math.min(ring.segments.length - start, RING_LIMIT);
  if (count > 0) ring.selected = start;
  await ensurePageBubbles(ring.page);
  if (!ring) return; // 创建窗口期间环已被关闭
  for (const s of ring.slots) {
    if (isVisibleIndex(s.index)) void s.win.show().catch(() => {});
    else void s.win.hide().catch(() => {});
  }
  await broadcastState();
  raiseSelected();
}

function selectIndex(index: number): void {
  if (!ring || index < 0 || index >= ring.segments.length) return;
  ring.selected = index;
  void broadcastState();
  raiseSelected();
}

/** 粘贴：隐藏全部环形窗口 → 写剪贴板 → 模拟粘贴（焦点自然回到目标应用）；
 *  成功后落一条习惯记录（用户对哪个提取器的产出投了票） */
async function pasteRing(index: number): Promise<void> {
  if (!ring) return;
  // 局部捕获：writeText await 期间环可能已被关闭（重按 Ctrl+B），后续引用不再依赖可变全局
  const current = ring;
  if (index >= 0 && index < current.segments.length) current.selected = index;
  const seg = current.segments[current.selected];
  const text = seg?.text ?? '';
  current.hidden = true;
  for (const s of current.slots) void s.win.hide().catch(() => {});
  void current.hub.hide().catch(() => {});
  if (!text) return;
  // 灵动岛：粘贴也写剪贴板，先抑制随之触发的"已复制"误报，写入成功后显示"已粘贴"（与 pasteUtil 同规范）
  suppressIslandCopy();
  try {
    await writeText(text);
  } catch {
    return;
  }
  void notifyIslandPaste(text, 'text');
  setTimeout(() => { invoke('paste').catch(() => {}); }, 200);
  // 习惯记录：用户用实际粘贴为该提取器的产出"投了票"
  void dbService.insertClipHabit({
    contentHash: current.contentHash,
    extractorId: seg?.extractorId ?? '',
    action: 'paste',
    segmentText: text.slice(0, 200),
  }).catch(() => {});
  // 习惯画像采集（仅本地，.docs/smart-clip-ai-analysis.md）：分布统计；AI 产出被粘贴 = 采纳分子
  void recordPaste(text, seg?.extractorId ?? '').catch(() => {});
  if (seg?.extractorId === 'ai-analysis') void recordAiAdoption().catch(() => {});
}

/** 整体关闭：全部气泡 + 控制盘 + 事件监听 */
async function closeRing(): Promise<void> {
  const current = ring;
  ring = null;
  // 环形系统生命周期结束：解除主窗口失焦隐藏的豁免（app.vue 据此跳过连带隐藏）
  (window as any).__ringActive = false;
  if (!current) return;
  current.unlisteners.forEach((u) => { try { u(); } catch { /* ignore */ } });
  for (const s of current.slots) void s.win.close().catch(() => {});
  void current.hub.close().catch(() => {});
}

/**
 * 打开环形：灵动岛反馈随 Ctrl+B 立刻出现（本地预判分流）。
 * 两阶段上屏：阶段一本地拆分完成即显示基础气泡+控制盘（不等 AI）；阶段二 AI 分析
 * 完成后新增片段立刻补建气泡上环——用户总是先看到可用的环，AI 产出随后叠加。
 */
async function openRing(): Promise<void> {
  const ts = Date.now();
  // 标记环形系统活跃：主窗口失焦自动隐藏（app.vue tryHideMainWindow）据此豁免，
  // 避免环形窗口被当作"可见子窗口"连带关闭而 ring 状态残留（下次 Ctrl+B 被误判为 toggle off）
  (window as any).__ringActive = true;
  // 环盘显示期间主窗口被豁免保持可见：立即收掉已显示的主窗口 tooltip（悬停新弹由
  // index.vue showTooltip 的 __ringActive 门控阻止）；关环后自动恢复
  void emit('tooltip:hide').catch(() => {});
  const hubLabel = `clipboard-bubble-ring-hub-${ts}`;
  (window as any).__childOpeningUntil = Date.now() + 600;

  // 预判先行（毫秒级本地判定，无 AI 成本）：按下瞬间即定分流去向，灵动岛据此立刻给出
  // 首屏反馈，不等环盘窗口创建。选中项此刻快照：处理期间新复制不改变本次环的目标
  const selected = getSelectedItem();
  const content = selected && (selected.type ?? 'text') === 'text' ? selected.content : '';
  const planP: Promise<AnalysisPlan | null> = content ? planAnalysis(content) : Promise.resolve(null);

  const { cx, cy } = await ringCenter();
  // 源内容哈希：习惯记录按它关联"同类内容 → 用户选择"
  const contentHash = hashText(selected?.content ?? '');
  const hub = new WebviewWindow(hubLabel, {
    url: '/bubble?mode=ring-hub',
    title: 'Smart Clipboard',
    width: HUB_W,
    height: HUB_H,
    x: Math.round(cx - HUB_W / 2),
    y: Math.round(cy - HUB_H / 2),
    resizable: false,
    decorations: false,
    transparent: true,   // 透明窗口：环心控制盘同为圆润卡片形态
    skipTaskbar: true,
    alwaysOnTop: true,
    focus: false,        // 创建期不取焦点：处理期间环盘仍隐藏，隐窗持焦会吞掉用户键盘输入，
                         // 且焦点变化会触发失焦误关整环；键盘焦点在环盘显示后由 setFocus 显式获取
    focusable: true,
    shadow: false,
    visible: false,
  });
  ring = {
    ts,
    slots: [],
    hub,
    segments: [],
    selected: 0,
    page: 0,
    contentHash,
    center: { x: cx, y: cy },
    hidden: false,
    shown: false,
    unlisteners: [],
  };
  hub.once('tauri://created', () => {
    (window as any).__childOpeningUntil = Date.now() + 400;
  });
  hub.once('tauri://error', () => {
    void closeRing();
  });

  // 控制盘 / 气泡窗口的指令通道
  const on = async (name: string, handler: (payload: any) => void): Promise<void> => {
    const un = await listen(name, (ev) => handler(ev.payload));
    // await 期间环可能已被关闭（控制盘创建失败 / 用户重按 Ctrl+B）：立即解绑防泄漏
    if (!ring) { try { un(); } catch { /* ignore */ } return; }
    ring.unlisteners.push(un);
  };
  await on('ring:nav', (p) => {
    // dir = 键盘方向键（空间导航）；delta = 控制盘 ‹ › 按钮（顺序循环）
    const dir = p?.dir as NavDir | undefined;
    if (dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right') navSpatial(dir);
    else navSelected(Number(p?.delta ?? 0));
  });
  await on('ring:page-nav', (p) => void switchPage(Number(p?.delta ?? 0)));
  await on('ring:select-req', (p) => selectIndex(Number(p?.index ?? -1)));
  await on('ring:paste-req', (p) => void pasteRing(Number(p?.index ?? -1)));
  await on('ring:habit', (p) => {
    const index = Number(p?.index ?? -1);
    const action = p?.action === 'pin' ? 'pin' : 'paste';
    const seg = ring?.segments[index];
    if (!ring || !seg) return;
    void dbService.insertClipHabit({
      contentHash: ring.contentHash,
      extractorId: seg.extractorId,
      action,
      segmentText: seg.text.slice(0, 200),
    }).catch(() => {});
    // 习惯画像采集（仅本地）：钉住也计偏好；AI 产出被采纳记分子
    void recordPaste(seg.text, seg.extractorId).catch(() => {});
    if (seg.extractorId === 'ai-analysis') void recordAiAdoption().catch(() => {});
  });
  await on('ring:close', () => void closeRing());

  // 控制盘失焦（用户点回其它应用）→ 整环自动退场：键盘入口已失效，环失去存在意义。
  // 仅环盘已显示（ring.shown）后生效：处理期间 hub 未持焦也未显示，焦点抖动不误杀
  // 处理中的环——本地拆分/AI 分析成功后环盘必然显示。粘贴/关闭流程先行置
  // ring.hidden 或 ring=null，此回调不会误触发。
  if (!ring) return; // 注册监听期间环已被关闭
  const unHubFocus = await ring.hub.onFocusChanged(({ payload: focused }) => {
    if (!focused && ring && ring.shown && !ring.hidden) void closeRing();
  });
  if (!ring) { try { unHubFocus(); } catch { /* ignore */ } return; }
  ring.unlisteners.push(unHubFocus);

  // 控制盘 ready 握手收尾异步推进（不阻塞）：环心就绪即补推状态+显示+取焦。
  // 两阶段上屏：阶段一本地拆分完成 → 气泡环立刻显示（不等控制盘页面加载，
  // 也 AI 无关）；阶段二 AI 分析完成 → 新增片段立刻补建气泡上环。
  void waitHubReady(hubLabel);
  const plan = await planP;
  // ---- 阶段一：本地拆分 → 立刻显示气泡环 ----
  const base = await parseRingSegments(selected, content, plan);
  if (!ring || !base) return; // 处理期间环已被关闭（控制盘创建失败 / 重按 Ctrl+B）
  ring.segments = base.segments;
  if (ring.segments.length === 0) {
    await closeRing();
    return;
  }
  void ensurePageBubbles(0); // 并行建窗：气泡 ready 握手即上屏（shown 门控），与 AI 等待重叠
  // 环盘立刻进入显示流程：此后控制盘失焦才触发整环自动退场。
  // 气泡各自握手后显示（错过广播有握手补发状态兜底），环心由收尾任务浮现
  ring.shown = true;
  await broadcastState();
  for (const s of ring.slots) {
    if (isVisibleIndex(s.index)) void s.win.show().catch(() => {});
  }
  raiseSelected();

  // ---- 阶段二：AI 分析完成 → 新增气泡立刻补上环 ----
  if (base.parseError) return; // 解析失败已弹错误岛：AI 链路大概率同源失败，直接跳过
  const extra = await runRingAnalysis(plan, ring.segments);
  if (!ring || extra.length === 0) return;
  ring.segments = [...ring.segments, ...extra];
  void ensurePageBubbles(0); // 仅补建新增槽位（ensureBubble 内按槽位去重，已有窗口不动）
  await broadcastState(); // 控制盘计数刷新（总片段数变化）
}

/**
 * 控制盘 ready 握手收尾：页面加载完成（已挂载监听）后补推环形状态、显示环心并取焦。
 * 环心显示**不再阻塞气泡环**——控制盘 webview 页面加载（数百毫秒~秒级）此前是
 * 本地切分路径上唯一的显示延迟源；就绪前显示会短暂空白，故收尾后浮现。
 * openRing 对本 Promise fire-and-forget：收尾与 AI 分析并行推进。
 */
function waitHubReady(hubLabel: string): Promise<void> {
  return new Promise((resolve) => {
    let un: UnlistenFn | null = null;
    let done = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (poll) clearInterval(poll);
      try { un?.(); } catch { /* ignore */ }
      resolve();
    };
    /** 就绪收尾：补推状态（openRing 首次广播发生在就绪前，hub 未监听）+ 显示环心取焦 */
    const reveal = () => {
      if (!ring || ring.hidden) return;
      void broadcastState();
      void ring.hub.show()
        .then(() => ring?.hub.setFocus().catch(() => {}))
        .catch(() => {});
    };
    void listen('bubble:ring:hub-ready', (ev) => {
      if ((ev.payload as string) !== hubLabel) return;
      reveal();
      finish();
    }).then((u) => {
      un = u;
      if (done) { try { u(); } catch { /* ignore */ } }
    });
    // 控制盘创建失败（tauri://error → closeRing → ring=null）时立即放行
    poll = setInterval(() => { if (!ring) finish(); }, 100);
    // 页面加载异常兜底：超时仍显示环心（与既有超时行为一致，不让环心缺失）
    setTimeout(() => { if (!done) { reveal(); finish(); } }, 5000);
  });
}
