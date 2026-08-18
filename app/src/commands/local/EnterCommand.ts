import type { Command } from '../Command';

export class EnterCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        // 待迁移
    }
}