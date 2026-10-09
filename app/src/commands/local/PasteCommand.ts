import type { Command } from '../Command';
import {
    getSelectedContent, getSelectedRowId,
    sequenceActive, peekSequenceItem, advanceSequenceCursor, exitSequence,
} from './clipboardStore';
import clipboardService from '~/src/db/dbService';
import { pasteContentToActiveApp } from './pasteUtil';
import { decryptClipText, isEncryptedContent } from '../../clipboard/encryption';
import { notifyIsland } from '~/composables/useCopyIsland';
import { useI18n } from '~/composables/useI18n';
import { activeTab } from '~/composables/useTabs';

/**
 * Enter 粘贴命令：将当前选中的 clip 项粘贴到唤起 clip 窗口前的目标输入框。
 *
 * 时序（关键，顺序不可颠倒）：
 *   1. 取选中项内容
 *   2. 递增使用次数（必须传数据库 id）
 *   3. 写剪贴板 → 隐藏窗口 → 模拟 Ctrl/Cmd+V（与 Ctrl+数字 快捷粘贴共用 pasteUtil 实现）
 *
 * 序列粘贴模式激活时（批量多选 ≥2 条设置为队列）：改为按队列游标逐条粘贴（循环步进），
 * 粘贴后延迟弹岛进度（序列粘贴 {i}/{n}），不受选中行影响。
 *
 * 仅在剪贴板 Tab 响应：常用剪贴页的选中态是 PinnedClipList 的本地状态，
 * 与主剪贴板 store 不同步，按 Enter 会粘贴屏幕上不可见的条目（其粘贴走 Ctrl+数字 专属命令）。
 */
export class PasteCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;

        if (activeTab.value !== 'clip') return;

        // ===== 序列粘贴模式：按队列步进粘贴，忽略当前选中行 =====
        if (sequenceActive.value) {
            const item = peekSequenceItem();
            if (!item) {
                // 队列条目已不在加载数据中（被删除/被裁剪）：退出序列防粘贴错误内容
                exitSequence();
                return;
            }
            await this.pasteItem(item);
            const { index, total } = advanceSequenceCursor();
            // 进度胶囊延迟到 pasteContentToActiveApp 的"已粘贴"提示之后（岛单窗显示，覆盖展示）
            setTimeout(() => {
                notifyIsland({ kind: 'info', text: useI18n().t('clip.sequence_progress', { i: index, n: total }) });
            }, 700);
            return;
        }

        const selected = getSelectedContent();
        if (!selected) return;
        const { content, type, htmlContent } = selected;
        if (!content) return;

        // 递增使用次数：传数据库 id（此前误传行索引，会污染 id===行号 的无关记录并打乱列表排序）。
        // 抑制写剪贴板触发的入库计数 bump：本条已显式 +1，剪贴板监听再 bump 会双计（+2）
        const id = getSelectedRowId();
        if (id !== undefined) {
            clipboardService.suppressUseCountBump();
            await clipboardService.increaseUseCount(id).catch((err) => {
                console.error('记录使用次数失败:', err);
            });
        }

        await pasteContentToActiveApp(content, type, htmlContent ?? undefined);
    }

    /** 粘贴单条（序列与普通粘贴共用）：加密条目先解密，显式计数防双计 */
    private async pasteItem(item: { id: number; content: string; type?: string; html_content?: string | null }): Promise<void> {
        if (!item.content) return;
        // 加密条目先解密为明文再写剪贴板；解密失败中止粘贴
        let pasteText = item.content;
        if (isEncryptedContent(item.content)) {
            try {
                pasteText = await decryptClipText(item.content);
            } catch (e) {
                console.error('粘贴加密条目解密失败:', e);
                return;
            }
        }
        clipboardService.suppressUseCountBump();
        await clipboardService.increaseUseCount(item.id).catch((err) => {
            console.error('记录使用次数失败:', err);
        });
        await pasteContentToActiveApp(pasteText, (item.type ?? 'text') as 'text' | 'image' | 'html' | 'files', item.html_content ?? undefined);
    }
}
