/**
 * 配色全局初始化：每个窗口（主窗口 + tooltip/viewer 等子窗口）启动时
 * 读取持久化配色并应用到 <html data-scheme>，同时注册跨窗口切换广播监听。
 *
 * 自定义主题：先同步恢复 localStorage 运行快照（首帧前生效），
 * 再异步读取 KV 校正主题列表与启用状态。
 */
import { restoreThemeSnapshot } from '~/src/theme/themeApply';
import { useTheme } from '~/composables/useTheme';

export default defineNuxtPlugin(() => {
  restoreThemeSnapshot();
  useColorScheme();
  useTheme();
});
