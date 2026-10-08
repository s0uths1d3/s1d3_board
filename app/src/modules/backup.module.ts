import type { AppModule } from '../core/registry';
import { runDailyAutoBackup } from '../backup/autoBackup';

/**
 * 自动备份模块（数据安全层）：每日首启把业务数据快照到 app_data/backups/
 * （保留最近 7 份），供设置页「自动备份恢复」入口恢复。同日幂等，失败不阻塞启动。
 */
export const backupModule: AppModule = {
    id: 'backup',
    dependencies: ['clipboard'],
    start() {
        void runDailyAutoBackup();
    },
};
