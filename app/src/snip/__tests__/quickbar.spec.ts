import { describe, expect, it } from 'vitest';
import {
  placeQuickBar,
  quickBarWidth,
  QUICKBAR_BUTTON,
  QUICKBAR_PADDING,
  QUICKBAR_HEIGHT,
} from '../quickbar';

const MON = { x: 0, y: 0, w: 1920, h: 1080 };
const BAR = { w: 140, h: 40 };

describe('quickBarWidth', () => {
  it('宽度 = 按钮数 × 按钮宽 + 两侧内边距', () => {
    expect(quickBarWidth(4)).toBe(4 * QUICKBAR_BUTTON + QUICKBAR_PADDING * 2);
    expect(quickBarWidth(3)).toBe(3 * QUICKBAR_BUTTON + QUICKBAR_PADDING * 2);
  });

  it('按钮数异常兜底为 1（不产生零/负宽度窗口）', () => {
    expect(quickBarWidth(0)).toBe(QUICKBAR_BUTTON + QUICKBAR_PADDING * 2);
    expect(quickBarWidth(-3)).toBe(QUICKBAR_BUTTON + QUICKBAR_PADDING * 2);
  });

  it('高度常量 = 按钮高 + 两侧内边距', () => {
    expect(QUICKBAR_HEIGHT).toBe(QUICKBAR_BUTTON + QUICKBAR_PADDING * 2);
  });
});

describe('placeQuickBar', () => {
  it('下方空间充足：贴在选区下方，左对齐', () => {
    expect(placeQuickBar({ x: 100, y: 100, w: 300, h: 200 }, MON, BAR)).toEqual({ x: 100, y: 308 });
  });

  it('下方越界：翻到选区上方', () => {
    const y = placeQuickBar({ x: 100, y: 900, w: 300, h: 150 }, MON, BAR);
    expect(y).toEqual({ x: 100, y: 900 - BAR.h - 8 });
  });

  it('选区贴顶且下方越界：钳制在显示器底边内', () => {
    const y = placeQuickBar({ x: 10, y: 0, w: 200, h: 1080 }, MON, BAR);
    expect(y.y).toBe(MON.h - BAR.h);
  });

  it('选区贴右边缘：水平钳制不越界', () => {
    const p = placeQuickBar({ x: 1900, y: 100, w: 100, h: 100 }, MON, BAR);
    expect(p.x).toBe(MON.w - BAR.w);
  });

  it('负原点副屏（左侧显示器）：坐标保持负值且不越界', () => {
    const mon = { x: -1920, y: 0, w: 1920, h: 1080 };
    const p = placeQuickBar({ x: -1900, y: 100, w: 200, h: 100 }, mon, BAR);
    expect(p).toEqual({ x: -1900, y: 208 });
  });

  it('副屏贴左边：钳制到副屏左边界', () => {
    const mon = { x: -1920, y: 0, w: 1920, h: 1080 };
    const p = placeQuickBar({ x: -1950, y: 100, w: 200, h: 100 }, mon, BAR);
    expect(p.x).toBe(-1920);
  });

  it('显示器比工具条还窄：回落到显示器左边界（不产生负坐标）', () => {
    const mon = { x: 0, y: 0, w: 100, h: 100 };
    const p = placeQuickBar({ x: 10, y: 10, w: 50, h: 50 }, mon, BAR);
    expect(p).toEqual({ x: 0, y: mon.h - BAR.h });
  });
});
