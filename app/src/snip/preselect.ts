/**
 * 截图入口预选几何（纯函数，snipManager 消费、vitest 覆盖）。
 *
 * 输入一律为**物理像素**（捕获范围 / 显示器 / 窗口探测 / 上次选区），
 * 输出为覆盖窗内**逻辑像素**（CSS px，前端页面直接可用）。
 *
 * 入口语义：
 *   region     = 自由框选（无预选）
 *   fullscreen = 光标所在显示器整屏（不是虚拟桌面并集：跨屏并集含非矩形空隙）
 *   window     = 光标下的窗口（探测结果）
 *   last       = 上次确认的选区
 */

import type { Rect } from './selection';

export type SnipEntryKind = 'region' | 'fullscreen' | 'window' | 'last';

/** 本次捕获覆盖的物理矩形（虚拟桌面并集或单屏） */
export interface CaptureBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 光标所在显示器（物理像素） */
export interface MonitorBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 入口 → 预选矩形（物理像素）；窗口/上次选区由调用方异步查好后传入 */
export function preselectSource(
  entry: SnipEntryKind,
  cap: CaptureBounds,
  cursorMon: MonitorBounds | null,
  windowRect: Rect | null,
  lastRegion: Rect | null,
): Rect | null {
  if (entry === 'fullscreen') {
    return cursorMon
      ? { x: cursorMon.x, y: cursorMon.y, w: cursorMon.w, h: cursorMon.h }
      : { x: cap.x, y: cap.y, w: cap.width, h: cap.height };
  }
  if (entry === 'window') return windowRect;
  if (entry === 'last') return lastRegion;
  return null;
}

/** 预选矩形裁剪到本次捕获范围并按 scale 换算成页面逻辑坐标；过小视为无效（null） */
export function clampPreselect(
  region: Rect | null,
  cap: CaptureBounds,
  scale: number,
): Rect | null {
  if (!region || region.w <= 0 || region.h <= 0) return null;
  const s = scale > 0 ? scale : 1;
  const x1 = Math.max(cap.x, region.x);
  const y1 = Math.max(cap.y, region.y);
  const x2 = Math.min(cap.x + cap.width, region.x + region.w);
  const y2 = Math.min(cap.y + cap.height, region.y + region.h);
  if (x2 - x1 < 2 || y2 - y1 < 2) return null;
  return {
    x: (x1 - cap.x) / s,
    y: (y1 - cap.y) / s,
    w: (x2 - x1) / s,
    h: (y2 - y1) / s,
  };
}
