import type { Command } from "~/src/commands/Command";
import { cycleColorScheme, COLOR_SCHEME_LABELS, useColorScheme } from "~/composables/useColorScheme";

/** 局部快捷键 Ctrl+Alt+C：默认 → 浅色 → 深色 循环切换配色（与标题栏配色按钮共用同一状态） */
export class CycleColorSchemeCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        useColorScheme();
        const next = await cycleColorScheme();
        console.info(`配色已切换为「${COLOR_SCHEME_LABELS[next]}」`);
    }
}
