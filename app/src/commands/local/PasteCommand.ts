import type { Command } from '../Command';
import { getSelectedContent, getSelectedRowId } from './clipboardStore';
import clipboardService from '~/src/db/dbService';
import { pasteContentToActiveApp } from './pasteUtil';
import { activeTab } from '~/composables/useTabs';

/**
 * Enter 粘贴命令：将当前选中的 clip 项粘贴到唤起 clip 窗口前的目标输入框。
 *
 * 时序（关键，顺序不可颠倒）：
 *   1. 取选中项内容
 *   2. 递增使用次数（必须传数据库 id）
 *   3. 写剪贴板 → 隐藏窗口 → 模拟 Ctrl/Cmd+V（与 Ctrl+数字 快捷粘贴共用 pasteUtil 实现）
 *
 * 仅在剪贴板 Tab 响应：常用剪贴页的选中态是 PinnedClipList 的本地状态，
 * 与主剪贴板 store 不同步，按 Enter 会粘贴屏幕上不可见的条目（其粘贴走 Ctrl+数字 专属命令）。
 */
export class PasteCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;

        if (activeTab.value !== 'clip') return;

        const selected = getSelectedContent();
        if (!selected) return;
        const { content, type } = selected;
        if (!content) return;

        // 递增使用次数：传数据库 id（此前误传行索引，会污染 id===行号 的无关记录并打乱列表排序）
        const id = getSelectedRowId();
        if (id !== undefined) {
            await clipboardService.increaseUseCount(id).catch((err) => {
                console.error('记录使用次数失败:', err);
            });
        }

        await pasteContentToActiveApp(content, type);
    }
}
