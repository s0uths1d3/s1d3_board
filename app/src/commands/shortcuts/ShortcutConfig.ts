import type { Command } from '../Command';

export type ShortcutScope = 'global' | 'local';

export interface ShortcutConfig {
    /** 唯一标识（用于更新/重置/冲突检测） */
    id: string;
    /** 当前快捷键（Tauri key 格式，如 CommandOrControl+I / Control+Shift+ArrowUp） */
    key: string;
    /** 默认快捷键（重置时恢复） */
    defaultKey: string;
    scope: ShortcutScope;
    command: Command;
    title: string;
    /** 是否启用该快捷键（false 时不注册/不响应） */
    enabled: boolean;
}
