import { ShortcutManager } from './ShortcutManager';
import { ToggleWindowCommand } from '../commands/global/ToggleWindowCommand';
import { HideWindowCommand } from '../commands/local/HideWindowCommand';
import type { ShortcutConfig } from './ShortcutConfig';
import {ArrowDownTargetMovementCommand, ArrowUpTargetMovementCommand} from "~/src/commands/local/TargetMovementCommand";
import {SearchCommand} from "~/src/commands/local/SearchCommand";

export const toggleWindowCommand = new ToggleWindowCommand();
const hideWindowCommand = new HideWindowCommand();
const arrowUpTargetMovementCommand = new ArrowUpTargetMovementCommand()
const arrowDownTargetMovementCommand = new ArrowDownTargetMovementCommand()
const searchCommand = new SearchCommand()

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
    }
    ,{
        key: 'ArrowUp',
        scope: 'local',
        command: arrowUpTargetMovementCommand
    },{
        key: 'ArrowDown',
        scope: 'local',
        command: arrowDownTargetMovementCommand
    },{
        key: 'Control+F',
        scope: 'local',
        command: searchCommand
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
    await manager.unregisterAll();
}
