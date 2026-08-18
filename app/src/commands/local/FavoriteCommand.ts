import type {Command} from "~/src/commands/Command";
import clipboardService from "~/src/db/dbService";
import {getSelectedRowId} from "~/src/commands/local/TargetMovementCommand";

export class FavoriteCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        const id = getSelectedRowId()
        const res = await clipboardService.fetchClipboardSingleData(id);
        await this.favorite(id, res.is_favorite)
    }

    async favorite(id: number, value: number) {
        value = value === 0 ? 1 : 0;
        console.log(value)
        await clipboardService.updateFavorite(id, value)
    }
}

