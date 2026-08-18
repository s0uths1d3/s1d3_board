import type { Command } from '../Command';
import type {ClipboardData} from "~/src/Entities";

export const deleteTarget = ref<ClipboardData | null>(null);

export class DelCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        // 派发事件，由 index.vue 打开独立删除确认窗口
        window.dispatchEvent(new CustomEvent('delete-request'));
    }
}
