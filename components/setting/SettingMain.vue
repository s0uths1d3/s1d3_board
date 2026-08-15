<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { shortcuts } from "~/src/commands/shortcuts/InitShortcuts";
import { getOsTypeFromNavigator } from "~/src/utils/SystemOS";
import clipboardService from '~/src/db/dbService';

const osType = ref('');

interface SettingItem {
  label: string;
  // input 用字符串值，select 用字符串数组（单选取 [0]）
  value: string | string[];
  type: 'input' | 'select' | 'checkbox';
}

interface SettingGroup {
  title: string;
  type: string;
  items: SettingItem[];
}

// 各设置项的响应式状态（直接承载字符串值，避免把 ref 塞进静态配置数组导致 v-model 失效）
const apiKey = ref('');
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
        value: '',
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
        value: '',
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

// 将响应式状态同步进静态配置项的 value（模板通过 item.value 双向绑定）
function syncSettingsToModel() {
  const aiItem = settings.find(s => s.type === 'ai_setting')?.items[0]
  if (aiItem) aiItem.value = apiKey.value
  const generalItems = settings.find(s => s.type === 'general')?.items ?? []
  const limitItem = generalItems.find(i => i.label === '最大查询数量')
  if (limitItem) limitItem.value = maxLimit.value
}

onMounted(async () => {
  osType.value = getOsTypeFromNavigator();
  maxLimit.value = await clipboardService.getKeyValue('max_save_count');
  apiKey.value = await clipboardService.getKeyValue('api_key');
  syncSettingsToModel();
});

function controlDisplayText(key: string): string {
  let modifiedKey = key;
  if (modifiedKey.includes('Or')) {
    if (osType.value === 'Darwin') {
      return modifiedKey.replace('CommandOrControl', 'Command');
    } else {
      return modifiedKey.replace('CommandOrControl', 'ctrl');
    }
  }
  return key;
}

async function applySettings(type: string) {
  if (type === 'ai_setting') {
    const aiItem = settings.find(s => s.type === 'ai_setting')?.items[0]
    apiKey.value = (aiItem?.value as string) ?? ''
    await clipboardService.setKeyValue('api_key', apiKey.value)
  } else if (type === 'general') {
    const limitItem = settings.find(s => s.type === 'general')?.items.find(i => i.label === '最大查询数量')
    maxLimit.value = (limitItem?.value as string) ?? ''
    await clipboardService.setKeyValue('max_save_count', maxLimit.value)
  }
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
                <input v-if="item.type === 'input'" type="text"
                       v-model="item.value"
                       class="w-fit rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none"/>
                <select v-if="item.type === 'select'" v-model="colorScheme[0]" class="rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none">
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
