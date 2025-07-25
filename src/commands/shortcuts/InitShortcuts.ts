import { ShortcutManager } from './ShortcutManager';
import { ToggleWindowCommand } from '../global/ToggleWindowCommand';
import { HideWindowCommand } from '../local/HideWindowCommand';
import type { ShortcutConfig } from './ShortcutConfig';
import {ArrowDownTargetMovementCommand, ArrowUpTargetMovementCommand} from "~/src/commands/local/TargetMovementCommand";
import {SearchCommand} from "~/src/commands/local/SearchCommand";
import {DelCommand} from  "~/src/commands/local/DelCommand"
import {FavoriteCommand} from  "~/src/commands/local/FavoriteCommand"

export const toggleWindowCommand = new ToggleWindowCommand();
const hideWindowCommand = new HideWindowCommand();
const arrowUpTargetMovementCommand = new ArrowUpTargetMovementCommand()
const arrowDownTargetMovementCommand = new ArrowDownTargetMovementCommand()
const searchCommand = new SearchCommand()
const delCommand = new DelCommand();
const favoriteCommand = new FavoriteCommand()

const shortcuts: ShortcutConfig[] = [
    {
        key: 'CommandOrControl+I',
        scope: 'global',
        command: toggleWindowCommand,
    },
    {
        key: 'Escape',
        scope: 'local',
        command: hideWindowCommand,
    },
    {
        key: 'ArrowUp',
        scope: 'local',
        command: arrowUpTargetMovementCommand
    },{
        key: 'ArrowDown',
        scope: 'local',
        command: arrowDownTargetMovementCommand
    },
    {
        key: 'Control+F',
        scope: 'local',
        command: searchCommand
    },
    {
        key:'delete',
        scope:'local',
        command: delCommand
    },{
        key:'l',
        scope:"local",
        command: favoriteCommand
    }
];

const manager = new ShortcutManager();

export async function initShortcuts() {
    await manager.registerAll(shortcuts);
}

export function unregisterLocalShortcuts() {
    manager.unregisterAllLocals();
}

export async function unregisterAllShortcuts() {
    console.log('unmounting...')
    await manager.unregisterAll();
}
