import {TrayIcon} from '@tauri-apps/api/tray';
import {Menu} from '@tauri-apps/api/menu';
import {Image} from '@tauri-apps/api/image';
import {invoke} from '@tauri-apps/api/core';
import {resolveResource} from '@tauri-apps/api/path';
import {WebviewWindow} from '@tauri-apps/api/webviewWindow';
import {getCurrentWindow} from "@tauri-apps/api/window";
import {isTauri} from "~/utils/env";
import statsService from "~/src/statistics/statsService";

/** 托盘菜单创建（独立函数）：Windows 原生菜单窗口在创建时快照进程主题
 *  （SetPreferredAppMode 对已存在的菜单不生效），因此切换配色后需要整体
 *  重建菜单才能让右键菜单实时跟随应用配色（琥珀/浅色 → 浅色菜单，深色 → 暗色菜单）。 */
async function createTrayMenu(): Promise<Menu> {
    return Menu.new({
        items: [
            {
                id: 'toggle',
                text: '显示/隐藏',
                action: async () => {
                    const main = await WebviewWindow.getByLabel('main');
                    if (!main) return;
                    if (await main.isVisible()) {
                        await main.hide();
                    } else {
                        await main.show();
                        // 等待窗口/WebView2 就绪后再聚焦，避免 SetFocus 报 0x80070057
                        await new Promise(r => setTimeout(r, 50));
                        await main.setFocus();
                    }
                }
            },
            {
                id: 'quit',
                text: '退出',
                action: async () => {
                    // 真正退出程序：直接结束进程（绕过主窗口 close 拦截——
                    // 标题栏 x 已改为隐藏到托盘，托盘退出是唯一退出入口）。
                    // process exit 不会触发 beforeunload 的统计落库，这里先手动 flush。
                    try {
                        await statsService.flush();
                    } catch { /* 落库失败仍退出 */ }
                    await invoke('quit_app');
                }
            },
        ],
    });
}

/** 当前托盘实例（重建菜单时调用 setMenu 替换） */
let trayIconRef: TrayIcon | null = null;
/** 重建去重：setMenu 异步串行进行，避免连续切换配色时并发重建 */
let rebuildingMenu = false;

async function rebuildTrayMenu() {
    if (!trayIconRef || rebuildingMenu) return;
    rebuildingMenu = true;
    try {
        await trayIconRef.setMenu(await createTrayMenu());
        console.log('Tray menu rebuilt (follow color scheme)');
    } catch (e) {
        console.error('重建托盘菜单失败:', e);
    } finally {
        rebuildingMenu = false;
    }
}

export default defineNuxtPlugin(async (nuxtApp) => {
    // 托盘图标 / 窗口 API 仅存在于 Tauri 桌面容器内，
    // 纯 Web dev server 下直接跳过，避免 Tauri API 缺失导致 H3Error。
    if (!isTauri()) {
        return;
    }
    // 只在主窗口创建托盘图标，避免子窗口（查看器/删除确认）重复创建多个托盘
    if (getCurrentWindow().label !== 'main') {
        return;
    }

    // 先挂监听再创建托盘：useColorScheme 的 watch immediate 可能在托盘创建完成前触发，
    // 事件不能丢（trayIconRef 未就绪时 rebuild 会跳过，创建完成后的主动重建会兜底）
    window.addEventListener('resolved-scheme-changed', () => {
        void rebuildTrayMenu();
    });

    try {
        const menu = await createTrayMenu();

        // 图标：通过 resolveResource 解析打包资源（bundle.resources 已配置 icons/icon_256x256.ico）
        // 获得绝对路径，再用 Image.fromPath 加载。不能直接传相对路径（运行时无法解析）。
        const iconPath = await resolveResource('icons/icon_256x256.ico');
        const trayIcon = await Image.fromPath(iconPath);

        const options = {
            menu,
            menuOnLeftClick: true,
            title: 's1d3 board',
            icon: trayIcon,
        };
        trayIconRef = await TrayIcon.new(options);
        console.log('Tray icon created successfully');
        await getCurrentWindow().setIcon(trayIcon);

        // 托盘菜单的深浅色由 useColorScheme 统一同步（set_menu_theme → Windows
        // SetPreferredAppMode），跟随应用配色（琥珀/浅色 → 菜单浅色，深色 → 菜单暗色）；
        // 此处不再强制窗口 setTheme('light')——它对原生菜单无效，且会干扰
        // matchMedia 对系统深浅色的解析，破坏「跟随系统」配色档。
        //
        // 但 SetPreferredAppMode 对已创建的菜单窗口不生效（创建时快照主题），
        // 因此解析配色变化时（resolved-scheme-changed 事件）整体重建托盘菜单；
        // 创建完成后也主动重建一次，纠正启动时序下首建菜单的主题偏差
        // （首建发生在 set_menu_theme 首次调用前，主题跟随系统而非持久化配色）。
        void rebuildTrayMenu();
    } catch (error) {
        console.error('Error initializing tray:', error);
    }
});
