import type { EventBus } from './events';
import type { DatabaseConnection } from './db/connection';

/**
 * KV 配置存取抽象（设置项 settings 表的 key/value TEXT 语义；
 * 阶段 2 由 settingsRepository 提供实现并接线到模块装配）。
 */
export interface ConfigStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string | null): Promise<void>;
}

/** 日志器抽象：模块经 ctx.logger 输出，不直接散落 console 调用（新代码约定；存量 console 不强迁） */
export interface Logger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

export function createConsoleLogger(scope: string): Logger {
    const prefix = `[${scope}]`;
    return {
        info(message, ...args) { console.log(prefix, message, ...args); },
        warn(message, ...args) { console.warn(prefix, message, ...args); },
        error(message, ...args) { console.error(prefix, message, ...args); },
    };
}

/**
 * 模块运行上下文：模块只依赖此抽象（依赖抽象而非具体实现），
 * 不直接 import dbService / 仓储等具体实现——具体能力由模块装配层（modules/index.ts）注入。
 */
export interface ModuleContext {
    /** 同窗口事件总线（跨窗口通信走 Tauri emit，不经此处） */
    readonly events: EventBus;
    /** 数据库连接句柄（全应用单一连接持有者 core/db/connection） */
    readonly db: DatabaseConnection;
    /** 设置 KV 存取 */
    readonly config: ConfigStore;
    /** 日志器 */
    readonly logger: Logger;
}

export function createModuleContext(parts: {
    events: EventBus;
    db: DatabaseConnection;
    config: ConfigStore;
    logger?: Logger;
}): ModuleContext {
    return {
        events: parts.events,
        db: parts.db,
        config: parts.config,
        logger: parts.logger ?? createConsoleLogger('app'),
    };
}
