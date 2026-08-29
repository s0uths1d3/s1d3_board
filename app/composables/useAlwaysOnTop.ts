import { ref } from 'vue';
import { getCurrentWindow, getAllWindows } from '@tauri-apps/api/window';
import { isTauri } from '~/utils/env';

/** 主窗口置顶状态（模块级单例，TitleBar 按钮与快捷键命令共享，图标自动同步） */
const alwaysOnTop = ref(false);
let initialized = false;

/** 切换主窗口置顶状态，并同步所有已存在的子窗口（tooltip / image-viewer）跟随 */
async function toggleAlwaysOnTop() {
  if (!isTauri()) return;
  try {
    const win = getCurrentWindow();
    const next = !alwaysOnTop.value;
    await win.setAlwaysOnTop(next);
    alwaysOnTop.value = next;
    // 同步所有已存在的子窗口跟随主窗口置顶，避免主窗口置顶时子窗口被遮挡
    const wins = await getAllWindows();
    for (const w of wins) {
      if (w.label === 'main') continue;
      try { await w.setAlwaysOnTop(next); } catch { /* 忽略单窗失败 */ }
    }
  } catch {
    // 忽略置顶切换失败（如窗口 API 不可用）
  }
}

/** 获取共享的置顶状态与切换函数，并幂等地初始化一次实际置顶状态 */
export function useAlwaysOnTop() {
  if (!initialized && isTauri()) {
    initialized = true;
    getCurrentWindow().isAlwaysOnTop().then((v) => { alwaysOnTop.value = v; }).catch(() => {});
  }
  return { alwaysOnTop, toggleAlwaysOnTop };
}
