import type { AppModule } from '../core/registry';
import { startClipboardListener, stopClipboardListener } from '../clipboard/clipboardListener';
import clipboardService from '~/src/db/dbService';

/**
 * 剪贴板模块（采集层）：start 启动文本/图片监听管道（落库 → island:copy /
 * smart-clip:copy / clipboard:changed 派发 → 按上限裁剪），stop 反挂监听。
 * 依赖 smart-clip：处理层监听先挂载，最早的复制事件不丢。
 */
export const clipboardModule: AppModule = {
    id: 'clipboard',
    dependencies: ['smart-clip'],
    async start() {
        try {
            await startClipboardListener();
            console.log('✅ 数据库初始化完成，剪贴板监听已启动');
        } catch (error) {
            console.error('❌ 初始化失败:', error);
        }
        // 启动时按「图片缓存上限」做一次磁盘清理（孤儿文件 + 不常用原图优先淘汰；
        // 方法内部自带 try/catch 与 DB 等待，fire-and-forget 不阻塞启动）
        void clipboardService.cleanupImageStorage();
    },
    async stop() {
        await stopClipboardListener();
    },
};
