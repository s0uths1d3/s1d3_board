<template>
  <div class="flex h-screen flex-col overflow-hidden rounded-2xl">
    <!-- 图片查看器/tooltip/智能剪贴板气泡/灵动岛历史等子窗口不渲染主窗口的自定义 TitleBar
         （历史窗口为原生边框，自带标题栏与关闭按钮，不重复渲染导航与窗口控制） -->
    <TitleBar v-if="route.path !== '/viewer' && route.path !== '/tooltip' && route.path !== '/bubble' && route.path !== '/island-history'" />
    <!-- 相对定位包裹层：自绘滚动条滑块（ScrollIndicator）按此定位，只覆盖滚动区、不含标题栏。
         #app-main 由原 flex 项降为层内 h-full，盒子尺寸与原先一致。 -->
    <div class="relative min-h-0 flex-1">
      <main id="app-main" class="h-full overflow-y-auto" :class="{ 'is-main-window': isMainWindow() }">
        <NuxtPage />
      </main>
      <!-- 自绘滚动条只服务主窗口：只有它会在长短不一的 Tab 内容间切换 -->
      <ScrollIndicator v-if="isMainWindow()" />
    </div>
  </div>
</template>

<script setup lang="ts">

import TitleBar from "~/components/mainpage/TitleBar.vue";
import ScrollIndicator from "~/components/mainpage/ScrollIndicator.vue";
import {isTauri} from "~/utils/env";
import { getCurrentWindow, getAllWindows } from '@tauri-apps/api/window';
import statsService from "~/src/statistics/statsService";
import { savePopupLastPosition } from "~/composables/usePopupPosition";
import { createAppRegistry, appContext } from "~/src/modules";

// Tauri 2.11 注入脚本缺陷补丁：unregisterListener 读本地表不判空
// （listeners[eventId].handlerId）——listen 返回后立即解绑（注册脚本经 webview eval
// 宏任务队列尚未执行）会抛 unhandled rejection，且中断 _unlisten 后续的 Rust 侧
// unlisten invoke 造成监听泄漏。覆写为容错版：崩溃时延迟到注册入表后重试本地清理，
// _unlisten 的 invoke 正常继续；注册先行时行为与原版完全一致。
// 存在性守卫：注入脚本未就绪时跳过（补丁失效但不影响应用启动）。
if (isTauri()) {
  const internals = (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ as {
    unregisterListener: (event: string, eventId: number) => void;
  } | undefined;
  if (internals && typeof internals.unregisterListener === 'function') {
    const origUnregisterListener = internals.unregisterListener.bind(internals);
    internals.unregisterListener = (event: string, eventId: number) => {
      try {
        origUnregisterListener(event, eventId);
      } catch {
        // 本地表尚无此 eventId（注册 eval 未执行）：延迟一帧重试本地清理
        setTimeout(() => {
          try { origUnregisterListener(event, eventId); } catch { /* 条目已被清理 */ }
        }, 0);
      }
    };
  }
}

/** 剪贴板监听与全局快捷键只需在主窗口注册一次；
 * 子窗口（如图片查看器）跳过，避免重复监听，以及关闭子窗口时误注销主窗口的全局快捷键。 */
function isMainWindow(): boolean {
  return !isTauri() || getCurrentWindow().label === 'main';
}

/** 失焦自动隐藏的延迟计时器（避免与子窗口焦点切换竞争） */
let hideOnBlurTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 执行主窗口失焦自动隐藏：检查各类豁免条件后隐藏主窗口并清理子窗口。
 * 提取为函数，供 onFocusChanged（失焦）与 tooltip 停用（active=false）两处共用，
 * 确保 tooltip 关闭后若主窗口仍失焦能补执行隐藏。
 */
async function tryHideMainWindow() {
  try {
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
    // tooltip 正在使用（显示中）期间，跳过失焦自动隐藏；
    // 用 tooltip:active 生命周期信号（而非短命 interacting 标志），覆盖点击/拖动等全部交互场景
    if (typeof window !== 'undefined' && (window as any).__tooltipActive) {
      return;
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

    // 隐藏前记录主窗口位置，供「上次位置」弹出模式恢复（拖动后的新位置也能被记住）
    await savePopupLastPosition().catch(() => {});
    await getCurrentWindow().hide();
  } catch (e) {
    console.error('主窗口失焦自动隐藏失败:', e);
  }
}

/** 主窗口失去焦点时自动隐藏，仅驻留后台（通过 Ctrl+I / 托盘唤出） */
async function setupAutoHideOnBlur() {
  if (!isTauri() || !isMainWindow()) return;

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

const route = useRoute();

/** 应用模块注册表（组合根装配；boot 按依赖拓扑序 init→start，shutdown 反序 stop→dispose） */
const registry = createAppRegistry();

onMounted(async () => {
  if (!isMainWindow()) return;

  // 模块引导（依赖声明固化原启动顺序硬约束）：
  // smart-clip 挂处理层监听 → clipboard 启动剪贴板监听器（不遗漏最早复制事件）→
  // island（消费 island:copy）→ statistics → todo-reminder → shortcuts。
  // 模块依赖 Tauri 插件，纯 Web 环境跳过引导。
  if (isTauri()) {
    await registry.boot(appContext);
  }

  // 失焦自动隐藏（后台驻留模式）——窗口生命周期行为，保留在 app.vue
  await setupAutoHideOnBlur();

  // 退出前强制落库 pending（防崩溃/强制退出丢失当日未落库数据，§14.1.1）
  window.addEventListener('beforeunload', flushStatsOnExit);
  if (isTauri()) {
    getCurrentWindow().onCloseRequested(async (event) => {
      // 标题栏 x = 隐藏到托盘（不退出程序；退出请用托盘右键菜单的「退出」）。
      // 不复用 tryHideMainWindow：它带 viewer/置顶/tooltip 等豁免分支，
      // 显式点击 x 应无条件隐藏（含关闭查看器等子窗口）。
      // 统计先落库再隐藏（fire-and-forget 的 flush 会被窗口销毁中断，丢失当日数据）。
      // 注意此处不可 registry.shutdown()：窗口仅隐藏到托盘，模块须保持运行。
      event.preventDefault();
      try {
        await statsService.flush();
      } finally {
        try {
          const windows = await getAllWindows();
          for (const w of windows) {
            try {
              if (w.label === 'main') continue;
              // 灵动岛独立运行：主窗口隐藏到托盘后岛仍正常提供复制/粘贴反馈
              if (w.label === 'clipboard-bubble-island' || w.label === 'island-history') continue;
              if (await w.isVisible()) await w.close();
            } catch { /* 忽略单窗关闭失败 */ }
          }
          await savePopupLastPosition().catch(() => {});
        } finally {
          await getCurrentWindow().hide();
        }
      }
    });
  }
})

/** 退出前兜底落库（§14.1.1）：pending 未落库数据不丢失 */
async function flushStatsOnExit() {
  await statsService.flush();
}

onBeforeUnmount(async () => {
  if (!isMainWindow()) return;
  // 模块收尾：反拓扑序 stop（shortcuts 注销 → statistics 停跟踪落库 → clipboard 反挂监听）
  await registry.shutdown();
  window.removeEventListener('beforeunload', flushStatsOnExit);
});
</script>