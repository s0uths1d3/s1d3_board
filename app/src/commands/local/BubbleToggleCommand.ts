import type { Command } from '../Command';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, cursorPosition } from '@tauri-apps/api/window';
import { listen, emit, emitTo, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from 'tauri-plugin-clipboard-api';
import { getSmartClipEntries, parseClipItem } from '../../smart-clip/smartClip';
import { getSelectedItem } from './clipboardStore';
import { hashText } from '~/utils/hash';
import dbService from '../../db/dbService';

/**
 * 环形多气泡窗口系统（设计文档 §4.4 多窗口交互）：
 *
 * 每条解析片段 = 一只**独立 OS 气泡窗口**，绕光标所在位置排成环形；
 * 屏幕中央（环心）是一只**控制盘窗口**，提供箭头导航 / 翻页 / 关闭。
 *
 * - 环上限 RING_LIMIT=8：片段超出自动分页，翻页时按需创建窗口、非当前页隐藏；
 * - 导航：控制盘 ‹ › 切换选中（键盘 ←→ 翻页由控制盘窗口自行转发），
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
const HUB_H = 176;
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
  const PAD_X = 28;     // 左右内边距 + 钉住按钮预留
  const PAD_Y = 26;     // 上下内边距
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
 * 计算片段：优先解析「当前选中的剪贴项」（命中缓存即时返回）；
 * 无选中项/解析失败时，回退为**最近一条**解析结果（不再拍平整份历史，
 * 避免新旧解析结果混在同一环里，出现"显示文字与处理结果不一致"）。
 */
async function collectSegments(): Promise<Array<{ text: string; w: number; h: number; extractorId: string }>> {
  const selected = getSelectedItem();
  const content = selected && (selected.type ?? 'text') === 'text' ? selected.content : '';
  let segs: Array<{ text: string; extractorId?: string }> = [];
  if (selected && content) {
    try {
      const entry = await parseClipItem(selected.id, content, Date.now());
      segs = entry.segments.map((s) => ({ text: s.text, extractorId: s.extractorId }));
    } catch { /* 降级为最近一次解析结果 */ }
  }
  if (segs.length === 0) {
    const latest = getSmartClipEntries()[0];
    segs = latest ? latest.segments.map((s) => ({ text: s.text, extractorId: s.extractorId })) : [];
  }
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
  return out.slice(0, MAX_SEGMENTS);
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
    transparent: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focus: false,        // 不抢目标应用焦点
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

  // ready 握手：投递本文本；若属于当前页则显示
  let done = false;
  const un = await listen('bubble:ring:ready', (ev) => {
    if (done || (ev.payload as string) !== label) return;
    done = true;
    un();
    void emitTo(label, 'bubble:ring:data', { text: seg.text });
    if (isVisibleIndex(index)) void win.show().catch(() => {});
  });
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

/** 导航：在当前页范围内环形切换选中 */
function navSelected(delta: number): void {
  if (!ring) return;
  const start = ring.page * RING_LIMIT;
  const count = Math.min(ring.segments.length - start, RING_LIMIT);
  if (count <= 0) return;
  const end = start + count - 1;
  let s = ring.selected;
  s = s < start || s > end ? start : start + ((s - start + delta + count) % count);
  ring.selected = s;
  void broadcastState();
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
  if (index >= 0 && index < ring.segments.length) ring.selected = index;
  const seg = ring.segments[ring.selected];
  const text = seg?.text ?? '';
  ring.hidden = true;
  for (const s of ring.slots) void s.win.hide().catch(() => {});
  void ring.hub.hide().catch(() => {});
  if (!text) return;
  try {
    await writeText(text);
  } catch {
    return;
  }
  setTimeout(() => { invoke('paste').catch(() => {}); }, 200);
  // 习惯记录：用户用实际粘贴为该提取器的产出"投了票"
  void dbService.insertClipHabit({
    contentHash: ring.contentHash,
    extractorId: seg?.extractorId ?? '',
    action: 'paste',
    segmentText: text.slice(0, 200),
  }).catch(() => {});
}

/** 整体关闭：全部气泡 + 控制盘 + 事件监听 */
async function closeRing(): Promise<void> {
  const current = ring;
  ring = null;
  if (!current) return;
  current.unlisteners.forEach((u) => { try { u(); } catch { /* ignore */ } });
  for (const s of current.slots) void s.win.close().catch(() => {});
  void current.hub.close().catch(() => {});
}

/** 打开环形：AI/规则处理完成前不显示任何窗口，处理完成后整环（气泡+控制盘）一起显示 */
async function openRing(): Promise<void> {
  const ts = Date.now();
  const hubLabel = `clipboard-bubble-ring-hub-${ts}`;
  (window as any).__childOpeningUntil = Date.now() + 600;

  const { cx, cy } = await ringCenter();
  // 源内容哈希：习惯记录按它关联"同类内容 → 用户选择"
  const contentHash = hashText(getSelectedItem()?.content ?? '');
  const hub = new WebviewWindow(hubLabel, {
    url: '/bubble?mode=ring-hub',
    title: 'Smart Clipboard',
    width: HUB_W,
    height: HUB_H,
    x: Math.round(cx - HUB_W / 2),
    y: Math.round(cy - HUB_H / 2),
    resizable: false,
    decorations: false,
    transparent: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focus: false,
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
    ring?.unlisteners.push(un);
  };
  await on('ring:nav', (p) => navSelected(Number(p?.delta ?? 0)));
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
  });
  await on('ring:close', () => void closeRing());

  // 控制盘 ready 握手：仅确认窗口就绪（此阶段整个环不可见）
  await waitHubReady(hubLabel);

  // 片段就绪（AI/规则处理完成）后才显示环盘；无可展示片段直接关闭
  ring.segments = (await collectSegments()).slice(0, MAX_SEGMENTS);
  if (!ring || ring.segments.length === 0) {
    await closeRing();
    return;
  }
  await ensurePageBubbles(0);
  await broadcastState();
  // 依次显示：当前页气泡 → 环心控制盘 → 选中项置顶
  for (const s of ring.slots) {
    if (isVisibleIndex(s.index)) void s.win.show().catch(() => {});
  }
  void ring.hub.show().catch(() => {});
  raiseSelected();
}

/** 等待控制盘 ready 握手（超时兜底放行，避免解析完成后环无法显示） */
function waitHubReady(hubLabel: string): Promise<void> {
  return new Promise((resolve) => {
    let un: UnlistenFn | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { un?.(); } catch { /* ignore */ }
      resolve();
    };
    void listen('bubble:ring:hub-ready', (ev) => {
      if ((ev.payload as string) === hubLabel) finish();
    }).then((u) => {
      un = u;
      if (done) { try { u(); } catch { /* ignore */ } }
    });
    setTimeout(finish, 5000);
  });
}
