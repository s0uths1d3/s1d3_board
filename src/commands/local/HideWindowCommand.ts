import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Command } from '../Command';
import {setIsWindowVisible} from "~/src/commands/global/ToggleWindowCommand";

export class HideWindowCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        const win = getCurrentWindow();
        await win.hide().then(()=>{
            setIsWindowVisible(false)
        })
    }
}
