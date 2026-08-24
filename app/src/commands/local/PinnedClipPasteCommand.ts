import type { Command } from '../Command';
import clipboardService from '~/src/db/dbService';
import { pasteContentToActiveApp } from './pasteUtil';

/**
 * Ctrl+1~Ctrl+0 快捷粘贴命令：粘贴「常用剪贴」列表中的第 N 项。
 * 每个数字对应一个命令实例（slot 1~10），列表按 sort_order 排序，编号由顺序决定。
 */
export class PinnedClipPasteCommand implements Command {
    /** 槽位序号（1~10），对应常用剪贴列表的第 N 项 */
    constructor(private slot: number) {}

    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        const clips = await clipboardService.fetchPinnedClips();
        const item = clips[this.slot - 1];
        if (!item || !item.content) return;
        await pasteContentToActiveApp(item.content, item.type);
    }
}
