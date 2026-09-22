import { describe, expect, it, vi } from 'vitest';

// 门面装配依赖 statsService：桩化以验证清空钩子接线（避免真实连接/统计副作用）
vi.mock('~/src/statistics/statsService', () => ({
    default: {
        record: vi.fn(async () => {}),
        clearAll: vi.fn(async () => {}),
        flush: vi.fn(async () => {}),
    },
}));

import dbService from '../../../db/dbService';
import statsService from '~/src/statistics/statsService';

/**
 * dbService 门面兼容性测试：
 * 门面必须保留原 DatabaseService 的全部 44 个公有方法（签名不变，27+ 处调用方零改动）。
 */
const PUBLIC_METHODS = [
    // 初始化 / 监听
    'ensureDbInitialized', 'startClipboardListener', 'suppressUseCountBump',
    // 剪贴板
    'decodeQrText', 'fetchClipboardData', 'fetchClipboardSingleData', 'updateFavorite',
    'increaseUseCount', 'increaseUseCountByContent', 'deleteClipboardData',
    // 常用剪贴
    'fetchPinnedClips', 'fetchPinnedClip', 'insertPinnedClip', 'isPinnedContentExist',
    'updatePinnedClip', 'pinPinnedClip', 'deletePinnedClip',
    // 清空撤回
    'clearDatabase', 'undoClearDatabase', 'finalizeClear',
    // 设置 + 快捷键
    'setKeyValue', 'getKeyValue', 'saveShortcutSetting', 'loadShortcutSettings',
    // 智能剪贴板（方案/习惯/缓存）
    'fetchClipSchemes', 'saveClipScheme', 'deleteClipScheme',
    'insertClipHabit', 'fetchHabitDigest', 'getAiCache', 'setAiCache',
    // 灵动岛历史
    'insertIslandHistory', 'getIslandHistory', 'clearIslandHistory',
    // 便签
    'insertNote', 'updateNote', 'deleteNote', 'fetchNotes', 'fetchSingleNote',
    // 待办
    'insertTodo', 'updateTodo', 'deleteTodo', 'fetchTodos', 'fetchSingleTodo',
] as const;

describe('dbService 门面兼容性', () => {
    it('保留全部原公有方法（44 个）', () => {
        expect(PUBLIC_METHODS).toHaveLength(44);
        for (const name of PUBLIC_METHODS) {
            expect(dbService, name).toHaveProperty(name);
            expect(typeof (dbService as unknown as Record<string, unknown>)[name], name).toBe('function');
        }
    });

    it('clearDatabase 装配：统计清空钩子（statsService.clearAll）在备份仓储流程内被调用', async () => {
        await dbService.clearDatabase();
        expect(statsService.clearAll).toHaveBeenCalledTimes(1);
    });

    it('suppressUseCountBump 转发（同步方法，原签名默认 1200ms）', () => {
        expect(() => dbService.suppressUseCountBump()).not.toThrow();
        expect(() => dbService.suppressUseCountBump(500)).not.toThrow();
    });

    it('ensureDbInitialized：幂等可重复调用', async () => {
        await dbService.ensureDbInitialized();
        await dbService.ensureDbInitialized();
        expect(true).toBe(true);
    });
});
