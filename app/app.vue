<template>
  <div class="flex h-screen flex-col overflow-hidden rounded-2xl">
    <!-- 图片查看器/删除确认/tooltip 等子窗口不渲染主窗口的自定义 TitleBar -->
    <TitleBar v-if="route.path !== '/viewer' && route.path !== '/delete-confirm' && route.path !== '/tooltip'" />
    <main id="app-main" class="flex-1 overflow-y-auto">
      <NuxtPage />
    </main>
  </div>
</template>

<script setup lang="ts">

import TitleBar from "~/components/mainpage/TitleBar.vue";
import {initShortcuts, unregisterAllShortcuts} from "~/src/commands/shortcuts/InitShortcuts";
import clipboardService from "~/src/db/dbService";
import {isTauri} from "~/src/utils/env";
import { getCurrentWindow, getAllWindows } from '@tauri-apps/api/window';
import statsService from "~/src/statistics/statsService";
import { seedMockStats, isStatsEmpty } from "~/src/statistics/mockData";
import { statsUnlocked } from "~/composables/useTabs";

/** 剪贴板监听与全局快捷键只需在主窗口注册一次；
 * 子窗口（如图片查看器）跳过，避免重复监听，以及关闭子窗口时误注销主窗口的全局快捷键。 */
function isMainWindow(): boolean {
  return !isTauri() || getCurrentWindow().label === 'main';
}

/** 失焦自动隐藏的延迟计时器（避免与子窗口焦点切换竞争） */
let hideOnBlurTimer: ReturnType<typeof setTimeout> | null = null;
/** 主窗口是否处于聚焦状态（供 tooltip 停用时判断是否需要补隐藏） */
let mainFocused = true;

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

    // 主窗口隐藏前，关闭所有子窗口：
    // - 图片查看器：close（随主窗口一起关闭）
    // - 删除确认：close（随主窗口一起关闭）
    // - tooltip 悬停窗口：同样 close（而非 hide）。原因：父窗口隐藏时独立 WebView 子窗口
    //   会被系统挂起、事件通道失效；若仅 hide 保留单例，主窗口重新显示后 emit('tooltip:show')
    //   会发往失效窗口、tooltip 无法再出现（需刷新才恢复）。close 后单例自然失效，
    //   下次 hover 走 openTooltipWindow 的 new WebviewWindow 重建鲜活窗口即可正常工作。
    for (const w of windows) {
      try {
        if (w.label === 'main') continue;
        if (w.label.startsWith('tooltip-')) {
          if (await w.isVisible()) await w.close();
        } else if (await w.isVisible()) {
          await w.close();
        }
      } catch { /* 忽略单窗关闭失败 */ }
    }

    await getCurrentWindow().hide();
  } catch (e) {
    console.error('主窗口失焦自动隐藏失败:', e);
  }
}

/** 主窗口失去焦点时自动隐藏，仅驻留后台（通过 Ctrl+I / 托盘唤出） */
async function setupAutoHideOnBlur() {
  if (!isTauri() || !isMainWindow()) return;

  getCurrentWindow().onFocusChanged(async ({ payload: focused }) => {
    mainFocused = focused;
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

onMounted(async () => {
  if (!isMainWindow()) return;

  try {
    await clipboardService.startClipboardListener();
    console.log('✅ 数据库初始化完成，剪贴板监听已启动');
  } catch (error) {
    console.error('❌ 初始化失败:', error);
  }

  // 全局快捷键依赖 Tauri 全局快捷键插件，仅在主窗口注册（子窗口如 tooltip 跳过，避免重复注册冲突）
  if (isTauri() && isMainWindow()) {
    try {
      await initShortcuts();
    } catch (error) {
      console.error('❌ 快捷键注册失败:', error);
    }
  }

  // 失焦自动隐藏（后台驻留模式）
  await setupAutoHideOnBlur();

  // ===== 统计模块（§7.9 / §14.8）=====
  // 使用时长跟踪（30s 结算一次，增量进入 pending 累加器，§4.5）
  statsService.startUsageTracking();
  // 退出前强制落库 pending（防崩溃/强制退出丢失当日未落库数据，§14.1.1）
  window.addEventListener('beforeunload', flushStatsOnExit);
  if (isTauri()) {
    getCurrentWindow().onCloseRequested(() => {
      void statsService.flush();
    });
  }
  // 统计 Tab 显示门槛判定：轻量查询（仅 COUNT/SUM 两列），满足后置位解锁（§7.9 / §14.8）。
  // 未解锁且统计表为空（全新环境）时，生成演示数据以展示统计功能；之后重新判定。
  try {
    let unlocked = await statsService.isStatsUnlocked();
    if (!unlocked) {
      const empty = await isStatsEmpty();
      if (empty) {
        await seedMockStats();
      }
      unlocked = await statsService.isStatsUnlocked();
    }
    if (unlocked) statsUnlocked.value = true;
  } catch (e) {
    console.error('统计解锁判定失败:', e);
  }
})

/** 退出前兜底落库（§14.1.1）：pending 未落库数据不丢失 */
async function flushStatsOnExit() {
  await statsService.flush();
}

onBeforeUnmount(async () => {
  if (!isMainWindow()) return;
  await unregisterAllShortcuts();
  // 停止使用时长跟踪（内部执行最后一次结算 + 落库）
  statsService.stopUsageTracking();
  window.removeEventListener('beforeunload', flushStatsOnExit);
});
</script>