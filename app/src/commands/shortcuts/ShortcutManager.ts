import { register, unregister, unregisterAll } from '@tauri-apps/plugin-global-shortcut';
import type { ShortcutConfig } from './ShortcutConfig';

export class ShortcutManager {
    private localHandlers: (() => void)[] = [];

    async register(config: ShortcutConfig) {
        // 单独禁用的快捷键不注册/不响应
        if (config.enabled === false) {
            console.log(`[Shortcut Disabled] ${config.id}`);
            return;
        }
        if (config.scope === 'global') {
            // 先注销可能残留的同名全局快捷键（HMR/reload 后 Rust 侧可能仍占用），
            // 避免 "HotKey already registered" 导致该快捷键失效
            try {
                await unregister(config.key);
            } catch (e) {
                // 未注册过则忽略
            }
            await register(config.key, async (event) => {
                await config.command.execute(event);
            });
            console.log(`[Global Shortcut Registered] ${config.key}`);
        } else if (config.scope === 'local') {
            const handler = async (e: KeyboardEvent) => {
                const key = config.key.toLowerCase();
                const pressedKey = e.key.toLowerCase();

                // 长按产生的重复按键：方向键导航允许长按连续移动（e.repeat 也响应）；
                // 命令类快捷键（如 Enter 粘贴、Delete 等）长按仍只触发一次，避免误操作。
                if (e.repeat && !(pressedKey === 'arrowup' || pressedKey === 'arrowdown')) return;

                const ctrl = key.includes('ctrl') || key.includes('command');
                const alt = key.includes('alt');
                const shift = key.includes('shift');

                const modifierMatch =
                    (!ctrl || e.ctrlKey || e.metaKey) &&
                    (!alt || e.altKey) &&
                    (!shift || e.shiftKey);

                const mainKey = key.split('+').pop()?.trim();
                // 数字键（Ctrl+1~0 / Ctrl+Shift+1~0）：用 e.code 匹配（如 'Digit1'），
                // 因为 Shift 组合下 e.key 会变成符号字符（美式键盘 Shift+1 为 '!'），精确比对会失效。
                const isDigitKey = /^[0-9]$/.test(mainKey);
                const mainKeyMatch = isDigitKey
                    ? (e.code ?? '').toLowerCase() === `digit${mainKey}`
                    : pressedKey === mainKey;
                const isMatch = mainKeyMatch && modifierMatch;

                if (isMatch) {
                    // 命中本地快捷键：阻止默认行为（如 Enter 在输入框的换行/提交），避免与命令重复触发
                    e.preventDefault();
                    e.stopPropagation();
                    await config.command.execute({state: 'Pressed'});
                } else if (pressedKey === 'arrowup' || pressedKey === 'arrowdown') {
                    // 方向键即使未命中命令也阻止默认滚动，避免页面随方向键滚动
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
            // 逐个注册并容错：某个快捷键（如全局 Ctrl+I 与系统冲突）注册失败时，
            // 不中断后续注册，确保方向键等本地快捷键始终生效。
            try {
                await this.register(config);
            } catch (e) {
                console.error(`[Shortcut Register Failed] ${config.key}:`, e);
            }
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
