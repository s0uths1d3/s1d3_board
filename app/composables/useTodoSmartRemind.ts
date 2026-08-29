import { ref } from 'vue';
import dbService from '~/src/db/dbService';

/** 是否启用待办智能提醒（提前 30/10/5 分钟 + 自定义提醒）。单例 ref，设置页与调度服务共享。
 *  关闭时仅保留"到期时刻"通知；默认开启，多数用户无需任何设置。 */
const smartRemindEnabled = ref(true);
let loaded = false;

export function useTodoSmartRemind() {
  if (!loaded) {
    loaded = true;
    dbService.getKeyValue('todo_smart_remind').then((v) => {
      if (v === '0') smartRemindEnabled.value = false;
    }).catch(() => { /* 未设置过则保持默认开启 */ });
  }
  return { smartRemindEnabled };
}

/** 供调度服务同步读取当前开关（不触发懒加载之外的逻辑） */
export function isTodoSmartRemindEnabled(): boolean {
  return smartRemindEnabled.value;
}

/** 切换智能提醒开关并持久化 */
export async function setTodoSmartRemindEnabled(v: boolean): Promise<void> {
  smartRemindEnabled.value = v;
  try {
    await dbService.setKeyValue('todo_smart_remind', v ? '1' : '0');
  } catch { /* 写入失败不影响本次会话 */ }
}
