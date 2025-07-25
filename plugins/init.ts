import {TrayIcon} from '@tauri-apps/api/tray';
import {Menu} from '@tauri-apps/api/menu';
import {getCurrentWindow} from "@tauri-apps/api/window";

export default defineNuxtPlugin(async (nuxtApp) => {
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
