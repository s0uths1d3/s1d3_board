import {getCurrentWindow} from '@tauri-apps/api/window';
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
        setWindowVisible()
        try {
            if (isWindowVisible.value) {
                await win.show();
                await win.setFocus();
            } else {
                await win.hide();
            }
        } catch (error) {
            console.error('Error toggling window visibility:', error);
        }
    }
}

export function setWindowVisible(){
    isWindowVisible.value = !isWindowVisible.value
}