import type { Command } from "~/src/commands/Command";
import { useAlwaysOnTop } from "~/composables/useAlwaysOnTop";

/** 局部快捷键 Ctrl+T：切换主窗口是否始终置顶（与标题栏置顶按钮共用同一状态） */
export class ToggleAlwaysOnTopCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        const { toggleAlwaysOnTop } = useAlwaysOnTop();
        await toggleAlwaysOnTop();
    }
}
