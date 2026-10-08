/**
 * 自动定时备份（每日首启快照到 app_data/backups/，保留最近 7 份）：
 * - 触发：backup 模块 start（主窗口启动）检查 KV auto_backup_last_date，非当天即执行（同日幂等）；
 * - 内容：dbService.exportData()——与手动导出同一数据包（6 张数据表，图片内联自包含）；
 * - 落盘：Rust 命令 write_auto_backup（路径固定 app_data/backups，文件名白名单校验，原子写）；
 *   当天重启动覆盖同名文件（当日快照语义）；
 * - 裁剪：写后按文件名倒序保留 KEEP_COUNT 份，其余删除；
 * - 恢复：设置页「自动备份恢复」入口 → readAutoBackup → importData 替换式导入。
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '~/utils/env';
import dbService from '~/src/db/dbService';

/** 上次自动备份日期（本地时区 YYYY-MM-DD）持久化 key */
const LAST_DATE_KEY = 'auto_backup_last_date';
/** 备份保留份数 */
const KEEP_COUNT = 7;

/** 本地时区日期戳（跨日首次启动触发新备份） */
function todayStamp(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function autoBackupFileName(date: string): string {
    return `s1de-board-auto-${date}.json`;
}

/** 每日首启自动备份：失败仅记录日志（不阻塞启动主流程，次日再试） */
export async function runDailyAutoBackup(): Promise<void> {
    try {
        if (!isTauri()) return;
        const today = todayStamp();
        if ((await dbService.getKeyValue(LAST_DATE_KEY)) === today) return;
        const bundle = await dbService.exportData();
        await invoke('write_auto_backup', { name: autoBackupFileName(today), contents: JSON.stringify(bundle) });
        await dbService.setKeyValue(LAST_DATE_KEY, today);
        await pruneOldBackups();
    } catch (e) {
        console.error('[auto-backup] 每日自动备份失败:', e);
    }
}

/** 按文件名倒序保留 KEEP_COUNT 份，多余删除（单份删除失败容忍） */
export async function pruneOldBackups(): Promise<void> {
    const names = await listAutoBackups();
    for (const name of names.slice(KEEP_COUNT)) {
        await invoke('delete_auto_backup', { name }).catch(() => {});
    }
}

/** 列出自动备份文件名（Rust 侧已按日期倒序） */
export async function listAutoBackups(): Promise<string[]> {
    return invoke<string[]>('list_auto_backups');
}

/** 读取自动备份 JSON 内容（设置页恢复入口） */
export async function readAutoBackup(name: string): Promise<string> {
    return invoke<string>('read_auto_backup', { name });
}
