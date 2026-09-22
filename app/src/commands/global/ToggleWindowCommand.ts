import {getCurrentWindow} from '@tauri-apps/api/window';
import {getCurrentWebview} from '@tauri-apps/api/webview';
import type {Command} from '../Command';
import {bus} from '../../core/events';
import {applyPopupPosition, savePopupLastPosition} from '~/composables/usePopupPosition';

export class ToggleWindowCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;

        const win = getCurrentWindow();
        try {
            const visible = await win.isVisible();
            // 焦点参与 toggle 判定：可见但未持焦（环盘/其它子窗口持焦、或滞留后台）
            // 时按 Ctrl+I 的意图是「唤出」而非「隐藏」——否则环盘打开期间主窗口被
            // __ringActive 豁免自动隐藏而保持可见，Ctrl+I 会误执行 hide，表现为
            // 「按了没反应 / 无法显示主窗口」。主窗口 setFocus 后环心失焦自动退场
            // （ring.shown 门控下的 closeRing），环盘无需在此显式关闭。
            const focused = visible ? await win.isFocused().catch(() => false) : false;
            if (visible && focused) {
                // 隐藏前记录当前位置（含用户拖动过的新位置），供「上次位置」模式恢复
                await savePopupLastPosition().catch(() => {});
                await win.hide();
            } else {
                // 按设置的弹出位置模式定位（光标处 / 上次位置 / 屏幕中央）后再显示
                await applyPopupPosition().catch(() => {});
                if (await win.isMinimized().catch(() => false)) {
                    await win.unminimize().catch(() => {});
                }
                await win.show();

                // 等待窗口/WebView2 完成显示后再聚焦，避免对未就绪的 webview
                // 调用 SetFocus 报 0x80070057(E_INVALIDARG)。
                await new Promise(r => setTimeout(r, 50));

                // 系统级聚焦：窗口 + webview 都必须拿到键盘焦点，local 快捷键（方向键）才会生效。
                // 仅 window.focus()（JS）无法转移系统键盘焦点，必须调用 Tauri 的 setFocus。
                await win.setFocus();
                // webview 级 setFocus 是 fire-and-forget（JS catch 收不到错误，失败只在 Rust 侧
                // 打 "failed to focus webview" ERROR 日志）：对最小化/挂起中的 webview 调用
                // MoveFocus 会报 0x80070057，因此调用前显式排除最小化状态。
                try {
                    if (!(await win.isMinimized())) {
                        await getCurrentWebview().setFocus();
                    }
                } catch (e) {
                    console.error('webview 聚焦失败:', e);
                }

                // 延迟派发事件，等窗口完成显示后让列表元素聚焦（双重保险）
                setTimeout(() => {
                    window.focus();
                    bus.emit('window-shown');
                }, 80);
            }
        } catch (error) {
            console.error('Error toggling window visibility:', error);
        }
    }
}
