/**
 * 截图入口预选几何测试：fullscreen / window / last 与钳制换算。
 * 覆盖多显示器（负坐标副屏）、裁剪越界、无效区域、scale 换算。
 */
import { describe, expect, it } from 'vitest';
import { clampPreselect, preselectSource } from '../preselect';

const cap = { x: 0, y: 0, width: 3840, height: 1080 };

describe('preselectSource', () => {
    it('region 无预选', () => {
        expect(preselectSource('region', cap, null, null, null)).toBeNull();
    });

    it('fullscreen 取光标所在显示器', () => {
        const mon = { x: 1920, y: 0, w: 1920, h: 1080 };
        expect(preselectSource('fullscreen', cap, mon, null, null)).toEqual({
            x: 1920, y: 0, w: 1920, h: 1080,
        });
    });

    it('fullscreen 副屏负坐标', () => {
        const mon = { x: -1920, y: -240, w: 1920, h: 1080 };
        const wide = { x: -1920, y: -240, width: 5760, height: 1320 };
        expect(preselectSource('fullscreen', wide, mon, null, null)).toEqual({
            x: -1920, y: -240, w: 1920, h: 1080,
        });
    });

    it('fullscreen 无光标屏信息时退回捕获范围', () => {
        expect(preselectSource('fullscreen', cap, null, null, null)).toEqual({
            x: 0, y: 0, w: 3840, h: 1080,
        });
    });

    it('window 使用窗口探测结果，缺失为 null', () => {
        const win = { x: 100, y: 50, w: 800, h: 600 };
        expect(preselectSource('window', cap, null, win, null)).toEqual(win);
        expect(preselectSource('window', cap, null, null, null)).toBeNull();
    });

    it('last 使用上次选区，缺失为 null', () => {
        const last = { x: 10, y: 20, w: 300, h: 200 };
        expect(preselectSource('last', cap, null, null, last)).toEqual(last);
        expect(preselectSource('last', cap, null, null, null)).toBeNull();
    });
});

describe('clampPreselect', () => {
    it('完全在范围内的 1x 屏：原样换算', () => {
        expect(clampPreselect({ x: 100, y: 100, w: 400, h: 300 }, cap, 1)).toEqual({
            x: 100, y: 100, w: 400, h: 300,
        });
    });

    it('2x 屏物理 → 逻辑（尺寸与偏移同除）', () => {
        expect(clampPreselect({ x: 200, y: 400, w: 800, h: 600 }, cap, 2)).toEqual({
            x: 100, y: 200, w: 400, h: 300,
        });
    });

    it('越界部分裁掉', () => {
        expect(clampPreselect({ x: -50, y: -50, w: 200, h: 100 }, cap, 1)).toEqual({
            x: 0, y: 0, w: 150, h: 50,
        });
    });

    it('完全在范围外返回 null', () => {
        expect(clampPreselect({ x: 5000, y: 5000, w: 100, h: 100 }, cap, 1)).toBeNull();
    });

    it('裁剪后小于 2px 视为无效', () => {
        expect(clampPreselect({ x: 3839, y: 0, w: 100, h: 100 }, cap, 1)).toBeNull();
    });

    it('无效尺寸返回 null', () => {
        expect(clampPreselect({ x: 0, y: 0, w: 0, h: 100 }, cap, 1)).toBeNull();
        expect(clampPreselect({ x: 0, y: 0, w: 100, h: 0 }, cap, 1)).toBeNull();
    });

    it('无预选返回 null', () => {
        expect(clampPreselect(null, cap, 1)).toBeNull();
    });

    it('scale 异常（0/负）兜底为 1', () => {
        expect(clampPreselect({ x: 10, y: 10, w: 20, h: 20 }, cap, 0)).toEqual({
            x: 10, y: 10, w: 20, h: 20,
        });
        expect(clampPreselect({ x: 10, y: 10, w: 20, h: 20 }, cap, -2)).toEqual({
            x: 10, y: 10, w: 20, h: 20,
        });
    });
});
