import type { Command } from '../Command';
import { activeTab } from '~/composables/useTabs';

/**
 * Ctrl+N：新建便签（便签页局部快捷键）
 * 通过派发 create-note 事件，由便签页 StickyNote 响应并创建。
 */
export class CreateNoteCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        // 仅在便签页生效；其他标签页无便签新建语义，忽略
        if (activeTab.value !== 'note') return;
        window.dispatchEvent(new CustomEvent('create-note'));
    }
}
