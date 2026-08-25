import type { Command } from '../Command';
import { activeTab } from '~/composables/useTabs';

/**
 * Ctrl+Enter：保存当前编辑中的便签（便签页局部快捷键）
 * 通过派发 save-note 事件，由处于编辑态的 StickyNoteItem 响应并保存。
 */
export class SaveNoteCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        // 仅在便签页生效；其他标签页无便签编辑态，忽略
        if (activeTab.value !== 'note') return;
        window.dispatchEvent(new CustomEvent('save-note'));
    }
}
