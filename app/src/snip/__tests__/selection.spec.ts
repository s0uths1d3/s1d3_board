import { describe, expect, it } from 'vitest';
import {
  clampRect,
  hitTestHandle,
  isValidSelection,
  MIN_SELECTION,
  moveRect,
  rectFromDrag,
  resizeByHandle,
} from '../selection';

describe('snip selection geometry', () => {
  it('rectFromDrag：负向拖拽翻正', () => {
    expect(rectFromDrag(100, 100, 40, 30, 1920, 1080)).toEqual({ x: 40, y: 30, w: 60, h: 70 });
  });

  it('rectFromDrag：越界钳制到屏幕内', () => {
    // 右下越界：宽高被钳制
    expect(rectFromDrag(1900, 1070, 2000, 1200, 1920, 1080)).toEqual({ x: 1900, y: 1070, w: 20, h: 10 });
    // 起点为负：钳到 0
    expect(rectFromDrag(-10, -10, 50, 50, 1920, 1080)).toEqual({ x: 0, y: 0, w: 50, h: 50 });
  });

  it('clampRect：越界部分裁掉（跟随指针，锚点不动）', () => {
    expect(clampRect({ x: 10, y: 10, w: 3000, h: 2000 }, 1920, 1080))
      .toEqual({ x: 10, y: 10, w: 1910, h: 1070 });
    expect(clampRect({ x: -10, y: -10, w: 60, h: 60 }, 1920, 1080))
      .toEqual({ x: 0, y: 0, w: 50, h: 50 });
  });

  it('hitTestHandle：角手柄命中', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    expect(hitTestHandle(rect, 100, 100)).toBe('nw');
    expect(hitTestHandle(rect, 300, 200)).toBe('se');
    expect(hitTestHandle(rect, 300, 100)).toBe('ne');
    expect(hitTestHandle(rect, 100, 200)).toBe('sw');
  });

  it('hitTestHandle：边中点手柄命中', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    expect(hitTestHandle(rect, 200, 100)).toBe('n');
    expect(hitTestHandle(rect, 300, 150)).toBe('e');
    expect(hitTestHandle(rect, 200, 200)).toBe('s');
    expect(hitTestHandle(rect, 100, 150)).toBe('w');
  });

  it('hitTestHandle：空白处返回 null', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    expect(hitTestHandle(rect, 200, 150)).toBeNull();
    expect(hitTestHandle(rect, 50, 50)).toBeNull();
  });

  it('resizeByHandle：拖角缩放', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    expect(resizeByHandle(rect, 'se', 350, 250, 1920, 1080)).toEqual({ x: 100, y: 100, w: 250, h: 150 });
    expect(resizeByHandle(rect, 'nw', 50, 80, 1920, 1080)).toEqual({ x: 50, y: 80, w: 250, h: 120 });
  });

  it('resizeByHandle：跨轴翻转翻正', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    // se 拖到 nw 左上方：翻正后起点变指针处
    expect(resizeByHandle(rect, 'se', 50, 60, 1920, 1080)).toEqual({ x: 50, y: 60, w: 50, h: 40 });
  });

  it('resizeByHandle：拖边调整且越界钳制', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    expect(resizeByHandle(rect, 'e', 1500, 150, 1920, 1080)).toEqual({ x: 100, y: 100, w: 1400, h: 100 });
    expect(resizeByHandle(rect, 'e', 5000, 150, 1920, 1080)).toEqual({ x: 100, y: 100, w: 1820, h: 100 });
  });

  it('moveRect：位移与钳制', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    expect(moveRect(rect, 50, -20, 1920, 1080)).toEqual({ x: 150, y: 80, w: 200, h: 100 });
    expect(moveRect(rect, 5000, 0, 1920, 1080)).toEqual({ x: 1720, y: 100, w: 200, h: 100 });
    expect(moveRect(rect, -500, 0, 1920, 1080)).toEqual({ x: 0, y: 100, w: 200, h: 100 });
  });

  it('isValidSelection：最小选区', () => {
    expect(isValidSelection({ x: 0, y: 0, w: MIN_SELECTION, h: MIN_SELECTION })).toBe(true);
    expect(isValidSelection({ x: 0, y: 0, w: MIN_SELECTION - 1, h: 50 })).toBe(false);
    expect(isValidSelection({ x: 0, y: 0, w: 50, h: 0 })).toBe(false);
  });
});
