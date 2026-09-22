import type { AppModule } from '../core/registry';
import statsService from '../statistics/statsService';
import { restoreAppUsageSetting } from '~/composables/useAppUsage';

/**
 * 统计模块：使用时长跟踪（30s 结算）与应用使用时长 Tab 开关恢复；
 * stop 收尾停跟踪（内部做最后结算/拉取并落库）。
 * 退出前的 pending 强制落库（beforeunload / onCloseRequested → flush）仍由 app.vue 承担。
 */
export const statisticsModule: AppModule = {
    id: 'statistics',
    dependencies: ['settings'],
    start() {
        // ===== 统计模块（§7.9 / §14.8）=====
        // 使用时长跟踪（30s 结算一次，增量进入 pending 累加器，§4.5）
        statsService.startUsageTracking();
        // ===== 应用使用时长（独立导航 Tab；默认关闭，此处恢复持久化的开关状态）=====
        void restoreAppUsageSetting();
    },
    stop() {
        // 停止使用时长跟踪（内部执行最后一次结算 + 落库）
        statsService.stopUsageTracking();
        // 应用使用时长：最后拉取一次并落库
        statsService.stopAppUsageTracking();
    },
};
