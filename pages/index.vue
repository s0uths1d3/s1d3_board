<script setup lang="ts">
import type { ClipboardData } from '~/src/ClipboardData';
import Database from "@tauri-apps/plugin-sql";
import { formatTimestamp } from "~/src/utils/formatDate";
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setIsWindowVisible } from "~/src/commands/global/ToggleWindowCommand";

import {
  selectedRowIndex,
  dataLength,
  ArrowUpTargetMovementCommand,
  ArrowDownTargetMovementCommand,
  selectRow
} from '~/src/commands/local/TargetMovementCommand';

const data = ref<ClipboardData[]>([]);
const listElement = ref<HTMLElement | null>(null);

let updateInterval: NodeJS.Timeout;
const db = await Database.load('sqlite:s1de_board.db');

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
    const result = await db.select(
        "SELECT * FROM clipboard ORDER BY last_use DESC LIMIT 100",
    );
    data.value = result as ClipboardData[];
    dataLength.value = data.value.length;
    if (selectedRowIndex.value >= data.value.length) {
      selectedRowIndex.value = data.value.length - 1;
    }
  } catch (err) {
    console.log(err);
  }
}

async function favorite(value: number) {
  value = value === 0 ? 1 : 0;
  await db?.execute(
      "UPDATE clipboard SET is_favorite = $2 WHERE id = $1",
      [data.value[selectedRowIndex.value].id, value]
  );
}

async function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'ArrowUp') {
    await new ArrowUpTargetMovementCommand().execute();
  } else if (event.key === 'ArrowDown') {
    await new ArrowDownTargetMovementCommand().execute();
  } else if (event.key === 'Enter') {
    await db?.execute(
        "UPDATE clipboard SET count = count + 1, last_use = $2 WHERE id = $1",
        [data.value[selectedRowIndex.value].id, Math.floor(Date.now())]
    ).then(() => {
      getCurrentWindow().hide();
      setIsWindowVisible(false);
    });
  }
}
</script>

<template>
  <ul ref="listElement" class="list bg-base-100 rounded-box shadow-md" tabindex="0" @keydown="handleKeyDown">
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
        <svg v-else  class="size-[1.2em]" viewBox="0 0 1426 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"
             >
          <path
              d="M985.6 1022.976c-14.848 0-31.744-4.096-47.104-12.288L716.288 899.584l-223.744 111.104c-14.336 7.68-30.208 11.776-47.104 11.776-21.504 0-42.496-6.656-59.392-19.456-31.232-23.552-47.104-64-39.936-101.376l45.568-237.056-175.616-163.328c-27.136-27.648-37.376-67.072-27.136-104.448l0.512-1.024c12.8-38.4 44.544-65.024 82.944-70.144l243.712-44.544L625.152 58.88C642.56 23.552 678.4 1.024 716.288 1.024c39.424 0 76.288 23.552 91.648 58.368l109.056 221.696 243.712 42.496c38.4 5.632 70.656 33.28 81.408 71.168 12.288 36.864 2.048 77.312-25.6 104.96l-0.512 0.512-174.592 164.864 44.032 237.568c7.168 37.888-8.192 76.288-39.424 100.352-17.92 12.8-38.912 19.968-60.416 19.968z"
              fill="#ffffff" ></path>
        </svg>
      </button>
    </li>
  </ul>
</template>