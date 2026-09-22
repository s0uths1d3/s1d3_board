import type { AppModule } from '../core/registry';
import { initShortcuts, unregisterAllShortcuts } from '../commands/shortcuts/InitShortcuts';

/**
 * 全局快捷键模块：start 注册（恢复用户自定义键位与启用状态），stop 注销。
 * 读取 shortcut_binding / shortcut_enabled_* 设置，依赖 settings 域先行装配。
 */
export const shortcutsModule: AppModule = {
    id: 'shortcuts',
    dependencies: ['settings'],
    async start() {
        try {
            await initShortcuts();
        } catch (error) {
            console.error('❌ 快捷键注册失败:', error);
        }
    },
    async stop() {
        await unregisterAllShortcuts();
    },
};
