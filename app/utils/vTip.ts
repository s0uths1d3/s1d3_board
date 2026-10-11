/**
 * 全局 hover 提示指令（v-tip）
 *
 * 替换浏览器原生 title 属性，统一使用暖色主题提示气泡（样式见 main.css `.s1d3-tip`）。
 * - 单例 DOM 复用：所有 v-tip 共享同一个提示元素，hover / focus 时按目标定位显示；
 * - 默认显示在元素上方，首选方位放不下时翻转到对侧；两侧都放不下取剩余空间更大的一侧
 *   贴边收进，尽量不遮盖触发元素（此前无条件 clamp 会把气泡压回视口内盖住控件）；
 * - 兄弟窗口避让：tooltip 属于本窗口 surface，无法越过同应用的其他原生窗口
 *   （如快速录入小窗），显示前通过 Tauri API 取兄弟窗口矩形，四个方位中选
 *   与其重叠最小者；几乎完全被盖住（≥90%）时直接不显示。本窗口持有焦点时
 *   同应用窗口必在其下，跳过避让，气泡始终落在窗口内空间充裕的方位；
 * - 内容为空时不显示；滚动 / resize / 失焦 / 按下时自动隐藏；
 *   焦点触发的提示仅限键盘导航（focus-visible），鼠标点击落焦不弹气泡，
 *   避免操作后的提示气泡与灵动岛等操作反馈同时出现、互相打架。
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
/** 默认悬停延时：短暂路过不弹，避免鼠标路过时被连续弹出的气泡打断 */
const DEFAULT_SHOW_DELAY = 1000;
/** 当前悬停显示延时（经 configureVTip 注入覆盖；未注入时用默认值） */
let showDelay = DEFAULT_SHOW_DELAY;

/**
 * 外部注入 v-tip 配置：目前仅支持 showDelay（悬停多久才弹出提示，ms）。
 * 其余常量（间距 GAP、隐藏时机等）保持内部默认，不接受注入。
 * 典型用法：设置页等信息密度高的页面注入更短延时（如 300），卸载时还原默认值。
 */
export function configureVTip(options: { showDelay?: number }): void {
  if (typeof options?.showDelay === 'number' && options.showDelay >= 0) {
    showDelay = options.showDelay;
  }
}

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
  // 绑定值为 undefined/null（如可选 tip 未配置）时按空内容处理，由 showTip 的空内容短路兜住
  if (value == null) return { content: '', placement: 'top' };
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
 * 放置轴上二选一：首选方位放不下且对侧放得下才翻转；两侧都放不下取剩余空间
 * 更大的一侧贴边收进——保证气泡不因边界 clamp 被压回盖住触发元素
 * （设置页靠近窗口上下边框的开关提示，此前会被顶回盖在开关上）。
 * 垂直轴的横向收进 / 水平轴的纵向收进不与触发元素重叠，保持原样。
 */
function computeTipRect(el: HTMLElement, tip: HTMLDivElement, placement: TipPlacement, size: Rect): Rect {
  const rect = el.getBoundingClientRect();
  const tw = size.width;
  const th = size.height;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = 0;
  let left = 0;

  if (placement === 'top' || placement === 'bottom') {
    // 纵向：上方 = 触发元素上沿减气泡高，下方 = 下沿加间距，二选一互不重叠
    const above = rect.top - th - GAP;
    const below = rect.bottom + GAP;
    const fitsAbove = above >= 6;
    const fitsBelow = below + th <= vh - 6;
    if (placement === 'top') {
      top = fitsAbove ? above
        : fitsBelow ? below
          // 两侧都放不下（兜底）：取剩余空间更大的一侧
          : (rect.top >= vh - rect.bottom ? above : below);
    } else {
      top = fitsBelow ? below
        : fitsAbove ? above
          : (rect.top >= vh - rect.bottom ? above : below);
    }
    if (!fitsAbove && !fitsBelow) {
      // 兜底贴边收进（几何上无法完全避让，可能部分盖住触发元素）
      top = Math.max(6, Math.min(top, vh - th - 6));
    }
    // 横向：以触发元素水平居中，越界时收进（横向收进不会盖住触发元素）
    left = Math.max(6, Math.min(rect.left + rect.width / 2 - tw / 2, vw - tw - 6));
  } else {
    // 横向：左侧 = 触发元素左沿减气泡宽，右侧 = 右沿加间距（与纵轴对称）
    const atLeft = rect.left - tw - GAP;
    const atRight = rect.right + GAP;
    const fitsLeft = atLeft >= 6;
    const fitsRight = atRight + tw <= vw - 6;
    if (placement === 'left') {
      left = fitsLeft ? atLeft
        : fitsRight ? atRight
          // 两侧都放不下（兜底）：取剩余空间更大的一侧
          : (rect.left >= vw - rect.right ? atLeft : atRight);
    } else {
      left = fitsRight ? atRight
        : fitsLeft ? atLeft
          : (rect.left >= vw - rect.right ? atLeft : atRight);
    }
    if (!fitsLeft && !fitsRight) {
      left = Math.max(6, Math.min(left, vw - tw - 6));
    }
    // 纵向：以触发元素垂直居中，越界时收进（气泡在侧面，纵向收进不会盖住它）
    top = Math.max(6, Math.min(rect.top + rect.height / 2 - th / 2, vh - th - 6));
  }

  return { left, top, width: tw, height: th };
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
    const cur = getCurrentWindow();
    // 本窗口持有焦点 ⇒ 同应用其他窗口都在其下，不可能遮挡本窗口 surface 上的
    // tooltip，直接跳过避让——否则主窗口最大化铺底（位于本窗口之下）时其矩形
    // 覆盖整个视口，所有候选方位重叠≈100%：tooltip 要么被 ≥90% 抑制不显示，
    // 要么被挤到边角。仅焦点不在本窗口时（可能被同应用窗口压住）才避让。
    if (await cur.isFocused()) return [];
    const all = await Window.getAll();
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
      // 先取兄弟窗口坐标再测算：落位测量尽量靠近应用时机，
      // 避免 async 间隙里布局漂移（换行/字体就绪等）导致测算尺寸失真
      const occluders = await getOccluders();
      // 等待兄弟窗口坐标期间指针已移开则放弃
      if (currentEl !== el) return;
      // 气泡尺寸用 offsetWidth/Height（布局尺寸，不受过渡/变换影响）；
      // 候选方位：首选在前；严格更优才替换，天然偏向首选方位
      const size = { left: 0, top: 0, width: tip.offsetWidth, height: tip.offsetHeight };
      const candidates = ([placement, 'top', 'bottom', 'left', 'right'] as TipPlacement[])
        .filter((p, i, arr) => arr.indexOf(p) === i)
        .map(p => computeTipRect(el, tip, p, size));
      const area = size.width * size.height || 1;
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
      // 落位复核：按真实渲染框实测，若仍越出视口（测算与渲染不一致的兜底），
      // 原位平移收进——保证气泡任何情况下不被窗口边框裁切
      requestAnimationFrame(() => {
        if (currentEl !== el) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const real = tip.getBoundingClientRect();
        let dx = 0;
        let dy = 0;
        if (real.right > vw - 6) dx = vw - 6 - real.right;
        if (real.left + dx < 6) dx = 6 - real.left;
        if (real.bottom > vh - 6) dy = vh - 6 - real.bottom;
        if (real.top + dy < 6) dy = 6 - real.top;
        if (dx || dy) applyTipRect(tip, { ...best, left: best.left + dx, top: best.top + dy });
        tip.style.opacity = '1';
      });
    })();
  }, showDelay);
}

function onViewportChange() {
  hideTip();
}

function bindGlobalListeners() {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
  // 任意按下（鼠标/触控）立即隐藏：操作发生时提示让位给灵动岛等操作反馈，不再共存
  document.addEventListener('pointerdown', onViewportChange, true);
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
    const onFocusIn = () => {
      // 仅键盘导航（focus-visible）触发焦点提示：鼠标点击落下的焦点不弹气泡，
      // 否则点击开关/分段选项后气泡常驻，与灵动岛操作反馈同时出现产生冲突
      if (!el.matches(':focus-visible')) return;
      currentEl = el; showTip(el, binding.value);
    };
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
