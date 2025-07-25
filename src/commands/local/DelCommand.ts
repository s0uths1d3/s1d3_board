import type { Command } from '../Command';
import type {ClipboardData} from "~/src/ClipboardData";

export const showConfirm = ref(false);
export const deleteTarget = ref<ClipboardData | null>(null);

export class DelCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        showConfirm.value = true
    }
}