import type { Command } from '../Command';
import { activeTab } from '~/composables/useTabs';

export class DelCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        // 待办 Tab：对当前选中项请求删除，由 TodoList 打开内联确认框（与方向键选中、Ctrl+Enter 编辑同一套键盘交互）
        if (activeTab.value === 'todo') {
            window.dispatchEvent(new CustomEvent('todo:delete-request'));
            return;
        }
        // 仅在主剪贴板标签页生效；常用剪贴页的删除由该页自行处理，
        // 避免误删主剪贴板当前选中项。
        if (activeTab.value !== 'clip') return;
        // 派发事件，由 index.vue 打开独立删除确认窗口
        window.dispatchEvent(new CustomEvent('delete-request'));
    }
}
