import { ref } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '~/utils/env';
import dbService from '~/src/db/dbService';
import statsService from '~/src/statistics/statsService';

/**
 * 应用使用时长记录开关（设置页 / 应用时长页共用）
 *
 * - Rust 侧默认关闭（enabled=false 不累计前台时长），前端持久化到 settings KV
 * - 开启：invoke Rust gate + 启动 30s 拉取（statsService.startAppUsageTracking）
 * - 关闭：invoke Rust gate（清空内存增量）+ 停止拉取并强制落库
 */

const KV_KEY = 'app_usage_enabled';

/** 记录开关（响应式，页面直接渲染） */
export const appUsageEnabled = ref(false);

/** 已从 settings 表恢复过（防止启动恢复与页面初始化竞争重复执行） */
let restored = false;

/** 启动恢复：读取持久化开关 → 恢复 Rust 侧状态与拉取定时器（app.vue 启动调用一次） */
export async function restoreAppUsageSetting(): Promise<void> {
  if (restored || !isTauri()) return;
  restored = true;
  try {
    const raw = await dbService.getKeyValue(KV_KEY);
    if (raw === '1') {
      await setAppUsageEnabled(true);
    }
  } catch { /* 读取失败按默认关闭处理 */ }
}

/** 切换记录开关：同步 Rust 侧 + 拉取定时器 + 持久化；失败时回滚 UI 状态 */
export async function setAppUsageEnabled(enabled: boolean): Promise<void> {
  const prev = appUsageEnabled.value;
  appUsageEnabled.value = enabled;
  if (!isTauri()) return;
  try {
    await invoke('set_app_usage_enabled', { enabled });
    if (enabled) {
      statsService.startAppUsageTracking();
    } else {
      statsService.stopAppUsageTracking();
    }
    void dbService.setKeyValue(KV_KEY, enabled ? '1' : '0').catch(() => { /* 持久化失败不影响本次会话 */ });
  } catch (e) {
    // Rust 侧切换失败：回滚 UI 状态
    appUsageEnabled.value = prev;
    console.error('[app_usage] 切换开关失败:', e);
    throw e;
  }
}
