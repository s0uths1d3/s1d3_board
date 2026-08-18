<script setup lang="ts">
import { ref, computed, onMounted, watch, onBeforeUnmount } from 'vue';
import { shortcuts } from "~/src/commands/shortcuts/InitShortcuts";
import { updateShortcutKey, resetShortcut, resetAllShortcuts } from "~/src/commands/shortcuts/InitShortcuts";
import { formatShortcutForDisplay, parseKeyEvent } from "~/src/utils/shortcutFormat";
import { getOsTypeFromNavigator } from "~/src/utils/SystemOS";
import clipboardService from '~/src/db/dbService';

const osType = ref('');

interface SettingItem {
  label: string;
  value: string | string[];
  type: 'input' | 'select' | 'checkbox';
}

interface SettingGroup {
  title: string;
  type: string;
  items: SettingItem[];
}

// 各设置项的响应式状态（直接承载值，并通过 watch 实时持久化，无需“应用”按钮）
const apiKey = ref('');
const maxLimit = ref('');
const colorScheme = ref(['深色', '浅色']);

// 实时保存：任意设置项变化即写入数据库
watch(apiKey, async (val) => {
  await clipboardService.setKeyValue('api_key', val ?? '');
});
watch(maxLimit, async (val) => {
  await clipboardService.setKeyValue('max_save_count', val ?? '');
});
watch(colorScheme, async (val) => {
  await clipboardService.setKeyValue('color_scheme', val?.[0] ?? '');
}, { deep: true });

const settings: SettingGroup[] = [
  {
    title: '快捷键设置',
    type: 'shortcut',
    items: [],
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

// ===== 快捷键录制 =====
/** 当前正在录制的快捷键 id（null 表示未在录制） */
const recordingId = ref<string | null>(null);
/** 各快捷键的错误信息（冲突等） */
const errorMap = ref<Record<string, string>>({});
let recorderHandler: ((e: KeyboardEvent) => void) | null = null;

/** 快捷键设置组渲染数据 */
const shortcutItems = computed(() =>
  shortcuts.value.map(s => ({
    id: s.id,
    label: s.title,
    key: s.key,
    scope: s.scope,
    display: formatShortcutForDisplay(s.key),
    isModified: s.key !== s.defaultKey,
  }))
);

/** 按全局/局部分组的快捷键渲染数据 */
const shortcutGroups = computed(() =>
  (['global', 'local'] as const).map(scope => {
    const items = shortcutItems.value.filter(i => i.scope === scope);
    return {
      title: scope === 'global' ? '全局快捷键' : '局部快捷键',
      scope,
      items,
      hasModified: items.some(i => i.isModified),
    };
  })
);

function startRecording(id: string) {
  if (recordingId.value) return;
  recordingId.value = id;
  // capture 阶段监听，抢在 ShortcutManager 之前拦截按键
  recorderHandler = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      cancelRecording();
      return;
    }
    const newKey = parseKeyEvent(e);
    if (!newKey) return; // 只按了修饰键，等待主键
    commitRecording(id, newKey);
  };
  window.addEventListener('keydown', recorderHandler, true);
}

function cancelRecording() {
  if (recorderHandler) {
    window.removeEventListener('keydown', recorderHandler, true);
    recorderHandler = null;
  }
  recordingId.value = null;
}

async function commitRecording(id: string, newKey: string) {
  cancelRecording();
  const err = await updateShortcutKey(id, newKey);
  if (err) {
    errorMap.value[id] = err;
  } else {
    delete errorMap.value[id];
  }
}

async function resetOne(id: string) {
  const err = await resetShortcut(id);
  if (err) {
    errorMap.value[id] = err;
  } else {
    delete errorMap.value[id];
  }
}

async function resetAll(scope?: 'global' | 'local') {
  cancelRecording();
  await resetAllShortcuts(scope);
  errorMap.value = {};
}

// 切换设置组时取消录制
watch(activeSetting, () => cancelRecording());

onBeforeUnmount(() => cancelRecording());

onMounted(async () => {
  osType.value = getOsTypeFromNavigator();
  maxLimit.value = await clipboardService.getKeyValue('max_save_count');
  apiKey.value = await clipboardService.getKeyValue('api_key');
  try {
    const scheme = await clipboardService.getKeyValue('color_scheme');
    if (scheme) colorScheme.value = [scheme, scheme === '深色' ? '浅色' : '深色'];
  } catch (e) {
    // 尚未设置过配色，使用默认值
  }
});
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
          <!-- 快捷键设置组 -->
          <div v-if="activeSetting.type === 'shortcut'" class="flex flex-col gap-4">
            <div v-for="group in shortcutGroups" :key="group.scope">
              <ul class="glass-card rounded-2xl shadow-soft">
                <li class="border-b border-accent p-4 pb-2 text-xs uppercase tracking-wide text-ink-faint">
                  {{ group.title }}
                </li>
                <li v-for="item in group.items" :key="item.id"
                    class="flex flex-col gap-1 border-b border-accent/50 p-4 last:border-b-0">
                  <div class="flex items-center justify-between gap-4">
                    <div class="text-ink">{{ item.label }}</div>
                    <div class="flex items-center gap-2">
                      <button
                          type="button"
                          class="w-56 rounded-xl border border-accent bg-surface-field px-3 py-2 text-center font-mono text-sm font-semibold text-ink transition-all duration-300 ease-soft hover:border-gold focus:outline-none"
                          :class="recordingId === item.id ? 'border-gold ring-1 ring-gold/60 animate-pulse' : ''"
                          @click="startRecording(item.id)"
                      >
                        {{ recordingId === item.id ? '按下新快捷键… (Esc 取消)' : item.display }}
                      </button>
                      <button
                          v-if="item.isModified"
                          type="button"
                          class="btn-soft p-2"
                          title="重置为默认"
                          @click="resetOne(item.id)"
                      >
                        <svg class="size-[1.2em]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div v-if="errorMap[item.id]" class="text-xs text-[rgba(176,92,92,1)]">
                    {{ errorMap[item.id] }}
                  </div>
                </li>
              </ul>
              <div v-if="group.hasModified" class="mt-2 flex justify-end">
                <button class="btn-soft" @click="resetAll(group.scope)">
                  <svg class="mr-1 inline h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  全部重置
                </button>
              </div>
            </div>
            <p class="text-xs text-ink-faint">
              点击快捷键输入框后按下新的组合键即可自定义；Esc 取消；重复的快捷键会提示冲突。全局快捷键在系统任意位置生效，局部快捷键仅在窗口内生效。
            </p>
          </div>

          <!-- 其他设置组 -->
          <div v-else>
            <ul class="glass-card rounded-2xl shadow-soft">
              <li class="border-b border-accent p-4 pb-2 text-xs uppercase tracking-wide text-ink-faint">
                {{ activeSetting.title }}
              </li>
              <li v-for="(item, itemIndex) in activeSetting.items" :key="itemIndex"
                  class="flex items-center justify-between gap-4 p-4">
                <div>
                  <div class="text-ink">{{ item.label }}</div>
                </div>
                <div class="w-56 shrink-0">
                  <input v-if="item.type === 'input' && item.label === 'API key'" type="text"
                         v-model="apiKey"
                         placeholder="输入 API key"
                         class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none"/>
                  <input v-else-if="item.type === 'input' && item.label === '最大查询数量'" type="text"
                         v-model="maxLimit"
                         placeholder="如 500"
                         class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none"/>
                  <select v-if="item.type === 'select'" v-model="colorScheme[0]" class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none">
                    <option v-for="(value, index) in colorScheme" :key="index" :value="value">
                      {{ value }}
                    </option>
                  </select>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
