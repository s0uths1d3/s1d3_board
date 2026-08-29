<script setup lang="ts">
import { ref, computed, onMounted, watch, onBeforeUnmount, nextTick } from 'vue';
import { shortcuts } from "~/src/commands/shortcuts/InitShortcuts";
import { updateShortcutKey, resetShortcut, resetAllShortcuts, toggleShortcutEnabled, setShortcutGroupEnabled, resetShortcutGroup } from "~/src/commands/shortcuts/InitShortcuts";
import { formatShortcutForDisplay, parseKeyEvent } from "~/src/utils/shortcutFormat";
import { getOsTypeFromNavigator } from "~/src/utils/SystemOS";
import clipboardService from '~/src/db/dbService';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { isTauri } from '~/src/utils/env';
import { useTooltipEnabled } from '~/composables/useTooltipEnabled';
import { usePopupPosition, setPopupPositionMode, type PopupPositionMode } from '~/composables/usePopupPosition';
import { useColorScheme, setColorScheme, COLOR_SCHEME_LABELS, COLOR_SCHEME_ORDER, type ColorSchemeMode } from '~/composables/useColorScheme';
import { useTodoSmartRemind } from '~/composables/useTodoSmartRemind';
import { useSearchHighlight } from '~/composables/useSearchHighlight';
import { navRows, reorderTab, persistNavConfig, setTabEnabled, statsUnlocked } from '~/composables/useTabs';
import { useLongPressReorder } from '~/composables/useLongPressReorder';

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
// ===== 配色：琥珀（当前暖米色）/ 跟随系统 / 浅色 / 深色，与标题栏按钮、Ctrl+Alt+C 快捷键共用同一状态 =====
const { scheme } = useColorScheme();
const colorSchemeOptions = COLOR_SCHEME_ORDER.map(value => ({ value, label: COLOR_SCHEME_LABELS[value] }));
const colorSchemeLabel = computed(() => COLOR_SCHEME_LABELS[scheme.value]);
async function selectColorScheme(value: ColorSchemeMode) {
  if (scheme.value === value) return;
  await setColorScheme(value);
  showHint(`已切换为${COLOR_SCHEME_LABELS[value]}配色`);
}
/** 开机自启状态（系统级设置，使用 tauri autostart 插件，不存数据库） */
const autoStartEnabled = ref(false);
/** 初始化标志：onMounted 读取系统自启状态时跳过 watch 的 enable/disable 与提示逻辑 */
let initializingAutoStart = false;
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

// ===== 窗口弹出位置（快捷键唤出主窗口时的落点） =====
const { popupPositionMode } = usePopupPosition();/** 三个候选模式：光标处 / 上次打开位置 / 光标所在屏幕居中 */
const POPUP_POSITION_OPTIONS: { value: PopupPositionMode; label: string; tip: string }[] = [
  { value: 'cursor', label: '光标处', tip: '在鼠标光标附近弹出' },
  { value: 'last', label: '上次位置', tip: '在上次打开（含拖动后）的位置弹出' },
  { value: 'center', label: '屏幕中央', tip: '在光标所在屏幕居中弹出' },
];
/** 切换弹出位置模式并持久化（UiSegmented 回传字符串值，此处收敛为模式类型） */
function selectPopupPosition(v: string) {
  const mode = v as PopupPositionMode;
  void setPopupPositionMode(mode);
  showHint('已保存窗口弹出位置');
}
/** 是否开启搜索高亮，与所有搜索框共享同一状态 */
const { searchHighlightEnabled } = useSearchHighlight();
/** 待办智能提醒（提前 30/10/5 分钟 + 自定义提醒）；关闭后仅保留到期时刻通知 */
const { smartRemindEnabled } = useTodoSmartRemind();
watch(searchHighlightEnabled, async (val) => {
  await clipboardService.setKeyValue('search_highlight_enabled', val ? '1' : '0');
});
// 实时保存：任意设置项变化即写入数据库
watch(apiKey, async (val) => {
  await clipboardService.setKeyValue('api_key', val ?? '');
});
watch(maxLimit, async (val) => {
  await clipboardService.setKeyValue('max_save_count', val ?? '');
});

// 提示窗口 / 搜索高亮的切换提示已在模板 @change 中内联处理

// 开机自启：切换时调用系统 autostart 插件（enable/disable）
watch(autoStartEnabled, async (val) => {
  // 初始化读取系统状态时跳过，避免每次进入设置页都误触发 enable/disable 和提示
  if (initializingAutoStart) return;
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
    title: '导航栏设置',
    type: 'nav',
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
        label: '待办智能提醒',
        value: '',
        type: 'checkbox'
      },
      {
        label: '窗口弹出位置',
        value: '',
        type: 'select'
      },
      {
        label: '搜索高亮',
        value: '',
        type: 'checkbox'
      },
      {
        label: '配色',
        value: '',
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

// ===== 设置左侧分类 + 导航配置列表 长按拖拽排序 =====
/** 导航配置列表的拖动状态 key */
const navDraggingKey = ref<string | null>(null);
const navReorder = useLongPressReorder({
  container: '[data-nav-config-list]',
  items: '.nav-config-item',
  axis: 'y',
  onReorder: (from, to) => reorderTab(from as any, to as any),
  onDrop: () => { void persistNavConfig(); },
  onStateChange: (k) => { navDraggingKey.value = k; },
});

/** 设置左侧分类的拖动状态（用 title 标识，因 settings 是普通数组按 title 持久化顺序） */
const settingGroupDragging = ref<string | null>(null);
const SETTING_GROUP_ORDER_KEY = 'setting_group_order';
/** 左侧分类顺序（持久化）；默认按 settings 定义顺序 */
const settingOrder = ref<string[]>(settings.map(s => s.title));
/** 加载已保存的分类顺序 */
async function loadSettingOrder() {
  try {
    const raw = await clipboardService.getKeyValue(SETTING_GROUP_ORDER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const valid = new Set(settings.map(s => s.title));
        settingOrder.value = [...parsed.filter((t: unknown) => typeof t === 'string' && valid.has(t)), ...settings.map(s => s.title).filter(t => !parsed.includes(t))];
      }
    }
  } catch { /* 使用默认顺序 */ }
}
/** 按用户顺序展示左侧分类 */
const orderedSettings = computed(() =>
  [...settings].sort((a, b) => settingOrder.value.indexOf(a.title) - settingOrder.value.indexOf(b.title)),
);
const settingReorder = useLongPressReorder({
  container: '[data-setting-nav]',
  items: '.setting-nav-item',
  axis: 'y',
  onReorder: (from, to) => {
    const a = settingOrder.value.indexOf(from);
    const b = settingOrder.value.indexOf(to);
    if (a < 0 || b < 0) return;
    const order = [...settingOrder.value];
    order.splice(a, 1);
    order.splice(b, 0, from);
    settingOrder.value = order;
  },
  onDrop: () => {
    void clipboardService.setKeyValue(SETTING_GROUP_ORDER_KEY, JSON.stringify(settingOrder.value));
  },
  onStateChange: (k) => { settingGroupDragging.value = k; },
});
void loadSettingOrder();

/** 左侧分类点击：长按拖拽结束后的 click 抑制切换（拖动 ≠ 点击） */
function onSettingClick(setting: (typeof settings)[number]) {
  if (settingReorder.consumeDragged()) return;
  activeSetting.value = setting;
}

/** 导航配置行开关点击：拖拽结束后的 click 抑制切换 */
function onNavRowToggle(row: (typeof navRows.value)[number]) {
  if (navReorder.consumeDragged()) return;
  setTabEnabled(row.key, !row.enabled);
}

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

/** 单项启用/禁用开关：切换后给出即时反馈 */
function toggleShortcutWithHint(id: string) {
  const item = shortcuts.value.find(s => s.id === id);
  const next = !item?.enabled;
  toggleShortcutEnabled(id);
  showHint(next ? '已启用快捷键' : '已禁用快捷键');
}

/** 整组胶囊开关：点击在「全部启用 / 全部禁用」间切换 */
async function toggleGroup(group: { key: string; items: { id: string; enabled: boolean }[] }) {
  const enable = !groupAllEnabled(group);
  await setShortcutGroupEnabled(group.items.map(i => i.id), enable);
  showHint(enable ? '已开启该组全部快捷键' : '已关闭该组全部快捷键');
}

/** 一键还原组内全部快捷键为默认（图标按钮） */
async function resetGroup(group: { key: string; items: { id: string }[] }) {
  await resetShortcutGroup(group.items.map(i => i.id));
  showHint('已还原该组快捷键为默认');
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
    showHint('快捷键保存失败：' + err);
  } else {
    delete errorMap.value[id];
    showHint('快捷键已保存');
  }
}

async function resetOne(id: string) {
  const err = await resetShortcut(id);
  if (err) {
    errorMap.value[id] = err;
    showHint('重置失败：' + err);
  } else {
    delete errorMap.value[id];
    showHint('已重置为默认');
  }
}

async function resetAll(scope?: 'global' | 'local') {
  cancelRecording();
  await resetAllShortcuts(scope);
  errorMap.value = {};
  showHint('已全部重置为默认');
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
  // 配色的读取/应用/持久化由 useColorScheme 统一负责，这里无需处理
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
  // 读取当前开机自启状态（仅桌面容器内可用）；
  // 用 initializingAutoStart 标记，避免触发 watch 误发 enable/disable 与提示。
  // 注意：watch 默认异步（flush: 'pre'），必须 await nextTick() 等回调执行完再清除标记，
  // 否则 watch 在下一 tick 运行时标记已为 false，仍会误发提示。
  if (isTauri()) {
    initializingAutoStart = true;
    try {
      autoStartEnabled.value = await isEnabled();
    } catch (e) {
      console.error('读取开机自启状态失败:', e);
    }
    await nextTick();
    initializingAutoStart = false;
  }
});
</script>

<template>
  <div class="container mx-auto p-4">
    <div class="flex">
      <div class="w-1/5 pr-4 sticky top-4 self-start" data-setting-nav>
        <!-- 左侧分类列表：长按 1s 可拖动调整顺序，松开自动持久化；TransitionGroup 提供平滑让位 -->
        <TransitionGroup name="reorder-list" tag="div">
          <div
              v-for="setting in orderedSettings"
              :key="setting.title"
              class="setting-nav-item mb-2"
              :class="settingGroupDragging === setting.title ? 'opacity-50 scale-95' : ''"
              :data-reorder-key="setting.title"
              @pointerdown="settingReorder.pressStart(setting.title, $event)"
          >
            <button
                class="btn-soft btn-block w-full"
                :class="{ 'border-gold bg-secondary text-gold': activeSetting === setting }"
                @click="onSettingClick(setting)"
            >
              {{ setting.title }}
            </button>
          </div>
        </TransitionGroup>
      </div>
      <div class="w-4/5">
        <!-- 分类切换过渡：复用全局 page-curtain（淡入 + 上浮），key 驱动 -->
        <Transition name="page-curtain" mode="out-in">
        <div v-if="activeSetting" :key="activeSetting.title" class="min-h-[280px]">
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
                      <UiToggleSwitch
                          size="sm"
                          :model-value="item.enabled"
                          tip-on="点击禁用" tip-off="点击启用"
                          :label="item.label"
                          @change="toggleShortcutWithHint(item.id)"
                      />
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
                          v-tip="'重置为默认'"
                          @click="resetOne(item.id)"
                      >
                        <svg class="size-[1.2em]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div v-if="errorMap[item.id]" class="text-xs text-danger">
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
                  <UiToggleSwitch
                      size="sm"
                      :model-value="groupAllEnabled(cg)"
                      tip-on="点击关闭该组全部" tip-off="点击开启该组全部"
                      :label="cg.title"
                      @change="toggleGroup(cg)"
                  />
                  <!-- 一键还原（图标按钮） -->
                  <button
                      type="button"
                      class="btn-soft p-2"
                      v-tip="'一键还原该组为默认'"
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
                      <UiToggleSwitch
                          size="sm"
                          :model-value="item.enabled"
                          tip-on="点击禁用" tip-off="点击启用"
                          :label="item.label"
                          @change="toggleShortcutWithHint(item.id)"
                      />
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
                          v-tip="'重置为默认'"
                          @click="resetOne(item.id)"
                      >
                        <svg class="size-[1.2em]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div v-if="errorMap[item.id]" class="text-xs text-danger">
                    {{ errorMap[item.id] }}
                  </div>
                </li>
              </ul>
            </div>

            <p class="text-xs text-ink-faint">
              点击快捷键输入框后按下新的组合键即可自定义；Esc 取消；重复的快捷键会提示冲突。全局快捷键在系统任意位置生效，局部快捷键仅在窗口内生效。
            </p>
          </div>

          <!-- 其他设置组（排除导航栏设置，导航栏有独立分支） -->
          <div v-else-if="activeSetting.type !== 'nav'">
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
                            class="btn-soft w-full text-danger"
                            @click="showClearConfirm = true">
                      清空数据库
                    </button>
                    <div v-else class="flex gap-2">
                      <button type="button" class="btn-soft flex-1 text-danger"
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
                         class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none"
                         @blur="showHint('已保存 API key')"/>
                  <input v-else-if="item.type === 'input' && item.label === '剪贴板最大存储数量'" type="text"
                         v-model="maxLimit"
                         placeholder="如 500"
                         class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none"
                         @blur="showHint('已保存最大存储数量')"/>
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === '开机自启'"
                      v-model="autoStartEnabled"
                      label="开机自启"
                  />
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === '提示窗口'"
                      v-model="tooltipEnabled"
                      tip-on="点击禁用" tip-off="点击启用"
                      label="提示窗口"
                      @change="showHint(tooltipEnabled ? '已开启提示窗口' : '已关闭提示窗口')"
                  />
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === '搜索高亮'"
                      v-model="searchHighlightEnabled"
                      tip-on="点击禁用" tip-off="点击启用"
                      label="搜索高亮"
                      @change="showHint(searchHighlightEnabled ? '已开启搜索高亮' : '已关闭搜索高亮')"
                  />
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === '待办智能提醒'"
                      v-model="smartRemindEnabled"
                      tip-on="关闭后仅保留到期时刻通知" tip-off="开启后按任务长短智能提前提醒"
                      label="待办智能提醒"
                      @change="showHint(smartRemindEnabled ? '已开启智能提醒' : '已关闭智能提醒，仅保留到期通知')"
                  />
                  <!-- 窗口弹出位置：三选一分段控件（跟随系统风格，选中金色高亮） -->
                  <UiSegmented
                      v-else-if="item.type === 'select' && item.label === '窗口弹出位置'"
                      :model-value="popupPositionMode"
                      :options="POPUP_POSITION_OPTIONS"
                      block
                      label="窗口弹出位置"
                      @update:model-value="selectPopupPosition"
                  />
                  <!-- 配色：琥珀/跟随系统/浅色/深色，与标题栏按钮、Ctrl+Alt+C 快捷键共用同一状态 -->
                  <UiDropdown
                      v-else-if="item.type === 'select'"
                      class="w-full"
                      align="end"
                      match-trigger-width
                      aria-label="配色"
                      panel-class="glass-card menu w-full rounded-2xl p-2"
                  >
                    <template #trigger="{ open }">
                      <button type="button" tabindex="-1" class="btn-soft flex w-full items-center justify-between rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink">
                        <span>{{ colorSchemeLabel }}</span>
                        <svg class="h-4 w-4 opacity-60 transition-transform duration-200" :class="open ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                    </template>
                    <ul class="menu p-2">
                      <li v-for="opt in colorSchemeOptions" :key="opt.value">
                        <button
                            type="button"
                            class="flex w-full items-center justify-between rounded-xl"
                            :class="scheme === opt.value ? 'text-gold' : ''"
                            @click="selectColorScheme(opt.value)"
                        >
                          <span>{{ opt.label }}</span>
                          <svg v-if="scheme === opt.value" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        </button>
                      </li>
                    </ul>
                  </UiDropdown>
                </div>
              </li>
            </ul>
          </div>

          <!-- 导航栏设置：tab 顺序与显示开关（剪贴板/设置强制保留；统计受解锁门槛控制） -->
          <div v-else-if="activeSetting.type === 'nav'" class="flex flex-col gap-4">
            <div class="glass-card rounded-2xl shadow-soft" data-nav-config-list>
              <TransitionGroup name="reorder-list" tag="ul">
                <li key="__header__" class="border-b border-accent p-4 pb-2 text-xs uppercase tracking-wide text-ink-faint">
                  导航栏图标 · 显示与排序（至少保留 剪贴板 / 设置）
                </li>
                <li
                    v-for="row in navRows"
                    :key="row.key"
                    class="nav-config-item flex items-center justify-between gap-4 border-b border-accent/50 p-4 last:border-b-0 transition-all duration-200 ease-soft"
                    :class="navDraggingKey === row.key ? 'bg-gold/10 opacity-50 scale-[0.98]' : ''"
                    :data-reorder-key="row.key"
                    @pointerdown="navReorder.pressStart(row.key, $event)"
                >
                <div class="flex items-center gap-3">
                  <svg class="h-4 w-4 shrink-0 text-ink-faint/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M8 9h.01M8 15h.01M16 9h.01M16 15h.01M12 9h.01M12 15h.01" />
                    <circle cx="8" cy="9" r="0.1" /><circle cx="8" cy="15" r="0.1" />
                    <circle cx="12" cy="9" r="0.1" /><circle cx="12" cy="15" r="0.1" />
                    <circle cx="16" cy="9" r="0.1" /><circle cx="16" cy="15" r="0.1" />
                  </svg>
                  <div class="flex flex-col">
                    <div class="flex items-center gap-1.5 text-ink" :class="{ 'opacity-50': !row.enabled || (row.gate && !statsUnlocked) }">
                      {{ row.name }}
                      <svg v-if="row.locked" class="h-3.5 w-3.5 text-ink-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="5" y="11" width="14" height="10" rx="2" />
                        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                      </svg>
                    </div>
                    <div v-if="row.gate && !statsUnlocked" class="text-xs text-ink-faint">
                      解锁条件：活跃使用 ≥ 7 天 且 累计粘贴 ≥ 1000 次
                    </div>
                    <div v-else-if="row.locked" class="text-xs text-ink-faint">内置项，不可关闭</div>
                  </div>
                </div>
                <!-- 右侧操作：内置项显示锁定图标；未解锁统计显示禁用开关；其余为可切换胶囊开关 -->
                <svg
                    v-if="row.locked"
                    class="h-4 w-4 text-ink-faint/70"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round"
                    v-tip="'内置项，不可关闭'"
                >
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
                <UiToggleSwitch
                    v-else
                    :model-value="row.enabled && !(row.gate && !statsUnlocked)"
                    :disabled="row.gate && !statsUnlocked"
                    tip-on="点击隐藏" tip-off="点击显示"
                    disabled-tip="未解锁，满足条件后可开启"
                    :label="row.name"
                    @change="onNavRowToggle(row)"
                />
              </li>
              </TransitionGroup>
            </div>
            <p class="text-xs text-ink-faint">
              按住图标（约 0.5 秒）后拖动即可调整导航栏顺序，松开自动保存；关闭图标后将从标题栏隐藏（内置的剪贴板与设置不可关闭）。「统计」达到解锁条件后自动出现。
            </p>
          </div>
        </div>
        </Transition>
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
