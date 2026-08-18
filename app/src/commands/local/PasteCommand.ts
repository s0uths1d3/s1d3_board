import type { Command } from '../Command';
import { getSelectedContent, getSelectedRowIndex } from './clipboardStore';
import clipboardService from '~/src/db/dbService';
import { writeText } from 'tauri-plugin-clipboard-api';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '~/src/utils/env';

/**
 * Enter 粘贴命令：将当前选中的 clip 项粘贴到唤起 clip 窗口前的目标输入框。
 *
 * 丝滑时序（关键，顺序不可颠倒）：
 *   1. 取选中项内容
 *   2. 递增使用次数
 *   3. 把内容写入系统剪贴板（Tauri 原生 / Web 回退）
 *   4. 隐藏 clip 窗口 —— 焦点会回到之前的目标窗口
 *   5. 延迟一小段（等待目标窗口重新获得焦点）
 *   6. 模拟 Ctrl/Cmd+V 粘贴
 *
 * 若先模拟粘贴再隐藏窗口，按键会落在 clip 窗口自身，导致粘贴失败。
 */
export class PasteCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;

        const content = getSelectedContent();
        if (!content) return;

        await clipboardService.increaseUseCount(getSelectedRowIndex());

        // 1. 写入系统剪贴板（跨平台）
        try {
            if (isTauri()) {
                await writeText(content);
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
}
