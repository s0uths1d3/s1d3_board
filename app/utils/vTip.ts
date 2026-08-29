/**
 * 全局 hover 提示指令（v-tip）
 *
 * 替换浏览器原生 title 属性，统一使用暖色主题提示气泡（样式见 main.css `.s1d3-tip`）。
 * - 单例 DOM 复用：所有 v-tip 共享同一个提示元素，hover / focus 时按目标定位显示；
 * - 默认显示在元素上方，空间不足自动翻转到下方，并做视口边界收进；
 * - 兄弟窗口避让：tooltip 属于本窗口 surface，无法越过同应用的其他原生窗口
 *   （如快速录入小窗），显示前通过 Tauri API 取兄弟窗口矩形，四个方位中选
 *   与其重叠最小者；几乎完全被盖住（≥90%）时直接不显示；
 * - 内容为空时不显示；滚动 / resize / 失焦 / 点击时自动隐藏。
 *
 * 用法：
 *   <button v-tip="'删除'">…</button>
 *   <div v-tip="{ content: '复制之王内容', placement: 'right' }">…</div>
 */
import { getCurrentWindow, Window } from '@tauri-apps/api/window';
import { isTauri } from './env';

export type TipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TipOptions {
  content: string;
  placement?: TipPlacement;
}

type TipValue = string | TipOptions;

let tipEl: HTMLDivElement | null = null;
/** 当前触发提示的元素（用于延时显示时校验鼠标是否已离开） */
let currentEl: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

const GAP = 10;
const SHOW_DELAY = 120;

/** 任意矩形（CSS 像素，当前窗口视口坐标系） */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function getTip(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 's1d3-tip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function parseValue(value: TipValue): TipOptions {
  if (typeof value === 'string') return { content: value, placement: 'top' };
  return { content: value.content, placement: value.placement ?? 'top' };
}

function hideTip() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  currentEl = null;
  if (tipEl) tipEl.style.opacity = '0';
}

/**
 * 计算某放置方位下 tooltip 的目标矩形（不落样式）。
 * 已做视口边界收进（上下左右各留 6px）。
 */
function computeTipRect(el: HTMLElement, tip: HTMLDivElement, placement: TipPlacement): Rect {
  const rect = el.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = 0;
  let left = 0;

  switch (placement) {
    case 'top':
      top = rect.top - tipRect.height - GAP;
      left = rect.left + rect.width / 2 - tipRect.width / 2;
      if (top < 6) top = rect.bottom + GAP;
      break;
    case 'bottom':
      top = rect.bottom + GAP;
      left = rect.left + rect.width / 2 - tipRect.width / 2;
      if (top + tipRect.height > vh - 6) top = rect.top - tipRect.height - GAP;
      break;
    case 'left':
      left = rect.left - tipRect.width - GAP;
      top = rect.top + rect.height / 2 - tipRect.height / 2;
      if (left < 6) left = rect.right + GAP;
      break;
    case 'right':
      left = rect.right + GAP;
      top = rect.top + rect.height / 2 - tipRect.height / 2;
      if (left + tipRect.width > vw - 6) left = rect.left - tipRect.width - GAP;
      break;
  }
  // 视口边界收进
  left = Math.max(6, Math.min(left, vw - tipRect.width - 6));
  top = Math.max(6, Math.min(top, vh - tipRect.height - 6));

  return { left, top, width: tipRect.width, height: tipRect.height };
}

function applyTipRect(tip: HTMLDivElement, r: Rect) {
  tip.style.left = `${Math.round(r.left)}px`;
  tip.style.top = `${Math.round(r.top)}px`;
}

/**
 * 同应用其他 Tauri 窗口在当前窗口视口坐标系中的矩形（CSS 像素）。
 * tooltip 属于本窗口 surface，永远无法越过兄弟原生窗口，只能定位时避让。
 * 物理/逻辑像素换算：偏移用本窗口缩放比，兄弟窗口尺寸用其自身缩放比（跨屏 DPI 不同）。
 */
async function getOccluders(): Promise<Rect[]> {
  if (!isTauri()) return [];
  try {
    const all = await Window.getAll();
    const cur = getCurrentWindow();
    const others = all.filter(w => w.label !== cur.label);
    if (others.length === 0) return [];
    const [myPos, myScale] = await Promise.all([cur.outerPosition(), cur.scaleFactor()]);
    return await Promise.all(others.map(async w => {
      const [pos, size, scale] = await Promise.all([w.outerPosition(), w.outerSize(), w.scaleFactor()]);
      return {
        left: (pos.x - myPos.x) / myScale,
        top: (pos.y - myPos.y) / myScale,
        width: size.width / scale,
        height: size.height / scale,
      };
    }));
  } catch {
    return [];
  }
}

/** a 与矩形组的相交总面积 */
function overlapArea(a: Rect, rects: Rect[]): number {
  let sum = 0;
  for (const r of rects) {
    const w = Math.min(a.left + a.width, r.left + r.width) - Math.max(a.left, r.left);
    const h = Math.min(a.top + a.height, r.top + r.height) - Math.max(a.top, r.top);
    if (w > 0 && h > 0) sum += w * h;
  }
  return sum;
}

function showTip(el: HTMLElement, value: TipValue) {
  const { content, placement } = parseValue(value);
  if (!content) return;
  if (showTimer) clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    showTimer = null;
    if (currentEl !== el) return;
    const tip = getTip();
    tip.textContent = content;
    tip.style.visibility = 'visible';
    void (async () => {
      // 候选方位：首选在前；严格更优才替换，天然偏向首选方位
      const candidates = ([placement, 'top', 'bottom', 'left', 'right'] as TipPlacement[])
        .filter((p, i, arr) => arr.indexOf(p) === i)
        .map(p => computeTipRect(el, tip, p));
      const occluders = await getOccluders();
      // 等待兄弟窗口坐标期间指针已移开则放弃
      if (currentEl !== el) return;
      const area = candidates[0]!.width * candidates[0]!.height || 1;
      let best = candidates[0]!;
      let bestOverlap = Infinity;
      for (const c of candidates) {
        const overlap = overlapArea(c, occluders);
        if (overlap < bestOverlap) {
          bestOverlap = overlap;
          best = c;
        }
      }
      // 所有方位都被兄弟窗口盖住 ≥90%：残缺气泡比没有更糟，直接不显示
      if (occluders.length > 0 && bestOverlap >= area * 0.9) {
        hideTip();
        return;
      }
      applyTipRect(tip, best);
      requestAnimationFrame(() => {
        tip.style.opacity = '1';
      });
    })();
  }, SHOW_DELAY);
}

function onViewportChange() {
  hideTip();
}

function bindGlobalListeners() {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
  // 焦点移到同应用其他窗口（快速录入小窗等）时立即隐藏，避免残影盖在新窗口下
  window.addEventListener('blur', onViewportChange);
}

interface TipHandlers {
  onEnter: () => void;
  onLeave: () => void;
  onFocusIn: () => void;
  onFocusOut: () => void;
  onClick: () => void;
}

const elHandlers = new WeakMap<HTMLElement, TipHandlers>();

export const vTip = {
  mounted(el: HTMLElement, binding: { value: TipValue }) {
    bindGlobalListeners();
    const onEnter = () => { currentEl = el; showTip(el, binding.value); };
    const onLeave = hideTip;
    const onFocusIn = () => { currentEl = el; showTip(el, binding.value); };
    const onFocusOut = hideTip;
    const onClick = hideTip;
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    el.addEventListener('click', onClick);
    elHandlers.set(el, { onEnter, onLeave, onFocusIn, onFocusOut, onClick });
  },
  updated(el: HTMLElement, binding: { value: TipValue }) {
    // 内容变化时若正在显示则刷新
    if (currentEl === el) showTip(el, binding.value);
  },
  unmounted(el: HTMLElement) {
    const handlers = elHandlers.get(el);
    if (handlers) {
      el.removeEventListener('mouseenter', handlers.onEnter);
      el.removeEventListener('mouseleave', handlers.onLeave);
      el.removeEventListener('focusin', handlers.onFocusIn);
      el.removeEventListener('focusout', handlers.onFocusOut);
      el.removeEventListener('click', handlers.onClick);
      elHandlers.delete(el);
    }
    if (currentEl === el) hideTip();
  },
};
