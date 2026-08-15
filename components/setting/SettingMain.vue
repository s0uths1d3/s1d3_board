<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { shortcuts } from "~/src/commands/shortcuts/InitShortcuts";
import { getOsTypeFromNavigator } from "~/src/utils/SystemOS";
import clipboardService from '~/src/db/dbService';

const osTye = ref('');

interface SettingItem {
  label: string;
  value: string | string[];
  type: 'input' | 'select' | 'checkbox';
}

interface SettingGroup {
  title: string;
  type:string;
  items: SettingItem[];
}
const apikey = ref('');
const maxLimit = ref('');
const colorScheme = ref(['深色', '浅色']);

const settings: SettingGroup[] = [
  {
    title: '快捷键设置',
    type: 'shortcut',
    items: shortcuts.map(shortcut => ({ label: shortcut.title, value: controlDisplayText(shortcut.key), type: 'input' })),
  },
  {
    title: 'Api设置',
    type: 'ai_setting',
    items: [
      {
        label: 'API key',
        value: apikey,
        type: 'input'
      }
    ]
  },
  {
    title: '通用设置',
    type: 'general',
    items: [
      {
        label: '最大查询数量',
        value: maxLimit,
        type: 'input'
      },
      {
        label: '配色',
        value: colorScheme.value,
        type: 'select'
      }
    ]
  }
];

const activeSetting = ref(settings[0]);

onMounted(async () => {
  osTye.value = getOsTypeFromNavigator();
  maxLimit.value = await clipboardService.getKeyValue('max_save_count');
  apikey.value = await clipboardService.getKeyValue('api_key');
});

function controlDisplayText(key: string): string {
  let modifiedKey = key;
  if (modifiedKey.includes('Or')) {
    if (osTye.value === 'Darwin') {
      return modifiedKey.replace('CommandOrControl', 'Command');
    } else {
      return modifiedKey.replace('CommandOrControl', 'ctrl');
    }
  }
  return key;
}

async function applySettings(type:string) {
  if (type === 'ai_setting')
    await clipboardService.setKeyValue('api_key',apikey.value)
  else if (type === 'general')
    await clipboardService.setKeyValue('max_save_count',maxLimit.value)
}
</script>

<template>
  <div class="container mx-auto p-4">
    <div class="flex">
      <div class="w-1/5 pr-4">
        <div v-for="(setting, index) in settings" :key="index" class="mb-2">
          <button
              class="btn-soft btn-block w-full"
              :class="{ 'border-gold bg-secondary text-gold': activeSetting === setting }"
              @click="activeSetting = setting"
          >
            {{ setting.title }}
          </button>
        </div>
      </div>
      <div class="w-4/5">
        <div v-if="activeSetting">
          <ul class="glass-card rounded-2xl shadow-soft">
            <li class="border-b border-accent p-4 pb-2 text-xs uppercase tracking-wide text-ink-faint">
              {{ activeSetting.title }}
            </li>
            <li v-for="(item, itemIndex) in activeSetting.items" :key="itemIndex"
                class="list-row flex items-center justify-between p-4">
              <div>
                <div class="text-ink">{{ item.label }}</div>
              </div>
              <div>
                <input v-if="item.type === 'input'" type="text" v-model="item.value"
                       class="w-fit rounded-xl border border-accent bg-[rgba(255,255,255,0.5)] px-3 py-2 text-ink focus:border-gold focus:outline-none"/>
                <select v-if="item.type === 'select'" v-model="item.value[0]" class="rounded-xl border border-accent bg-[rgba(255,255,255,0.5)] px-3 py-2 text-ink focus:border-gold focus:outline-none">
                  <option v-for="(value, index) in colorScheme" :key="index" :value="value">
                    {{ value }}
                  </option>
                </select>
              </div>
            </li>
            <li>
              <button class="btn-gold btn-block w-full" @click="applySettings(activeSetting.type)">
                {{ '应用' }}
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
