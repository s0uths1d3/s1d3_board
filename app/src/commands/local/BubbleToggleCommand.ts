import type { Command } from '../Command';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen, emitTo } from '@tauri-apps/api/event';
import { getSmartClipEntries, parseClipItem } from '../../smart-clip/smartClip';
import { getSelectedItem } from './clipboardStore';
import type { SmartClipEntry } from '../../smart-clip/types';

/**
 * 气泡窗口开关命令（设计文档 §4.4，全局快捷键 Ctrl+B 默认）：
 *
 * - Use a unique label per open (see tooltip single-instance pattern).
 * - 可见 → 关闭（toggle off）；不存在/隐藏 → close 后重建。
 *   重建而非复用隐藏实例的原因：WebView2 隐藏窗口可能被系统挂起、事件通道失效
 *   （同 tooltip 单例重建的经验），重建可保证数据与键盘交互鲜活。
 * - 创建走 visible:false + ready 握手（bubble:ready → 主窗口 emitTo bubble:show 数据 →
 *   气泡窗口自行 show + setFocus），避免空窗口闪烁与竞态。
 * - 数据来源（deliverEntries）：**当前选中的剪贴项**（clipboardStore 的选中态），
 *   命中缓存则复用、否则走解析管道（规则/AI），因此选中任意一条历史记录也能即时解析；
 *   无选中项（列表为空 / 选中图片）时回退为 smartClip 内存 store 的最近解析结果。
 * - AI 加工耗时不可控：先用原文占位让气泡立刻弹出，解析完成后再投递结果覆盖。
 */
const BUBBLE_PREFIX = 'clipboard-bubble-';
let currentLabel: string | null = null;

/** 原文占位条目：AI 加工未返回前也要让气泡有可粘贴内容（解析失败时同样保留） */
function rawEntry(id: number, content: string, ts: number): SmartClipEntry {
    return { id, content, segments: [{ index: 0, text: content, source: 'rule' }], ts };
}

/** 定向投递气泡数据：解析「当前选中项」；解析进行中标记 loading，完成后覆盖为结果 */
async function deliverEntries(label: string): Promise<void> {
    const selected = getSelectedItem();
    // 仅文本进解析管道：图片内容是 base64，拆分/加工无意义
    const content = selected && (selected.type ?? 'text') === 'text' ? selected.content : '';
    if (!selected || !content) {
        await emitTo(label, 'bubble:show', { entries: getSmartClipEntries(), loading: false });
        return;
    }
    const placeholder = rawEntry(selected.id, content, Date.now());
    await emitTo(label, 'bubble:show', { entries: [placeholder], loading: true });
    try {
        const entry = await parseClipItem(selected.id, content, placeholder.ts);
        await emitTo(label, 'bubble:show', { entries: [entry], loading: false });
    } catch (e) {
        console.error('[bubble] 解析选中剪贴项失败，保留原文:', e);
        await emitTo(label, 'bubble:show', { entries: [placeholder], loading: false });
    }
}

export class BubbleToggleCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;

        // Toggle off when the current bubble is visible; otherwise destroy and rebuild.
        if (currentLabel) {
            const existing = await WebviewWindow.getByLabel(currentLabel).catch(() => null);
            if (existing) {
                const visible = await existing.isVisible().catch(() => false);
                await existing.close().catch(() => {});
                if (visible) {
                    currentLabel = null;
                    return;
                }
            }
            currentLabel = null;
        }

        // Unique label per open avoids the fixed-label race: closing the old window
        // then new-ing the same label before the old one is fully destroyed makes
        // window creation fail, so the bubble never opens (Ctrl+B failed on 2nd press).
        const label = `${BUBBLE_PREFIX}${Date.now()}`;
        currentLabel = label;

        (window as any).__childOpeningUntil = Date.now() + 600;

        const unReady = await listen('bubble:ready', (ev) => {
            if ((ev.payload as string | undefined) !== label) return;
            unReady();
            void deliverEntries(label);
        });
        setTimeout(() => unReady(), 5000);

        const win = new WebviewWindow(label, {
            url: '/bubble',
            title: 'Smart Clipboard',
            width: 400,
            height: 480,
            resizable: false,
            decorations: false,
            transparent: false,
            skipTaskbar: true,
            focus: false,          // bubble.vue setFocus() after show; avoid focusing invisible window
            alwaysOnTop: true,     // quick-paste must float above the target app
            visible: false,        // bubble window shows itself after bubble:show data arrives
        });
        win.once('tauri://created', () => {
            (window as any).__childOpeningUntil = Date.now() + 400;
        });
        win.once('tauri://error', () => {
            unReady();
            if (currentLabel === label) currentLabel = null;
        });
    }
}
