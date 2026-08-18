import {TrayIcon} from '@tauri-apps/api/tray';
import {Menu} from '@tauri-apps/api/menu';
import {getCurrentWindow} from "@tauri-apps/api/window";
import {isTauri} from "~/src/utils/env";

export default defineNuxtPlugin(async (nuxtApp) => {
    // 托盘图标 / 窗口 API 仅存在于 Tauri 桌面容器内，
    // 纯 Web dev server 下直接跳过，避免 Tauri API 缺失导致 H3Error。
    if (!isTauri()) {
        return;
    }

    try {
        const menu = await Menu.new({
            items: [
                {
                    id: 'quit',
                    text: 'Quit',
                    action: async () => {
                        await getCurrentWindow().close();
                    }
                },
            ],
        });

        const options = {
            menu,
            menuOnLeftClick: true,
            title: 's1de board',
            icon: '../assets/icon/icon_64x64.ico'
        };
        await TrayIcon.new(options);
        await getCurrentWindow().setIcon('../assets/icon/icon.png')
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
    }
});
