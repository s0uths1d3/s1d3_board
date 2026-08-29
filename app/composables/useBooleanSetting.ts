import { ref } from 'vue';
import dbService from '~/src/db/dbService';

/**
 * 布尔设置项单例工厂：模块级 ref + 首次调用时从 settings 表读回（'1'/'0'）+ 持久化写入。
 * 收敛此前 useTooltipEnabled / useSearchHighlight 等逐行同构的样板（新增布尔设置一行搞定）。
 *
 * @param key settings 表 KV key
 * @param defaultOn 无持久化值时的默认状态
 */
export function createBooleanSetting(key: string, defaultOn: boolean) {
  const enabled = ref(defaultOn);
  let loaded = false;

  function useSetting() {
    if (!loaded) {
      loaded = true;
      dbService.getKeyValue(key).then((v) => {
        if (v === '' ) return; // 未设置过：保持默认
        enabled.value = v === '1';
      }).catch(() => { /* 读取失败保持默认 */ });
    }
    return enabled;
  }

  /** 持久化当前状态（设置页 watch/@change 调用） */
  async function persist(value: boolean): Promise<void> {
    enabled.value = value;
    await dbService.setKeyValue(key, value ? '1' : '0');
  }

  return { useSetting, enabled, persist };
}
