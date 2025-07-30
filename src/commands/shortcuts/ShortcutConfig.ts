import type { Command } from '../Command';
import {shortcuts} from "~/src/commands/shortcuts/InitShortcuts";

export type ShortcutScope = 'global' | 'local';

export interface ShortcutConfig {
    key: string;
    scope: ShortcutScope;
    command: Command;
    title: string;
    shortcuts?: string;
}
