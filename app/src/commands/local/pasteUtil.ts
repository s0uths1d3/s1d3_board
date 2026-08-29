import { writeText, writeImageBase64 } from 'tauri-plugin-clipboard-api';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '~/utils/env';

/**
 * 将指定内容粘贴到唤起剪贴板窗口前的目标输入框。
 *
 * 丝滑时序（关键，顺序不可颠倒）：
 *   1. 把内容写入系统剪贴板（Tauri 原生 / Web 回退）
 *   2. 隐藏 clip 窗口 —— 焦点会回到之前的目标窗口
 *   3. 延迟一小段（等待目标窗口重新获得焦点）
 *   4. 模拟 Ctrl/Cmd+V 粘贴
 *
 * 若先模拟粘贴再隐藏窗口，按键会落在 clip 窗口自身，导致粘贴失败。
 * 该工具供 Enter 粘贴、Ctrl+数字 快捷粘贴等命令复用。
 */
export async function pasteContentToActiveApp(content: string, type: 'text' | 'image'): Promise<void> {
    if (!content) return;

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
        }, 200);
    }
}
