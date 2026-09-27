import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Command } from '../Command';
import { savePopupLastPosition } from '~/composables/usePopupPosition';
import { closeTooltipWindows } from '~/composables/useTooltipEnabled';

export class HideWindowCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        // 隐藏前记录当前位置，供「上次位置」弹出模式恢复
        await savePopupLastPosition().catch(() => {});
        // 主窗口收起前关闭 tooltip 子窗口：否则 tooltip 仍置顶残留在屏幕上
        await closeTooltipWindows().catch(() => {});
        try {
            const win = getCurrentWindow();
            await win.hide();
        } catch (e) {
            // 与 ToggleWindowCommand 同等的防护等级：隐藏失败不再成为 unhandled rejection
            console.error('隐藏窗口失败:', e);
        }
    }
}
