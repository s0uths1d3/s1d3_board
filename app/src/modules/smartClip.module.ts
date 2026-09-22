import type { AppModule } from '../core/registry';
import { initSmartClipListener } from '../smart-clip/smartClip';

/**
 * 智能剪贴板模块（处理层）：init 阶段挂载 smart-clip:copy 事件监听。
 * 必须先于 clipboard 模块 start 启动剪贴板监听器（dependencies 声明固化，
 * 原 app.vue 启动顺序硬约束：不遗漏最早的复制事件）。
 */
export const smartClipModule: AppModule = {
    id: 'smart-clip',
    init() {
        initSmartClipListener();
    },
};
