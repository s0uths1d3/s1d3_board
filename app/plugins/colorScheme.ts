/**
 * 配色全局初始化：每个窗口（主窗口 + tooltip/viewer 等子窗口）启动时
 * 读取持久化配色并应用到 <html data-scheme>，同时注册跨窗口切换广播监听。
 */
export default defineNuxtPlugin(() => {
  useColorScheme();
});
