<script setup lang="ts">
import { ref, computed, onMounted, watch, onBeforeUnmount } from 'vue';
import { shortcuts } from "~/src/commands/shortcuts/InitShortcuts";
import { updateShortcutKey, resetShortcut, resetAllShortcuts, toggleShortcutEnabled, setShortcutGroupEnabled, resetShortcutGroup } from "~/src/commands/shortcuts/InitShortcuts";
import { formatShortcutForDisplay, parseKeyEvent } from "~/src/utils/shortcutFormat";
import { getOsTypeFromNavigator } from "~/src/utils/SystemOS";
import clipboardService from '~/src/db/dbService';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { isTauri } from '~/src/utils/env';
import { useTooltipEnabled } from '~/composables/useTooltipEnabled';

const osType = ref('');

interface SettingItem {
  label: string;
  value: string | string[];
  type: 'input' | 'select' | 'checkbox' | 'action';
}

interface SettingGroup {
  title: string;
  type: string;
  items: SettingItem[];
}

// 各设置项的响应式状态（直接承载值，并通过 watch 实时持久化，无需“应用”按钮）
const apiKey = ref('');
const maxLimit = ref('');
const schemeOptions = ['深色', '浅色'];
const selectedScheme = ref('深色');
/** 开机自启状态（系统级设置，使用 tauri autostart 插件，不存数据库） */
const autoStartEnabled = ref(false);
/** 设置页即时反馈提示（toast） */
const hint = ref('');
let hintTimer: ReturnType<typeof setTimeout> | null = null;
const showHint = (msg: string) => {
  hint.value = msg;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hint.value = ''; }, 2500);
};
/** 是否开启悬停提示窗口（tooltip），与主窗口共享同一状态 */
const { tooltipEnabled } = useTooltipEnabled();
watch(tooltipEnabled, async (val) => {
  await clipboardService.setKeyValue('tooltip_enabled', val ? '1' : '0');
});
// 实时保存：任意设置项变化即写入数据库
watch(apiKey, async (val) => {
  await clipboardService.setKeyValue('api_key', val ?? '');
});
watch(maxLimit, async (val) => {
  await clipboardService.setKeyValue('max_save_count', val ?? '');
});
watch(selectedScheme, async (val) => {
  await clipboardService.setKeyValue('color_scheme', val ?? '');
});

// 开机自启：切换时调用系统 autostart 插件（enable/disable）
watch(autoStartEnabled, async (val) => {
  if (!isTauri()) return;
  try {
    if (val) {
      await enable();
    } else {
      await disable();
    }
    showHint(val ? '已开启开机自启' : '已关闭开机自启');
  } catch (e) {
    console.error('设置开机自启失败:', e);
    // 失败回滚 UI 状态
    autoStartEnabled.value = !val;
    // 提示用户：Tauri autostart 默认写当前用户注册表（HKCU），一般无需管理员权限，
    // 失败多因系统策略/注册表权限限制
    showHint('开机自启设置失败，请检查系统权限');
  }
});

// 清空数据库：二次确认状态
const showClearConfirm = ref(false);
const clearing = ref(false);
const clearMsg = ref('');

async function confirmClearDatabase() {
  if (clearing.value) return;
  clearing.value = true;
  clearMsg.value = '';
  try {
    await clipboardService.clearDatabase();
    clearMsg.value = '已清空剪贴板、便签与待办数据';
    // 触发剪贴板列表刷新（若在其他页已挂载）
    try {
      const { fetchData } = await import('~/src/commands/local/clipboardStore');
      await fetchData();
    } catch (_) { /* 列表未挂载时忽略 */ }
  } catch (e) {
    clearMsg.value = '清空失败：' + (e as Error).message;
  } finally {
    clearing.value = false;
    showClearConfirm.value = false;
  }
}

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
        label: '剪贴板最大存储数量',
        value: '',
        type: 'input'
      },
      {
        label: '开机自启',
        value: '',
        type: 'checkbox'
      },
      {
        label: '提示窗口',
        value: '',
        type: 'checkbox'
      },
      {
        label: '配色',
        value: selectedScheme.value,
        type: 'select'
      },
      {
        label: '清空数据库',
        value: '',
        type: 'action'
      }
    ]
  }
];

const activeSetting = ref(settings[0]);
// 持久化当前选中的设置分类，下次进入设置默认停在该分类
watch(activeSetting, async (val) => {
  await clipboardService.setKeyValue('setting_active_tab', val?.title ?? '');
});

// ===== 快捷键录制 =====
/** 当前正在录制的快捷键 id（null 表示未在录制） */
const recordingId = ref<string | null>(null);
/** 各快捷键的错误信息（冲突等） */
const errorMap = ref<Record<string, string>>({});
let recorderHandler: ((e: KeyboardEvent) => void) | null = null;

/** 快捷键设置组渲染数据 */
const shortcutItems = computed(() =>
  shortcuts.value.map(s => {
    // 数字快捷粘贴（Ctrl+1~0 / Ctrl+Shift+1~0）单独归类，默认折叠展示
    const group = s.id.startsWith('pinned_paste') ? 'pinned'
      : s.id.startsWith('slot_paste') ? 'slot' : 'normal';
    return {
      id: s.id,
      label: s.title,
      key: s.key,
      scope: s.scope,
      display: formatShortcutForDisplay(s.key),
      isModified: s.key !== s.defaultKey,
      enabled: s.enabled,
      group,
    };
  })
);

/** 按全局/局部分组的快捷键渲染数据（排除数字快捷粘贴，它们单独折叠展示） */
const shortcutGroups = computed(() =>
  (['global', 'local'] as const).map(scope => {
    const items = shortcutItems.value.filter(i => i.scope === scope && i.group === 'normal');
    return {
      title: scope === 'global' ? '全局快捷键' : '局部快捷键',
      scope,
      items,
      hasModified: items.some(i => i.isModified),
    };
  })
);

/** 两组可折叠的数字快捷粘贴（默认折叠，支持一键开启/关闭/还原） */
const collapsibleGroups = computed(() => [
  { key: 'pinned', title: '常用剪贴快捷粘贴（Ctrl+1~0）', items: shortcutItems.value.filter(i => i.group === 'pinned') },
  { key: 'slot', title: '剪贴板快捷粘贴（Ctrl+Shift+1~0）', items: shortcutItems.value.filter(i => i.group === 'slot') },
]);
/** 折叠状态（默认收起） */
const collapsed = ref<Record<string, boolean>>({ pinned: true, slot: true });

function toggleCollapse(key: string) {
  collapsed.value[key] = !collapsed.value[key];
}

/** 组内是否全部启用（整组胶囊开关的状态判定） */
function groupAllEnabled(group: { key: string; items: { enabled: boolean }[] }): boolean {
  return group.items.length > 0 && group.items.every(i => i.enabled);
}

/** 整组胶囊开关：点击在「全部启用 / 全部禁用」间切换 */
async function toggleGroup(group: { key: string; items: { id: string; enabled: boolean }[] }) {
  await setShortcutGroupEnabled(group.items.map(i => i.id), !groupAllEnabled(group));
}

/** 一键还原组内全部快捷键为默认（图标按钮） */
async function resetGroup(group: { key: string; items: { id: string }[] }) {
  await resetShortcutGroup(group.items.map(i => i.id));
}

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

onBeforeUnmount(() => {
  cancelRecording();
  if (hintTimer) clearTimeout(hintTimer);
});

onMounted(async () => {
  osType.value = getOsTypeFromNavigator();
  maxLimit.value = await clipboardService.getKeyValue('max_save_count');
  apiKey.value = await clipboardService.getKeyValue('api_key');
  try {
    const scheme = await clipboardService.getKeyValue('color_scheme');
    if (scheme) selectedScheme.value = scheme;
  } catch (e) {
    // 尚未设置过配色，使用默认值
  }
  // 恢复上次选中的设置分类（快捷键 / Api设置 / 通用）
  try {
    const savedTab = await clipboardService.getKeyValue('setting_active_tab');
    if (savedTab) {
      const found = settings.find(s => s.title === savedTab);
      if (found) activeSetting.value = found;
    }
  } catch (e) {
    // 忽略，使用默认第一项
  }
  // 读取当前开机自启状态（仅桌面容器内可用）
  if (isTauri()) {
    try {
      autoStartEnabled.value = await isEnabled();
    } catch (e) {
      console.error('读取开机自启状态失败:', e);
    }
  }
});
</script>

<template>
  <div class="container mx-auto p-4">
    <div class="flex">
      <div class="w-1/5 pr-4 sticky top-4 self-start">
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
                    <div class="flex items-center gap-3">
                      <!-- 独立启用/禁用开关 -->
                      <button
                          type="button" role="switch" :aria-checked="item.enabled"
                          class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-300 ease-soft"
                          :class="item.enabled ? 'bg-gold' : 'bg-accent'"
                          :title="item.enabled ? '点击禁用' : '点击启用'"
                          @click="toggleShortcutEnabled(item.id)"
                      >
                        <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow-soft transition-transform duration-300 ease-soft"
                              :class="item.enabled ? 'translate-x-[1.125rem]' : 'translate-x-0.5'"></span>
                      </button>
                      <div class="text-ink" :class="{ 'opacity-50': !item.enabled }">{{ item.label }}</div>
                    </div>
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

            <!-- 两组数字快捷粘贴：默认折叠 + 一键开启/关闭/还原 -->
            <div v-for="cg in collapsibleGroups" :key="cg.key" class="glass-card rounded-2xl shadow-soft">
              <div class="flex items-center justify-between gap-2 border-b border-accent p-4">
                <button
                    type="button"
                    class="flex items-center gap-2 text-xs uppercase tracking-wide text-ink-faint transition-colors hover:text-ink"
                    @click="toggleCollapse(cg.key)"
                >
                  <svg class="size-4 transition-transform duration-300 ease-soft" :class="collapsed[cg.key] ? '' : 'rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                  {{ cg.title }}
                </button>
                <div class="flex items-center gap-3">
                  <!-- 整组启用/禁用胶囊开关 -->
                  <button
                      type="button" role="switch" :aria-checked="groupAllEnabled(cg)"
                      class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-300 ease-soft"
                      :class="groupAllEnabled(cg) ? 'bg-gold' : 'bg-accent'"
                      :title="groupAllEnabled(cg) ? '点击关闭该组全部' : '点击开启该组全部'"
                      @click="toggleGroup(cg)"
                  >
                    <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow-soft transition-transform duration-300 ease-soft"
                          :class="groupAllEnabled(cg) ? 'translate-x-[1.125rem]' : 'translate-x-0.5'"></span>
                  </button>
                  <!-- 一键还原（图标按钮） -->
                  <button
                      type="button"
                      class="btn-soft p-2"
                      title="一键还原该组为默认"
                      @click="resetGroup(cg)"
                  >
                    <svg class="size-[1.2em]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                  </button>
                </div>
              </div>
              <ul v-show="!collapsed[cg.key]">
                <li v-for="item in cg.items" :key="item.id"
                    class="flex flex-col gap-1 border-b border-accent/50 p-4 last:border-b-0">
                  <div class="flex items-center justify-between gap-4">
                    <div class="flex items-center gap-3">
                      <button
                          type="button" role="switch" :aria-checked="item.enabled"
                          class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-300 ease-soft"
                          :class="item.enabled ? 'bg-gold' : 'bg-accent'"
                          :title="item.enabled ? '点击禁用' : '点击启用'"
                          @click="toggleShortcutEnabled(item.id)"
                      >
                        <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow-soft transition-transform duration-300 ease-soft"
                              :class="item.enabled ? 'translate-x-[1.125rem]' : 'translate-x-0.5'"></span>
                      </button>
                      <div class="text-ink" :class="{ 'opacity-50': !item.enabled }">{{ item.label }}</div>
                    </div>
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
                  <div v-if="item.type === 'action' && clearMsg" class="mt-1 text-xs text-ink-faint">
                    {{ clearMsg }}
                  </div>
                </div>
                <div class="w-56 shrink-0">
                  <!-- 操作型设置项（如清空数据库）：二次确认 -->
                  <template v-if="item.type === 'action'">
                    <button v-if="!showClearConfirm" type="button"
                            class="btn-soft w-full text-[rgba(176,92,92,1)]"
                            @click="showClearConfirm = true">
                      清空数据库
                    </button>
                    <div v-else class="flex gap-2">
                      <button type="button" class="btn-soft flex-1 text-[rgba(176,92,92,1)]"
                              :disabled="clearing" @click="confirmClearDatabase">
                        {{ clearing ? '清空中…' : '确认清空' }}
                      </button>
                      <button type="button" class="btn-soft flex-1"
                              :disabled="clearing" @click="showClearConfirm = false">
                        取消
                      </button>
                    </div>
                  </template>
                  <input v-else-if="item.type === 'input' && item.label === 'API key'" type="text"
                         v-model="apiKey"
                         placeholder="输入 API key"
                         class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none"/>
                  <input v-else-if="item.type === 'input' && item.label === '剪贴板最大存储数量'" type="text"
                         v-model="maxLimit"
                         placeholder="如 500"
                         class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none"/>
                  <button
                      v-else-if="item.type === 'checkbox' && item.label === '开机自启'"
                      type="button" role="switch" :aria-checked="autoStartEnabled"
                      class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-300 ease-soft"
                      :class="autoStartEnabled ? 'bg-gold' : 'bg-accent'"
                      @click="autoStartEnabled = !autoStartEnabled"
                  >
                    <span class="inline-block h-5 w-5 transform rounded-full bg-white shadow-soft transition-transform duration-300 ease-soft"
                          :class="autoStartEnabled ? 'translate-x-5' : 'translate-x-0.5'"></span>
                  </button>
                  <button
                      v-else-if="item.type === 'checkbox' && item.label === '提示窗口'"
                      type="button" role="switch" :aria-checked="tooltipEnabled"
                      class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-300 ease-soft"
                      :class="tooltipEnabled ? 'bg-gold' : 'bg-accent'"
                      @click="tooltipEnabled = !tooltipEnabled"
                  >
                    <span class="inline-block h-5 w-5 transform rounded-full bg-white shadow-soft transition-transform duration-300 ease-soft"
                          :class="tooltipEnabled ? 'translate-x-5' : 'translate-x-0.5'"></span>
                  </button>
                  <div v-else-if="item.type === 'select'" class="dropdown dropdown-end w-full">
                    <button
                        type="button" tabindex="0"
                        class="btn-soft flex w-full items-center justify-between rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink"
                    >
                      <span>{{ selectedScheme }}</span>
                      <svg class="h-4 w-4 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                    <ul tabindex="0" class="dropdown-content glass-card menu w-full rounded-2xl p-2">
                      <li v-for="opt in schemeOptions" :key="opt">
                        <button
                            type="button"
                            class="flex w-full items-center justify-between rounded-xl"
                            :class="selectedScheme === opt ? 'text-gold' : ''"
                            @click="selectedScheme = opt"
                        >
                          <span>{{ opt }}</span>
                          <svg v-if="selectedScheme === opt" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        </button>
                      </li>
                    </ul>
                  </div>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- 即时反馈提示（toast） -->
    <div
        v-if="hint"
        class="pointer-events-none fixed left-1/2 top-20 z-[90] -translate-x-1/2 rounded-full border border-accent bg-surface-field/95 px-4 py-2 text-sm text-ink shadow-float backdrop-blur"
    >
      {{ hint }}
    </div>
  </div>
</template>
