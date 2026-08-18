import { ShortcutManager } from './ShortcutManager';
import { ToggleWindowCommand } from '../global/ToggleWindowCommand';
import { HideWindowCommand } from '../local/HideWindowCommand';
import type { ShortcutConfig } from './ShortcutConfig';
import {ArrowDownTargetMovementCommand, ArrowUpTargetMovementCommand} from "~/src/commands/local/TargetMovementCommand";
import {PasteCommand} from "~/src/commands/local/PasteCommand";
import {DelCommand} from  "~/src/commands/local/DelCommand"
import {FavoriteCommand} from  "~/src/commands/local/FavoriteCommand"
import dbService from "~/src/db/dbService";

const toggleWindowCommand = new ToggleWindowCommand();
const hideWindowCommand = new HideWindowCommand();
const arrowUpTargetMovementCommand = new ArrowUpTargetMovementCommand()
const arrowDownTargetMovementCommand = new ArrowDownTargetMovementCommand()
const pasteCommand = new PasteCommand()
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
    },    {
        key: 'ArrowDown',
        scope: 'local',
        command: arrowDownTargetMovementCommand,
        title:'选择下一项'
    },
    {
        key: 'Enter',
        scope: 'local',
        command: pasteCommand,
        title: '粘贴选中项'
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
let initialized = false;

export async function initShortcuts() {
    // 防止 HMR 热重载时重复注册：window keydown 监听只绑一次
    if (initialized) return;

    // 先清理可能残留的本地监听与 Rust 侧全局快捷键
    // （reload 时 onBeforeUnmount 可能未执行，避免重复绑定 / "HotKey already registered"）
    manager.unregisterAllLocals();
    try {
        await manager.unregisterAllGlobals();
    } catch (e) {
        console.error('注销残留快捷键失败:', e);
    }

    // console.log(await dbService.getShortcutSetting());
    await manager.registerAll(shortcuts);
    initialized = true;
}

export function unregisterLocalShortcuts() {
    manager.unregisterAllLocals();
}

export async function unregisterAllShortcuts() {
    console.log('unmounting...')
    await manager.unregisterAll();
    initialized = false;
}
