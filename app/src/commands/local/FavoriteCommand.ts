import type {Command} from "~/src/commands/Command";
import clipboardService from "~/src/db/dbService";
import {getSelectedRowId} from "~/src/commands/local/clipboardStore";
import { emit } from '@tauri-apps/api/event';

export class FavoriteCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        const id = getSelectedRowId()
        if (id === undefined) return;
        const res = await clipboardService.fetchClipboardSingleData(id);
        await this.favorite(id, res.is_favorite)
    }

    async favorite(id: number, value: number) {
        value = value === 0 ? 1 : 0;
        await clipboardService.updateFavorite(id, value)
        await emit('favorite:result', { favorite: value === 1 });
    }
}

