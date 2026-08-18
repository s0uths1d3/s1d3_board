import { register, unregisterAll } from '@tauri-apps/plugin-global-shortcut';
import type { ShortcutConfig } from './ShortcutConfig';

export class ShortcutManager {
    private localHandlers: (() => void)[] = [];

    async register(config: ShortcutConfig) {
        if (config.scope === 'global') {
            await register(config.key, async (event) => {
                await config.command.execute(event);
            });
            console.log(`[Global Shortcut Registered] ${config.key}`);
        } else if (config.scope === 'local') {
            const handler = async (e: KeyboardEvent) => {
                const key = config.key.toLowerCase();
                const pressedKey = e.key.toLowerCase();

                const ctrl = key.includes('ctrl') || key.includes('command');
                const alt = key.includes('alt');
                const shift = key.includes('shift');

                const modifierMatch =
                    (!ctrl || e.ctrlKey || e.metaKey) &&
                    (!alt || e.altKey) &&
                    (!shift || e.shiftKey);

                const mainKey = key.split('+').pop()?.trim();
                const isMatch = pressedKey === mainKey && modifierMatch;

                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                    e.preventDefault();
                }

                if (e.key.toLowerCase() === 'f2' ||
                    // e.key.toLowerCase() === 'f5' ||
                    e.key.toLowerCase() === 'f7') {
                    e.preventDefault();
                }
                if (isMatch) {
                    await config.command.execute({state: 'Pressed'});
                }
                if (pressedKey === 'arrowup' || pressedKey === 'arrowdown') {
                    e.preventDefault();
                }
            };
            window.addEventListener('keydown', handler);
            this.localHandlers.push(() => window.removeEventListener('keydown', handler));
            console.log(`[Local Shortcut Registered] ${config.key}`);
        }
    }

    async registerAll(configs: ShortcutConfig[]) {
        for (const config of configs) {
            await this.register(config);
        }
    }

    /** 注销所有全局快捷键 */
    async unregisterAllGlobals() {
        await unregisterAll();
        console.log('[All Global Shortcuts Unregistered]');
    }

    /** 注销所有局部快捷键 */
    unregisterAllLocals() {
        this.localHandlers.forEach(unregister => unregister());
        this.localHandlers = [];
        console.log('[All Local Shortcuts Unregistered]');
    }

    /** 注销所有快捷键 */
    async unregisterAll() {
        await this.unregisterAllGlobals();
        this.unregisterAllLocals();
    }
}
