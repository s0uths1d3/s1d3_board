import { ref } from 'vue';
import dbService from '~/src/db/dbService';

/**
 * 来源应用忽略名单（settings KV：ignored_apps = JSON 字符串数组）：
 * 名单内的应用（前台进程名，小写、去 .exe）复制的内容不落库、不弹岛——
 * 与"隐私模式"的全局暂停不同，这里按应用粒度选择性忽略（如密码管理器）。
 * 设置页"隐私与安全"子组维护名单；监听管道同步读取（isIgnoredApp）。
 * 默认空名单（不忽略任何应用）。
 */

/** 忽略名单（小写进程名集合），DB 就绪前的内存态为空 */
const ignoredApps = ref<string[]>([]);
let loaded = false;
let loadPromise: Promise<void> | null = null;

/** 触发首次加载（幂等）并等待落定：监听启动 / 设置页面板打开前调用 */
export function ensureIgnoredAppsLoaded(): Promise<void> {
  if (!loaded) {
    loaded = true;
    loadPromise = dbService.getKeyValue('ignored_apps').then((raw) => {
      if (!raw) return; // 未设置过：保持空名单
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        ignoredApps.value = parsed.map((a) => String(a).toLowerCase());
      }
    }).catch(() => { /* 读取失败保持空名单（解析失败等同未配置） */ });
  }
  return loadPromise ?? Promise.resolve();
}

/** 监听管道同步读取：复制来源应用命中名单时不记录 */
export function isIgnoredApp(app: string | null | undefined): boolean {
  if (!app) return false;
  return ignoredApps.value.includes(app.toLowerCase());
}

/** 持久化当前名单（内部工具：add/remove 共用） */
async function persist(): Promise<void> {
  await dbService.setKeyValue('ignored_apps', JSON.stringify(ignoredApps.value));
}

/** 添加忽略应用（设置页点选/手动输入；已存在则跳过；统一小写存储） */
export async function addIgnoredApp(app: string): Promise<void> {
  const name = app.trim().toLowerCase();
  if (!name || ignoredApps.value.includes(name)) return;
  ignoredApps.value = [...ignoredApps.value, name];
  await persist();
}

/** 移除忽略应用（设置页删除条目；不存在则跳过） */
export async function removeIgnoredApp(app: string): Promise<void> {
  const name = app.trim().toLowerCase();
  if (!ignoredApps.value.includes(name)) return;
  ignoredApps.value = ignoredApps.value.filter((a) => a !== name);
  await persist();
}

/** 设置页绑定：忽略名单（共享同一状态源） */
export function useIgnoredApps() {
  return { ignoredApps };
}
