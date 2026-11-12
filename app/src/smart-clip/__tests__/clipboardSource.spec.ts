import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
    readText: vi.fn(),
    readFiles: vi.fn(),
    invoke: vi.fn(),
    fetchRecentImageQr: vi.fn(),
}));

vi.mock('tauri-plugin-clipboard-api', () => ({
    readText: h.readText,
    readFiles: h.readFiles,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('~/src/db/dbService', () => ({ default: { fetchRecentImageQr: h.fetchRecentImageQr } }));

import { resolveClipboardSource } from '../clipboardSource';

describe('resolveClipboardSource（Ctrl+B 唯一内容源）', () => {
    beforeEach(() => {
        h.readText.mockReset();
        h.readFiles.mockReset();
        h.invoke.mockReset();
        h.fetchRecentImageQr.mockReset();
        // 默认：不是图片、没有文件
        h.invoke.mockResolvedValue({ seq: 1, hasDib: false });
        h.readFiles.mockResolvedValue([]);
    });

    it('文本优先：返回剪贴板文本并标记 origin=text', async () => {
        h.readText.mockResolvedValue('  第一段\n第二段  ');
        const src = await resolveClipboardSource();
        expect(src).toEqual({ kind: 'text', content: '  第一段\n第二段  ', origin: 'text' });
        // 文本命中后不再探测图片/文件（避免额外 IPC）
        expect(h.invoke).not.toHaveBeenCalled();
        expect(h.readFiles).not.toHaveBeenCalled();
    });

    it('读取剪贴板持续抛错：重试后仍失败，继续探测图片/文件后返回 error', async () => {
        const err = new Error('Get text error, code = 5');
        h.readText.mockRejectedValue(err);
        const src = await resolveClipboardSource();
        expect(src).toEqual({ kind: 'error', error: err });
        expect(h.readText.mock.calls.length).toBe(3); // 瞬态占用：退避重试
        expect(h.invoke).toHaveBeenCalled(); // 图片探测照常执行
        expect(h.readFiles).toHaveBeenCalled();
    });

    it('无文本格式（code = 1168）不是读取失败：按文本为空继续下探', async () => {
        h.readText.mockRejectedValue(new Error('Get text error, code = 1168'));
        expect(await resolveClipboardSource()).toEqual({ kind: 'empty' });
        // 不重试：无文本格式是确定结果
        expect(h.readText.mock.calls.length).toBe(1);
    });

    it('读取失败但剪贴板是图片：走图片链路而不是报读取失败', async () => {
        h.readText.mockRejectedValue(new Error('Get text error, code = 5'));
        h.invoke.mockResolvedValue({ seq: 7, hasDib: true });
        h.fetchRecentImageQr.mockResolvedValue({ qrText: null });

        expect(await resolveClipboardSource()).toEqual({ kind: 'unsupported', reason: 'image' });
    });

    it('describeClipboardReadError：错误码翻成人话，其余原样保留', async () => {
        const { describeClipboardReadError } = await import('../clipboardSource');
        expect(describeClipboardReadError(new Error('Get text error, code = 5'))).toBe('剪贴板被其他程序占用');
        expect(describeClipboardReadError('Get text error, code = 1168')).toBe('Get text error, code = 1168');
    });

    it('文本为空且剪贴板为图片：采用 10 秒内落库的二维码文本', async () => {
        h.readText.mockResolvedValue('');
        h.invoke.mockResolvedValue({ seq: 9, hasDib: true });
        h.fetchRecentImageQr.mockResolvedValue({ qrText: 'https://example.com/a' });

        const src = await resolveClipboardSource();

        expect(src).toEqual({ kind: 'text', content: 'https://example.com/a', origin: 'image-qr' });
        // 新鲜度窗口：查询下界 = now - 10s
        const since = h.fetchRecentImageQr.mock.calls[0]![0] as number;
        expect(Date.now() - since).toBeGreaterThanOrEqual(9_000);
        expect(Date.now() - since).toBeLessThanOrEqual(11_000);
        // 图片命中后不再探测文件列表
        expect(h.readFiles).not.toHaveBeenCalled();
    });

    it('图片未识别出二维码：返回 unsupported=image', async () => {
        h.readText.mockResolvedValue('   ');
        h.invoke.mockResolvedValue({ seq: 3, hasDib: true });
        h.fetchRecentImageQr.mockResolvedValue({ qrText: null });

        expect(await resolveClipboardSource()).toEqual({ kind: 'unsupported', reason: 'image' });
    });

    it('没有最近 10 秒内的图片记录：同样按不支持的图片处理（不引用历史图片）', async () => {
        h.readText.mockResolvedValue('');
        h.invoke.mockResolvedValue({ seq: 3, hasDib: true });
        h.fetchRecentImageQr.mockResolvedValue(null);

        expect(await resolveClipboardSource()).toEqual({ kind: 'unsupported', reason: 'image' });
    });

    it('图片探测失败但存在文件列表：返回 unsupported=files', async () => {
        h.readText.mockResolvedValue('');
        h.invoke.mockRejectedValue(new Error('no probe'));
        h.readFiles.mockResolvedValue(['C:\\a.txt']);

        expect(await resolveClipboardSource()).toEqual({ kind: 'unsupported', reason: 'files' });
    });

    it('空剪贴板：返回 empty', async () => {
        h.readText.mockResolvedValue('');
        expect(await resolveClipboardSource()).toEqual({ kind: 'empty' });
    });
});

describe('pickSelectedRingContent 选中项内容源', () => {
    it('文本 / 富文本条目：采用选中项内容', async () => {
        const { pickSelectedRingContent } = await import('../clipboardSource');
        expect(pickSelectedRingContent({ type: 'text', content: 'a' })).toBe('a');
        expect(pickSelectedRingContent({ type: 'html', content: '<p>x</p>' })).toBe('<p>x</p>');
        // 缺省 type 视为文本
        expect(pickSelectedRingContent({ content: 'b' })).toBe('b');
    });

    it('图片 / 文件 / 空内容 / 未选中：返回 null（回落到系统剪贴板）', async () => {
        const { pickSelectedRingContent } = await import('../clipboardSource');
        expect(pickSelectedRingContent({ type: 'image', content: 'x' })).toBeNull();
        expect(pickSelectedRingContent({ type: 'files', content: 'x' })).toBeNull();
        expect(pickSelectedRingContent({ type: 'text', content: '   \n ' })).toBeNull();
        expect(pickSelectedRingContent(undefined)).toBeNull();
    });
});
