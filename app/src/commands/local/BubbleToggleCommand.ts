import type { Command } from '../Command';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import { getSmartClipEntries } from '../../smart-clip/smartClip';

/**
 * 气泡窗口开关命令（设计文档 §4.4，全局快捷键 Ctrl+B 默认）：
 *
 * - 窗口单例 label：clipboard-bubble-main
 * - 可见 → 关闭（toggle off）；不存在/隐藏 → close 后重建。
 *   重建而非复用隐藏实例的原因：WebView2 隐藏窗口可能被系统挂起、事件通道失效
 *   （同 tooltip 单例重建的经验），重建可保证数据与键盘交互鲜活。
 * - 创建走 visible:false + ready 握手（bubble:ready → 主窗口 emit bubble:show 数据 →
 *   气泡窗口自行 show + setFocus），避免空窗口闪烁与竞态。
 * - 数据来源：smartClip 内存 store（主窗口上下文持有，复制事件实时更新）。
 */
const BUBBLE_LABEL = 'clipboard-bubble-main';

export class BubbleToggleCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;

        const existing = await WebviewWindow.getByLabel(BUBBLE_LABEL).catch(() => null);
        if (existing) {
            const visible = await existing.isVisible().catch(() => false);
            // 可见 → 关闭；隐藏/挂起 → 销毁后重建（保数据与交互鲜活）
            await existing.close().catch(() => {});
            if (visible) return;
        }

        // 子窗口创建豁免期：避免创建瞬间触发主窗口失焦隐藏（同 tooltip 模式）
        (window as any).__childOpeningUntil = Date.now() + 600;

        // ready 握手必须先于 new WebviewWindow 注册（同 tooltip 的竞态处理经验）
        const unReady = await listen('bubble:ready', () => {
            void emit('bubble:show', { entries: getSmartClipEntries() });
            unReady();
        });
        setTimeout(() => unReady(), 5000);

        const win = new WebviewWindow(BUBBLE_LABEL, {
            url: '/bubble',
            title: 'Smart Clipboard',
            width: 400,
            height: 480,
            resizable: false,
            decorations: false,
            transparent: false,
            skipTaskbar: true,
            focus: true,          // 键盘交互（↑↓/Enter）需要窗口焦点
            alwaysOnTop: true,    // 快捷粘贴场景必须浮于目标应用之上
            visible: false,       // 数据就绪（bubble:show）后由气泡窗口自行 show
        });
        win.once('tauri://created', () => {
            (window as any).__childOpeningUntil = Date.now() + 400;
        });
        win.once('tauri://error', () => {
            unReady();
        });
    }
}
