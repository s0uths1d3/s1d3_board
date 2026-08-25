import type { Command } from '../Command';
import { ref } from 'vue';
import type {ClipboardData} from "~/src/Entities";
import { activeTab } from '~/composables/useTabs';

export const deleteTarget = ref<ClipboardData | null>(null);

export class DelCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        // 仅在主剪贴板标签页生效；常用剪贴页的删除由该页自行处理，
        // 避免误删主剪贴板当前选中项。
        if (activeTab.value !== 'clip') return;
        // 派发事件，由 index.vue 打开独立删除确认窗口
        window.dispatchEvent(new CustomEvent('delete-request'));
    }
}
