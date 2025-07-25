import {getCurrentWindow, UserAttentionType} from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type {Command} from '../Command';
import {ref} from 'vue';

let isWindowVisible = ref(true);

let listElement: HTMLElement | null = null;

onMounted(() => {
    listElement = document.querySelector('ul[listElement]');
});

export class ToggleWindowCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;

        const win = await getCurrentWindow();
        const wv = await getCurrentWebview();
        isWindowVisible.value = !isWindowVisible.value;
        try {
            if (isWindowVisible.value) {
                await win.show();
                await win.setAlwaysOnTop(true);
                await win.setFocus();
                await wv.setFocus()
            } else {
                await win.hide();
            }
        } catch (error) {
            console.error('Error toggling window visibility:', error);
        }
    }
}

export function setIsWindowVisible(is: boolean) {
    isWindowVisible.value = is;
}

