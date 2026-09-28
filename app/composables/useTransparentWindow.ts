/**
 * 透明自绘圆角窗口共用（图片查看器 / tooltip / 灵动岛 / 钉住卡片 / 托盘菜单等）：
 * 全局 body 渐变背景与光晕伪元素（main.css「全局背景」段）会铺满整个矩形窗口，
 * 页面自绘圆角之外露出实底「白角」。此处在页面挂载时注入一次性样式：body 置
 * 透明并隐藏光晕伪元素，悬浮观感由各页面根容器自绘圆角承载。
 * 同一 webview 仅注入一次（幂等）；页面卸载无需移除——透明窗口页面的
 * body 本就不该有全局背景，样式常驻不影响该窗口内的其它路由内容。
 */
let injected = false;

export function useTransparentWindow(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'transparent-window-body';
  style.textContent = [
    'body { background: transparent !important; }',
    'body::before, body::after { display: none !important; }',
  ].join('\n');
  document.head.appendChild(style);
}
