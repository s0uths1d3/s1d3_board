import type { Command } from '../Command';
import { activeTab, setActiveTab, tabItems } from '~/composables/useTabs';

/**
 * Ctrl+← / Ctrl+→ 切换顶层 Tab 命令（循环）
 *
 * - 右移：clip → todo → note → pinned → setting → clip
 * - 左移：setting → pinned → note → todo → clip → setting
 */
export class SwitchTabCommand implements Command {
    constructor(private direction: 1 | -1) {}

    async execute(): Promise<void> {
        const order = tabItems.map(t => t.key);
        const currentIdx = order.indexOf(activeTab.value);
        if (currentIdx === -1) return;

        // 循环索引：边界处回绕
        const nextIdx = (currentIdx + this.direction + order.length) % order.length;
        setActiveTab(order[nextIdx]!);
    }
}
