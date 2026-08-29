import { ref } from 'vue';
import { getCurrentWindow, cursorPosition, currentMonitor, availableMonitors, PhysicalPosition } from '@tauri-apps/api/window';
import dbService from '~/src/db/dbService';
import { isTauri } from '~/utils/env';

/** 主窗口弹出位置模式 */
export type PopupPositionMode = 'cursor' | 'last' | 'center';

const POPUP_POSITION_KEY = 'popup_position_mode';
const POPUP_LAST_POS_KEY = 'popup_last_position';

/** 弹出位置模式（单例 ref，设置页与快捷键命令共享）；默认「上次位置」= 系统原生行为 */
const popupPositionMode = ref<PopupPositionMode>('last');
let loaded = false;

export function usePopupPosition() {
  if (!loaded) {
    loaded = true;
    dbService.getKeyValue(POPUP_POSITION_KEY).then((v) => {
      if (v === 'cursor' || v === 'last' || v === 'center') popupPositionMode.value = v;
    }).catch(() => { /* 未设置过则保持默认 */ });
  }
  return { popupPositionMode };
}

/** 切换弹出位置模式并持久化 */
export async function setPopupPositionMode(mode: PopupPositionMode): Promise<void> {
  popupPositionMode.value = mode;
  try {
    await dbService.setKeyValue(POPUP_POSITION_KEY, mode);
  } catch { /* 写入失败不影响本次会话 */ }
}

/** 把当前窗口位置记为「上次打开的位置」（在隐藏或重新定位前调用，含用户拖动过的新位置） */
export async function savePopupLastPosition(): Promise<void> {
  if (!isTauri()) return;
  try {
    const pos = await getCurrentWindow().outerPosition();
    await dbService.setKeyValue(POPUP_LAST_POS_KEY, JSON.stringify({ x: pos.x, y: pos.y }));
  } catch { /* 忽略保存失败 */ }
}

/**
 * 按弹出位置模式定位主窗口（在 show() 之前调用）。
 * - cursor：光标右下方 12px 处弹出，放不下翻到光标左/上方，并收进光标所在显示器；
 * - last：恢复上次保存的位置（从未保存过则保持系统默认）；
 * - center：在光标所在显示器居中。
 * 定位失败时静默保持原位置，不阻塞弹出。
 */
export async function applyPopupPosition(): Promise<void> {
  if (!isTauri()) return;
  try {
    const win = getCurrentWindow();
    const mode = popupPositionMode.value;

    if (mode === 'last') {
      const raw = await dbService.getKeyValue(POPUP_LAST_POS_KEY);
      if (!raw) return;
      const pos = JSON.parse(raw) as { x?: number; y?: number };
      if (typeof pos?.x === 'number' && typeof pos?.y === 'number') {
        await win.setPosition(new PhysicalPosition(pos.x, pos.y));
      }
      return;
    }

    const cursor = await cursorPosition();
    // 光标所在显示器（多屏找不到时退化为当前窗口所在显示器）
    const monitors = await availableMonitors();
    const mon = monitors.find(m =>
      cursor.x >= m.position.x && cursor.x < m.position.x + m.size.width &&
      cursor.y >= m.position.y && cursor.y < m.position.y + m.size.height,
    ) ?? await currentMonitor().catch(() => null);
    if (!mon) return;
    const size = await win.outerSize();

    if (mode === 'center') {
      const x = mon.position.x + Math.round((mon.size.width - size.width) / 2);
      const y = mon.position.y + Math.round((mon.size.height - size.height) / 2);
      await win.setPosition(new PhysicalPosition(Math.max(mon.position.x, x), Math.max(mon.position.y, y)));
      return;
    }

    // cursor 模式：优先光标右下方，越界则翻到光标左/上方，最后收进显示器边界
    const OFFSET = 12;
    let x = cursor.x + OFFSET;
    let y = cursor.y + OFFSET;
    if (x + size.width > mon.position.x + mon.size.width) x = cursor.x - OFFSET - size.width;
    if (y + size.height > mon.position.y + mon.size.height) y = cursor.y - OFFSET - size.height;
    x = Math.max(mon.position.x, Math.min(x, mon.position.x + mon.size.width - size.width));
    y = Math.max(mon.position.y, Math.min(y, mon.position.y + mon.size.height - size.height));
    await win.setPosition(new PhysicalPosition(x, y));
  } catch { /* 定位失败保持原位置 */ }
}
