import type { Command } from "~/src/commands/Command";
import { cycleColorScheme, COLOR_SCHEME_LABELS, useColorScheme } from "~/composables/useColorScheme";

/** 切换配色快捷键（跟随系统 → 琥珀 → 浅色 → 深色循环；默认不绑定，可在设置页录制；与标题栏配色按钮共用同一状态） */
export class CycleColorSchemeCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        useColorScheme();
        const next = await cycleColorScheme();
        console.info(`配色已切换为「${COLOR_SCHEME_LABELS[next]}」`);
    }
}
