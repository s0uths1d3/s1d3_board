import type { Command } from '../Command';
import {
  dataLength,
  selectedRowIndex,
  selectRow,
  getSelectedRowIndex,
  getSelectedRowId,
} from './clipboardStore';
import { activeTab } from '~/composables/useTabs';

/**
 * 上下方向键选择命令
 *
 * 状态统一来自 clipboardStore：
 * - 上移：selectedRowIndex - 1（不能小于 0）
 * - 下移：selectedRowIndex + 1（不能超过 dataLength）
 *
 * 仅在主剪贴板标签页（'clip'）生效；常用剪贴页有独立的键盘交互，
 * 避免两个列表的方向键/删除互相干扰。
 */

export class ArrowUpTargetMovementCommand implements Command {
    async execute(): Promise<void> {
        if (activeTab.value !== 'clip') return;
        const newIndex = selectedRowIndex.value - 1;
        if (newIndex >= 0) {
            selectedRowIndex.value = newIndex;
            selectRow(newIndex);
        }
    }
}

export class ArrowDownTargetMovementCommand implements Command {
    async execute(): Promise<void> {
        if (activeTab.value !== 'clip') return;
        const newIndex = selectedRowIndex.value + 1;
        if (newIndex < dataLength.value) {
            selectedRowIndex.value = newIndex;
            selectRow(newIndex);
        }
    }
}

// 兼容导出：index.vue / FavoriteCommand 仍可从本模块 import，状态则共享自 clipboardStore
export {
  dataLength,
  selectedRowIndex,
  selectRow,
  getSelectedRowIndex,
  getSelectedRowId,
};
