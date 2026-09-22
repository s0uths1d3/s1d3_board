import { describe, expect, it, vi, type Mock } from 'vitest';
import { bus } from '../../core/events';
import { createModuleContext } from '../../core/context';
import { createAppRegistry } from '../index';
import { initSmartClipListener } from '../../smart-clip/smartClip';
import { startClipboardListener, stopClipboardListener } from '../../clipboard/clipboardListener';
import { initCopyIsland } from '~/composables/useCopyIsland';
import { restoreIslandApiSetting, setupIslandHistoryBridge } from '../../island/islandApi';
import { restoreIslandWebhookSetting } from '../../island/islandWebhook';
import statsService from '../../statistics/statsService';
import { restoreAppUsageSetting } from '~/composables/useAppUsage';
import reminderService from '../../todo/reminderService';
import { initShortcuts, unregisterAllShortcuts } from '../../commands/shortcuts/InitShortcuts';
import { runDatabaseMigrations } from '../../core/db/migrator';

/**
 * 模块引导顺序集成测试：
 * 外部副作用（剪贴板插件 / Tauri 命令 / 定时器服务）全部桩化，
 * 只验证注册表驱动的生命周期顺序与原 app.vue 启动顺序硬约束的等价性。
 */
vi.mock('../../clipboard/clipboardListener', () => ({
    startClipboardListener: vi.fn(async () => {}),
    stopClipboardListener: vi.fn(async () => {}),
    suppressUseCountBump: vi.fn(),
}));
vi.mock('../../smart-clip/smartClip', () => ({ initSmartClipListener: vi.fn() }));
vi.mock('~/composables/useCopyIsland', () => ({ initCopyIsland: vi.fn() }));
vi.mock('../../island/islandApi', () => ({
    restoreIslandApiSetting: vi.fn(async () => {}),
    setupIslandHistoryBridge: vi.fn(async () => {}),
}));
vi.mock('../../island/islandWebhook', () => ({ restoreIslandWebhookSetting: vi.fn(async () => {}) }));
vi.mock('../../statistics/statsService', () => ({
    default: {
        record: vi.fn(async () => {}),
        flush: vi.fn(async () => {}),
        clearAll: vi.fn(async () => {}),
        startUsageTracking: vi.fn(),
        stopUsageTracking: vi.fn(),
        stopAppUsageTracking: vi.fn(),
    },
}));
vi.mock('~/composables/useAppUsage', () => ({ restoreAppUsageSetting: vi.fn(async () => {}) }));
vi.mock('../../todo/reminderService', () => ({ default: { start: vi.fn(async () => {}) } }));
vi.mock('../../commands/shortcuts/InitShortcuts', () => ({
    initShortcuts: vi.fn(async () => {}),
    unregisterAllShortcuts: vi.fn(async () => {}),
}));
vi.mock('../../core/db/migrator', () => ({ runDatabaseMigrations: vi.fn(async () => {}) }));

/** 构造可断言的模块上下文（db/config 为最小桩：boot 流程不触达它们） */
function makeCtx() {
    return createModuleContext({
        events: bus,
        db: {
            peek: () => undefined,
            ready: async () => ({}) as never,
            executeWithRetry: async () => undefined as never,
        },
        config: { get: async () => null, set: async () => {} },
    });
}

describe('模块注册表引导顺序（modules/index 装配）', () => {
    it('boot：smart-clip 监听先挂载 → clipboard 启动 → island → statistics → todo-reminder → shortcuts', async () => {
        const order: string[] = [];
        (initSmartClipListener as Mock).mockImplementation(() => { order.push('smart-clip.init'); });
        (startClipboardListener as Mock).mockImplementation(async () => { order.push('clipboard.start'); });
        (initCopyIsland as Mock).mockImplementation(() => { order.push('island.start'); });
        (restoreIslandApiSetting as Mock).mockImplementation(async () => { order.push('island.start'); });
        (setupIslandHistoryBridge as Mock).mockImplementation(async () => { order.push('island.start'); });
        (restoreIslandWebhookSetting as Mock).mockImplementation(async () => { order.push('island.start'); });
        (statsService.startUsageTracking as Mock).mockImplementation(() => { order.push('statistics.start'); });
        (restoreAppUsageSetting as Mock).mockImplementation(async () => { order.push('statistics.start'); });
        (reminderService.start as Mock).mockImplementation(async () => { order.push('todo-reminder.start'); });
        (initShortcuts as Mock).mockImplementation(async () => { order.push('shortcuts.start'); });

        const registry = createAppRegistry();
        await registry.boot(makeCtx());

        expect(order).toEqual([
            'smart-clip.init',
            'clipboard.start',
            'island.start', 'island.start', 'island.start', 'island.start',
            'statistics.start', 'statistics.start',
            'todo-reminder.start',
            'shortcuts.start',
        ]);
    });

    it('shutdown：stop 反拓扑序（shortcuts → statistics → clipboard），无 stop 的模块跳过', async () => {
        const order: string[] = [];
        (unregisterAllShortcuts as Mock).mockImplementation(async () => { order.push('shortcuts.stop'); });
        (statsService.stopUsageTracking as Mock).mockImplementation(() => { order.push('statistics.stop'); });
        (statsService.stopAppUsageTracking as Mock).mockImplementation(() => { order.push('statistics.stop'); });
        (stopClipboardListener as Mock).mockImplementation(async () => { order.push('clipboard.stop'); });

        const registry = createAppRegistry();
        await registry.boot(makeCtx());
        order.length = 0;
        await registry.shutdown();

        expect(order).toEqual(['shortcuts.stop', 'statistics.stop', 'statistics.stop', 'clipboard.stop']);
    });

    it('故障隔离：clipboard start 抛错被隔离，后续模块照常启动', async () => {
        (startClipboardListener as Mock).mockRejectedValueOnce(new Error('boom'));
        (initShortcuts as Mock).mockImplementation(async () => {});

        const registry = createAppRegistry();
        await registry.boot(makeCtx());

        expect(initCopyIsland).toHaveBeenCalled();
        expect(initShortcuts).toHaveBeenCalled();
    });
});
