import { describe, expect, it } from 'vitest';
import {
  ANNO_TOOLS,
  boundsOf,
  cloneAnno,
  defaultMeasureText,
  hitBoundsOf,
  nextStepLabel,
  normalizeRect,
  pointInRect,
  renumberSteps,
  resizeAnnoByHandle,
  stepRadius,
  topmostAt,
  translateAnno,
  type Annotation,
  type MeasureText,
} from '../annotations';

/** 确定性文本测量：宽度 = 字符数 × 字号 / 2，高度 = 行数 × 字号 × 1.3 */
const fakeMeasure: MeasureText = (text, fontSize) => {
  const lines = text.split('\n');
  const w = Math.max(...lines.map((l) => l.length * (fontSize / 2)));
  return { w, h: lines.length * fontSize * 1.3 };
};

function anno(partial: Partial<Annotation>): Annotation {
  return {
    id: 1,
    tool: 'rect',
    color: '#f0b429',
    size: 5,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    ...partial,
  };
}

describe('snip annotations：基础几何', () => {
  it('normalizeRect 负向拖拽翻正', () => {
    expect(normalizeRect(100, 80, 20, 30)).toEqual({ x: 20, y: 30, w: 80, h: 50 });
  });

  it('stepRadius 最小 6，否则 size×2', () => {
    expect(stepRadius(1)).toBe(6);
    expect(stepRadius(3)).toBe(6);
    expect(stepRadius(5)).toBe(10);
  });

  it('defaultMeasureText：ASCII 窄、CJK 全角、多行高度累加', () => {
    const a = defaultMeasureText('abc', 10);
    expect(a.w).toBeCloseTo(16.5);
    expect(a.h).toBeCloseTo(13);
    const cjk = defaultMeasureText('中文', 10);
    expect(cjk.w).toBeCloseTo(20);
    const multi = defaultMeasureText('a\nb\nc', 10);
    expect(multi.h).toBeCloseTo(39);
  });

  it('ANNO_TOOLS 顺序与键盘 1~9 一致', () => {
    expect(ANNO_TOOLS).toEqual(['rect', 'ellipse', 'arrow', 'line', 'pen', 'highlighter', 'text', 'mosaic', 'step']);
  });
});

describe('snip annotations：boundsOf', () => {
  it('矩形/椭圆/马赛克：对角盒；未成形返回 null', () => {
    expect(boundsOf(anno({ x1: 300, y1: 200, x2: 100, y2: 50 }))).toEqual({ x: 100, y: 50, w: 200, h: 150 });
    expect(boundsOf(anno({ tool: 'ellipse', x1: 10, y1: 10, x2: 10, y2: 10 }))).toBeNull();
    expect(boundsOf(anno({ tool: 'mosaic', x1: 0, y1: 0, x2: 0, y2: 9 }))).toBeNull();
  });

  it('直线/箭头：单轴为 0 合法（水平/垂直线）', () => {
    expect(boundsOf(anno({ tool: 'line', x1: 100, y1: 150, x2: 300, y2: 150 })))
      .toEqual({ x: 100, y: 150, w: 200, h: 0 });
    expect(boundsOf(anno({ tool: 'arrow', x1: 50, y1: 300, x2: 50, y2: 100 })))
      .toEqual({ x: 50, y: 100, w: 0, h: 200 });
    expect(boundsOf(anno({ tool: 'line', x1: 5, y1: 5, x2: 5, y2: 5 }))).toBeNull();
  });

  it('画笔/荧光笔：采点包围盒；单点/空点', () => {
    const pen = anno({ tool: 'pen', points: [{ x: 10, y: 20 }, { x: 60, y: 40 }, { x: 30, y: 90 }] });
    expect(boundsOf(pen)).toEqual({ x: 10, y: 20, w: 50, h: 70 });
    expect(boundsOf(anno({ tool: 'highlighter', points: [{ x: 7, y: 9 }] }))).toEqual({ x: 7, y: 9, w: 0, h: 0 });
    expect(boundsOf(anno({ tool: 'pen', points: [] }))).toBeNull();
  });

  it('文字：注入测量；空文本返回 null', () => {
    const a = anno({ tool: 'text', x1: 40, y1: 60, size: 5, text: 'abcd' });
    expect(boundsOf(a, fakeMeasure)).toEqual({ x: 40, y: 60, w: 40, h: 26 });
    expect(boundsOf(anno({ tool: 'text', text: '' }), fakeMeasure)).toBeNull();
  });

  it('序号：以圆心为中的外接正方形', () => {
    expect(boundsOf(anno({ tool: 'step', x1: 200, y1: 150, size: 5 }))).toEqual({ x: 190, y: 140, w: 20, h: 20 });
  });

  it('hitBoundsOf：外扩 max(3, size/2)', () => {
    const small = anno({ x1: 100, y1: 100, x2: 200, y2: 200, size: 4 });
    expect(hitBoundsOf(small)).toEqual({ x: 97, y: 97, w: 106, h: 106 });
    const thick = anno({ tool: 'arrow', x1: 100, y1: 100, x2: 200, y2: 100, size: 20 });
    expect(hitBoundsOf(thick)).toEqual({ x: 90, y: 90, w: 120, h: 20 });
  });

  it('pointInRect 闭区间', () => {
    const r = { x: 10, y: 10, w: 100, h: 50 };
    expect(pointInRect(r, 10, 10)).toBe(true);
    expect(pointInRect(r, 110, 60)).toBe(true);
    expect(pointInRect(r, 111, 60)).toBe(false);
  });
});

describe('snip annotations：拾取', () => {
  it('topmostAt 取最上层（数组尾部）', () => {
    const bottom = anno({ id: 1, x1: 0, y1: 0, x2: 200, y2: 200 });
    const top = anno({ id: 2, tool: 'ellipse', x1: 50, y1: 50, x2: 150, y2: 150 });
    expect(topmostAt([bottom, top], 100, 100)?.id).toBe(2);
    expect(topmostAt([bottom, top], 10, 10)?.id).toBe(1);
    expect(topmostAt([bottom, top], 500, 500)).toBeNull();
  });

  it('topmostAt 支持线宽外扩命中（细线可点中）', () => {
    const line = anno({ tool: 'line', x1: 0, y1: 100, x2: 200, y2: 100, size: 2 });
    expect(topmostAt([line], 100, 102)?.id).toBe(1);
    expect(topmostAt([line], 100, 110)).toBeNull();
  });
});

describe('snip annotations：平移与复制', () => {
  it('translateAnno 整体位移且不修改原对象', () => {
    const a = anno({ x1: 10, y1: 20, x2: 110, y2: 220 });
    const b = translateAnno(a, 5, -10);
    expect(b).toMatchObject({ x1: 15, y1: 10, x2: 115, y2: 210 });
    expect(a).toMatchObject({ x1: 10, y1: 20 });
    expect(b).not.toBe(a);
  });

  it('translateAnno 逐点平移折线', () => {
    const a = anno({ tool: 'pen', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
    const b = translateAnno(a, 10, 20);
    expect(b.points).toEqual([{ x: 11, y: 22 }, { x: 13, y: 24 }]);
    expect(a.points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  });

  it('cloneAnno 深拷贝折线并偏移', () => {
    const a = anno({ tool: 'pen', points: [{ x: 0, y: 0 }] });
    const b = cloneAnno(a, 99, 16, 16);
    expect(b.id).toBe(99);
    expect(b.points).toEqual([{ x: 16, y: 16 }]);
    expect(b.points).not.toBe(a.points);
  });
});

describe('snip annotations：手柄缩放', () => {
  it('矩形 se 缩放', () => {
    const a = anno({ x1: 100, y1: 100, x2: 300, y2: 200 });
    expect(resizeAnnoByHandle(a, 'se', 350, 250)).toMatchObject({ x1: 100, y1: 100, x2: 350, y2: 250 });
  });

  it('矩形 nw 缩放（左上扩展）', () => {
    const a = anno({ x1: 100, y1: 100, x2: 300, y2: 200 });
    expect(resizeAnnoByHandle(a, 'nw', 50, 80)).toMatchObject({ x1: 50, y1: 80, x2: 300, y2: 200 });
  });

  it('矩形跨轴翻转（se 拖到左上）', () => {
    const a = anno({ x1: 100, y1: 100, x2: 200, y2: 200 });
    // 新盒 = {50,60,50,40}：原对角几何按比例映射，仍然落在盒内
    expect(resizeAnnoByHandle(a, 'se', 50, 60)).toMatchObject({ x1: 50, y1: 60, x2: 100, y2: 100 });
  });

  it('水平直线下拉成斜线（退化轴处理）', () => {
    const a = anno({ tool: 'line', x1: 100, y1: 150, x2: 300, y2: 150 });
    expect(resizeAnnoByHandle(a, 's', 200, 250)).toMatchObject({ x1: 100, y1: 150, x2: 300, y2: 250 });
  });

  it('垂直直线左拉成斜线（退化轴处理）', () => {
    const a = anno({ tool: 'line', x1: 50, y1: 100, x2: 50, y2: 300 });
    // 左边界拖到 10：盒宽 40，两端点分别落到左右边界 → 斜线
    expect(resizeAnnoByHandle(a, 'w', 10, 200)).toMatchObject({ x1: 10, y1: 100, x2: 50, y2: 300 });
  });

  it('画笔按比例缩放每个点', () => {
    const a = anno({ tool: 'pen', points: [{ x: 100, y: 100 }, { x: 200, y: 200 }] });
    const b = resizeAnnoByHandle(a, 'se', 250, 250);
    expect(b.points).toEqual([{ x: 100, y: 100 }, { x: 250, y: 250 }]);
  });

  it('文字按高度比缩放字号', () => {
    const a = anno({ tool: 'text', x1: 100, y1: 100, size: 5, text: 'x' });
    // 原盒 h = 26；拉到 h = 52 → 字号翻倍
    const b = resizeAnnoByHandle(a, 's', 0, 152, fakeMeasure);
    expect(b.size).toBeCloseTo(10);
    expect(b).toMatchObject({ x1: 100, y1: 100 });
  });

  it('序号缩放：圆心居中、半径跟随、字号钳制到上限 80', () => {
    const a = anno({ tool: 'step', x1: 200, y1: 200, size: 5, label: 1 });
    const b = resizeAnnoByHandle(a, 'se', 240, 240);
    expect(b.x1).toBe(215);
    expect(b.y1).toBe(215);
    expect(b.size).toBeCloseTo(12.5);
    const huge = anno({ tool: 'step', x1: 0, y1: 0, size: 5 });
    expect(resizeAnnoByHandle(huge, 'se', 400, 400).size).toBe(80);
  });

  it('无有效包围盒的标注原样返回', () => {
    const a = anno({ x1: 0, y1: 0, x2: 0, y2: 0 });
    expect(resizeAnnoByHandle(a, 'se', 10, 10)).toBe(a);
  });

  it('缩放不修改原对象', () => {
    const a = anno({ x1: 100, y1: 100, x2: 300, y2: 200 });
    resizeAnnoByHandle(a, 'se', 400, 300);
    expect(a).toMatchObject({ x2: 300, y2: 200 });
  });
});

describe('snip annotations：序号管理', () => {
  it('nextStepLabel 取最大 +1，空列表为 1', () => {
    expect(nextStepLabel([])).toBe(1);
    expect(nextStepLabel([anno({ tool: 'step', label: 3 }), anno({ tool: 'rect' })])).toBe(4);
  });

  it('renumberSteps 删除后保持连续编号', () => {
    const list = [
      anno({ id: 1, tool: 'step', label: 1 }),
      anno({ id: 2, tool: 'rect' }),
      anno({ id: 3, tool: 'step', label: 4 }),
    ];
    expect(renumberSteps(list).map((x) => x.label)).toEqual([1, undefined, 2]);
    expect(renumberSteps([])).toEqual([]);
  });
});
