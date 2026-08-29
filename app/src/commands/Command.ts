/** 快捷键事件载荷（对齐 Tauri ShortcutEvent 的 state 字面量，拼错状态名会直接编译报错） */
export type CommandEvent = { state: 'Pressed' | 'Released' };

export interface Command {
    execute(event?: CommandEvent): Promise<void>;
}
