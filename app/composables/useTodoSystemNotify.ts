import { createBooleanSetting } from './useBooleanSetting';

/**
 * 待办系统通知开关：控制提醒服务是否弹 OS 级系统通知（sendNotification）。
 * 仅关闭系统通知弹窗——提示音与灵动岛提醒不受影响（灵动岛另有总开关）；
 * 定时排程与已发记录（firedLog）照常运转，避免开关切换期间提醒重复轰炸。默认开启。
 */
const setting = createBooleanSetting('todo_system_notify', true);

/** 设置页绑定：待办系统通知开关（共享同一状态源） */
export function useTodoSystemNotify() {
  const todoSystemNotifyEnabled = setting.useSetting();
  return { todoSystemNotifyEnabled };
}

/** 持久化开关状态（设置页切换时调用） */
export async function setTodoSystemNotifyEnabled(v: boolean): Promise<void> {
  await setting.persist(v);
}

/** 供提醒服务同步读取当前开关（不触发懒加载之外的逻辑） */
export function isTodoSystemNotifyEnabled(): boolean {
  return setting.enabled.value;
}

/** 触发首次加载（幂等）并等待落定：提醒服务 init 在请求系统通知权限前调用，
 *  开关关闭时跳过权限请求，避免无谓的权限弹窗 */
export function ensureTodoSystemNotifyLoaded(): Promise<void> {
  return setting.ensureLoaded();
}
