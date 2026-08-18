import { getOsTypeFromNavigator } from './SystemOS';

/**
 * 快捷键格式化与解析工具
 *
 * - 存储格式：Tauri 全局快捷键格式，如 `CommandOrControl+I`、`Control+Shift+ArrowUp`
 * - 显示格式：全大写友好文案，如 `CTRL+I`、`SHIFT+ALT+↑`
 * - 平台自适应：macOS 的 CommandOrControl 显示 CMD，Windows/Linux 显示 CTRL
 */

/** 修饰键名称映射（显示为大写缩写）；`commandorcontrol` 由 format 按当前系统动态解析 */
const MOD_DISPLAY: Record<string, string> = {
  'command': 'CMD',
  'cmd': 'CMD',
  'control': 'CTRL',
  'ctrl': 'CTRL',
  'shift': 'SHIFT',
  'alt': 'ALT',
  'option': 'OPT',
  'super': 'SUPER',
  'meta': 'CMD',
};

/** 方向键显示为箭头符号 */
const KEY_DISPLAY: Record<string, string> = {
  'arrowup': '↑',
  'arrowdown': '↓',
  'arrowleft': '←',
  'arrowright': '→',
  'enter': 'ENTER',
  'escape': 'ESC',
  'delete': 'DEL',
  'backspace': 'BKSP',
  'space': 'SPACE',
  'tab': 'TAB',
};

/** 判断当前是否 macOS */
export function isMacOS(): boolean {
  return getOsTypeFromNavigator() === 'Darwin';
}

/**
 * 把 Tauri 格式快捷键转成大写友好显示文案（按当前操作系统自适应修饰键名）
 * 例（Windows/Linux）：`CommandOrControl+I` → `CTRL + I`，`Control+Shift+ArrowUp` → `CTRL + SHIFT + ↑`
 * 例（macOS）：`CommandOrControl+I` → `CMD + I`，`Control+Shift+ArrowUp` → `CTRL + SHIFT + ↑`
 * 组合键之间以空格分隔，提升可读性
 */
export function formatShortcutForDisplay(key: string): string {
  if (!key) return '';
  const isMac = isMacOS();
  return key
    .split('+')
    .map(part => {
      const lower = part.toLowerCase();
      // CommandOrControl：跨平台占位符，按当前系统解析为 CMD（macOS）或 CTRL（其他）
      if (lower === 'commandorcontrol') return isMac ? 'CMD' : 'CTRL';
      if (MOD_DISPLAY[lower]) return MOD_DISPLAY[lower]!;
      if (KEY_DISPLAY[lower]) return KEY_DISPLAY[lower]!;
      return part.toUpperCase();
    })
    .join(' + ');
}

/** 按键事件 → 忽略纯修饰键 */
const MODIFIER_KEYS = ['control', 'shift', 'alt', 'meta', 'cmd', 'option', 'super'];

/**
 * 从 KeyboardEvent 解析出 Tauri 格式快捷键字符串（用于录制）
 * - macOS：按 Meta 记为 Command；Windows/Linux：按 Ctrl 记为 Control
 * - 只按了修饰键（无主键）时返回空字符串
 */
export function parseKeyEvent(e: KeyboardEvent): string {
  const mainKey = e.key;

  // 忽略纯修饰键按下（如单独按 Ctrl、Shift）
  if (MODIFIER_KEYS.includes(mainKey.toLowerCase())) {
    return '';
  }

  const mods: string[] = [];
  // macOS 用 Command，其他平台用 Control（CommandOrControl 在录制时按实际按下键记录）
  const isMac = isMacOS();
  if (e.ctrlKey && !e.metaKey) {
    mods.push('Control');
  }
  if (e.metaKey) {
    mods.push(isMac ? 'Command' : 'Super');
  }
  if (e.altKey) {
    mods.push('Alt');
  }
  if (e.shiftKey) {
    mods.push('Shift');
  }

  // 主键规范化：方向键/Escape/Enter/Delete 用标准名，字母保持大写
  let mainPart: string;
  const lower = mainKey.toLowerCase();
  if (lower === 'arrowup' || lower === 'arrowdown' || lower === 'arrowleft' || lower === 'arrowright') {
    mainPart = mainKey.slice(0, 1).toUpperCase() + mainKey.slice(1).toLowerCase(); // ArrowUp
  } else if (lower === 'escape') {
    mainPart = 'Escape';
  } else if (lower === 'enter') {
    mainPart = 'Enter';
  } else if (lower === 'delete') {
    mainPart = 'Delete';
  } else if (lower === ' ' || lower === 'spacebar') {
    mainPart = 'Space';
  } else if (/^[a-z]$/.test(lower)) {
    mainPart = mainKey.toUpperCase();
  } else {
    // F1-F12、数字、符号等原样（数字键在 Shift 时可能是符号，这里取 e.code 的最后部分）
    mainPart = mainKey.length === 1 ? mainKey.toUpperCase() : mainKey;
  }

  return [...mods, mainPart].join('+');
}
