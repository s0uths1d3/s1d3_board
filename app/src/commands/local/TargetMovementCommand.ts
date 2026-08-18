import type { Command } from '../Command';
import {
  dataLength,
  selectedRowIndex,
  selectRow,
  getSelectedRowIndex,
  getSelectedRowId,
} from './clipboardStore';

/**
 * 上下方向键选择命令
 *
 * 状态统一来自 clipboardStore：
 * - 上移：selectedRowIndex - 1（不能小于 0）
 * - 下移：selectedRowIndex + 1（不能超过 dataLength）
 */

export class ArrowUpTargetMovementCommand implements Command {
    async execute(): Promise<void> {
        const newIndex = selectedRowIndex.value - 1;
        if (newIndex >= 0) {
            selectedRowIndex.value = newIndex;
            selectRow(newIndex);
        }
    }
}

export class ArrowDownTargetMovementCommand implements Command {
    async execute(): Promise<void> {
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
