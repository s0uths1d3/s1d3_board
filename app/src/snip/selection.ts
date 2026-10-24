/**
 * 截图选区几何纯函数（snip.vue 消费，vitest 覆盖）：
 * 拖拽建区 / 8 向手柄命中与缩放（含跨轴翻转）/ 边界钳制 / 最小选区判定。
 * 坐标一律为覆盖窗内逻辑像素（CSS px）；物理像素换算在页面 emit 边界完成。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 8 向手柄：四角 + 四边中点 */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** 最小有效选区（低于视为误触，取消选中） */
export const MIN_SELECTION = 8;
/** 手柄命中方形边长（CSS px） */
export const HANDLE_SIZE = 8;

/** 拖拽两点 → 规范矩形（负宽高翻正），并钳制在 [0, bound] 屏幕内 */
export function rectFromDrag(x1: number, y1: number, x2: number, y2: number, boundW: number, boundH: number): Rect {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  return clampRect({ x, y, w, h }, boundW, boundH);
}

/** 矩形钳制（拖拽/缩放语义）：四边各自钳进屏幕，越界部分裁掉（跟随指针，锚点不动） */
export function clampRect(rect: Rect, boundW: number, boundH: number): Rect {
  const x1 = Math.min(Math.max(0, rect.x), boundW);
  const y1 = Math.min(Math.max(0, rect.y), boundH);
  const x2 = Math.min(Math.max(0, rect.x + rect.w), boundW);
  const y2 = Math.min(Math.max(0, rect.y + rect.h), boundH);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 手柄锚点（矩形四角与四边中点） */
function handleAnchor(rect: Rect, handle: Handle): { ax: number; ay: number } {
  const { x, y, w, h } = rect;
  switch (handle) {
    case 'nw': return { ax: x, ay: y };
    case 'n': return { ax: x + w / 2, ay: y };
    case 'ne': return { ax: x + w, ay: y };
    case 'e': return { ax: x + w, ay: y + h / 2 };
    case 'se': return { ax: x + w, ay: y + h };
    case 's': return { ax: x + w / 2, ay: y + h };
    case 'sw': return { ax: x, ay: y + h };
    case 'w': return { ax: x, ay: y + h / 2 };
  }
}

/** 命中 8 向手柄（方形边长可传入以匹配视觉尺寸，默认 HANDLE_SIZE），未命中返回 null。
 *  角手柄优先于边手柄。 */
export function hitTestHandle(rect: Rect, px: number, py: number, size: number = HANDLE_SIZE): Handle | null {
  const corners: Handle[] = ['nw', 'ne', 'se', 'sw'];
  const edges: Handle[] = ['n', 'e', 's', 'w'];
  const half = Math.max(HANDLE_SIZE, size) / 2;
  const hit = (h: Handle): boolean => {
    const { ax, ay } = handleAnchor(rect, h);
    return px >= ax - half && px <= ax + half && py >= ay - half && py <= ay + half;
  };
  return corners.find(hit) ?? edges.find(hit) ?? null;
}

/** 拖动手柄后的新矩形：被拖的边/角跟随指针（可跨轴翻转），钳制在屏幕内 */
export function resizeByHandle(rect: Rect, handle: Handle, px: number, py: number, boundW: number, boundH: number): Rect {
  let ax1 = rect.x;
  let ay1 = rect.y;
  let ax2 = rect.x + rect.w;
  let ay2 = rect.y + rect.h;
  switch (handle) {
    case 'nw': ax1 = px; ay1 = py; break;
    case 'n': ay1 = py; break;
    case 'ne': ax2 = px; ay1 = py; break;
    case 'e': ax2 = px; break;
    case 'se': ax2 = px; ay2 = py; break;
    case 's': ay2 = py; break;
    case 'sw': ax1 = px; ay2 = py; break;
    case 'w': ax1 = px; break;
  }
  return clampRect(
    {
      x: Math.min(ax1, ax2),
      y: Math.min(ay1, ay2),
      w: Math.abs(ax2 - ax1),
      h: Math.abs(ay2 - ay1),
    },
    boundW,
    boundH,
  );
}

/** 选区内整体移动后的矩形（保尺寸平移，钳制在屏幕内） */
export function moveRect(rect: Rect, dx: number, dy: number, boundW: number, boundH: number): Rect {
  const x = Math.min(Math.max(0, rect.x + dx), Math.max(0, boundW - rect.w));
  const y = Math.min(Math.max(0, rect.y + dy), Math.max(0, boundH - rect.h));
  return { ...rect, x, y };
}

/** 最小选区判定（低于 MIN_SELECTION 视为误触） */
export function isValidSelection(rect: Rect): boolean {
  return rect.w >= MIN_SELECTION && rect.h >= MIN_SELECTION;
}
