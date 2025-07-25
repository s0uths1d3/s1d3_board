<template>
  <main>
    <NuxtPage />
  </main>
</template>

<script setup lang="ts">

import {unregisterAllShortcuts} from "~/src/commands/shortcuts/InitShortcuts";
import clipboardService from "~/src/db/dbSeivice";

onMounted(async () => {
  try {
    await clipboardService.startClipboardListener();
    console.log('✅ 数据库初始化完成，剪贴板监听已启动');
  } catch (error) {
    console.error('❌ 初始化失败:', error);
  }
})

onBeforeUnmount(async () => {
  await unregisterAllShortcuts();
});
</script>