import { ShortcutManager } from './ShortcutManager';
import { ToggleWindowCommand } from '../global/ToggleWindowCommand';
import { HideWindowCommand } from '../local/HideWindowCommand';
import type { ShortcutConfig } from './ShortcutConfig';
import {ArrowDownTargetMovementCommand, ArrowUpTargetMovementCommand} from "~/src/commands/local/TargetMovementCommand";
import {SearchCommand} from "~/src/commands/local/SearchCommand";
import {DelCommand} from  "~/src/commands/local/DelCommand"
import {FavoriteCommand} from  "~/src/commands/local/FavoriteCommand"

const toggleWindowCommand = new ToggleWindowCommand();
const hideWindowCommand = new HideWindowCommand();
const arrowUpTargetMovementCommand = new ArrowUpTargetMovementCommand()
const arrowDownTargetMovementCommand = new ArrowDownTargetMovementCommand()
const searchCommand = new SearchCommand()
const delCommand = new DelCommand();
const favoriteCommand = new FavoriteCommand()


export const shortcuts: ShortcutConfig[] = [
    {
        key: 'CommandOrControl+I',
        scope: 'global',
        command: toggleWindowCommand,
        title: '显示与隐藏窗口'
    },
    {
        key: 'Escape',
        scope: 'local',
        command: hideWindowCommand,
        title: '隐藏窗口'
    },
    {
        key: 'ArrowUp',
        scope: 'local',
        command: arrowUpTargetMovementCommand,
        title:'选择上一项'
    },{
        key: 'ArrowDown',
        scope: 'local',
        command: arrowDownTargetMovementCommand,
        title:'选择下一项'
    },
    {
        key: 'CommandOrControl+F',
        scope: 'local',
        command: searchCommand,
        title: '搜索'
    },
    {
        key:'delete',
        scope:'local',
        command: delCommand,
        title:'删除选择项'
    },{
        key:'l',
        scope:"local",
        command: favoriteCommand,
        title: '收藏选择选'
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
