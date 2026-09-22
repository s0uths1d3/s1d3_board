import { createDatabaseConnection } from './connection';

/**
 * 全应用共享的数据库连接单例：
 * dbService 门面与统计服务（statsService）共用同一连接句柄，
 * 替代原先各自 Database.load 的多持连接（getRawDb 的共享语义由此承接）。
 */
export const appConnection = createDatabaseConnection();
