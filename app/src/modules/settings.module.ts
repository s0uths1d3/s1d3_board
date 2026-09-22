import type { AppModule } from '../core/registry';

/**
 * 设置域模块（配置锚点）：
 * ModuleContext.config（ConfigStore 抽象）的具体实现由装配层（modules/index.ts）
 * 绑定 settings 仓储；本模块自身不持有运行期资源，作为依赖声明根存在——
 * 需要读取设置 KV 的模块（statistics / todo-reminder / shortcuts）依赖它，
 * 表达"配置域先行装配"的边界关系。
 */
export const settingsModule: AppModule = {
    id: 'settings',
};
