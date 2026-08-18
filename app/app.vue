<template>
  <div class="flex h-screen flex-col overflow-hidden rounded-2xl">
    <TitleBar />
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

onMounted(async () => {
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
})

onBeforeUnmount(async () => {
  await unregisterAllShortcuts();
});
</script>