<template>
  <div class="flex h-screen flex-col overflow-hidden rounded-2xl">
    <!-- 图片查看器/删除确认等子窗口自带系统标题栏，不再渲染自定义 TitleBar -->
    <TitleBar v-if="route.path !== '/viewer' && route.path !== '/delete-confirm'" />
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
        const windows = await getAllWindows();
        let childFocused = false;
        for (const w of windows) {
          try {
            if (w.label !== 'main' && await w.isFocused()) {
              childFocused = true; // 子窗口聚焦中，不隐藏
            }
          } catch { /* 忽略单窗查询失败 */ }
        }
        if (childFocused) return;

        // 主窗口隐藏前，关闭所有子窗口（删除确认/图片查看器随主窗口一起关闭）
        for (const w of windows) {
          try {
            if (w.label !== 'main' && await w.isVisible()) {
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

  // 全局快捷键依赖 Tauri 全局快捷键插件，仅在桌面容器内注册
  if (isTauri()) {
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