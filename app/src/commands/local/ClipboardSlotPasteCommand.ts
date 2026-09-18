import type { Command } from '../Command';
import { data } from './clipboardStore';
import clipboardService from '~/src/db/dbService';
import { pasteContentToActiveApp } from './pasteUtil';

/**
 * Ctrl+Shift+1~Ctrl+Shift+0 快捷粘贴命令：粘贴主剪贴板列表（当前展示的 data）中的第 N 项。
 * 每个数字对应一个命令实例（slot 1~10）。
 */
export class ClipboardSlotPasteCommand implements Command {
    /** 槽位序号（1~10），对应当前剪贴板列表的第 N 项 */
    constructor(private slot: number) {}

    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        const item = data.value[this.slot - 1];
        if (!item || !item.content) return;
        // 抑制写剪贴板触发的入库计数 bump：本命令已显式 +1，剪贴板监听再 bump 会双计（+2）
        clipboardService.suppressUseCountBump();
        await clipboardService.increaseUseCount(item.id);
        await pasteContentToActiveApp(item.content, item.type);
    }
}
