// src/shortcuts/ShortcutConfig.ts
import type { Command } from '../commands/Command';

export type ShortcutScope = 'global' | 'local';

export interface ShortcutConfig {
    key: string;
    scope: ShortcutScope;
    command: Command;
}
