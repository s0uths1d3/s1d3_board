import type { Command } from '../Command';
import { activeTab } from '~/composables/useTabs';

/**
 * Ctrl+F：聚焦当前标签页的搜索框（聚焦查找）。
 * 通过派发 focus-search 事件，由各标签页组件（clip / todo 等）响应并聚焦其搜索输入框；
 * 没有搜索框的标签页（note / pinned / statistics / setting）无响应，静默忽略。
 */
export class FocusSearchCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        if (!activeTab.value) return;
        window.dispatchEvent(new CustomEvent('focus-search', { detail: { tab: activeTab.value } }));
    }
}
