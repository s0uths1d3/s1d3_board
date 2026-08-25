import type { Command } from '../Command';
import clipboardService from '~/src/db/dbService';
import { getSelectedItem } from './clipboardStore';
import { emit } from '@tauri-apps/api/event';

/**
 * Ctrl+U：将当前选中的剪贴板项添加为常用剪贴。
 * 若该内容（按 content + type 判定）已存在于常用剪贴，则直接忽略。
 * 执行结果通过事件 'add-to-pinned:result' 上报，由主窗口展示 toast 提示。
 */
export class AddToPinnedCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        const item = getSelectedItem();
        if (!item) {
            await emit('add-to-pinned:result', { status: 'none' });
            return;
        }

        const content = item.content;
        const type = (item.type ?? 'text') as 'text' | 'image';

        // 去重：已添加则忽略
        const exists = await clipboardService.isPinnedContentExist(content, type);
        if (exists) {
            await emit('add-to-pinned:result', { status: 'exists' });
            return;
        }

        await clipboardService.insertPinnedClip(content, type, item.name ?? '', item.source ?? '');
        await emit('add-to-pinned:result', { status: 'added' });
    }
}
