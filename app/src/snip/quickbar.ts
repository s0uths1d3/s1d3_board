/**
 * 截图快速访问条几何（纯函数，vitest 覆盖）。
 *
 * 快速访问条是确认截图后浮现的小工具条（贴图 / OCR / 上传 / 历史），
 * 默认贴在选区左下角下方；下方放不下时翻到选区上方，整体钳制在显示器内。
 * 坐标与尺寸一律为物理像素（窗口 setPosition 直传，避免取整误差）。
 */

export interface QuickBarRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface QuickBarPlacement {
  /** 工具条左上角（物理像素，屏幕全局坐标） */
  x: number;
  y: number;
}

/** 工具条按钮尺寸与内边距（逻辑 px，页面与窗口尺寸共用） */
export const QUICKBAR_BUTTON = 28;
export const QUICKBAR_PADDING = 6;
export const QUICKBAR_HEIGHT = QUICKBAR_BUTTON + QUICKBAR_PADDING * 2;
export const QUICKBAR_GAP = 8;

/** 工具条逻辑宽度：按钮数 × 按钮宽 + 内边距（上传入口仅配置地址时显示） */
export function quickBarWidth(buttonCount: number): number {
  const n = Math.max(1, Math.round(buttonCount));
  return n * QUICKBAR_BUTTON + QUICKBAR_PADDING * 2;
}

/**
 * 计算工具条位置：
 *  1. 优先选区正下方（间隔 gap）
 *  2. 下方越出显示器底边 → 翻到选区上方
 *  3. 上方仍越界（选区内贴顶）→ 钳制到显示器内
 *  4. 水平钳制在显示器内（跨屏/贴右边缘时不越界）
 */
export function placeQuickBar(
  sel: QuickBarRect,
  monitor: QuickBarRect,
  bar: { w: number; h: number },
  gap = QUICKBAR_GAP,
): QuickBarPlacement {
  const maxX = monitor.x + monitor.w - bar.w;
  const x = Math.min(Math.max(sel.x, monitor.x), Math.max(monitor.x, maxX));

  const below = sel.y + sel.h + gap;
  const above = sel.y - bar.h - gap;
  const minY = monitor.y;
  const maxY = monitor.y + monitor.h - bar.h;
  let y = below;
  if (below > maxY) {
    y = above >= minY ? above : maxY;
  }
  y = Math.min(Math.max(y, minY), Math.max(minY, maxY));
  return { x, y };
}
