import { ModuleRegistry, type AppModule } from '../core/registry';
import { createModuleContext, type ConfigStore } from '../core/context';
import { bus } from '../core/events';
import { appConnection } from '../core/db/appConnection';
import { runDatabaseMigrations } from '../core/db/migrator';
import { createSettingsRepository } from '../core/db/repositories/settingsRepository';
import { settingsModule } from './settings.module';
import { smartClipModule } from './smartClip.module';
import { clipboardModule } from './clipboard.module';
import { islandModule } from './island.module';
import { statisticsModule } from './statistics.module';
import { todoReminderModule } from './todoReminder.module';
import { shortcutsModule } from './shortcuts.module';

/**
 * 模块装配组合根：
 * - appContext：ModuleContext 抽象的具体绑定（events 总线 / db 单一连接 / config 设置 KV）；
 * - createAppRegistry：注册全部模块。依赖声明固化启动顺序（原 app.vue onMounted 的硬约束）：
 *   smart-clip（挂监听）→ clipboard（启动剪贴板监听器）→ island（消费 island:copy），
 *   settings 为配置锚点（statistics / todo-reminder / shortcuts 依赖它）。
 * 模块间通信一律走事件总线或依赖声明，不直接 import 彼此实现（边界控制）。
 */

/** ConfigStore 抽象的 settings 仓储实现：getKV 的 '' 空哨兵映射为 null（缺失语义） */
function createSettingsConfigStore(): ConfigStore {
    const settings = createSettingsRepository({ conn: appConnection });
    return {
        async get(key) {
            // 与 dbService.getKeyValue 同语义：先确保迁移完成再读
            await runDatabaseMigrations(appConnection);
            const v = await settings.getKeyValue(key);
            return v === '' ? null : v;
        },
        async set(key, value) {
            await runDatabaseMigrations(appConnection);
            await settings.setKeyValue(key, value ?? '');
        },
    };
}

/** 应用模块上下文（主窗口一份；子窗口不引导模块，见 app.vue isMainWindow 守卫） */
export const appContext = createModuleContext({
    events: bus,
    db: appConnection,
    config: createSettingsConfigStore(),
});

/** 模块清单（注册顺序 = 无依赖时的执行顺序） */
const APP_MODULES: AppModule[] = [
    settingsModule,
    smartClipModule,
    clipboardModule,
    islandModule,
    statisticsModule,
    todoReminderModule,
    shortcutsModule,
];

/** 装配注册表：每次调用返回全新实例（幂等 boot/shutdown 状态隔离，HMR 安全） */
export function createAppRegistry(): ModuleRegistry {
    const registry = new ModuleRegistry();
    for (const m of APP_MODULES) registry.register(m);
    return registry;
}
