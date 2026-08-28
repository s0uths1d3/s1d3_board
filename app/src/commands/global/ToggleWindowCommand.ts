import {getCurrentWindow} from '@tauri-apps/api/window';
import {getCurrentWebview} from '@tauri-apps/api/webview';
import type {Command} from '../Command';
import {applyPopupPosition, savePopupLastPosition} from '~/composables/usePopupPosition';

export class ToggleWindowCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;

        const win = getCurrentWindow();
        try {
            const visible = await win.isVisible();
            if (visible) {
                // 隐藏前记录当前位置（含用户拖动过的新位置），供「上次位置」模式恢复
                await savePopupLastPosition().catch(() => {});
                await win.hide();
            } else {
                // 按设置的弹出位置模式定位（光标处 / 上次位置 / 屏幕中央）后再显示
                await applyPopupPosition().catch(() => {});
                await win.show();

                // 等待窗口/WebView2 完成显示后再聚焦，避免对未就绪的 webview
                // 调用 SetFocus 报 0x80070057(E_INVALIDARG)。
                await new Promise(r => setTimeout(r, 50));

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
