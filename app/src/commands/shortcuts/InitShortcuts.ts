import { ref } from 'vue';
import { ShortcutManager } from './ShortcutManager';
import { ToggleWindowCommand } from '../global/ToggleWindowCommand';
import { HideWindowCommand } from '../local/HideWindowCommand';
import type { ShortcutConfig, ShortcutScope } from './ShortcutConfig';
import {ArrowDownTargetMovementCommand, ArrowUpTargetMovementCommand} from "~/src/commands/local/TargetMovementCommand";
import {PasteCommand} from "~/src/commands/local/PasteCommand";
import {SwitchTabCommand} from "~/src/commands/local/SwitchTabCommand";
import {DelCommand} from  "~/src/commands/local/DelCommand"
import {FavoriteCommand} from  "~/src/commands/local/FavoriteCommand"
import {ToggleAlwaysOnTopCommand} from "~/src/commands/local/ToggleAlwaysOnTopCommand"
import dbService from "~/src/db/dbService";

const toggleWindowCommand = new ToggleWindowCommand();
const hideWindowCommand = new HideWindowCommand();
const arrowUpTargetMovementCommand = new ArrowUpTargetMovementCommand()
const arrowDownTargetMovementCommand = new ArrowDownTargetMovementCommand()
const pasteCommand = new PasteCommand()
const switchPrevTabCommand = new SwitchTabCommand(-1)
const switchNextTabCommand = new SwitchTabCommand(1)
const delCommand = new DelCommand();
const favoriteCommand = new FavoriteCommand()
const toggleAlwaysOnTopCommand = new ToggleAlwaysOnTopCommand()

/** 默认快捷键定义（id 用于唯一标识，defaultKey 用于重置） */
const DEFAULT_SHORTCUTS: ShortcutConfig[] = [
    {
        id: 'toggle_window',
        key: 'CommandOrControl+I',
        defaultKey: 'CommandOrControl+I',
        scope: 'global',
        command: toggleWindowCommand,
        title: '显示与隐藏窗口'
    },
    {
        id: 'hide_window',
        key: 'Escape',
        defaultKey: 'Escape',
        scope: 'local',
        command: hideWindowCommand,
        title: '隐藏窗口'
    },
    {
        id: 'select_prev',
        key: 'ArrowUp',
        defaultKey: 'ArrowUp',
        scope: 'local',
        command: arrowUpTargetMovementCommand,
        title:'选择上一项'
    },
    {
        id: 'select_next',
        key: 'ArrowDown',
        defaultKey: 'ArrowDown',
        scope: 'local',
        command: arrowDownTargetMovementCommand,
        title:'选择下一项'
    },
    {
        id: 'paste',
        key: 'Enter',
        defaultKey: 'Enter',
        scope: 'local',
        command: pasteCommand,
        title: '粘贴选中项'
    },
    {
        id: 'switch_prev_tab',
        key: 'Control+ArrowLeft',
        defaultKey: 'Control+ArrowLeft',
        scope: 'local',
        command: switchPrevTabCommand,
        title: '上一个标签页'
    },
    {
        id: 'switch_next_tab',
        key: 'Control+ArrowRight',
        defaultKey: 'Control+ArrowRight',
        scope: 'local',
        command: switchNextTabCommand,
        title: '下一个标签页'
    },
    {
        id: 'delete_item',
        key: 'Delete',
        defaultKey: 'Delete',
        scope: 'local',
        command: delCommand,
        title:'删除选择项'
    },
    {
        id: 'favorite_item',
        key: 'Control+L',
        defaultKey: 'Control+L',
        scope: 'local',
        command: favoriteCommand,
        title: '收藏选中项'
    },
    {
        id: 'toggle_always_on_top',
        key: 'Control+T',
        defaultKey: 'Control+T',
        scope: 'local',
        command: toggleAlwaysOnTopCommand,
        title: '切换窗口置顶'
    }
];

/** 响应式快捷键列表（自定义后实时反映到设置页与注册表） */
export const shortcuts = ref<ShortcutConfig[]>([...DEFAULT_SHORTCUTS]);

const manager = new ShortcutManager();
let initialized = false;

/** 用当前 shortcuts 配置重新注册全部快捷键（自定义后调用） */
async function reloadShortcuts() {
    manager.unregisterAllLocals();
    try {
        await manager.unregisterAllGlobals();
    } catch (e) {
        console.error('注销残留快捷键失败:', e);
    }
    await manager.registerAll(shortcuts.value);
}

/** 把当前快捷键配置批量写入数据库（幂等 upsert） */
async function persistAllShortcuts() {
    try {
        for (const s of shortcuts.value) {
            await dbService.saveShortcutSetting(s.id, s.key, s.scope, s.title);
        }
    } catch (e) {
        console.error('保存快捷键到数据库失败:', e);
    }
}

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

    // 从数据库恢复用户自定义的快捷键（仅覆盖存在的项，缺省保持默认）
    try {
        const saved = await dbService.loadShortcutSettings();
        for (const item of saved) {
            const target = shortcuts.value.find(s => s.id === item.id);
            if (target && !findShortcutConflict(item.value, target.id)) {
                target.key = item.value;
            }
        }
    } catch (e) {
        console.error('加载快捷键配置失败，使用默认配置:', e);
    }

    await manager.registerAll(shortcuts.value);
    initialized = true;
}

/** 检测某 key 是否与其他快捷键冲突（排除指定 id），返回冲突项或 null */
export function findShortcutConflict(key: string, excludeId?: string): ShortcutConfig | null {
    const normalized = key.toLowerCase().replace(/\s+/g, '');
    return shortcuts.value.find(
        s => s.id !== excludeId && s.key.toLowerCase().replace(/\s+/g, '') === normalized
    ) ?? null;
}

/** 更新指定快捷键的 key；冲突时返回错误信息，成功返回 null */
export async function updateShortcutKey(id: string, newKey: string): Promise<string | null> {
    const target = shortcuts.value.find(s => s.id === id);
    if (!target) return '快捷键不存在';
    if (!newKey) return '快捷键不能为空';

    const conflict = findShortcutConflict(newKey, id);
    if (conflict) return `与「${conflict.title}」冲突`;

    target.key = newKey;
    try {
        await reloadShortcuts();
    } catch (e) {
        console.error('快捷键注册失败:', e);
        return '快捷键注册失败';
    }
    try {
        await dbService.saveShortcutSetting(target.id, target.key, target.scope, target.title);
    } catch (e) {
        console.error('保存快捷键到数据库失败:', e);
    }
    return null;
}

/** 单独重置：恢复该快捷键的默认值 */
export async function resetShortcut(id: string): Promise<string | null> {
    const target = shortcuts.value.find(s => s.id === id);
    if (!target) return '快捷键不存在';

    const conflict = findShortcutConflict(target.defaultKey, id);
    if (conflict) return `默认快捷键与「${conflict.title}」冲突`;

    target.key = target.defaultKey;
    try {
        await reloadShortcuts();
    } catch (e) {
        console.error('快捷键注册失败:', e);
        return '快捷键注册失败';
    }
    try {
        await dbService.saveShortcutSetting(target.id, target.key, target.scope, target.title);
    } catch (e) {
        console.error('保存快捷键到数据库失败:', e);
    }
    return null;
}

/** 全部重置：恢复快捷键为默认值；可传入 scope 只重置全局或局部 */
export async function resetAllShortcuts(scope?: ShortcutScope): Promise<void> {
    shortcuts.value.forEach(s => {
        if (scope && s.scope !== scope) return;
        const def = DEFAULT_SHORTCUTS.find(d => d.id === s.id);
        if (def) s.key = def.defaultKey;
    });
    try {
        await reloadShortcuts();
        await persistAllShortcuts();
    } catch (e) {
        console.error('快捷键注册失败:', e);
    }
}

export function unregisterLocalShortcuts() {
    manager.unregisterAllLocals();
}

export async function unregisterAllShortcuts() {
    console.log('unmounting...')
    await manager.unregisterAll();
    initialized = false;
}
