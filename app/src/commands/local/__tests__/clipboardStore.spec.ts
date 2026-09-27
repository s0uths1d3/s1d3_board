import { beforeEach, describe, expect, it } from 'vitest';
import type { ClipboardData } from '~/src/entities';
import {
    batchSelectedIds,
    clearBatchSelection,
    data,
    resetClips,
    selectBatchRange,
    selectedRowIndex,
    toggleBatchSelect,
} from '../clipboardStore';

/**
 * 剪贴板列表共享状态测试（批量选择 / 收藏流转的状态层）：
 * clipboardStore 是模块级单例（index.vue 与键盘命令共用），用例间需手动复位。
 * dbService 依赖 @tauri-apps/plugin-sql 全局 mock（vitest.setup.ts），
 * resetClips 走真实门面 → MockDatabase 返回空结果集。
 */

function seedRow(id: number): ClipboardData {
    return {
        id,
        content: `c${id}`,
        type: 'text',
        is_favorite: 0,
        count: 0,
        created_at: '0',
        updated_at: '0',
        source: '',
        category: '',
    };
}

function seed(n: number) {
    data.value = Array.from({ length: n }, (_, i) => seedRow(i + 1));
}

beforeEach(() => {
    clearBatchSelection();
    selectedRowIndex.value = 0;
    seed(0);
});

describe('批量选择：Ctrl 点击切换', () => {
    it('首次 Ctrl 点击：加入选中集合，锚点与键盘选中行同步', () => {
        seed(5);
        toggleBatchSelect(2, 1);
        expect(batchSelectedIds.value).toEqual(new Set([2]));
        expect(selectedRowIndex.value).toBe(1);
    });

    it('再次 Ctrl 点击同一项：移出选中集合，锚点复位', () => {
        seed(5);
        toggleBatchSelect(2, 1);
        toggleBatchSelect(2, 1);
        expect(batchSelectedIds.value.size).toBe(0);
    });

    it('多项切换：各自独立增删', () => {
        seed(5);
        toggleBatchSelect(1, 0);
        toggleBatchSelect(3, 2);
        expect(batchSelectedIds.value).toEqual(new Set([1, 3]));
        toggleBatchSelect(1, 0);
        expect(batchSelectedIds.value).toEqual(new Set([3]));
    });
});

describe('批量选择：Shift 范围选择', () => {
    it('无锚点时以当前键盘选中行为锚，正向范围全选', () => {
        seed(6);
        selectedRowIndex.value = 0;
        selectBatchRange(2);
        expect(batchSelectedIds.value).toEqual(new Set([1, 2, 3]));
    });

    it('已有锚点（此前 Ctrl 点击）：从锚点到当前行反向全选', () => {
        seed(6);
        toggleBatchSelect(4, 3); // 锚点=3
        selectBatchRange(1);
        expect(batchSelectedIds.value).toEqual(new Set([2, 3, 4]));
    });

    it('范围选择保留此前已选中的集合成员', () => {
        seed(6);
        toggleBatchSelect(6, 5); // 锚点=5，选中 {6}
        selectBatchRange(0);
        expect(batchSelectedIds.value).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    });

    it('clearBatchSelection 清空集合', () => {
        seed(3);
        selectBatchRange(2);
        clearBatchSelection();
        expect(batchSelectedIds.value.size).toBe(0);
    });
});

describe('列表重置与批量选择的联动', () => {
    it('resetClips 清空批量选择与列表数据（搜索词/筛选变化后旧 id 失效）', async () => {
        seed(3);
        toggleBatchSelect(1, 0);
        toggleBatchSelect(2, 1);
        expect(batchSelectedIds.value.size).toBe(2);
        await resetClips();
        expect(batchSelectedIds.value.size).toBe(0);
        expect(data.value).toHaveLength(0);
    });
});
