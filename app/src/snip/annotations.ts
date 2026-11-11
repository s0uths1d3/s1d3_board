/**
 * 标注（annotation）数据结构与几何纯函数（snip.vue 消费，vitest 覆盖）。
 *
 * 设计原则：
 * - 本文件不依赖 DOM / Vue / canvas，文本尺寸测量以回调注入（页面注入真实
 *   measureText，测试注入确定性假实现），保证几何逻辑 100% 可单测。
 * - 坐标一律为覆盖窗内逻辑像素；物理像素换算只发生在页面 emit / 烘焙边界。
 * - 编辑操作（平移 / 手柄缩放 / 复制）返回新对象而不原地修改：便于撤销栈快照
 *   与测试断言，避免共享引用污染历史。
 */

import { resizeByHandle, type Handle, type Rect } from './selection';

/** 标注工具（矩形/椭圆/箭头/直线/画笔/荧光笔/文字/马赛克/序号） */
export type AnnoTool =
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'line'
  | 'pen'
  | 'highlighter'
  | 'text'
  | 'mosaic'
  | 'step';

/** 工具排列顺序（键盘 1~9 对应下标 0~8；0 为移动工具，见页面映射） */
export const ANNO_TOOLS: readonly AnnoTool[] = [
  'rect', 'ellipse', 'arrow', 'line', 'pen', 'highlighter', 'text', 'mosaic', 'step',
];

/** 拖拽类工具（矩形/椭圆/箭头/直线/马赛克）：用 (x1,y1)→(x2,y2) 对角表达 */
export const DRAG_TOOLS: readonly AnnoTool[] = ['rect', 'ellipse', 'arrow', 'line', 'mosaic'];

export interface Point {
  x: number;
  y: number;
}

/** 标注对象（页面与纯函数共用同一结构） */
export interface Annotation {
  id: number;
  tool: AnnoTool;
  color: string;
  /** 线宽/笔刷大小（文字工具为字号基准：字号 = size × 4） */
  size: number;
  /** 拖拽对角 / 文字落点 / 序号圆心 */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** pen/highlighter：采点折线（逻辑坐标） */
  points?: Point[];
  /** text：文本内容（\n 分行） */
  text?: string;
  /** text：白底衬块（创建时取当期开关） */
  bg?: boolean;
  /** mosaic：块大小（逻辑 px；马赛克=像素块，模糊=强度） */
  block?: number;
  /** mosaic：遮挡样式 */
  style?: 'mosaic' | 'blur';
  /** rect：圆角半径（逻辑 px，渲染再钳到 min(w,h)/2） */
  radius?: number;
  /** step：序号（创建时自增，删除后由 renumberSteps 重排） */
  label?: number;
}

/** 文本尺寸测量回调：返回逻辑像素宽高（多行时 h 应含行距） */
export type MeasureText = (text: string, fontSize: number) => { w: number; h: number };

/** 无 canvas 环境的确定性估算（测试 / 降级）：CJK 全角按 1em，ASCII 按 0.55em */
export function defaultMeasureText(text: string, fontSize: number): { w: number; h: number } {
  const lines = String(text ?? '').split('\n');
  let w = 0;
  for (const line of lines) {
    let lw = 0;
    for (const ch of line) {
      // eslint-disable-next-line no-control-regex
      lw += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? fontSize : fontSize * 0.55;
    }
    w = Math.max(w, lw);
  }
  const h = Math.max(1, lines.length) * fontSize * 1.3;
  return { w, h };
}

/** 序号圆半径（与页面渲染公式一致：size × 2，最小 6） */
export function stepRadius(size: number): number {
  return Math.max(6, size * 2);
}

/** 两点 → 规范矩形（负宽高翻正，不做边界钳制——钳制由页面按选区做） */
export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

/**
 * 标注的紧致几何包围盒（不含线宽外扩；命中判定用 hitBoundsOf）。
 * - rect/ellipse/mosaic：对角矩形；未成形（宽高均 0）返回 null
 * - arrow/line：两端点包围盒（允许单轴为 0，水平/垂直直线合法）
 * - pen/highlighter：采点包围盒
 * - text：注入测量得到的文本盒（空文本返回 null）
 * - step：以 (x1,y1) 为圆心的外接正方形
 */
export function boundsOf(a: Annotation, measure: MeasureText = defaultMeasureText): Rect | null {
  switch (a.tool) {
    case 'rect':
    case 'ellipse':
    case 'mosaic': {
      const r = normalizeRect(a.x1, a.y1, a.x2, a.y2);
      return r.w <= 0 || r.h <= 0 ? null : r;
    }
    case 'arrow':
    case 'line': {
      const r = normalizeRect(a.x1, a.y1, a.x2, a.y2);
      return r.w <= 0 && r.h <= 0 ? null : r;
    }
    case 'pen':
    case 'highlighter': {
      const pts = a.points ?? [];
      if (pts.length === 0) return null;
      if (pts.length === 1) return { x: pts[0]!.x, y: pts[0]!.y, w: 0, h: 0 };
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case 'text': {
      const text = a.text ?? '';
      if (!text) return null;
      const { w, h } = measure(text, a.size * 4);
      return { x: a.x1, y: a.y1, w, h };
    }
    case 'step': {
      const r = stepRadius(a.size);
      return { x: a.x1 - r, y: a.y1 - r, w: r * 2, h: r * 2 };
    }
  }
}

/** 命中包围盒（紧致盒外扩线宽/笔刷半径，最小 3px）：点选与拖拽拾取用 */
export function hitBoundsOf(a: Annotation, measure: MeasureText = defaultMeasureText): Rect | null {
  const b = boundsOf(a, measure);
  if (!b) return null;
  const pad = Math.max(3, a.size / 2);
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

/** 点是否落在矩形内（闭区间） */
export function pointInRect(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

/** 最上层命中标注（数组尾部即最上层）；无命中返回 null */
export function topmostAt(
  list: readonly Annotation[],
  px: number,
  py: number,
  measure: MeasureText = defaultMeasureText,
): Annotation | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const b = hitBoundsOf(list[i]!, measure);
    if (b && pointInRect(b, px, py)) return list[i]!;
  }
  return null;
}

/** 平移标注（返回新对象；折线逐点平移） */
export function translateAnno(a: Annotation, dx: number, dy: number): Annotation {
  const next: Annotation = {
    ...a,
    x1: a.x1 + dx,
    y1: a.y1 + dy,
    x2: a.x2 + dx,
    y2: a.y2 + dy,
    points: a.points ? a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) : undefined,
  };
  return next;
}

/** 单轴映射：旧包围盒 → 新包围盒；旧尺寸为 0 时统一落到新起点（退化轴） */
function mapAxis(v: number, oldStart: number, oldSize: number, newStart: number, newSize: number): number {
  if (oldSize === 0) return newStart;
  return newStart + ((v - oldStart) / oldSize) * newSize;
}

/** 把标注几何映射到新的包围盒（缩放核心） */
function remapToBounds(a: Annotation, oldB: Rect, newB: Rect): Annotation {
  const mx = (v: number) => mapAxis(v, oldB.x, oldB.w, newB.x, newB.w);
  const my = (v: number) => mapAxis(v, oldB.y, oldB.h, newB.y, newB.h);
  // 退化轴（水平/垂直直线 h=0 或 w=0）：两端点分别落到新盒两端，否则无法
  // 把一条水平线拉成斜线/竖线（单轴映射会把两端点塌缩到同一点）
  const rx1 = oldB.w === 0 ? newB.x : mx(a.x1);
  const rx2 = oldB.w === 0 ? newB.x + newB.w : mx(a.x2);
  const ry1 = oldB.h === 0 ? newB.y : my(a.y1);
  const ry2 = oldB.h === 0 ? newB.y + newB.h : my(a.y2);
  switch (a.tool) {
    case 'step': {
      const r = Math.max(6, Math.min(newB.w, newB.h) / 2);
      return {
        ...a,
        // 圆心 = 新盒中心；size 与半径保持渲染公式一致（r = size×2，最小 6）
        x1: newB.x + newB.w / 2,
        y1: newB.y + newB.h / 2,
        x2: newB.x + newB.w / 2,
        y2: newB.y + newB.h / 2,
        size: Math.min(80, Math.max(1, r / 2)),
      };
    }
    case 'text': {
      // 文字按高度比缩放字号（宽度由文字内容决定，不做横向拉伸）
      const ratio = oldB.h > 0 ? newB.h / oldB.h : 1;
      const size = Math.min(80, Math.max(1, a.size * ratio));
      return { ...a, size, x1: newB.x, y1: newB.y, x2: newB.x, y2: newB.y };
    }
    case 'pen':
    case 'highlighter':
      return {
        ...a,
        x1: mx(a.x1),
        y1: my(a.y1),
        x2: mx(a.x2),
        y2: my(a.y2),
        points: a.points?.map((p) => ({ x: mx(p.x), y: my(p.y) })),
      };
    default:
      return { ...a, x1: rx1, y1: ry1, x2: rx2, y2: ry2 };
  }
}

/**
 * 拖动手柄缩放标注：新包围盒由 `resizeByHandle` 推导（支持跨轴翻转），
 * 再把几何按比例映射进去。原标注无有效包围盒时原样返回。
 */
export function resizeAnnoByHandle(
  a: Annotation,
  handle: Handle,
  px: number,
  py: number,
  measure: MeasureText = defaultMeasureText,
): Annotation {
  const b = boundsOf(a, measure);
  if (!b) return a;
  const next = resizeByHandle(b, handle, px, py, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  return remapToBounds(a, b, next);
}

/** 复制标注（深拷贝折线；位置偏移；序号由调用方重排） */
export function cloneAnno(a: Annotation, newId: number, dx = 16, dy = 16): Annotation {
  return {
    ...a,
    id: newId,
    x1: a.x1 + dx,
    y1: a.y1 + dy,
    x2: a.x2 + dx,
    y2: a.y2 + dy,
    points: a.points ? a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) : undefined,
  };
}

/** 下一个序号（当前最大 label + 1；空列表为 1） */
export function nextStepLabel(list: readonly Annotation[]): number {
  let max = 0;
  for (const a of list) if (a.tool === 'step' && typeof a.label === 'number') max = Math.max(max, a.label);
  return max + 1;
}

/** 序号重排：按数组顺序把 step 标注的 label 重编为 1..n（删除后保持连续） */
export function renumberSteps(list: readonly Annotation[]): Annotation[] {
  let n = 0;
  return list.map((a) => (a.tool === 'step' ? { ...a, label: ++n } : a));
}
