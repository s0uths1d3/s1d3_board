import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Command } from './Command';

let isWindowVisible = true;

export class ToggleWindowCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;

        const win = getCurrentWindow();
        isWindowVisible = !isWindowVisible;

        if (isWindowVisible) {
            await win.show();
        } else {
            await win.hide();
        }
    }
}
