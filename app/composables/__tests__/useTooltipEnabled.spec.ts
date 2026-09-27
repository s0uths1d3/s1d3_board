import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * tooltip 生命周期测试：closeTooltipWindows（主窗口隐藏/失焦路径调用）
 * - 仅关闭 tooltip- 前缀子窗口（close 而非 hide：父窗口隐藏期间子 WebView 挂起）
 * - 复位主窗口侧激活标志 __tooltipActive
 * - 非 Tauri 环境（纯 Web）直接返回，不触碰 Tauri API
 */

const mocks = vi.hoisted(() => {
    type FakeWin = { label: string; close: () => Promise<void> };
    return {
        getAllWindows: vi.fn<() => Promise<FakeWin[]>>(async () => []),
        tauri: false,
    };
});

vi.mock('@tauri-apps/api/window', () => ({
    getAllWindows: mocks.getAllWindows,
}));

vi.mock('~/utils/env', () => ({
    isTauri: () => mocks.tauri,
}));

import { closeTooltipWindows } from '../useTooltipEnabled';

function fakeWindow(label: string) {
    return {
        label,
        close: vi.fn(async () => {}),
    };
}

beforeEach(() => {
    mocks.getAllWindows.mockReset().mockResolvedValue([]);
    mocks.tauri = false;
    delete (window as any).__tooltipActive;
});

describe('closeTooltipWindows：tooltip 子窗口清理', () => {
    it('非 Tauri 环境：直接返回，不枚举窗口、不复位标志', async () => {
        (window as any).__tooltipActive = true;
        await closeTooltipWindows();
        expect(mocks.getAllWindows).not.toHaveBeenCalled();
        expect((window as any).__tooltipActive).toBe(true);
    });

    it('Tauri 环境：仅 close tooltip- 前缀窗口，其余窗口不动', async () => {
        mocks.tauri = true;
        const tooltipA = fakeWindow('tooltip-1');
        const main = fakeWindow('main');
        const island = fakeWindow('island-history');
        const tooltipB = fakeWindow('tooltip-abc');
        mocks.getAllWindows.mockResolvedValue([tooltipA, main, island, tooltipB]);
        (window as any).__tooltipActive = true;

        await closeTooltipWindows();

        expect(tooltipA.close).toHaveBeenCalledTimes(1);
        expect(tooltipB.close).toHaveBeenCalledTimes(1);
        expect(main.close).not.toHaveBeenCalled();
        expect(island.close).not.toHaveBeenCalled();
        expect((window as any).__tooltipActive).toBe(false);
    });

    it('窗口枚举失败：静默吞错，激活标志仍复位', async () => {
        mocks.tauri = true;
        mocks.getAllWindows.mockRejectedValue(new Error('tauri bridge unavailable'));
        (window as any).__tooltipActive = true;

        await expect(closeTooltipWindows()).resolves.toBeUndefined();
        expect((window as any).__tooltipActive).toBe(false);
    });

    it('close 单窗口失败不影响其余清理（close 内部吞错）', async () => {
        mocks.tauri = true;
        const bad = { label: 'tooltip-bad', close: vi.fn(async () => { throw new Error('x'); }) };
        const good = fakeWindow('tooltip-good');
        mocks.getAllWindows.mockResolvedValue([bad, good]);

        // w.close().catch(() => {}) 吞掉单窗口失败：closeTooltipWindows 正常完成
        await expect(closeTooltipWindows()).resolves.toBeUndefined();
        expect(good.close).toHaveBeenCalledTimes(1);
        expect((window as any).__tooltipActive).toBe(false);
    });
});
