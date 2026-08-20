<template>
  <div class="flex h-screen flex-col overflow-hidden rounded-2xl">
    <!-- 图片查看器/删除确认/tooltip 等子窗口不渲染主窗口的自定义 TitleBar -->
    <TitleBar v-if="route.path !== '/viewer' && route.path !== '/delete-confirm' && route.path !== '/tooltip'" />
    <main class="flex-1 overflow-y-auto">
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

/** 剪贴板监听与全局快捷键只需在主窗口注册一次；
 * 子窗口（如图片查看器）跳过，避免重复监听，以及关闭子窗口时误注销主窗口的全局快捷键。 */
function isMainWindow(): boolean {
  return !isTauri() || getCurrentWindow().label === 'main';
}

/** 失焦自动隐藏的延迟计时器（避免与子窗口焦点切换竞争） */
let hideOnBlurTimer: ReturnType<typeof setTimeout> | null = null;

/** 主窗口失去焦点时自动隐藏，仅驻留后台（通过 Ctrl+I / 托盘唤出） */
async function setupAutoHideOnBlur() {
  if (!isTauri() || !isMainWindow()) return;

  getCurrentWindow().onFocusChanged(async ({ payload: focused }) => {
    if (focused) {
      // 获得焦点：取消挂起的隐藏
      if (hideOnBlurTimer) {
        clearTimeout(hideOnBlurTimer);
        hideOnBlurTimer = null;
      }
      return;
    }
    // 失焦：延迟确认没有子窗口（查看器/删除确认）持有焦点后再隐藏
    if (hideOnBlurTimer) clearTimeout(hideOnBlurTimer);
    hideOnBlurTimer = setTimeout(async () => {
      hideOnBlurTimer = null;
      try {
        // 子窗口正在创建/就绪期间豁免自动隐藏，避免双击打开查看器时主窗口被连带隐藏
        if (typeof window !== 'undefined' && (window as any).__childOpeningUntil
          && Date.now() < (window as any).__childOpeningUntil) {
          return;
        }
        const windows = await getAllWindows();
        let childFocused = false;
        for (const w of windows) {
          try {
            // tooltip 窗口聚焦时（用户正在其上操作/hover）应阻止主窗口隐藏；
            // 仅被动显示（未聚焦）时，切走应用不会阻止主窗口自动隐藏。
            if (w.label !== 'main' && await w.isFocused()) {
              childFocused = true; // 任意子窗口（查看器/删除确认/tooltip）聚焦中，不隐藏
            }
          } catch { /* 忽略单窗查询失败 */ }
        }
        if (childFocused) return;

        // 主窗口隐藏前，关闭/隐藏所有子窗口：
        // - 删除确认/图片查看器：close（随主窗口一起关闭）
        // - tooltip 悬停窗口：hide（保留单例标签，下次 hover 复用，避免主窗口消失后 tooltip 残留）
        for (const w of windows) {
          try {
            if (w.label === 'main') continue;
            if (w.label.startsWith('tooltip-')) {
              if (await w.isVisible()) await w.hide();
            } else if (await w.isVisible()) {
              await w.close();
            }
          } catch { /* 忽略单窗关闭失败 */ }
        }

        await getCurrentWindow().hide();
      } catch (e) {
        console.error('主窗口失焦自动隐藏失败:', e);
      }
    }, 150);
  });
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
})

onBeforeUnmount(async () => {
  if (!isMainWindow()) return;
  await unregisterAllShortcuts();
});
</script>