/**
 * 运行环境探测：仅在 Tauri 桌面容器内为 true。
 * 用于收敛依赖 Tauri API（全局快捷键、SQL 剪贴板监听）的逻辑，
 * 避免在纯 Web (nuxt dev) 环境下空转或抛错。
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
