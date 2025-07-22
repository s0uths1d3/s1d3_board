<template>
  <main>
    <NuxtPage />
  </main>
</template>

<script setup lang="ts">
import { initShortcuts, unregisterAllShortcuts } from '~/src/commands/shortcuts/InitShortcuts';
import { addDate } from "~/src/clip";


onBeforeMount(async () => {
  await initShortcuts()
  await addDate()

  const handler = async (e: KeyboardEvent) => {
  };

  window.addEventListener('keydown', handler);
});

onBeforeUnmount(async () => {
  await unregisterAllShortcuts();
});
</script>