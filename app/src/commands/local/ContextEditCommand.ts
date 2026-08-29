import type { Command } from '../Command';
import { activeTab } from '~/composables/useTabs';

/**
 * Ctrl+Enter：上下文快捷键
 * - 便签页：保存当前编辑中的便签（派发 save-note 事件）
 * - 待办页：对当前选中的待办项进入编辑态（派发 todo:edit-request 事件）
 * 其余标签页无对应编辑态，忽略。
 */
export class ContextEditCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        if (activeTab.value === 'note') {
            window.dispatchEvent(new CustomEvent('save-note'));
        } else if (activeTab.value === 'todo') {
            window.dispatchEvent(new CustomEvent('todo:edit-request'));
        }
    }
}
