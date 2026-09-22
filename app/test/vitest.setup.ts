import { vi } from 'vitest';

/**
 * 全局 mock：@tauri-apps/plugin-sql
 *
 * 仓储层/连接层测试不依赖真实 Tauri 运行时。被测代码 `Database.load(path)`
 * 拿到的是 MockDatabase 实例；测试内通过 `vi.mocked(Database.load)` 读取
 * 调用记录，或从 mock.results 取实例后对其 select/execute 打桩。
 *
 * 默认桩行为与 tauri-plugin-sql 签名一致：
 * - select: 返回 []（空结果集）
 * - execute: 返回 { rowsAffected: 0, lastInsertId: undefined }
 */
vi.mock('@tauri-apps/plugin-sql', () => {
    class MockDatabase {
        select = vi.fn(async () => []);
        execute = vi.fn(async () => ({ rowsAffected: 0, lastInsertId: undefined }));
        close = vi.fn(async () => {});
    }

    const load = vi.fn(async () => new MockDatabase());

    return {
        default: { load },
        __MockDatabase: MockDatabase,
    };
});
