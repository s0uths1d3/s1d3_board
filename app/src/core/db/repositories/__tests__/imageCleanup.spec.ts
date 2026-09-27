import { describe, expect, it } from 'vitest';
import {
    selectImageCleanupVictims,
    type ImageFileInfo,
    type ImageCleanupRow,
} from '../clipboardRepository';

/**
 * 磁盘图片清理淘汰选择（纯函数）单测：
 * 覆盖孤儿清理、超限淘汰序（使用次数 → 最久未用）、收藏豁免与常用剪贴保护集。
 */

const MB = 1024 * 1024;

function file(name: string, size: number): ImageFileInfo {
    return { name, size };
}

function row(id: number, ref: string, count: number, updated_at: number, is_favorite = 0): ImageCleanupRow {
    return { id, content: `imgfile:${ref}`, count, updated_at, is_favorite };
}

describe('selectImageCleanupVictims', () => {
    it('未超上限且无孤儿：返回空计划', () => {
        const files = [file('a.png', 10 * MB)];
        const rows = [row(1, 'a.png', 3, 100)];
        const plan = selectImageCleanupVictims(files, rows, 256 * MB);
        expect(plan).toEqual({ orphanFiles: [], victimFiles: [], victimRowIds: [] });
    });

    it('孤儿文件：磁盘有、DB 无引用 → 只删文件不删行', () => {
        const files = [file('a.png', 5 * MB), file('orphan.png', 2 * MB)];
        const rows = [row(1, 'a.png', 3, 100)];
        const plan = selectImageCleanupVictims(files, rows, 256 * MB);
        expect(plan.orphanFiles).toEqual(['orphan.png']);
        expect(plan.victimRowIds).toEqual([]);
        expect(plan.victimFiles).toEqual([]);
    });

    it('常用剪贴保护集：被引用的文件不算孤儿', () => {
        const files = [file('pinned.png', 2 * MB)];
        const plan = selectImageCleanupVictims(files, [], 256 * MB, ['imgfile:pinned.png']);
        expect(plan.orphanFiles).toEqual([]);
    });

    it('超限淘汰：使用次数少者优先', () => {
        const files = [file('a.png', 60 * MB), file('b.png', 60 * MB), file('c.png', 10 * MB)];
        const rows = [
            row(1, 'a.png', 10, 300),
            row(2, 'b.png', 1, 300),  // 次数最少 → 先淘汰
            row(3, 'c.png', 5, 300),
        ];
        const plan = selectImageCleanupVictims(files, rows, 100 * MB); // 占用 130MB 超 30MB，淘汰 b（60MB）即回落
        expect(plan.victimRowIds).toEqual([2]);
        expect(plan.victimFiles).toEqual(['b.png']);
    });

    it('超限淘汰：次数相同时最久未用者优先', () => {
        const files = [file('a.png', 60 * MB), file('b.png', 60 * MB)];
        const rows = [
            row(1, 'a.png', 3, 100),  // 更久未用 → 先淘汰
            row(2, 'b.png', 3, 200),
        ];
        const plan = selectImageCleanupVictims(files, rows, 100 * MB); // 占用 120MB 超 20MB，淘汰 a 即回落
        expect(plan.victimRowIds).toEqual([1]);
        expect(plan.victimFiles).toEqual(['a.png']);
    });

    it('收藏项豁免：即使次数最少也不被淘汰', () => {
        const files = [file('a.png', 60 * MB), file('b.png', 60 * MB)];
        const rows = [
            row(1, 'a.png', 0, 100, 1), // 收藏：豁免
            row(2, 'b.png', 9, 200),
        ];
        const plan = selectImageCleanupVictims(files, rows, 10 * MB);
        expect(plan.victimRowIds).toEqual([2]);
        expect(plan.victimFiles).toEqual(['b.png']);
    });

    it('超限较多时逐个淘汰直至回落上限以内', () => {
        const files = [file('a.png', 80 * MB), file('b.png', 80 * MB), file('c.png', 80 * MB)];
        const rows = [
            row(1, 'a.png', 1, 300),
            row(2, 'b.png', 2, 300),
            row(3, 'c.png', 3, 300),
        ];
        // 上限 100MB：占用 240MB，需释放 140MB → 淘汰 a、b（各 80MB）后剩 80MB ≤ 100MB
        const plan = selectImageCleanupVictims(files, rows, 100 * MB);
        expect(plan.victimRowIds).toEqual([1, 2]);
        expect(plan.victimFiles).toEqual(['a.png', 'b.png']);
    });

    it('极端上限：收藏占满候选外时淘汰所有非收藏', () => {
        const files = [file('a.png', 50 * MB), file('b.png', 50 * MB)];
        const rows = [
            row(1, 'a.png', 1, 100, 1), // 收藏
            row(2, 'b.png', 1, 200),
        ];
        const plan = selectImageCleanupVictims(files, rows, 0);
        expect(plan.victimRowIds).toEqual([2]);
        expect(plan.victimFiles).toEqual(['b.png']);
    });
});
