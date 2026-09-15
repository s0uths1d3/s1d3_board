import type { Command } from "~/src/commands/Command";
import { cycleColorScheme, useColorScheme } from "~/composables/useColorScheme";
import { notifyIsland } from "~/composables/useCopyIsland";
import { useI18n } from "~/composables/useI18n";

/** 切换配色快捷键（跟随系统 → 琥珀 → 浅色 → 深色循环；默认不绑定，可在设置页录制；与标题栏配色按钮共用同一状态） */
export class CycleColorSchemeCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        useColorScheme();
        const next = await cycleColorScheme();
        // 操作反馈 → 灵动岛（屏幕顶部全局胶囊），与标题栏配色按钮一致
        const { t } = useI18n();
        notifyIsland({ kind: 'success', text: t('setting.general.color_scheme_saved', { name: t(`color_scheme.${next}`) }) });
    }
}
