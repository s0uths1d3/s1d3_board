import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Command } from '../Command';
import { savePopupLastPosition } from '~/composables/usePopupPosition';

export class HideWindowCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        // 隐藏前记录当前位置，供「上次位置」弹出模式恢复
        await savePopupLastPosition().catch(() => {});
        const win = getCurrentWindow();
        await win.hide();
    }
}
