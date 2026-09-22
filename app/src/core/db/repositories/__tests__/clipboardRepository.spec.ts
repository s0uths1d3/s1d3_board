import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { bus } from '../../../events';
import { createDatabaseConnection } from '../../connection';
import { createClipboardRepository } from '../clipboardRepository';
import { connWith, stubDb, type RecordedCall } from './helpers';

// decodeQrText / resolveImageRows / 原图文件删除经 @tauri-apps/api/core invoke 调 Rust 命令：桩化
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

type Conn = Awaited<ReturnType<typeof connWith>>;

function makeRepo(conn: Conn) {
    const getKeyValue = vi.fn(async () => '');
    const recordStats = vi.fn(async () => {});
    const repo = createClipboardRepository({ conn, getKeyValue, recordStats });
    return { repo, getKeyValue, recordStats };
}

describe('clipboardRepository', () => {
    it('saveClipboard 新插入：ON CONFLICT upsert + island:copy/smart-clip:copy（仅文本）+ 统计埋点 + 触发裁剪', async () => {
        const { db, selects, executes } = stubDb();
        const conn = await connWith(db);
        const { repo, getKeyValue, recordStats } = makeRepo(conn);
        const emitSpy = vi.spyOn(bus, 'emit');

        await repo.saveClipboard('hello', 'text');

        // 先查后插（区分新插入），INSERT 走 ON CONFLICT 单语句 upsert
        const probe = selects.find((c) => c.sql === 'SELECT id FROM clipboard WHERE content = $1');
        expect(probe?.params).toEqual(['hello']);
        expect(executes[0]?.sql).toContain('INSERT INTO clipboard');
        expect(executes[0]?.sql).toContain('ON CONFLICT(content) DO UPDATE SET count = count + $6, updated_at = $5');
        expect(executes[0]?.params).toEqual(['hello', 'T', 'text', expect.any(Number), expect.any(Number), 1, null, null]);
        // 岛事件 + 文本才有的 smart-clip 广播（lastInsertId 来自 execute 桩）
        expect(emitSpy).toHaveBeenCalledWith('island:copy', { content: 'hello', type: 'text', qrText: undefined });
        expect(emitSpy).toHaveBeenCalledWith('smart-clip:copy', { id: 101, content: 'hello', ts: expect.any(Number) });
        // 统计埋点（文本 + 字符量）与裁剪上限读取
        expect(recordStats).toHaveBeenCalledWith({ clip_text: 1, clip_chars: 5 });
        expect(getKeyValue).toHaveBeenCalledWith('max_save_count');
        emitSpy.mockRestore();
    });

    it('saveClipboard 已存在：不埋点不裁剪，仍派发 island:copy', async () => {
        const { db, selects } = stubDb((sql) => (sql.includes('SELECT id FROM clipboard') ? [{ id: 1 }] : []));
        const conn = await connWith(db);
        const { repo, recordStats } = makeRepo(conn);
        const emitSpy = vi.spyOn(bus, 'emit');

        await repo.saveClipboard('hello', 'text');

        expect(selects.filter((c) => c.sql.includes('clipboard'))).toHaveLength(1); // 只有查重 SELECT，无 COUNT(*) 裁剪查询
        expect(emitSpy).toHaveBeenCalledTimes(1);
        expect(emitSpy).toHaveBeenCalledWith('island:copy', { content: 'hello', type: 'text', qrText: undefined });
        expect(recordStats).not.toHaveBeenCalled();
        emitSpy.mockRestore();
    });

    it('saveClipboard 图片：island:copy 用 islandImageContent 原图（DB 存 imgfile: 引用）', async () => {
        const conn = await connWith(stubDb().db);
        const { repo } = makeRepo(conn);
        const emitSpy = vi.spyOn(bus, 'emit');

        await repo.saveClipboard('imgfile:abc.png', 'image', null, null, 'data:image/png;base64,AAA');

        expect(emitSpy).toHaveBeenCalledWith('island:copy', { content: 'data:image/png;base64,AAA', type: 'image', qrText: null });
        emitSpy.mockRestore();
    });

    it('fetchClipboardData：imgfile: 引用在读取边界换回原图 data URL', async () => {
        const { db } = stubDb(() => [{ id: 1, type: 'image', content: 'imgfile:a.png' }]);
        const conn = await connWith(db);
        const { repo } = makeRepo(conn);
        vi.mocked(invoke).mockResolvedValueOnce('data:image/png;base64,XXX');

        const rows = await repo.fetchClipboardData({ value: { favorite: 0, searchContent: '', type: 'all' } });

        expect(rows[0]?.content).toBe('data:image/png;base64,XXX');
        expect(vi.mocked(invoke)).toHaveBeenCalledWith('read_clipboard_image_file', { file: 'a.png' });
    });

    it('fetchClipboardData：收藏筛选走 is_favorite 条件 + 100 条上限', async () => {
        const { db, selects } = stubDb();
        const conn = await connWith(db);
        const { repo } = makeRepo(conn);

        await repo.fetchClipboardData({ value: { favorite: 1, searchContent: '', type: 'all' } });

        expect(selects.at(-1)?.sql).toContain('WHERE is_favorite = $1');
        expect(selects.at(-1)?.sql).toContain('LIMIT 100');
    });

    it('fetchClipboardData：搜索词 LIKE 转义 % _ \\ 并仅匹配文本', async () => {
        const { db, selects } = stubDb();
        const conn = await connWith(db);
        const { repo } = makeRepo(conn);

        await repo.fetchClipboardData({ value: { favorite: 0, searchContent: 'a%b_c', type: 'all' } });

        expect(selects.at(-1)?.sql).toContain("content LIKE $1 ESCAPE '\\' AND type = 'text'");
        expect(selects.at(-1)?.params).toEqual(['%a\\%b\\_c%']);
    });

    it('increaseUseCountByContent：命中按 id 递增，未命中不写库', async () => {
        const hitDb = stubDb(() => [{ id: 7 }]);
        const hitConn = await connWith(hitDb.db);
        const hit = makeRepo(hitConn);
        await hit.repo.increaseUseCountByContent('hello');
        expect(hitDb.executes.some((c: RecordedCall) => c.sql === 'UPDATE clipboard SET count = count + 1, updated_at = $2 WHERE id = $1')).toBe(true);

        const missDb = stubDb();
        const missConn = await connWith(missDb.db);
        const miss = makeRepo(missConn);
        await miss.repo.increaseUseCountByContent('hello');
        expect(missDb.executes).toHaveLength(0);
    });

    it('decodeQrText：连接未初始化返回 null（不触发加载）；识别成功写入且守卫覆盖空哨兵', async () => {
        // 未初始化：peek 为 undefined → 直接 null。
        // 用裸连接（不注册 Database.load mock）：peek 路径不该触发加载，
        // 否则滞留的 mockImplementationOnce 会让后续测试消费到错位桩
        const fresh = makeRepo(createDatabaseConnection());
        expect(await fresh.repo.decodeQrText(1, 'data:...')).toBeNull();

        // 初始化后：invoke 识别结果写库（NULL 或 '' 可覆盖）
        const { db, executes } = stubDb();
        const conn = await connWith(db);
        const { repo } = makeRepo(conn);
        await conn.ready(); // 先建立连接，peek 非 undefined
        vi.mocked(invoke).mockResolvedValueOnce('https://example.com');

        const result = await repo.decodeQrText(3, 'data:image/png;base64,AAA');

        expect(result).toBe('https://example.com');
        expect(executes[0]?.sql).toBe("UPDATE clipboard SET qr_text = $1 WHERE id = $2 AND (qr_text IS NULL OR qr_text = '')");
        expect(executes[0]?.params).toEqual(['https://example.com', 3]);
    });

    it('trimClipboard：超限裁剪排除收藏项，图片条目联动删原图文件，500/批', async () => {
        const victims = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, type: i === 0 ? 'image' : 'text', content: i === 0 ? 'imgfile:v.png' : 'text' }));
        const { db, selects, executes } = stubDb((sql) => {
            if (sql.includes('SELECT COUNT(*)')) return [{ cnt: 1600 }];
            if (sql.includes('WHERE is_favorite <> 1')) return victims;
            return [];
        });
        const conn = await connWith(db);
        const getKeyValue = vi.fn(async () => '1000');
        const repo = createClipboardRepository({ conn, getKeyValue, recordStats: vi.fn(async () => {}) });

        await repo.saveClipboard('trigger', 'text'); // 新插入触发裁剪

        const deleteCalls = executes.filter((c: RecordedCall) => c.sql.startsWith('DELETE FROM clipboard'));
        expect(deleteCalls).toHaveLength(2); // 600 = 500 + 100 两批
        expect(deleteCalls[0]?.sql).toContain('IN ($1');
        // 图片条目联动删除（fire-and-forget invoke，saveClipboard 返回前已发出）
        expect(vi.mocked(invoke)).toHaveBeenCalledWith('delete_clipboard_image_file', { file: 'v.png' });
        // 裁剪候选排除收藏项
        expect(selects.some((c) => c.sql.includes('WHERE is_favorite <> 1'))).toBe(true);
    });
});
