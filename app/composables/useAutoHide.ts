import { getCurrentWindow, getAllWindows } from '@tauri-apps/api/window';
import { createBooleanSetting } from './useBooleanSetting';
import { savePopupLastPosition } from './usePopupPosition';
import { closeTooltipWindows } from './useTooltipEnabled';
import { bus } from '~/src/core/events';
import { isTauri } from '~/utils/env';

/**
 * 失焦自动隐藏主窗口（集中化）：
 * - 开关状态：createBooleanSetting 持久化（设置页「通用」切换）；
 * - 执行逻辑：onFocusChanged 失焦 150ms 后经豁免链检查再隐藏（原 app.vue 内联实现
 *   原样迁入，行为等价）——开关关闭 / 置顶 / 子窗口创建期 / 环形气泡 / tooltip 交互中 /
 *   任意子窗口聚焦 / 图片查看器可见均豁免；隐藏前关闭可见子窗口、保存便签编辑、
 *   记录窗口位置。app.vue 仅负责 ensureLoaded + 启动监听。
 * 默认开启。
 */
const autoHideSetting = createBooleanSetting('auto_hide_enabled', true);

/** 设置页绑定：失焦自动隐藏开关（共享同一状态源） */
export function useAutoHide() {
  const autoHideEnabled = autoHideSetting.useSetting();
  return { autoHideEnabled };
}

/** 持久化失焦自动隐藏状态（设置页切换时调用） */
export async function setAutoHideEnabled(v: boolean): Promise<void> {
  await autoHideSetting.persist(v);
}

/** 失焦钩子同步读取：关闭时不自动隐藏 */
export function isAutoHideEnabled(): boolean {
  return autoHideSetting.enabled.value;
}

/** 触发首次加载（幂等）并等待落定：主窗口挂载时调用 */
export function ensureAutoHideLoaded(): Promise<void> {
  return autoHideSetting.ensureLoaded();
}

// ===== 失焦自动隐藏执行逻辑 =====

/** 失焦自动隐藏的延迟计时器（避免与子窗口焦点切换竞争） */
let hideOnBlurTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 执行主窗口失焦自动隐藏：检查各类豁免条件后隐藏主窗口并清理子窗口。
 * 提取为函数，供 onFocusChanged（失焦）与 tooltip 停用（active=false）两处共用，
 * 确保 tooltip 关闭后若主窗口仍失焦能补执行隐藏。
 */
export async function tryHideMainWindow() {
  try {
    // 失焦自动隐藏开关（设置 → 通用）关闭时：主窗口保持显示，由用户手动收起。
    // 同步读共享状态（onMounted 已 ensureLoaded，持久化值先于首次失焦落定）
    if (!isAutoHideEnabled()) {
      return;
    }
    // 主窗口置顶（始终在最前）时禁止失焦自动隐藏：置顶语义即"永不退到后台"。
    // 否则置顶主窗口在切到其它窗口/应用后仍被隐藏，违背用户对"置顶"的预期。
    if (await getCurrentWindow().isAlwaysOnTop().catch(() => false)) {
      return;
    }
    // 子窗口正在创建/就绪期间豁免自动隐藏，避免双击打开查看器时主窗口被连带隐藏
    if (typeof window !== 'undefined' && (window as any).__childOpeningUntil
      && Date.now() < (window as any).__childOpeningUntil) {
      return;
    }
    // 环形气泡系统（Ctrl+B）活跃期间豁免自动隐藏：环形窗口 focus:false 不持焦点，
    // hub 创建成为前台即触发主窗口失焦；若在此连带隐藏主窗口并关闭环形窗口，
    // ring 内存状态会残留（下次 Ctrl+B 被误判为 toggle off 而无反应）。
    // 环形生命周期由 Ctrl+B / Esc / 粘贴 / 环心关闭按钮自管理，见 BubbleToggleCommand。
    if (typeof window !== 'undefined' && (window as any).__ringActive) {
      return;
    }
    // tooltip 显示中：区分「焦点在 tooltip 子窗口（点击/拖动滚动条等交互中）」与
    // 「焦点已切到外部应用」。交互中保持豁免（不打断用户操作）；
    // 焦点在外部时 tooltip 已失去悬停上下文，继续豁免会残留在屏幕最前
    // （tooltip 每次 show 都 setAlwaysOnTop）——关闭它（close 使单例失效，hover 重建）
    // 后继续走正常隐藏判定。
    if (typeof window !== 'undefined' && (window as any).__tooltipActive) {
      let tooltipFocused = false;
      for (const w of await getAllWindows()) {
        try {
          if (w.label.startsWith('tooltip-') && await w.isFocused()) {
            tooltipFocused = true;
            break;
          }
        } catch { /* 忽略单窗查询失败 */ }
      }
      if (tooltipFocused) return; // 用户正在 tooltip 内交互：保持显示与主窗口
      await closeTooltipWindows().catch(() => {});
    }
    const windows = await getAllWindows();
    let childFocused = false;
    for (const w of windows) {
      try {
        // 任意非主窗口（查看器/删除确认）聚焦中，不隐藏
        if (w.label !== 'main' && !w.label.startsWith('tooltip-') && await w.isFocused()) {
          childFocused = true;
        }
      } catch { /* 忽略单窗查询失败 */ }
    }
    if (childFocused) return;

    // 图片查看器（image-viewer）打开期间，即使主窗口短暂失焦也禁止隐藏主窗口、且不关闭查看器：
    // 双击打开查看器时其 focus:false，Windows 下查看器可能成为 foreground 但 focused 仍为
    // false，导致上面的 isFocused() 漏判、childFocused 失效，进而把主窗口与查看器一并隐藏。
    // 仅以“存在可见的 image-viewer 窗口”跳过主窗口隐藏，并让下方关闭循环跳过 image-viewer，
    // 但【不干扰 tooltip 窗口】：tooltip 的显示/隐藏由自身机制（__tooltipActive）独立控制，
    // 确保 image-viewer 存在时 hover 主窗口列表项仍可正常弹出 tooltip。
    let viewerVisible = false;
    for (const w of windows) {
      if (w.label.startsWith('image-viewer-') && (await w.isVisible().catch(() => false))) {
        viewerVisible = true;
        break;
      }
    }
    if (viewerVisible) return; // 仅跳过主窗口隐藏，不影响其它子窗口与 tooltip 逻辑

    // 主窗口隐藏前，关闭所有可见子窗口（查看器/tooltip 等）：
    // tooltip 悬停窗口 close 而非 hide——父窗口隐藏时独立 WebView 子窗口
    // 会被系统挂起、事件通道失效；若仅 hide 保留单例，主窗口重新显示后 emit('tooltip:show')
    // 会发往失效窗口、tooltip 无法再出现（需刷新才恢复）。close 后单例自然失效，
    // 下次 hover 走 openTooltipWindow 的 new WebviewWindow 重建鲜活窗口即可正常工作。
    for (const w of windows) {
      try {
        if (w.label === 'main') continue;
        // 灵动岛历史为用户主动打开的独立常驻窗口：主窗口失焦隐藏时不连带关闭，
        // 仅随自身标题栏关闭按钮 / 主窗口显式 x（onCloseRequested）退出
        if (w.label === 'island-history') continue;
        // 灵动岛提示窗口独立于主窗口生命周期：岛显示期间主窗口失焦（点击其他应用）
        // 不连带关闭岛——close 是永久销毁，岛的显隐完全由自身 island:show/超时机制控制
        if (w.label === 'clipboard-bubble-island') continue;
        if (await w.isVisible()) await w.close();
      } catch { /* 忽略单窗关闭失败 */ }
    }

    // 隐藏前保存便签编辑中的内容：OS 级窗口失焦不触发元素 blur，隐藏后 webview 可能被
    // 系统挂起/关闭，未落库的编辑内容有丢失风险（'save-note' 仅编辑态卡片响应，无编辑零开销）
    bus.emit('save-note');

    // 隐藏前记录主窗口位置，供「上次位置」弹出模式恢复（拖动后的新位置也能被记住）
    await savePopupLastPosition().catch(() => {});
    await getCurrentWindow().hide();
  } catch (e) {
    console.error('主窗口失焦自动隐藏失败:', e);
  }
}

/** 主窗口失去焦点时自动隐藏，仅驻留后台（通过 Ctrl+I / 托盘唤出） */
export async function setupAutoHideOnBlur() {
  if (!isTauri() || getCurrentWindow().label !== 'main') return;

  getCurrentWindow().onFocusChanged(async ({ payload: focused }) => {
    if (typeof window !== 'undefined') (window as any).__mainFocused = focused;
    if (focused) {
      // 获得焦点：取消挂起的隐藏
      if (hideOnBlurTimer) {
        clearTimeout(hideOnBlurTimer);
        hideOnBlurTimer = null;
      }
      return;
    }
    // 失焦：延迟确认没有子窗口（查看器/删除确认）持有焦点、tooltip 未在使用后再隐藏
    if (hideOnBlurTimer) clearTimeout(hideOnBlurTimer);
    hideOnBlurTimer = setTimeout(() => {
      hideOnBlurTimer = null;
      tryHideMainWindow();
    }, 150);
  });

  // 暴露给 index.vue：tooltip 停用（active=false）且主窗口当前失焦时，补执行隐藏
  if (typeof window !== 'undefined') {
    (window as any).__tryHideMainWindow = tryHideMainWindow;
  }
}
