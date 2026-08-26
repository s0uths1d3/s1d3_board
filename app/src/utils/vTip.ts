/**
 * 全局 hover 提示指令（v-tip）
 *
 * 替换浏览器原生 title 属性，统一使用暖色主题提示气泡（样式见 main.css `.s1d3-tip`）。
 * - 单例 DOM 复用：所有 v-tip 共享同一个提示元素，hover / focus 时按目标定位显示；
 * - 默认显示在元素上方，空间不足自动翻转到下方，并做视口边界收进；
 * - 内容为空时不显示；滚动 / resize / 点击时自动隐藏。
 *
 * 用法：
 *   <button v-tip="'删除'">…</button>
 *   <div v-tip="{ content: '复制之王内容', placement: 'right' }">…</div>
 */
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

function positionTip(el: HTMLElement, tip: HTMLDivElement, placement: TipPlacement) {
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

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
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
    positionTip(el, tip, placement);
    requestAnimationFrame(() => {
      tip.style.opacity = '1';
    });
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
