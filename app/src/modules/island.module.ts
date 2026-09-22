import type { AppModule } from '../core/registry';
import { initCopyIsland } from '~/composables/useCopyIsland';
import { restoreIslandApiSetting, setupIslandHistoryBridge } from '../island/islandApi';
import { restoreIslandWebhookSetting } from '../island/islandWebhook';

/**
 * 灵动岛模块（反馈层）：岛 UI、第三方 API（HTTP/SSE）、历史查询桥与 Webhook 出站。
 * 依赖 clipboard：消费剪贴板监听管道派发的 island:copy 事件。
 */
export const islandModule: AppModule = {
    id: 'island',
    dependencies: ['clipboard'],
    start() {
        // 灵动岛提示：复制/粘贴顶部胶囊反馈（设置可开关；依赖剪贴板监听的 island:copy 事件）
        initCopyIsland();
        // 灵动岛 API（第三方应用集成；按持久化开关恢复）
        void restoreIslandApiSetting();
        // 灵动岛历史查询桥：GET /api/history 的 HTTP 线程挂起请求由主窗口查库回传（常驻，与 API 开关无关）
        void setupIslandHistoryBridge();
        // 灵动岛 Webhook 出站推送（事件转发外部 URL；按持久化配置恢复）
        void restoreIslandWebhookSetting();
    },
};
