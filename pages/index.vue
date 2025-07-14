<script setup lang="ts">
import type { ClipboardData } from '~/src/ClipboardData';
import { formatTimestamp } from "~/src/utils/formatDate";
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setIsWindowVisible } from "~/src/commands/global/ToggleWindowCommand";
import {
  selectedRowIndex,
  dataLength,
  ArrowUpTargetMovementCommand,
  ArrowDownTargetMovementCommand,
  selectRow
} from '~/src/commands/local/TargetMovementCommand';
import {
  fetchClipboardData,
  updateFavorite,
  increaseUseCount
} from '~/src/db/dbSeivice';

const data = ref<ClipboardData[]>([]);
const listElement = ref<HTMLElement | null>(null);

let updateInterval: NodeJS.Timeout;

onMounted(async () => {
  await fetchData();
  updateInterval = setInterval(fetchData, 50);
  if (listElement.value) {
    listElement.value.focus();
  }
});

onBeforeUnmount(() => {
  clearInterval(updateInterval);
});

async function fetchData() {
  try {
    const result = await fetchClipboardData();
    data.value = result;
    dataLength.value = data.value.length;
    if (selectedRowIndex.value >= data.value.length) {
      selectedRowIndex.value = data.value.length - 1;
    }
  } catch (err) {
    console.error(err);
  }
}

async function favorite(value: number) {
  value = value === 0 ? 1 : 0;
  await updateFavorite(data.value[selectedRowIndex.value].id, value);
}

async function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'ArrowUp') {
    await new ArrowUpTargetMovementCommand().execute();
  } else if (event.key === 'ArrowDown') {
    await new ArrowDownTargetMovementCommand().execute();
  } else if (event.key === 'Enter') {
    await increaseUseCount(data.value[selectedRowIndex.value].id);
    getCurrentWindow().hide();
    setIsWindowVisible(false);
  }
}
</script>

<template>
  <ul ref="listElement" id="listElement" class="list bg-base-100 rounded-box shadow-md" style="outline: none" tabindex="0" @keydown="handleKeyDown">
    <li class="p-4 pb-2 text-xs opacity-60 tracking-wide">Most history</li>
    <li
        class="list-row cursor-pointer"
        v-for="(item, index) in data"
        :key="index"
        :class="{ 'bg-blue-200': index === selectedRowIndex }"
        @click="selectRow(index)"
    >
      <div class="text-4xl font-thin opacity-30 tabular-nums">{{ index + 1 + '\t' }}</div>
      <div class="list-col-grow" style="height: 4em">
        <div
            style="display: -webkit-box; -webkit-box-orient: vertical; line-clamp: 2; overflow: hidden; text-overflow: ellipsis; padding: 3px; word-wrap: break-word; white-space: pre-wrap;">
          <span class="tabular-nums">{{ item.content.replace(/<\(b<>r\)>/g, '\n') }}</span>
        </div>
        <div class="text-xs uppercase font-semibold opacity-60">Text
          {{ formatTimestamp(item.create_time) }}
          count:{{ item.count }}
          lastUse:{{ formatTimestamp(item.last_use) }}
        </div>
      </div>
      <button class="btn btn-square btn-ghost" @click="favorite(item.is_favorite)">
        <svg v-if="item.is_favorite===0" class="size-[1.2em]" viewBox="0 0 1059 1024" version="1.1"
             xmlns="http://www.w3.org/2000/svg">
          <path
              d="M253.488042 1024c-16.9 0-33.2875-5.1125-47.6125-15.3625-26.625-18.425-39.425-49.6625-34.3125-81.925l40.9625-251.9c1.5375-10.2375-1.5375-20.475-8.7-27.65L28.213042 466.4375c-22.0125-22.525-29.1875-55.3-19.45-84.9875 9.725-29.7 35.325-51.2 66.05-55.8125l237.575-36.35c10.75-1.5375 19.4625-8.1875 24.0625-17.925L441.388042 48.125c13.825-29.7 42.5-48.125 75.2625-48.125s61.4375 18.4375 75.2625 48.125l104.45 223.2375c4.6125 9.725 13.825 16.375 24.0625 17.925L958.000542 325.625a82.355 82.355 0 0 1 66.05 55.8125c10.2375 29.7 2.5625 62.4625-19.45 84.9875l-175.625 180.7375c-7.1625 7.175-10.2375 17.925-8.7 27.65l40.9625 251.9c5.125 31.75-8.1875 63.4875-34.3 81.925-26.1125 18.4375-59.9 20.4875-88.0625 4.6125l-206.85-114.6875c-9.725-5.1125-20.9875-5.1125-30.7125 0l-207.3625 115.2c-12.8125 6.65-26.6375 10.2375-40.4625 10.2375zM516.650542 51.2c-12.8 0-23.55 7.1625-29.1875 18.4375L383.525542 292.875c-11.775 25.0875-35.325 43.0125-62.975 47.1l-237.575 36.35c-12.2875 2.05-21.5 9.7375-25.6 21.5-4.1 11.775-1.025 24.0625 7.675 32.775L240.688042 611.325c18.4375 18.95 26.625 45.5625 22.525 71.675L222.250542 934.9125c-2.05 12.8 3.075 24.575 13.3125 31.7375 10.2375 7.175 23.0375 7.6875 33.7875 1.5375l207.3625-115.2c25.0875-13.825 55.3-13.825 80.3875 0l207.3625 115.2c10.75 6.1375 23.55 5.625 33.8-1.5375 10.2375-7.1625 15.3625-18.95 13.3125-31.7375L770.625542 683.0125c-4.1-26.1125 4.1-52.7375 22.525-71.675l175.625-180.7375c8.7-8.7 11.2625-20.9875 7.675-32.775-4.0875-11.775-13.3125-19.9625-25.6-21.5l-237.5625-36.35c-27.65-4.0875-51.2-22.0125-62.975-47.1L545.838042 69.6375c-5.625-11.2625-16.375-18.4375-29.1875-18.4375z m0 0"
              p-id="2629" fill="#ffffff"></path>
        </svg>
        <svg v-else class="size-[1.2em]" viewBox="0 0 1426 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"
        >
          <path
              d="M985.6 1022.976c-14.848 0-31.744-4.096-47.104-12.288L716.288 899.584l-223.744 111.104c-14.336 7.68-30.208 11.776-47.104 11.776-21.504 0-42.496-6.656-59.392-19.456-31.232-23.552-47.104-64-39.936-101.376l45.568-237.056-175.616-163.328c-27.136-27.648-37.376-67.072-27.136-104.448l0.512-1.024c12.8-38.4 44.544-65.024 82.944-70.144l243.712-44.544L625.152 58.88C642.56 23.552 678.4 1.024 716.288 1.024c39.424 0 76.288 23.552 91.648 58.368l109.056 221.696 243.712 42.496c38.4 5.632 70.656 33.28 81.408 71.168 12.288 36.864 2.048 77.312-25.6 104.96l-0.512 0.512-174.592 164.864 44.032 237.568c7.168 37.888-8.192 76.288-39.424 100.352-17.92 12.8-38.912 19.968-60.416 19.968z"
              fill="#ffffff"></path>
        </svg>
      </button>

      <button class="btn btn-square btn-ghost">
        <svg class="size-[1.2em]" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"
             p-id="4580">
          <path
              d="M254.398526 804.702412l-0.030699-4.787026C254.367827 801.546535 254.380106 803.13573 254.398526 804.702412zM614.190939 259.036661c-22.116717 0-40.047088 17.910928-40.047088 40.047088l0.37146 502.160911c0 22.097274 17.930371 40.048111 40.047088 40.048111s40.048111-17.950837 40.048111-40.048111l-0.350994-502.160911C654.259516 276.948613 636.328122 259.036661 614.190939 259.036661zM893.234259 140.105968l-318.891887 0.148379-0.178055-41.407062c0-22.13616-17.933441-40.048111-40.067554-40.048111-7.294127 0-14.126742 1.958608-20.017916 5.364171-5.894244-3.405563-12.729929-5.364171-20.031219-5.364171-22.115694 0-40.047088 17.911952-40.047088 40.048111l0.188288 41.463344-230.115981 0.106424c-3.228531-0.839111-6.613628-1.287319-10.104125-1.287319-3.502777 0-6.89913 0.452301-10.136871 1.296529l-73.067132 0.033769c-22.115694 0-40.048111 17.950837-40.048111 40.047088 0 22.13616 17.931395 40.048111 40.048111 40.048111l43.176358-0.020466 0.292666 617.902982 0.059352 0 0 42.551118c0 44.233434 35.862789 80.095199 80.095199 80.095199l40.048111 0 0 0.302899 440.523085-0.25685 0-0.046049 40.048111 0c43.663452 0 79.146595-34.95 80.054267-78.395488l-0.329505-583.369468c0-22.135136-17.930371-40.047088-40.048111-40.047088-22.115694 0-40.047088 17.911952-40.047088 40.047088l0.287549 509.324054c-1.407046 60.314691-18.594497 71.367421-79.993892 71.367421l41.575908 1.022283-454.442096 0.26606 52.398394-1.288343c-62.715367 0-79.305207-11.522428-80.0645-75.308173l0.493234 76.611865-0.543376 0-0.313132-660.818397 236.82273-0.109494c1.173732 0.103354 2.360767 0.166799 3.561106 0.166799 1.215688 0 2.416026-0.063445 3.604084-0.169869l32.639375-0.01535c1.25355 0.118704 2.521426 0.185218 3.805676 0.185218 1.299599 0 2.582825-0.067538 3.851725-0.188288l354.913289-0.163729c22.115694 0 40.050158-17.911952 40.050158-40.047088C933.283394 158.01792 915.349953 140.105968 893.234259 140.105968zM774.928806 815.294654l0.036839 65.715701-0.459464 0L774.928806 815.294654zM413.953452 259.036661c-22.116717 0-40.048111 17.910928-40.048111 40.047088l0.37146 502.160911c0 22.097274 17.931395 40.048111 40.049135 40.048111 22.115694 0 40.047088-17.950837 40.047088-40.048111l-0.37146-502.160911C454.00054 276.948613 436.069145 259.036661 413.953452 259.036661z"
              fill="#ffffff" p-id="4581"></path>
        </svg>
      </button>
    </li>
  </ul>
  <div role="alert" class="alert alert-vertical sm:alert-horizontal fixed-center">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-info h-6 w-6 shrink-0">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
    </svg>
    <span>确定要删除吗？</span>
    <div>
      <button class="btn btn-sm">取消</button>
      <button class="btn btn-sm btn-primary">确定</button>
    </div>
  </div>
</template>
