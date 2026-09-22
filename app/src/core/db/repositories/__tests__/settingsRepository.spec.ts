import { describe, expect, it, vi } from 'vitest';
import { createSettingsRepository } from '../settingsRepository';
import { connWith, stubDb } from './helpers';

describe('settingsRepository', () => {
    it('setKeyValue：UPSERT（首次设置的 key 也能写入）', async () => {
        const { db, executes } = stubDb();
        const repo = createSettingsRepository({ conn: await connWith(db) });

        await repo.setKeyValue('k', 'v');

        expect(executes[0]?.sql).toContain("INSERT INTO settings (key, value, type, updated_at) VALUES ($1, $2, 'other', $3)");
        expect(executes[0]?.sql).toContain('ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = $3');
        expect(executes[0]?.params).toEqual(['k', 'v', expect.any(Number)]);
    });

    it('getKeyValue：有行返回值，无行返回空串', async () => {
        const { db, selects } = stubDb((sql) => (sql.includes('FROM settings') ? [{ value: '1000' }] : []));
        const repo = createSettingsRepository({ conn: await connWith(db) });

        expect(await repo.getKeyValue('max_save_count')).toBe('1000');
        expect(selects.at(-1)?.sql).toBe('SELECT value FROM settings WHERE key = $1');

        const empty = createSettingsRepository({ conn: await connWith(stubDb().db) });
        expect(await empty.getKeyValue('missing')).toBe('');
    });

    it('saveShortcutSetting：已有记录 UPDATE，无记录 INSERT', async () => {
        const updDb = stubDb(() => [{ id: 1 }]);
        const updRepo = createSettingsRepository({ conn: await connWith(updDb.db) });
        await updRepo.saveShortcutSetting('paste', 'Ctrl+V', 'global', '粘贴');
        expect(updDb.executes[0]?.sql).toContain('UPDATE shortcut_binding SET key = $1');

        const insDb = stubDb();
        const insRepo = createSettingsRepository({ conn: await connWith(insDb.db) });
        await insRepo.saveShortcutSetting('paste', 'Ctrl+V', 'global', '粘贴');
        expect(insDb.executes[0]?.sql).toContain('INSERT INTO shortcut_binding (shortcut_id, key, scope, description, updated_at)');
    });

    it('loadShortcutSettings：过滤非字符串 shortcut_id', async () => {
        const { db } = stubDb(() => [{ shortcut_id: 'a', key: 'Ctrl+K' }, { shortcut_id: 3, key: 'X' }]);
        const repo = createSettingsRepository({ conn: await connWith(db) });

        expect(await repo.loadShortcutSettings()).toEqual([{ id: 'a', value: 'Ctrl+K' }]);
    });
});
