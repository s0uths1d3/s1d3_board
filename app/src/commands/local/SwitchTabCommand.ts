import type { Command } from '../Command';
import { activeTab, setActiveTab, getVisibleTabItems } from '~/composables/useTabs';

/**
 * Ctrl+← / Ctrl+→ 切换顶层 Tab 命令（循环）
 *
 * 基于 getVisibleTabItems()（统计 Tab 未解锁时自动跳过，§7.9），
 * 例：clip → todo → note → pinned → setting → clip（未解锁）
 *     … → setting → statistics → clip（已解锁）
 */
export class SwitchTabCommand implements Command {
    constructor(private direction: 1 | -1) {}

    async execute(): Promise<void> {
        const order = getVisibleTabItems().map(t => t.key);
        if (order.length === 0) return;
        const currentIdx = order.indexOf(activeTab.value);
        if (currentIdx === -1) return;

        // 循环索引：边界处回绕
        const nextIdx = (currentIdx + this.direction + order.length) % order.length;
        setActiveTab(order[nextIdx]!);
    }
}
