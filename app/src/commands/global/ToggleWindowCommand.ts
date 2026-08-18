import {getCurrentWindow} from '@tauri-apps/api/window';
import {getCurrentWebview} from '@tauri-apps/api/webview';
import type {Command} from '../Command';

export class ToggleWindowCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;

        const win = getCurrentWindow();
        try {
            const visible = await win.isVisible();
            if (visible) {
                await win.hide();
            } else {
                await win.show();

                // 系统级聚焦：窗口 + webview 都必须拿到键盘焦点，local 快捷键（方向键）才会生效。
                // 仅 window.focus()（JS）无法转移系统键盘焦点，必须调用 Tauri 的 setFocus。
                await win.setFocus();
                try {
                    await getCurrentWebview().setFocus();
                } catch (e) {
                    console.error('webview 聚焦失败:', e);
                }

                // 延迟派发事件，等窗口完成显示后让列表元素聚焦（双重保险）
                setTimeout(() => {
                    window.focus();
                    window.dispatchEvent(new CustomEvent('window-shown'));
                }, 80);
            }
        } catch (error) {
            console.error('Error toggling window visibility:', error);
        }
    }
}
