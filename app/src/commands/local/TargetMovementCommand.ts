import type { Command } from '../Command';
import {
  dataLength,
  selectedRowIndex,
  selectRow,
  getSelectedRowIndex,
  getSelectedRowId,
} from './clipboardStore';
import { moveTodoSelection } from './todoStore';
import { activeTab } from '~/composables/useTabs';

/**
 * 上下方向键选择命令
 *
 * 主剪贴板（'clip'）状态统一来自 clipboardStore：
 * - 上移：selectedRowIndex - 1（不能小于 0）
 * - 下移：selectedRowIndex + 1（不能超过 dataLength）
 *
 * 待办（'todo'）状态来自 todoStore：moveTodoSelection(-1 / +1)。
 * 常用剪贴页有独立的键盘交互，避免两个列表的方向键互相干扰。
 */

/** 焦点是否在文本输入框/文本域（编辑态）：此时方向键用于移动光标，不切换列表选中项。
 *  待办搜索框（.todo-search-input）除外——方向键仍用于切换列表选中项。 */
function isEditingField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  return !el.classList.contains('todo-search-input');
}

export class ArrowUpTargetMovementCommand implements Command {
    async execute(): Promise<void> {
        if (activeTab.value === 'todo') {
            if (isEditingField()) return;
            moveTodoSelection(-1);
            return;
        }
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
        if (activeTab.value === 'todo') {
            if (isEditingField()) return;
            moveTodoSelection(1);
            return;
        }
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
