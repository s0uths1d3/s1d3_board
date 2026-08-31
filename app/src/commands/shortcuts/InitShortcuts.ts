import { ref } from 'vue';
import { ShortcutManager } from './ShortcutManager';
import { ToggleWindowCommand } from '../global/ToggleWindowCommand';
import { HideWindowCommand } from '../local/HideWindowCommand';
import type { ShortcutConfig, ShortcutScope } from './ShortcutConfig';
import {CursorMoveCommand} from "~/src/commands/local/CursorMoveCommand";
import {PasteCommand} from "~/src/commands/local/PasteCommand";
import {SwitchTabCommand} from "~/src/commands/local/SwitchTabCommand";
import {DelCommand} from  "~/src/commands/local/DelCommand"
import {FavoriteCommand} from  "~/src/commands/local/FavoriteCommand"
import {ToggleAlwaysOnTopCommand} from "~/src/commands/local/ToggleAlwaysOnTopCommand"
import {AddToPinnedCommand} from "~/src/commands/local/AddToPinnedCommand"
import {PinnedClipPasteCommand} from "~/src/commands/local/PinnedClipPasteCommand"
import {ClipboardSlotPasteCommand} from "~/src/commands/local/ClipboardSlotPasteCommand"
import {ContextEditCommand} from "~/src/commands/local/ContextEditCommand"
import {CreateNoteCommand} from "~/src/commands/local/CreateNoteCommand"
import {FocusSearchCommand} from "~/src/commands/local/FocusSearchCommand"
import {CycleColorSchemeCommand} from "~/src/commands/local/CycleColorSchemeCommand"
import dbService from "~/src/db/dbService";
import { normalizeShortcutKey } from "~/utils/shortcutFormat";

const toggleWindowCommand = new ToggleWindowCommand();
const hideWindowCommand = new HideWindowCommand();
const arrowUpCursorMoveCommand = new CursorMoveCommand(-1)
const arrowDownCursorMoveCommand = new CursorMoveCommand(1)
const pasteCommand = new PasteCommand()
const switchPrevTabCommand = new SwitchTabCommand(-1)
const switchNextTabCommand = new SwitchTabCommand(1)
const delCommand = new DelCommand();
const favoriteCommand = new FavoriteCommand()
const toggleAlwaysOnTopCommand = new ToggleAlwaysOnTopCommand()
// Ctrl+U：将当前选中的剪贴项添加为常用剪贴（已存在则忽略）
const addToPinnedCommand = new AddToPinnedCommand()
// Ctrl+Enter：保存当前编辑中的便签
const contextEditCommand = new ContextEditCommand()
// Ctrl+N：新建便签
const createNoteCommand = new CreateNoteCommand()
// Ctrl+F：聚焦当前标签页的搜索框（clip / todo 等）
const focusSearchCommand = new FocusSearchCommand()
// 切换配色快捷键（默认不绑定，可在设置页录制）
const cycleColorSchemeCommand = new CycleColorSchemeCommand()
// Ctrl+1~Ctrl+0：常用剪贴前 10 项快捷粘贴（槽位序号 1~10）
const pinnedClipCommands = Array.from({ length: 10 }, (_, i) => new PinnedClipPasteCommand(i + 1))
// Ctrl+Shift+1~Ctrl+Shift+0：主剪贴板列表前 10 项快捷粘贴（槽位序号 1~10）
const clipboardSlotCommands = Array.from({ length: 10 }, (_, i) => new ClipboardSlotPasteCommand(i + 1))

/** 默认快捷键定义（id 用于唯一标识，defaultKey 用于重置） */
const DEFAULT_SHORTCUTS: ShortcutConfig[] = [
    {
        id: 'toggle_window',
        key: 'CommandOrControl+I',
        defaultKey: 'CommandOrControl+I',
        scope: 'global',
        command: toggleWindowCommand,
        title: '显示与隐藏窗口',
        enabled: true
    },
    {
        id: 'hide_window',
        key: 'Escape',
        defaultKey: 'Escape',
        scope: 'local',
        command: hideWindowCommand,
        title: '隐藏窗口',
        enabled: true
    },
    {
        id: 'select_prev',
        key: 'ArrowUp',
        defaultKey: 'ArrowUp',
        scope: 'local',
        command: arrowUpCursorMoveCommand,
        title:'选择上一项',
        enabled: true
    },
    {
        id: 'select_next',
        key: 'ArrowDown',
        defaultKey: 'ArrowDown',
        scope: 'local',
        command: arrowDownCursorMoveCommand,
        title:'选择下一项',
        enabled: true
    },
    {
        id: 'paste',
        key: 'Enter',
        defaultKey: 'Enter',
        scope: 'local',
        command: pasteCommand,
        title: '粘贴选中项',
        enabled: true
    },
    {
        id: 'switch_prev_tab',
        key: 'Control+ArrowLeft',
        defaultKey: 'Control+ArrowLeft',
        scope: 'local',
        command: switchPrevTabCommand,
        title: '上一个标签页',
        enabled: true
    },
    {
        id: 'switch_next_tab',
        key: 'Control+ArrowRight',
        defaultKey: 'Control+ArrowRight',
        scope: 'local',
        command: switchNextTabCommand,
        title: '下一个标签页',
        enabled: true
    },
    {
        id: 'delete_item',
        key: 'Delete',
        defaultKey: 'Delete',
        scope: 'local',
        command: delCommand,
        title:'删除选择项',
        enabled: true
    },
    {
        id: 'favorite_item',
        key: 'Control+L',
        defaultKey: 'Control+L',
        scope: 'local',
        command: favoriteCommand,
        title: '收藏选中项',
        enabled: true
    },
    {
        id: 'toggle_always_on_top',
        key: 'Control+T',
        defaultKey: 'Control+T',
        scope: 'local',
        command: toggleAlwaysOnTopCommand,
        title: '切换窗口置顶',
        enabled: true
    },
    {
        id: 'add_to_pinned',
        key: 'Control+U',
        defaultKey: 'Control+U',
        scope: 'local',
        command: addToPinnedCommand,
        title: '添加选中项为常用剪贴',
        enabled: true
    },
    {
        id: 'create_note',
        key: 'Control+N',
        defaultKey: 'Control+N',
        scope: 'local',
        command: createNoteCommand,
        title: '新建便签',
        enabled: true
    },
    {
        id: 'find_in_tab',
        key: 'CommandOrControl+F',
        defaultKey: 'CommandOrControl+F',
        // 聚焦搜索框是窗口内语义（窗口隐藏时 dispatchEvent 无意义），
        // 注册为 global 会在应用驻留托盘时劫持全系统其他应用的 Ctrl+F
        scope: 'local',
        command: focusSearchCommand,
        title: '聚焦当前页搜索框',
        enabled: true
    },
    {
        id: 'cycle_color_scheme',
        // 默认不绑定任何按键（空 key 不注册），需要时在设置页录制；
        // 旧版本默认 Control+Alt+C，升级后由下方恢复逻辑迁移为未绑定
        key: '',
        defaultKey: '',
        scope: 'local',
        command: cycleColorSchemeCommand,
        title: '切换配色',
        enabled: true
    },
    {
        id: 'save_note',
        key: 'Control+Enter',
        defaultKey: 'Control+Enter',
        scope: 'local',
        command: contextEditCommand,
        title: '保存便签（编辑中）',
        enabled: true
    },
    // Ctrl+1~Ctrl+0：粘贴常用剪贴列表第 N 项（第 10 项对应 0），全局生效
    ...Array.from({ length: 10 }, (_, i) => ({
        id: `pinned_paste_${i + 1}`,
        key: `CommandOrControl+${i + 1 === 10 ? 0 : i + 1}`,
        defaultKey: `CommandOrControl+${i + 1 === 10 ? 0 : i + 1}`,
        scope: 'global' as const,
        command: pinnedClipCommands[i]!,
        title: `粘贴常用剪贴第 ${i + 1} 项`,
        enabled: true
    })),
    // Ctrl+Shift+1~Ctrl+Shift+0：粘贴主剪贴板列表第 N 项（第 10 项对应 0），全局生效
    ...Array.from({ length: 10 }, (_, i) => ({
        id: `slot_paste_${i + 1}`,
        key: `CommandOrControl+Shift+${i + 1 === 10 ? 0 : i + 1}`,
        defaultKey: `CommandOrControl+Shift+${i + 1 === 10 ? 0 : i + 1}`,
        scope: 'global' as const,
        command: clipboardSlotCommands[i]!,
        title: `粘贴剪贴板第 ${i + 1} 项`,
        enabled: true
    }))
];

/** 响应式快捷键列表（自定义后实时反映到设置页与注册表） */
export const shortcuts = ref<ShortcutConfig[]>([...DEFAULT_SHORTCUTS]);

const manager = new ShortcutManager();
let initialized = false;

/** 用当前 shortcuts 配置重新注册全部快捷键（自定义后调用），返回注册失败的项 */
async function reloadShortcuts(): Promise<ShortcutConfig[]> {
    manager.unregisterAllLocals();
    try {
        await manager.unregisterAllGlobals();
    } catch (e) {
        console.error('注销残留快捷键失败:', e);
    }
    return await manager.registerAll(shortcuts.value);
}

/** 把当前快捷键配置批量写入数据库（幂等 upsert，含启用状态） */
async function persistAllShortcuts() {
    try {
        for (const s of shortcuts.value) {
            await dbService.saveShortcutSetting(s.id, s.key, s.scope, s.title);
            await dbService.setKeyValue(`shortcut_enabled_${s.id}`, s.enabled ? '1' : '0');
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
            if (!target) continue;
            // 切换标签页、保存便签、新建便签必须带修饰键（Ctrl/Cmd/Alt/Shift）：
            // 防止误存的无修饰方向键/回车/字母（如 ArrowLeft、Enter、N）覆盖默认组合，
            // 否则会导致「单按左右键就切标签」「Ctrl+Enter 保存失效」或单按字母误新建便签。
            // 命中脏数据时顺带修复数据库（写回默认），避免持续污染。
            const modifierRequiredIds = ['switch_prev_tab', 'switch_next_tab', 'save_note', 'create_note'];
            if (modifierRequiredIds.includes(target.id)) {
                const hasModifier = /(Control|Command|Ctrl|Alt|Shift)/i.test(item.value);
                if (!hasModifier) {
                    await dbService.saveShortcutSetting(target.id, target.defaultKey, target.scope, target.title);
                    continue;
                }
            }
            // 默认不绑定的快捷键（defaultKey 为空）：数据库里的旧默认值（升级前 persist 写入的
            // Control+Alt+C）不算用户自定义，忽略并清理，使升级后默认未绑定；用户后来显式
            // 绑定的其他键位则正常恢复。重绑回旧默认键的极端情况会被视为未绑定，可接受。
            if (!target.defaultKey && normalizeShortcutKey(item.value) === normalizeShortcutKey('Control+Alt+C')) {
                await dbService.saveShortcutSetting(target.id, '', target.scope, target.title);
                continue;
            }
            if (!findShortcutConflict(item.value, target.id)) {
                target.key = item.value;
            }
        }
    } catch (e) {
        console.error('加载快捷键配置失败，使用默认配置:', e);
    }

    // 从数据库恢复每个快捷键的启用状态（缺省默认启用）
    try {
        for (const s of shortcuts.value) {
            const v = await dbService.getKeyValue(`shortcut_enabled_${s.id}`);
            if (v !== null && v !== undefined && v !== '') s.enabled = v === '1';
        }
    } catch (e) {
        console.error('加载快捷键启用状态失败:', e);
    }

    await manager.registerAll(shortcuts.value);
    initialized = true;
}

/** 检测某 key 是否与其他快捷键冲突（排除指定 id），返回冲突项或 null。
 *  修饰键别名（Ctrl/Control/Command/CommandOrControl）归一化后比较，避免跨写法冲突漏检 */
export function findShortcutConflict(key: string, excludeId?: string): ShortcutConfig | null {
    const normalized = normalizeShortcutKey(key);
    return shortcuts.value.find(
        s => s.id !== excludeId && normalizeShortcutKey(s.key) === normalized
    ) ?? null;
}

/** 更新指定快捷键的 key；冲突时返回错误信息，成功返回 null */
export async function updateShortcutKey(id: string, newKey: string): Promise<string | null> {
    const target = shortcuts.value.find(s => s.id === id);
    if (!target) return '快捷键不存在';
    if (!newKey) return '快捷键不能为空';

    // 切换标签页、保存/新建便签必须带修饰键：避免无修饰方向键/回车/字母占用
    // （会与页面内方向键导航、Enter 粘贴等冲突，且导致默认组合失效）
    if (['switch_prev_tab', 'switch_next_tab', 'save_note', 'create_note'].includes(target.id)) {
        if (!/(Control|Command|Ctrl|Alt|Shift)/i.test(newKey)) {
            return '该快捷键必须包含修饰键（Ctrl/Cmd/Alt/Shift）';
        }
    }

    const conflict = findShortcutConflict(newKey, id);
    if (conflict) return `与「${conflict.title}」冲突`;

    const prevKey = target.key;
    target.key = newKey;
    let failed: ShortcutConfig[] = [];
    try {
        failed = await reloadShortcuts();
    } catch (e) {
        console.error('快捷键注册失败:', e);
        failed = [target];
    }
    if (failed.some(f => f.id === id)) {
        // 注册失败（如新键被系统/其他程序占用）：回滚为原键并重新注册，不把"死键"持久化
        target.key = prevKey;
        try { await reloadShortcuts(); } catch { /* 回滚注册失败仅记录 */ }
        return '快捷键注册失败（可能被系统或其他程序占用）';
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

/** 切换单个快捷键的启用状态并持久化（设置页每个快捷键项前的胶囊开关调用） */
export async function toggleShortcutEnabled(id: string): Promise<void> {
    const target = shortcuts.value.find(s => s.id === id);
    if (!target) return;
    target.enabled = !target.enabled;
    try {
        await reloadShortcuts();
    } catch (e) {
        console.error('快捷键注册失败:', e);
    }
    try {
        await dbService.setKeyValue(`shortcut_enabled_${target.id}`, target.enabled ? '1' : '0');
    } catch (e) {
        console.error('保存快捷键启用状态失败:', e);
    }
}

/** 批量设置一组快捷键的启用状态（一次重注册 + 批量持久化），供折叠组"一键开启/一键关闭" */
export async function setShortcutGroupEnabled(ids: string[], enabled: boolean): Promise<void> {
    for (const id of ids) {
        const s = shortcuts.value.find(x => x.id === id);
        if (s) s.enabled = enabled;
    }
    try {
        await reloadShortcuts();
    } catch (e) {
        console.error('快捷键注册失败:', e);
    }
    try {
        for (const id of ids) {
            const s = shortcuts.value.find(x => x.id === id);
            if (s) await dbService.setKeyValue(`shortcut_enabled_${id}`, s.enabled ? '1' : '0');
        }
    } catch (e) {
        console.error('保存快捷键启用状态失败:', e);
    }
}

/** 批量还原一组快捷键为默认（默认 key + 默认启用），供折叠组"一键还原" */
export async function resetShortcutGroup(ids: string[]): Promise<void> {
    for (const id of ids) {
        const s = shortcuts.value.find(x => x.id === id);
        const def = DEFAULT_SHORTCUTS.find(d => d.id === id);
        if (s && def) {
            s.key = def.defaultKey;
            s.enabled = def.enabled;
        }
    }
    try {
        await reloadShortcuts();
    } catch (e) {
        console.error('快捷键注册失败:', e);
    }
    try {
        for (const id of ids) {
            const s = shortcuts.value.find(x => x.id === id);
            if (s) {
                await dbService.saveShortcutSetting(s.id, s.key, s.scope, s.title);
                await dbService.setKeyValue(`shortcut_enabled_${id}`, s.enabled ? '1' : '0');
            }
        }
    } catch (e) {
        console.error('保存快捷键设置失败:', e);
    }
}

/** 全部重置：恢复快捷键为默认值；可传入 scope 只重置全局或局部 */
export async function resetAllShortcuts(scope?: ShortcutScope): Promise<void> {
    shortcuts.value.forEach(s => {
        if (scope && s.scope !== scope) return;
        const def = DEFAULT_SHORTCUTS.find(d => d.id === s.id);
        if (def) {
            s.key = def.defaultKey;
            s.enabled = def.enabled;
        }
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
