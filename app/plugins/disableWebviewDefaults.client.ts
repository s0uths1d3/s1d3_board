/**
 * 禁用 WebView 的浏览器默认行为（右键菜单、调试类默认快捷键），但保留普通快捷键。
 *
 * 环境区分：
 * - 开发环境（tauri dev / Vite DEV）：完全不拦截，保留 F5 刷新、F12 开发者工具等全部调试能力。
 * - 生产环境（tauri build 打包后）：禁用右键菜单，并仅拦截"调试/浏览器导航类"默认快捷键，
 *   普通快捷键（复制/粘贴/撤销/选择/输入等）一律放行，避免误禁用。
 *
 * 调试类快捷键白名单（prod 下被拦截，dev 下全部放行）：
 *   F5 / Ctrl+R / Ctrl+Shift+R        重新加载
 *   F12 / Ctrl+Shift+I / Ctrl+Shift+J  开发者工具 / 控制台
 *   Ctrl+U                             查看源代码
 */
export default defineNuxtPlugin(() => {
  // 仅客户端执行（.client.ts 已保证），此处再防御一次
  if (typeof document === 'undefined') return;

  const isDev = import.meta.env.DEV;

  // 开发环境：保留全部默认行为，不做任何拦截
  if (isDev) return;

  // 生产环境：禁用右键菜单
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // 生产环境：仅在命中"调试类"快捷键时拦截默认行为；普通快捷键完全放行
  document.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const key = e.key;

      // F5 / F12：刷新与开发者工具（无论是否带 Ctrl 都拦截）
      if (key === 'F5' || key === 'F12') {
        e.preventDefault();
        return;
      }
      // Ctrl/Cmd + R：重新加载
      if (ctrl && (key === 'r' || key === 'R')) {
        e.preventDefault();
        return;
      }
      // Ctrl/Cmd + Shift + R：硬重新加载
      if (ctrl && shift && (key === 'r' || key === 'R')) {
        e.preventDefault();
        return;
      }
      // Ctrl/Cmd + Shift + I / J：开发者工具 / 控制台
      if (ctrl && shift && (key === 'i' || key === 'I' || key === 'j' || key === 'J')) {
        e.preventDefault();
        return;
      }
      // Ctrl/Cmd + U：查看源代码
      if (ctrl && (key === 'u' || key === 'U')) {
        e.preventDefault();
        return;
      }
      // 其余按键（含 Ctrl+C/V/A/Z/X、方向键、字母数字、Backspace 等）一律放行
    },
    // 捕获阶段优先处理，确保先于页面内逻辑决定是否拦截默认行为
    true,
  );
});
