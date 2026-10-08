import { writeText, writeImageBase64, readText } from 'tauri-plugin-clipboard-api';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '~/utils/env';
import { notifyIslandPaste, suppressIslandCopy } from '~/composables/useCopyIsland';
import dbService from '~/src/db/dbService';

/** 粘贴完成后恢复原剪贴板的延迟：等目标应用完成剪贴板读取后再写回 */
const PASTE_RESTORE_DELAY_MS = 800;

/**
 * 将指定内容粘贴到唤起剪贴板窗口前的目标输入框。
 *
 * 丝滑时序（关键，顺序不可颠倒）：
 *   1. 把内容写入系统剪贴板（Tauri 原生 / Web 回退）
 *   2. 隐藏 clip 窗口 —— 焦点会回到之前的目标窗口
 *   3. 延迟一小段（等待目标窗口重新获得焦点）
 *   4. 模拟 Ctrl/Cmd+V 粘贴
 *   5. 「粘贴后恢复原剪贴板」开启时（默认关闭）：等粘贴完成再延迟一段，把粘贴前的
 *      剪贴板文本写回（恢复写入同样抑制"已复制"弹岛与计数 bump，不污染历史）
 *
 * 若先模拟粘贴再隐藏窗口，按键会落在 clip 窗口自身，导致粘贴失败。
 * 该工具供 Enter 粘贴、Ctrl+数字 快捷粘贴等命令复用。
 */
export async function pasteContentToActiveApp(content: string, type: 'text' | 'image'): Promise<void> {
    if (!content) return;

    // 恢复原剪贴板（开关默认关闭）：写剪贴板前先记录当前文本（仅文本；当前为图片/读不到时跳过）。
    // 与待粘贴内容一致时跳过——常规"复制后即粘贴"场景剪贴板本就未被破坏
    let previousText: string | null = null;
    if (isTauri() && (await dbService.getKeyValue('paste_restore_clipboard')) === '1') {
        try {
            const prev = await readText();
            previousText = prev && prev !== content ? prev : null;
        } catch { previousText = null; }
    }

    // 灵动岛：粘贴也会写剪贴板，先抑制随之触发的"已复制"，写入成功后再显示"已粘贴"。
    // 注意：此处不抑制入库计数 bump——PinnedClipPasteCommand 等无显式计数的路径靠
    // 剪贴板监听的 upsert bump 计数；有显式 increaseUseCount 的命令须自行调
    // dbService.suppressUseCountBump() 防双计（见 PasteCommand / ClipboardSlotPasteCommand）
    suppressIslandCopy();

    // 1. 写入系统剪贴板（跨平台，按类型区分）
    try {
        if (isTauri()) {
            if (type === 'image') {
                await writeImageBase64(content);
            } else {
                await writeText(content);
            }
        } else if (navigator.clipboard) {
            await navigator.clipboard.writeText(content);
        }
    } catch (err) {
        console.error('写入剪贴板失败:', err);
    }
    void notifyIslandPaste(content, type);

    // 2. 先隐藏窗口，让系统把焦点交还给目标窗口
    await getCurrentWindow().hide();

    // 3. 等待目标窗口获得焦点后再模拟粘贴
    if (isTauri()) {
        setTimeout(async () => {
            try {
                await invoke('paste');
            } catch (e) {
                console.error('模拟粘贴失败:', e);
            }
            if (previousText !== null) {
                setTimeout(() => {
                    suppressIslandCopy();
                    dbService.suppressUseCountBump();
                    writeText(previousText!).catch(() => { /* 恢复失败静默：不影响粘贴主流程 */ });
                }, PASTE_RESTORE_DELAY_MS);
            }
        }, 200);
    }
}
