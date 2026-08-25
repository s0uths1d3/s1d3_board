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

                // 长按产生的重复按键：方向键导航与 Ctrl+←/→ 切换标签允许长按连续响应（e.repeat 也响应）；
                // 命令类快捷键（如 Enter 粘贴、Delete 等）长按仍只触发一次，避免误操作。
                const repeatableKeys = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
                if (e.repeat && !repeatableKeys.includes(pressedKey)) return;

                const ctrl = key.includes('ctrl') || key.includes('command');
                const alt = key.includes('alt');
                const shift = key.includes('shift');

                // 切标签快捷键若被污染为无修饰方向键（如 ArrowLeft），
                // 强制按 Ctrl+←/→ 匹配：保证 Ctrl+←/→ 始终有效，单按方向键不会误切标签。
                // 用户自定义的带修饰键配置（如 Alt+←/→）不受影响。
                const isSwitchTab = config.id === 'switch_prev_tab' || config.id === 'switch_next_tab';
                const effectiveCtrl = isSwitchTab && !ctrl && !alt && !shift ? true : ctrl;

                // 精确匹配修饰键：配置了某修饰键必须按下，未配置则不许按下。
                // 避免如 Ctrl+Enter 同时命中「Enter 粘贴」（无修饰键）导致双重触发。
                const modifierMatch =
                    (effectiveCtrl === (e.ctrlKey || e.metaKey)) &&
                    (alt === e.altKey) &&
                    (shift === e.shiftKey);

                const mainKey = key.split('+').pop()?.trim() ?? '';
                // 数字键（Ctrl+1~0 / Ctrl+Shift+1~0）：用 e.code 匹配（如 'Digit1'），
                // 因为 Shift 组合下 e.key 会变成符号字符（美式键盘 Shift+1 为 '!'），精确比对会失效。
                // mainKey 已兜底为空字符串，避免 undefined 传入正则/模板字符串。
                const isDigitKey = /^[0-9]$/.test(mainKey);
                const mainKeyMatch = isDigitKey
                    ? (e.code ?? '').toLowerCase() === `digit${mainKey}`
                    : pressedKey === mainKey;
                const isMatch = mainKeyMatch && modifierMatch;

                if (isMatch) {
                    // 命中本地快捷键：阻止默认行为（如 Enter 在输入框的换行/提交），避免与命令重复触发。
                    // stopImmediatePropagation 阻断同 window 上其余局部快捷键监听器，
                    // 保证最先注册的 Ctrl+←/→ 切换标签拥有最高优先级，且不产生双重触发。
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
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
        // Ctrl+←/→ 切换标签页优先注册：先注册的监听器先执行，
        // 配合命中后的 stopImmediatePropagation 实现最高优先级。
        const priorityIds = new Set(['switch_prev_tab', 'switch_next_tab']);
        const priority = configs.filter(c => priorityIds.has(c.id));
        const rest = configs.filter(c => !priorityIds.has(c.id));
        for (const config of [...priority, ...rest]) {
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
