import {TrayIcon} from '@tauri-apps/api/tray';
import {Menu} from '@tauri-apps/api/menu';
import {Image} from '@tauri-apps/api/image';
import {resolveResource} from '@tauri-apps/api/path';
import {WebviewWindow} from '@tauri-apps/api/webviewWindow';
import {getCurrentWindow} from "@tauri-apps/api/window";
import {isTauri} from "~/src/utils/env";

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

    try {
        const menu = await Menu.new({
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
                            await main.setFocus();
                        }
                    }
                },
                {
                    id: 'quit',
                    text: '退出',
                    action: async () => {
                        const main = await WebviewWindow.getByLabel('main');
                        if (main) await main.close();
                    }
                },
            ],
        });

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
        await TrayIcon.new(options);
        console.log('Tray icon created successfully');
        await getCurrentWindow().setIcon(trayIcon);
        // 强制浅色主题：Windows 上窗口主题决定托盘菜单/上下文菜单的配色，
        // 与主窗口暖米白浅色风格保持一致（避免系统深色模式下托盘菜单变黑）
        try {
            await getCurrentWindow().setTheme('light');
        } catch (e) {
            console.warn('设置浅色主题失败:', e);
        }
    } catch (error) {
        console.error('Error initializing tray:', error);
    }
});
