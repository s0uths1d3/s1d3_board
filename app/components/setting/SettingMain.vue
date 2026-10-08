<script lang="ts">
// 模块级：跨组件挂载保留选中的设置分类。设置页随 Tab 切换被卸载/重建，
// 组件内 ref 会重置为第一项，导致每次进入设置都先闪现第一组、再跳到上次分类。
let lastActiveSettingTitle: string | null = null;

// ===== 清空撤回窗口（模块级单例，独立于组件生命周期）=====
// 设置页随 Tab 切换被卸载/重建：撤回状态若放组件内，切走即触发 expireUndoWindow
// 把备份丢掉——用户「清空后切走再切回」就永远失去撤回机会。状态移到模块级：
// 切走仅隐藏 UI，倒计时继续，窗口内切回仍可撤回，超时照常 finalize 丢备份。
// （ref 复用下方 <script setup> 的 vue 导入：双 script 块合并为同一模块，重复 import 会冲突）
// （dev HMR 会重执行本模块重建状态，属开发期边缘情况，不影响生产行为）
const undoActive = ref(false);
// 3 分钟撤回窗口（原 5 秒过短且误触即丢）：倒计时以 mm:ss 显示
const undoRemaining = ref(180);
let undoCountdownTimer: ReturnType<typeof setInterval> | null = null;
let undoExpireTimer: ReturnType<typeof setTimeout> | null = null;
</script>

<script setup lang="ts">
import { ref, computed, onMounted, watch, onBeforeUnmount, nextTick } from 'vue';
import {
  shortcuts, updateShortcutKey, resetShortcut, resetAllShortcuts,
  toggleShortcutEnabled, setShortcutGroupEnabled, resetShortcutGroup, failedShortcutIds,
} from "~/src/commands/shortcuts/InitShortcuts";
import { formatShortcutForDisplay, parseKeyEvent } from "~/utils/shortcutFormat";
import { getOsTypeFromNavigator } from "~/utils/systemOS";
import dbService from '~/src/db/dbService';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { DEFAULT_IMAGE_CACHE_MB, DEFAULT_MAX_SAVE_COUNT, type ImageFileInfo } from '~/src/core/db/repositories/clipboardRepository';
import type { DataBundle } from '~/src/core/db/repositories/dataTransferRepository';
import { listAutoBackups, readAutoBackup } from '~/src/backup/autoBackup';
import type { ClipExtractor, ClipScheme } from '~/src/entities';
import type { SmartClipMode } from '~/src/smart-clip/types';
import { updateSmartClipConfig } from '~/src/smart-clip/smartClip';
import { ISLAND_API_DEFAULT_PORT, applyIslandApi, ensureIslandApiToken, generateIslandApiToken, lastIslandApiFailure } from '~/src/island/islandApi';
import { bus } from '~/src/core/events';
import { loadIslandWebhookConfig, saveIslandWebhookConfig, testIslandWebhook, validateWebhookUrl, type WebhookTarget } from '~/src/island/islandWebhook';
import {
  loadExtractors, persistExtractors, missingBuiltinExtractors,
  type Translator,
} from '~/src/smart-clip/extractors';
import { generateExtractorDraft, generateSchemeDraft } from '~/src/smart-clip/aiGenerate';
import { clampAnalysisMaxChars } from '~/src/smart-clip/analyzer';
import { AI_CUSTOM_TEMPLATE, loadAiApiKey, migrateAiApiKey, storeAiApiKey } from '~/src/smart-clip/aiClient';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { isTauri } from '~/utils/env';
import { useTooltipEnabled } from '~/composables/useTooltipEnabled';
import { useIslandEnabled, setIslandEnabled, useIslandTiming, ensureIslandTimingLoaded, setIslandDelayMs, setIslandDurationMs, notifyIsland, type IslandKind, ISLAND_DELAY_DEFAULT, ISLAND_DURATION_DEFAULT } from '~/composables/useCopyIsland';
import { usePopupPosition, setPopupPositionMode, type PopupPositionMode } from '~/composables/usePopupPosition';
import { useColorScheme, setColorScheme, COLOR_SCHEME_LABELS, COLOR_SCHEME_ORDER, type ColorSchemeMode } from '~/composables/useColorScheme';
import { useI18n, setLocaleMode, LOCALES, type LocaleMode } from '~/composables/useI18n';
import { briefAiError, parseAiError } from '~/utils/aiError';
import { useTodoSmartRemind, setTodoSmartRemindEnabled } from '~/composables/useTodoSmartRemind';
import { useTodoSystemNotify, setTodoSystemNotifyEnabled } from '~/composables/useTodoSystemNotify';
import { useTooltipWrap, setTooltipWrapEnabled } from '~/composables/useTooltipWrap';
import {
    usePrivacyPause, setPrivacyPaused,
    useSensitiveFilter, setSensitiveFilterEnabled,
} from '~/composables/usePrivacySettings';
import { useAutoHide, setAutoHideEnabled } from '~/composables/useAutoHide';
import { useSearchHighlight } from '~/composables/useSearchHighlight';
import { appUsageEnabled, setAppUsageEnabled } from '~/composables/useAppUsage';
import { navRows, reorderTab, persistNavConfig, setTabEnabled } from '~/composables/useTabs';
import { useLongPressReorder } from '~/composables/useLongPressReorder';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { writeText } from 'tauri-plugin-clipboard-api';
import appIcon from '~/assets/icon/icon.png';
import ShortcutRow from '~/components/setting/ShortcutRow.vue';
import HighlightText from '~/components/mainpage/HighlightText.vue';

const osType = ref('');

interface SettingItem {
  label: string;
  value: string | string[];
  type: 'input' | 'select' | 'checkbox' | 'action';
  /** 搜索结果专用：命中项的来源分组标题（正常渲染时无此字段，用于结果列表显示归属） */
  groupTitle?: string;
}

/** 子分组：顶层分组内的分节卡片（标题 + 该节设置项），控制左侧分类数量 */
interface SettingChildGroup {
  title: string;
  items: SettingItem[];
}

interface SettingGroup {
  title: string;
  type: string;
  items: SettingItem[];
  /** 子分组（有则渲染为多张分节卡片，items 直挂方式仅剩类型兼容默认值） */
  children?: SettingChildGroup[];
}

// 各设置项的响应式状态（直接承载值，并通过 watch 实时持久化，无需“应用”按钮）
const apiKey = ref('');
/** 系统凭据库不可用警示：API Key 降级为 KV 明文存储时置真（输入框下方常驻警示） */
const aiKeyPlaintext = ref(false);
const maxLimit = ref('');
/** 图片缓存磁盘上限（MB）：留空/无效时清理策略回落默认 256MB（DEFAULT_IMAGE_CACHE_MB） */
const imageLimit = ref('');
// ===== 配色：琥珀（当前暖米色）/ 跟随系统 / 浅色 / 深色，与标题栏按钮、配色快捷键（默认不绑定）共用同一状态 =====
const { scheme } = useColorScheme();
const colorSchemeOptions = computed(() => COLOR_SCHEME_ORDER.map(value => ({ value, label: t(`color_scheme.${value}`) })));
const colorSchemeLabel = computed(() => t(`color_scheme.${scheme.value}`));
async function selectColorScheme(value: ColorSchemeMode) {
  if (scheme.value === value) return;
  await setColorScheme(value);
  showHint(t('setting.general.color_scheme_saved', { name: t(`color_scheme.${value}`) }));
}
// ===== 语言：跟随系统 / 中文 / English（useI18n 统一管理，含首次系统探测与跨窗口同步）=====
const { localeMode, t } = useI18n();
const localeOptions = computed(() => [
  { value: 'system' as const, label: t('locale.system') },
  ...LOCALES.map((l) => ({ value: l.value, label: l.label })),
]);
const localeLabel = computed(() =>
  localeOptions.value.find((o) => o.value === localeMode.value)?.label ?? '',
);
async function selectLocale(value: LocaleMode) {
  if (localeMode.value === value) return;
  // 切语言走整页 reload：先把未落库的防抖输入写库，避免最后编辑的设置项被 reload 丢弃
  flushPendingWrites();
  await setLocaleMode(value);
  showHint(t('setting.general.locale_changed', { name: localeOptions.value.find(o => o.value === value)?.label ?? '' }));
}
/** 开机自启状态（系统级设置，使用 tauri autostart 插件，不存数据库） */
const autoStartEnabled = ref(false);
/** 初始化标志：onMounted 读取系统自启状态时跳过 watch 的 enable/disable 与提示逻辑 */
let initializingAutoStart = false;
/** 设置页即时反馈提示 → 灵动岛（屏幕顶部全局胶囊，替代窗口内 toast；默认成功态，失败/中性显式传 kind） */
const showHint = (msg: string, kind: IslandKind = 'success') => {
  notifyIsland({ kind, text: msg });
};
/** 是否开启悬停提示窗口（tooltip），与主窗口共享同一状态 */
const { tooltipEnabled } = useTooltipEnabled();
watch(tooltipEnabled, async (val) => {
  await dbService.setKeyValue('tooltip_enabled', val ? '1' : '0');
});

/** 灵动岛提示：复制/粘贴时屏幕顶部胶囊反馈（useCopyIsland 模块级 watch 负责关闭窗口收尾） */
const { islandEnabled } = useIslandEnabled();
async function onIslandToggle(val: boolean) {
  await setIslandEnabled(val);
  showHint(val ? t('setting.general.island_on') : t('setting.general.island_off'));
}

// ===== 灵动岛出现延迟 / 停留时长（自由输入毫秒值；未设置/非法输入回落默认，范围自动钳制） =====
const { islandDelayMs, islandDurationMs } = useIslandTiming();
const islandDelayInput = ref('');
const islandDurationInput = ref('');
// 异步加载落定后回填输入框（未设置过则显示默认值）
void ensureIslandTimingLoaded().then(() => {
  islandDelayInput.value = String(islandDelayMs.value);
  islandDurationInput.value = String(islandDurationMs.value);
});
// 实时保存：逐字符输入加 400ms 防抖，停顿后落库并钳制
watch(islandDelayInput, (val) => {
  debouncePersist('island_delay_ms', () => setIslandDelayMs(val.trim() === '' ? ISLAND_DELAY_DEFAULT : Number(val)));
});
watch(islandDurationInput, (val) => {
  debouncePersist('island_duration_ms', () => setIslandDurationMs(val.trim() === '' ? ISLAND_DURATION_DEFAULT : Number(val)));
});
/** 失焦保存：立即写入（不等防抖）并把输入框收敛为实际生效值（钳制/默认回填） */
async function saveIslandDelay() {
  const val = islandDelayInput.value.trim();
  await setIslandDelayMs(val === '' ? ISLAND_DELAY_DEFAULT : Number(val));
  islandDelayInput.value = String(islandDelayMs.value);
  showHint(t('setting.general.island_delay_saved'));
}
async function saveIslandDuration() {
  const val = islandDurationInput.value.trim();
  await setIslandDurationMs(val === '' ? ISLAND_DURATION_DEFAULT : Number(val));
  islandDurationInput.value = String(islandDurationMs.value);
  showHint(t('setting.general.island_duration_saved'));
}

// ===== 窗口弹出位置（快捷键唤出主窗口时的落点） =====
const { popupPositionMode } = usePopupPosition();/** 三个候选模式：光标处 / 上次打开位置 / 光标所在屏幕居中 */
const POPUP_POSITION_OPTIONS = computed<{ value: PopupPositionMode; label: string; tip: string }[]>(() => [
  { value: 'cursor', label: t('setting.general.popup_positions.cursor'), tip: t('setting.general.popup_positions.cursor_tip') },
  { value: 'last', label: t('setting.general.popup_positions.last'), tip: t('setting.general.popup_positions.last_tip') },
  { value: 'center', label: t('setting.general.popup_positions.center'), tip: t('setting.general.popup_positions.center_tip') },
]);
/** 切换弹出位置模式并持久化（UiSegmented 回传字符串值，此处收敛为模式类型） */
function selectPopupPosition(v: string) {
  const mode = v as PopupPositionMode;
  void setPopupPositionMode(mode);
  showHint(t('setting.general.popup_position_saved'));
}
/** 是否开启搜索高亮，与所有搜索框共享同一状态 */
const { searchHighlightEnabled } = useSearchHighlight();
/** 待办智能提醒（提前 30/10/5 分钟 + 自定义提醒）；关闭后仅保留到期时刻通知。
 *  必须走 setTodoSmartRemindEnabled 持久化：直接改共享 ref 不会写库，重启后设置回滚。 */
const { smartRemindEnabled } = useTodoSmartRemind();
async function onSmartRemindToggle(val: boolean) {
  await setTodoSmartRemindEnabled(val);
  showHint(val ? t('setting.general.smart_remind_on') : t('setting.general.smart_remind_off'));
}

/** 待办系统通知开关：仅控制提醒是否弹 OS 级系统通知（提示音/灵动岛不受影响）。
 *  必须走 setTodoSystemNotifyEnabled 持久化：直接改共享 ref 不会写库，重启后设置回滚。 */
const { todoSystemNotifyEnabled } = useTodoSystemNotify();
async function onTodoSystemNotifyToggle(val: boolean) {
  await setTodoSystemNotifyEnabled(val);
  showHint(val ? t('setting.general.todo_notify_on') : t('setting.general.todo_notify_off'));
}

/** 应用使用时长记录开关：默认关闭（隐私）；切换失败时 composable 已回滚 UI，这里提示重试 */
async function onAppUsageToggle(val: boolean) {
  try {
    await setAppUsageEnabled(val);
    showHint(val ? t('setting.general.app_usage_on') : t('setting.general.app_usage_off'));
  } catch {
    showHint(t('setting.general.app_usage_failed'), 'error');
  }
}

/** 失焦自动隐藏开关：主窗口失焦后自动收起到托盘（app.vue 失焦钩子读取同一状态源） */
const { autoHideEnabled } = useAutoHide();
async function onAutoHideToggle(val: boolean) {
  await setAutoHideEnabled(val);
  showHint(val ? t('setting.general.auto_hide_on') : t('setting.general.auto_hide_off'));
}

/** 隐私模式（暂停记录）开关：开启后监听管道不处理任何剪贴板更新（托盘菜单同款开关，共用状态源） */
const { privacyPaused } = usePrivacyPause();
async function onPrivacyPauseToggle(val: boolean) {
  await setPrivacyPaused(val);
  showHint(val ? t('setting.general.privacy_pause_on') : t('setting.general.privacy_pause_off'));
}

/** 敏感内容防护开关：命中卡号/验证码/密码形态的文本不落库（检测规则见 src/privacy/sensitive.ts） */
const { sensitiveFilterEnabled } = useSensitiveFilter();
async function onSensitiveFilterToggle(val: boolean) {
  await setSensitiveFilterEnabled(val);
  showHint(val ? t('setting.general.sensitive_on') : t('setting.general.sensitive_off'));
}
// 粘贴后恢复原剪贴板：粘贴完成约 1 秒后把粘贴前内容写回（默认关闭；pasteUtil 消费此开关）
const pasteRestoreEnabled = ref(false);
async function onPasteRestoreToggle(val: boolean) {
  await dbService.setKeyValue('paste_restore_clipboard', val ? '1' : '0');
  showHint(val ? t('setting.general.paste_restore_on') : t('setting.general.paste_restore_off'));
}
// 剪贴板预览（tooltip）换行开关：默认关闭（不折行，超宽横向滚动），共享 composable 单例状态
const { tooltipWrapEnabled } = useTooltipWrap();
async function onTooltipWrapToggle(val: boolean) {
  await setTooltipWrapEnabled(val);
  showHint(val ? t('setting.general.tooltip_wrap_on') : t('setting.general.tooltip_wrap_off'));
}
watch(searchHighlightEnabled, async (val) => {
  await dbService.setKeyValue('search_highlight_enabled', val ? '1' : '0');
});
// 实时保存：文本输入加 400ms 防抖——API key / 最大数量是逐字符输入，
// 每键一次 INSERT...ON CONFLICT 写库纯属浪费；停止输入后统一落库一次。
// Map 存 { timer, write }：卸载/切语言时能取出 write 闭包立即执行（flush），
// 只存计时器的话 flush 时只能丢弃，最后一段输入就丢了
const pendingWrites = new Map<string, { timer: ReturnType<typeof setTimeout>; write: () => Promise<void> }>();
function debouncePersist(key: string, write: () => Promise<void>, delay = 400) {
  const pending = pendingWrites.get(key);
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    void write();
  }, delay);
  pendingWrites.set(key, { timer, write });
}
/** 立即执行所有未落库的防抖写入（fire-and-forget）：组件卸载 / 切语言 reload 前调用 */
function flushPendingWrites() {
  for (const { timer, write } of pendingWrites.values()) {
    clearTimeout(timer);
    void write().catch(() => {});
  }
  pendingWrites.clear();
}
onBeforeUnmount(() => {
  // 卸载时把未落库的输入立即写库（此前实现是 clearTimeout 丢弃，与注释不符导致丢输入）
  flushPendingWrites();
});
watch(apiKey, async (val) => {
  // API Key 加密存储（系统凭据库）：凭据库不可用时降级 KV 明文并警示
  debouncePersist('api_key', async () => {
    if ((await storeAiApiKey(val ?? '')) === 'plaintext') {
      aiKeyPlaintext.value = true;
      showHint(t('setting.general.api_key_plaintext_fallback'), 'error');
    } else {
      aiKeyPlaintext.value = false;
    }
  });
});
watch(maxLimit, async (val) => {
  debouncePersist('max_save_count', () => persistClampedCount('max_save_count', maxLimit, DEFAULT_MAX_SAVE_COUNT));
});
watch(imageLimit, async (val) => {
  debouncePersist('image_cache_max_mb', () => persistClampedCount('image_cache_max_mb', imageLimit, DEFAULT_IMAGE_CACHE_MB));
});

/** 数量/上限类输入写库前钳制：空 / 非数字 / ≤0 一律落默认值并回写输入框，
 *  不再原样存脏值（此前读取侧会静默回退，但输入框回显的仍是无效原始值，用户无从得知） */
async function persistClampedCount(key: string, model: { value: string }, fallback: number): Promise<void> {
  const parsed = parseInt(model.value ?? '', 10);
  const valid = Number.isFinite(parsed) && parsed > 0 ? String(parsed) : String(fallback);
  await dbService.setKeyValue(key, valid);
  if (model.value !== valid) model.value = valid; // 回显实际生效值（同值不重触发 watch）
}

// ===== 图片缓存占用可视化 + 手动清理（上次做的磁盘清理策略缺闭环：填了上限但看不到实际占用）=====
const imageCacheUsedBytes = ref<number | null>(null);
const imageCacheCleaning = ref(false);
/** 操作区（立即清理/打开缓存）折叠态：默认折叠，避免按钮挤出设置面板右缘 */
const imageCacheOpsOpen = ref(false);

/** 上限标签：未设置/无效时按默认 256MB 显示（与仓储清理口径一致） */
const imageCacheLimitLabel = computed(() => {
  const parsed = parseInt(imageLimit.value ?? '', 10);
  return String(Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IMAGE_CACHE_MB);
});

/** 占用进度百分比（上限钳制 100%；未知时 0） */
const imageCachePercent = computed(() => {
  if (imageCacheUsedBytes.value === null) return 0;
  const limitBytes = Number(imageCacheLimitLabel.value) * 1024 * 1024;
  if (limitBytes <= 0) return 0;
  return Math.min(100, (imageCacheUsedBytes.value / limitBytes) * 100);
});

const imageCacheUsageText = computed(() => {
  const limit = imageCacheLimitLabel.value;
  if (imageCacheUsedBytes.value === null) return t('setting.general.image_cache_usage_unknown', { limit });
  const mb = imageCacheUsedBytes.value / 1024 / 1024;
  const used = mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
  return t('setting.general.image_cache_usage', { used, limit });
});

/** 查询磁盘图片目录实际占用（Rust list_clipboard_image_files 返回文件名+字节数） */
async function refreshImageCacheUsage(): Promise<void> {
  try {
    const files = await invoke<ImageFileInfo[]>('list_clipboard_image_files');
    imageCacheUsedBytes.value = (files ?? []).reduce((s, f) => s + (f.size ?? 0), 0);
  } catch {
    imageCacheUsedBytes.value = null;
  }
}

/** 打开缓存：系统资源管理器查看图片缓存目录（%APPDATA%/S1d3Board/images，路径由 Rust 命令解析） */
async function openImageCacheFolder(): Promise<void> {
  try {
    await invoke('open_image_cache_dir');
  } catch (e) {
    console.error('打开图片缓存目录失败:', e);
    showHint(t('setting.general.image_cache_open_failed'), 'error');
  }
}

/** 立即清理（与清空数据库同款交互）：两步确认 → 清理（只删行，文件延迟）→ 5 秒撤回窗口 → 真删文件 */
const showCacheCleanConfirm = ref(false);
const cacheMsg = ref('');
// ===== 5 秒撤回窗口：清理只删条目行（备份到 image_cleanup_backup），文件待窗口结束才删除，期间可整体恢复 =====
const cacheUndoActive = ref(false);
const cacheUndoRemaining = ref(5);
const cacheFreedMb = ref('0');
let cacheUndoCountdownTimer: ReturnType<typeof setInterval> | null = null;
let cacheUndoExpireTimer: ReturnType<typeof setTimeout> | null = null;

const stopCacheUndoTimers = () => {
  if (cacheUndoCountdownTimer) {
    clearInterval(cacheUndoCountdownTimer);
    cacheUndoCountdownTimer = null;
  }
  if (cacheUndoExpireTimer) {
    clearTimeout(cacheUndoExpireTimer);
    cacheUndoExpireTimer = null;
  }
};

/** 窗口自然结束：真正删除待删文件 + 丢弃备份（失败无碍：下次启动迁移兜底清理遗留备份） */
async function expireCacheUndoWindow() {
  try {
    await dbService.finalizeImageCleanup();
  } catch { /* 下次启动兜底 */ }
}

/** 撤回清理：恢复被淘汰的条目、丢弃待删文件清单（文件从未离开原位，无需恢复文件） */
async function undoImageCleanup() {
  if (!cacheUndoActive.value) return;
  stopCacheUndoTimers();
  cacheUndoActive.value = false;
  try {
    await dbService.undoImageCleanup();
    cacheMsg.value = t('setting.general.image_cache_undo_done');
    await refreshImageCacheUsage();
  } catch (e) {
    console.error('撤回图片缓存清理失败:', e);
    cacheMsg.value = t('setting.general.image_cache_failed');
  }
}

/** 确认清理（两步确认后）：复用启动/新图入库同款清理实现，完成后按结果差异化反馈 */
async function confirmCleanImageCache(): Promise<void> {
  if (imageCacheCleaning.value) return;
  imageCacheCleaning.value = true;
  showCacheCleanConfirm.value = false;
  cacheMsg.value = '';
  try {
    // 连续清理：终结上一轮未过期的撤回窗口（本轮清理会覆盖备份表与待删清单，语义与清空数据库一致）
    stopCacheUndoTimers();
    cacheUndoActive.value = false;
    const result = await dbService.cleanupImageStorage();
    await refreshImageCacheUsage();
    if (result.failed) {
      showHint(t('setting.general.image_cache_failed'), 'error');
      return;
    }
    if (result.freedBytes <= 0) {
      // 无孤儿且未超上限：清理合法地无事可做——带占用/上限数字说明原因，避免「按钮没效果」的困惑
      showHint(t('setting.general.image_cache_clean_noop', { usage: imageCacheUsageText.value }));
      return;
    }
    // 开启 5 秒撤回窗口：文件尚未删除，倒计时归零后统一删除并丢弃备份
    cacheFreedMb.value = (result.freedBytes / 1024 / 1024).toFixed(1);
    cacheUndoRemaining.value = 5;
    cacheUndoActive.value = true;
    cacheUndoCountdownTimer = setInterval(() => {
      cacheUndoRemaining.value = Math.max(0, cacheUndoRemaining.value - 1);
    }, 1000);
    cacheUndoExpireTimer = setTimeout(() => {
      void expireCacheUndoWindow().then(() => {
        cacheUndoActive.value = false;
        cacheMsg.value = t('setting.general.image_cache_clean_done');
      });
    }, 5000);
  } catch {
    showHint(t('setting.general.image_cache_failed'), 'error');
  } finally {
    imageCacheCleaning.value = false;
  }
}

// ===== AI 通道配置（设计文档 §4.2）：提供商 / 地址 / 模型 + 连接测试 =====
// custom = 自定义 JSON 模板（path/headers/body/responsePath，支持 {{model}}/{{apiKey}}/{{system}}/{{content}} 占位符），
// 模板内容与 SSE 流式解析在 Rust 侧（ai.rs），前端只做编辑、校验与落库
type AiProviderKind = 'openai-compat' | 'anthropic' | 'custom';
const aiProvider = ref<AiProviderKind>('openai-compat');
const aiBaseUrl = ref('');
const aiModel = ref('');
const aiCustomConfig = ref('');
const aiCustomError = ref('');
const aiTestState = ref<'idle' | 'testing' | 'ok' | 'fail'>('idle');
const aiTestLatency = ref(0);
/** 时延分档着色：≤300ms 绿（畅通）/ ≤1000ms 金（一般）/ 更高红（偏慢） */
const aiTestLatencyClass = computed(() => {
  if (aiTestState.value !== 'ok') return '';
  return aiTestLatency.value <= 300 ? 'text-success'
    : aiTestLatency.value <= 1000 ? 'text-gold'
      : 'text-danger';
});
const aiTestError = ref('');
const AI_PROVIDER_OPTIONS = computed(() => [
  { value: 'openai-compat' as const, label: t('setting.general.ai_provider_openai') },
  { value: 'anthropic' as const, label: t('setting.general.ai_provider_anthropic') },
  { value: 'custom' as const, label: t('setting.general.ai_provider_custom') },
]);
function selectAiProvider(v: string) {
  aiProvider.value = v as AiProviderKind;
  const opt = AI_PROVIDER_OPTIONS.value.find(o => o.value === v);
  showHint(t('setting.general.ai_provider_saved', { name: opt?.label ?? v }));
}
/** 宽控件设置项：控件需要整行宽度（纵向布局，标签在上）——AI 提供商（分段器 + 自定义 JSON 编辑器） */
function isWideSettingItem(item: { label: string }): boolean {
  return item.label === 'setting.general.ai_provider';
}
watch(aiProvider, (val) => {
  debouncePersist('ai_provider', () => dbService.setKeyValue('ai_provider', val));
});
watch(aiBaseUrl, (val) => {
  debouncePersist('ai_base_url', () => dbService.setKeyValue('ai_base_url', val ?? ''));
});
watch(aiModel, (val) => {
  debouncePersist('ai_model', () => dbService.setKeyValue('ai_model', val ?? ''));
});

// ===== AI 分析长度上限（.docs/smart-clip-ai-analysis.md）：钳制 100–10000，非法回落 1000 =====
const aiAnalysisMax = ref('');
watch(aiAnalysisMax, (val) => {
  debouncePersist('ai_analysis_max_chars', () =>
    dbService.setKeyValue('ai_analysis_max_chars', String(clampAnalysisMaxChars(val))));
});

// ===== 自定义 JSON 模板编辑（仅 provider = custom 时显示） =====
/** 结构校验：JSON 可解析 + body 为对象 + headers 键值均为字符串（path/提取路径可省略有默认） */
function validateCustomConfig(text: string): string | null {
  let cfg: unknown;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    return t('setting.general.ai_custom_invalid', { error: String(e) });
  }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
    return t('setting.general.ai_custom_need_object');
  }
  const body = (cfg as { body?: unknown }).body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return t('setting.general.ai_custom_need_body');
  }
  const headers = (cfg as { headers?: unknown }).headers;
  if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) {
    return t('setting.general.ai_custom_need_headers');
  }
  return null;
}
watch(aiCustomConfig, (val) => {
  // 空值视为尚未配置（不报错）；非法 JSON 不落库，避免把坏模板存进 KV
  const text = val.trim();
  if (!text) {
    aiCustomError.value = '';
    debouncePersist('ai_custom_config', () => dbService.setKeyValue('ai_custom_config', ''));
    return;
  }
  const err = validateCustomConfig(text);
  aiCustomError.value = err ?? '';
  if (err) return;
  debouncePersist('ai_custom_config', () => dbService.setKeyValue('ai_custom_config', text));
});
/** 套用默认模板（OpenAI 形状最小可用配置，占位符说明见模板字段） */
function applyCustomTemplate() {
  aiCustomConfig.value = AI_CUSTOM_TEMPLATE;
  showHint(t('setting.general.ai_custom_template_applied'));
}

const aiTestParsed = computed(() => parseAiError(aiTestError.value));

/** 连接测试：invoke Rust ai_test_connection（请求细节在 Rust 侧，Key 不进 fetch） */
async function testAiConnection(): Promise<void> {
  if (aiTestState.value === 'testing') return;
  const { key } = await loadAiApiKey();
  if (!key) {
    showHint(t('setting.general.api_key_missing'), 'error');
    return;
  }
  // custom 模式下模板非法或为空时直接拦截，不打无效请求
  const customText = aiCustomConfig.value.trim();
  if (aiProvider.value === 'custom') {
    if (!customText) {
      showHint(t('setting.general.ai_custom_missing'), 'error');
      return;
    }
    const err = validateCustomConfig(customText);
    if (err) {
      showHint(err, 'error');
      return;
    }
  }
  aiTestState.value = 'testing';
  try {
    const res = await invoke<{ ok: boolean; latency_ms: number; error?: string }>(
      'ai_test_connection',
      {
        provider: aiProvider.value,
        baseUrl: aiBaseUrl.value,
        apiKey: key,
        model: aiModel.value,
        customConfig: aiProvider.value === 'custom' ? customText : undefined,
      },
    );
    aiTestLatency.value = res.latency_ms;
    aiTestState.value = res.ok ? 'ok' : 'fail';
    aiTestError.value = res.error ?? '';
    showHint(res.ok
      ? t('setting.general.ai_test_ok', { ms: res.latency_ms })
      : t('setting.general.ai_test_fail', { error: briefAiError(res.error ?? '') }), res.ok ? 'success' : 'error');
  } catch (e) {
    aiTestState.value = 'fail';
    aiTestError.value = String(e);
    showHint(t('setting.general.ai_test_fail', { error: briefAiError(String(e)) }), 'error');
  }
}

// ===== 智能剪贴板（设计文档 §4.3/§4.5）：模式 / 方案 / 提取器 / 开放 API =====
// 概念：提取器 = 单个内容的提取单元；方案 = 多个提取器的集成体（含独立标题与描述）。
// 已移除：原「分词规则」（clip_rules）与「AI 加工默认指令」——拆分能力由提取器承担，
// AI 指令写在 AI 提取器里，不再保留并列的全局规则/指令配置。
// ===== 方案：多条可 CRUD；一条「默认方案」作为开启态的叠加加工层 =====
const DEFAULT_SCHEME_ID = 'scheme_default';

const smartMode = ref<SmartClipMode>('on');
const schemes = ref<ClipScheme[]>([]);
const extractors = ref<ClipExtractor[]>([]);
const defaultSchemeId = ref('');
/** AI 结果冷却窗口（秒）：同内容在此时间内不重复触发 AI 生成（0 = 每次重新生成） */
const aiCacheWindow = ref('300');
watch(aiCacheWindow, (val) => {
  const n = Math.max(0, Math.floor(Number(val) || 0));
  // 防抖落库 + 提示：逐字符输入不打扰，停顿后统一保存并弹岛
  debouncePersist('ai_result_window', async () => {
    await dbService.setKeyValue('ai_result_window', String(n));
    showHint(t('smart.ai_cache_window_saved'));
  });
});

const SMART_MODE_OPTIONS = computed(() => [
  { value: 'off' as const, label: t('smart.mode_off') },
  { value: 'on' as const, label: t('smart.mode_on') },
]);
function selectSmartMode(v: string) {
  smartMode.value = v as SmartClipMode;
  showHint(t('smart.mode_switched', { name: t(`smart.mode_${v}`) }));
}
/** 提取器方式：正则 / 分隔符 / AI 指令 */
const EXTRACTOR_METHOD_OPTIONS = computed(() => [
  { value: 'regex' as const, label: t('smart.method_regex') },
  { value: 'separator' as const, label: t('smart.method_separator') },
  { value: 'ai' as const, label: t('smart.method_ai') },
]);

/** 把当前配置快照推送给处理层（smartClip 的 mode/scheme/extractors 缓存） */
function refreshSmartClipConfig(): void {
  const scheme = schemes.value.find((x) => x.id === defaultSchemeId.value && x.enabled === 1) ?? null;
  updateSmartClipConfig({ mode: smartMode.value, scheme, extractors: extractors.value });
}

// ===== 卡片编辑态：默认折叠（只显示标题 + 描述），点「编辑」才展开编辑区 =====
const editingSchemeId = ref<string | null>(null);
const editingExtractorId = ref<string | null>(null);

/** 折叠态的一行摘要：提取器 = 描述（无则表达式首行） */
function firstLine(text: string): string {
    return text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
}
function extractorSummary(x: ClipExtractor): string {
    return x.desc.trim() || firstLine(x.expression) || '-';
}
/** 方案折叠态摘要：描述 → 成员名（空成员 = 全部提取器） */
function schemeSummary(s: ClipScheme): string {
  if (s.description.trim()) return s.description;
  if ((s.members ?? []).length === 0) return t('smart.scheme_members_auto');
  return s.members.map((id) => extractorName(id)).join(' + ');
}
/** 提取器 id → 名称（方案成员展示用；已删除的成员显示占位） */
function extractorName(id: string): string {
  return extractors.value.find((x) => x.id === id)?.name ?? t('smart.member_missing');
}

// ===== 方案：可自由 CRUD；一条「默认方案」作为开启态的叠加加工层 =====
/**
 * 方案对账（每次进入设置页执行）：
 * - 清理已下线的旧内置方案行（历史 seed 产物）；
 * - 一条方案都没有时自动创建「默认方案」（保证叠加加工层始终可用）；
 * - 默认方案指向失效（被删）时回落到第一条。
 */
const LEGACY_SCHEME_IDS = ['scheme_netdisk', 'scheme_url_email', 'scheme_ai_netdisk', 'scheme_ai_summarize'];

async function ensureSchemes(): Promise<void> {
  for (const id of LEGACY_SCHEME_IDS) {
    if (schemes.value.some((x) => x.id === id)) await dbService.deleteClipScheme(id);
  }
  schemes.value = schemes.value.filter((x) => !LEGACY_SCHEME_IDS.includes(x.id));
  if (schemes.value.length === 0) {
    await dbService.saveClipScheme({
      id: DEFAULT_SCHEME_ID,
      title: t('smart.scheme_title_default'),
      description: t('smart.scheme_desc_default'),
      members: [],
      body: '',
      enabled: 1,
    });
  }
  schemes.value = await dbService.fetchClipSchemes();
  if (!schemes.value.some((x) => x.id === defaultSchemeId.value)) {
    defaultSchemeId.value = schemes.value[0]?.id ?? '';
    await dbService.setKeyValue('smart_default_scheme_id', defaultSchemeId.value);
  }
}

function addScheme(): void {
  const scheme: ClipScheme = {
    id: crypto.randomUUID(),
    title: t('smart.new_scheme'),
    description: '',
    members: [],
    body: '',
    enabled: 1,
  };
  schemes.value.unshift(scheme);
  editingSchemeId.value = scheme.id;
  void dbService.saveClipScheme(scheme);
  refreshSmartClipConfig();
  showHint(t('smart.scheme_added'));
}

/** 方案落库：标题/描述/成员/排版/启用任一改动都即时持久化 */
function saveScheme(scheme: ClipScheme): void {
  if (!scheme.title.trim()) scheme.title = t('smart.new_scheme');
  void dbService.saveClipScheme(scheme);
  refreshSmartClipConfig();
  showHint(t('smart.scheme_saved'));
}

async function removeScheme(scheme: ClipScheme): Promise<void> {
  schemes.value = schemes.value.filter((x) => x.id !== scheme.id);
  if (editingSchemeId.value === scheme.id) editingSchemeId.value = null;
  await dbService.deleteClipScheme(scheme.id);
  // 删除的是默认方案：回落到第一条；一条不剩则重建默认方案
  if (defaultSchemeId.value === scheme.id) {
    if (schemes.value.length === 0) {
      await dbService.saveClipScheme({
        id: DEFAULT_SCHEME_ID,
        title: t('smart.scheme_title_default'),
        description: t('smart.scheme_desc_default'),
        members: [],
        body: '',
        enabled: 1,
      });
    }
    defaultSchemeId.value = schemes.value[0]?.id ?? DEFAULT_SCHEME_ID;
    await dbService.setKeyValue('smart_default_scheme_id', defaultSchemeId.value);
  }
  refreshSmartClipConfig();
  showHint(t('smart.scheme_deleted', { name: scheme.title }));
}

/** 设为/取消默认方案（默认方案 = 开启态实际执行的叠加加工层） */
function toggleDefaultScheme(s: ClipScheme): void {
  const next = defaultSchemeId.value === s.id ? '' : s.id;
  defaultSchemeId.value = next;
  void dbService.setKeyValue('smart_default_scheme_id', next);
  refreshSmartClipConfig();
  showHint(next ? t('smart.default_scheme_set', { name: s.title }) : t('smart.default_scheme_cleared'));
}

/** 成员芯片移除：移除后为空则回到「自动接入全部提取器」 */
function removeMember(scheme: ClipScheme, id: string): void {
  scheme.members = (scheme.members ?? []).filter((x) => x !== id);
  saveScheme(scheme);
  showHint(t('smart.scheme_member_removed', { name: extractorName(id) }));
}

/** 重置成员：清空指定子集，回到声明式的「全部提取器自动接入」 */
function resetMembers(scheme: ClipScheme): void {
  scheme.members = [];
  saveScheme(scheme);
  showHint(t('smart.scheme_members_auto'));
}

/** AI 生成专属方案：按描述生成标题/描述，并从已有提取器中挑选成员组合 */
const addingAiScheme = ref(false);
const aiSchemeDesc = ref('');
const generatingScheme = ref(false);
async function generateSchemeByAi(): Promise<void> {
  const desc = aiSchemeDesc.value.trim();
  if (!desc || generatingScheme.value) return;
  generatingScheme.value = true;
  try {
    const draft = await generateSchemeDraft(desc, extractors.value);
    const scheme: ClipScheme = {
      id: crypto.randomUUID(),
      title: draft.title,
      description: draft.description,
      members: draft.members,
      body: '',
      enabled: 1,
    };
    schemes.value.unshift(scheme);
    await dbService.saveClipScheme(scheme);
    aiSchemeDesc.value = '';
    addingAiScheme.value = false;
    editingSchemeId.value = scheme.id;
    refreshSmartClipConfig();
    showHint(t('smart.ai_generate_scheme_done', { name: scheme.title }));
  } catch (e) {
    showHint(t('smart.ai_generate_failed', { error: String(e) }), 'error');
  } finally {
    generatingScheme.value = false;
  }
}

// ===== 提取器：单个内容的提取单元，可自由 CRUD（内置项同样可改可删，可一键恢复） =====
// 长按拖拽排序（与导航配置/设置分类同一套交互）：列表顺序 = 方案执行顺序
const extractorDraggingKey = ref<string | null>(null);
const extractorReorder = useLongPressReorder({
  container: '[data-extractor-list]',
  items: '.extractor-item',
  axis: 'y',
  onReorder: (from, to) => {
    const a = extractors.value.findIndex((x) => x.id === from);
    const b = extractors.value.findIndex((x) => x.id === to);
    if (a < 0 || b < 0) return;
    const list = [...extractors.value];
    const [moved] = list.splice(a, 1);
    list.splice(b, 0, moved!);
    extractors.value = list;
  },
  onDrop: () => {
    void persistExtractors(extractors.value);
    refreshSmartClipConfig();
  },
  onStateChange: (k) => { extractorDraggingKey.value = k; },
});

/** 行 pointerdown：仅从非交互元素启动长按拖拽（输入框/按钮保持原生行为） */
function onExtractorPointerDown(x: ClipExtractor, e: PointerEvent): void {
  const target = e.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, button')) return;
  extractorReorder.pressStart(x.id, e);
}

/** 行点击：展开/收起编辑；拖拽结束时的点击被抑制，避免误展开 */
function onExtractorRowClick(x: ClipExtractor): void {
  if (extractorReorder.consumeDragged()) return;
  editingExtractorId.value = editingExtractorId.value === x.id ? null : x.id;
}

function saveExtractor(x: ClipExtractor): void {
  if (!x.name.trim()) x.name = t('smart.new_extractor');
  void persistExtractors(extractors.value);
  refreshSmartClipConfig();
  showHint(t('smart.extractor_saved'));
}

/**
 * 新增提取器面板：分隔符 / 正则 / AI 指令**三合一**。
 * 三者的输入草稿相互独立（draftSeparator / draftRegex / draftAi）——切换方式不会
 * 覆盖已填内容，切回来仍在；提交时只取当前方式对应的那份草稿。
 */
const addingExtractor = ref(false);
const newExtractorName = ref('');
const newExtractorDesc = ref('');
const newExtractorMethod = ref<ClipExtractor['method']>('regex');
const draftSeparator = ref('');
const draftRegex = ref('');
const draftAi = ref('');

function currentDraft(): string {
    if (newExtractorMethod.value === 'separator') return draftSeparator.value;
    if (newExtractorMethod.value === 'ai') return draftAi.value;
    return draftRegex.value;
}

/** AI 生成：用一句描述生成提取器配置并回填表单（不直接落库，用户确认后再添加） */
const aiExtractorDesc = ref('');
const generatingExtractor = ref(false);
async function generateExtractorByAi(): Promise<void> {
  const desc = aiExtractorDesc.value.trim();
  if (!desc || generatingExtractor.value) return;
  generatingExtractor.value = true;
  try {
    const draft = await generateExtractorDraft(desc);
    newExtractorName.value = draft.name;
    newExtractorDesc.value = draft.desc;
    newExtractorMethod.value = draft.method;
    if (draft.method === 'separator') draftSeparator.value = draft.expression;
    else if (draft.method === 'ai') draftAi.value = draft.expression;
    else draftRegex.value = draft.expression;
    aiExtractorDesc.value = '';
    addingExtractor.value = true;
    showHint(t('smart.ai_generate_done'));
  } catch (e) {
    showHint(t('smart.ai_generate_failed', { error: String(e) }), 'error');
  } finally {
    generatingExtractor.value = false;
  }
}

/** 清空新增面板全部草稿（提交成功 / 取消共用，防旧内容残留到下次打开） */
function resetExtractorDrafts(): void {
    newExtractorName.value = '';
    newExtractorDesc.value = '';
    aiExtractorDesc.value = '';
    draftSeparator.value = '';
    draftRegex.value = '';
    draftAi.value = '';
}

function submitNewExtractor(): void {
    const expression = currentDraft().trim();
    if (!expression) return;
    const x: ClipExtractor = {
        id: crypto.randomUUID(),
        name: newExtractorName.value.trim() || t('smart.new_extractor'),
        desc: newExtractorDesc.value.trim(),
        method: newExtractorMethod.value,
        expression,
        sample: '',
        builtin: 0,
    };
    // 追加到末尾：列表顺序即方案执行顺序，新增提取器即声明式接入
    extractors.value.push(x);
    void persistExtractors(extractors.value);
    refreshSmartClipConfig();
    // 清空草稿、收起面板，并让新建项直接进入编辑态以便补描述/示例
    resetExtractorDrafts();
    addingExtractor.value = false;
    editingExtractorId.value = x.id;
    showHint(t('smart.extractor_added', { name: x.name }));
}

async function removeExtractor(x: ClipExtractor): Promise<void> {
  extractors.value = extractors.value.filter((e) => e.id !== x.id);
  if (editingExtractorId.value === x.id) editingExtractorId.value = null;
  await persistExtractors(extractors.value);
  refreshSmartClipConfig();
  showHint(t('smart.extractor_removed', { name: x.name }));
}

/** 提取器列表顺序 = 方案执行顺序：上移/下移并即时落库 */
async function moveExtractor(index: number, delta: number): Promise<void> {
  const list = [...extractors.value];
  const j = index + delta;
  if (j < 0 || j >= list.length) return;
  const a = list[index]!;
  list[index] = list[j]!;
  list[j] = a;
  extractors.value = list;
  await persistExtractors(list);
  refreshSmartClipConfig();
  showHint(t('smart.extractors_reordered'));
}

/** 恢复内置：只补齐被删掉的内置项（按 id 判定），已存在或被改过的保持原样 */
async function restoreExtractors(): Promise<void> {
  const missing = missingBuiltinExtractors(extractors.value, t as Translator);
  if (missing.length === 0) {
    showHint(t('smart.extractors_restore_none'), 'info');
    return;
  }
  extractors.value = [...extractors.value, ...missing];
  await persistExtractors(extractors.value);
  refreshSmartClipConfig();
  showHint(t('smart.extractors_restored', { count: String(missing.length) }));
}

// ===== 灵动岛 API（第三方应用集成）：开关/端口/令牌任一变化即持久化 + 应用（非法端口不应用，避免打字过程误触发） =====
const islandApiEnabled = ref(false);
const islandApiPort = ref(String(ISLAND_API_DEFAULT_PORT));
const islandApiToken = ref('');
// 恢复填充期间跳过 watch（否则加载赋值会以空值覆盖持久化并重复 apply；服务恢复由 app.vue 的 restoreIslandApiSetting 负责）
const islandApiLoading = ref(true);
// API 启动失败展示（端口占用等）：Rust 事件 → 失败监听 → 总线 → 此处内联展示；
// lastIslandApiFailure 进程内记忆用于挂载回填（启动期失败发生在设置页打开前），成功应用后清除
const islandApiError = ref('');
let unsubIslandApiFailure: (() => void) | null = null;
onMounted(() => {
  unsubIslandApiFailure = bus.on('island-api:failed', (reason) => { islandApiError.value = reason; });
});
onBeforeUnmount(() => { unsubIslandApiFailure?.(); });
watch([islandApiEnabled, islandApiPort, islandApiToken], async ([en, p, tk]) => {
  if (islandApiLoading.value) return;
  const portNum = Number(p);
  // 先持久化再应用：重启后 restoreIslandApiSetting 依此恢复服务
  await dbService.setKeyValue('island_api_enabled', en ? '1' : '0');
  if (portNum >= 1 && portNum <= 65535) await dbService.setKeyValue('island_api_port', String(portNum));
  await dbService.setKeyValue('island_api_token', tk);
  if (!en) {
    await applyIslandApi(false, portNum || ISLAND_API_DEFAULT_PORT, tk);
    islandApiError.value = '';
    return;
  }
  if (!portNum || portNum < 1 || portNum > 65535) return;
  await applyIslandApi(true, portNum, tk);
  islandApiError.value = '';
});
// 开关切换提示（端口/令牌输入过程不弹提示，避免干扰）；恢复填充期间跳过——
// 否则每次进入设置页都会把 ref 从初始 false 填到存储值，误触发「已开启」提示
watch(islandApiEnabled, (en) => {
  if (islandApiLoading.value) return;
  showHint(t(en ? 'island_api.on' : 'island_api.off'));
});
// 重新生成令牌：赋值触发上方 watch → 持久化并重启服务（SSE 客户端随之断开，需换新令牌重连）
async function regenerateIslandApiToken() {
  islandApiToken.value = generateIslandApiToken();
  showHint(t('island_api.regenerated'));
}
async function copyIslandApiToken() {
  try {
    await navigator.clipboard.writeText(islandApiToken.value);
    showHint(t('island_api.copied'));
  } catch {
    showHint(t('island_api.copy_fail'), 'error');
  }
}

// ===== 灵动岛 Webhook 出站推送：URL 列表任一变化即持久化 + 下发 Rust（deep watch 覆盖行内编辑） =====
const webhookEnabled = ref(false);
const webhookTargets = ref<WebhookTarget[]>([]);
const webhookTesting = ref(false);
// 恢复填充门控：进入设置页时把 ref 填到存储值不应触发持久化下发与「已开启」提示
const webhookLoading = ref(true);
// 卡片折叠态（标题行点击切换，开关独立于折叠不受影响）；默认折叠，需要配置时再展开
const islandApiOpen = ref(false);
const webhookOpen = ref(false);
const editingWebhookTargets = computed(() =>
  webhookTargets.value.filter((tg) => tg.url.trim() && validateWebhookUrl(tg.url.trim())),
);
watch([webhookEnabled, webhookTargets], async () => {
  if (webhookLoading.value) return;
  // 空 URL / 非法 URL 行视为编辑中，不参与持久化与下发（Rust 侧 validate_url 兜底）
  await saveIslandWebhookConfig({ enabled: webhookEnabled.value, targets: editingWebhookTargets.value });
}, { deep: true });
watch(webhookEnabled, (en) => {
  if (webhookLoading.value) return;
  showHint(t(en ? 'island_webhook.on' : 'island_webhook.off'));
});
function addWebhookTarget() {
  webhookTargets.value.push({
    id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    url: '', secret: '', events: ['island.show'], enabled: true,
  });
}
function removeWebhookTarget(id: string) {
  webhookTargets.value = webhookTargets.value.filter((tg) => tg.id !== id);
}
async function testWebhook() {
  if (webhookTesting.value) return;
  webhookTesting.value = true;
  try {
    const results = await testIslandWebhook();
    const failed = results.filter((r) => !r.ok);
    if (!failed.length) {
      showHint(t('island_webhook.test_ok'));
    } else {
      showHint(t('island_webhook.test_fail', { n: failed.length, error: failed[0]?.error ?? 'unknown' }), 'error');
    }
  } catch (e) {
    showHint(String(e), 'error');
  } finally {
    webhookTesting.value = false;
  }
}

// 处理开关/默认方案变化：持久化 + 推送配置快照给处理层
watch(smartMode, (val) => {
  void dbService.setKeyValue('smart_clip_mode', val);
  refreshSmartClipConfig();
});
watch(defaultSchemeId, (val) => {
  void dbService.setKeyValue('smart_default_scheme_id', val);
  refreshSmartClipConfig();
});

// 提示窗口 / 搜索高亮的切换提示已在模板 @change 中内联处理

// 开机自启：切换时调用系统 autostart 插件（enable/disable）
watch(autoStartEnabled, async (val) => {
  // 初始化读取系统状态时跳过，避免每次进入设置页都误触发 enable/disable 和提示
  if (initializingAutoStart) return;
  if (!isTauri()) return;
  // 开发模式：autostart 注册的是 target/debug 二进制，开机时 Nuxt dev server
  // 尚未运行，WebView 加载 devUrl（localhost:12321）直接 ERR_CONNECTION_REFUSED。
  // 因此 dev 下不支持开启；若此前误注册过，顺带清理注册项。
  if (import.meta.env.DEV) {
    if (val) {
      autoStartEnabled.value = false;
      showHint(t('setting.general.startup_dev_unsupported'), 'error');
    } else {
      try {
        await disable();
      } catch { /* 本就未注册时忽略 */ }
    }
    return;
  }
  try {
    if (val) {
      await enable();
    } else {
      await disable();
    }
    showHint(val ? t('setting.general.startup_on') : t('setting.general.startup_off'));
  } catch (e) {
    console.error('设置开机自启失败:', e);
    // 失败回滚 UI 状态
    autoStartEnabled.value = !val;
    // 提示用户：Tauri autostart 默认写当前用户注册表（HKCU），一般无需管理员权限，
    // 失败多因系统策略/注册表权限限制
    showHint(t('setting.general.startup_failed'), 'error');
  }
});

// 清空数据库：二次确认状态
const showClearConfirm = ref(false);
const clearing = ref(false);
const clearMsg = ref('');

// ===== 3 分钟撤回窗口：清空后数据先备份到 clear_backup_* 表，期间可合并恢复，超时丢弃备份 =====
// 状态在模块级（见文件顶部）：不随设置页卸载重置，切走再切回仍可撤回

const stopUndoTimers = () => {
  if (undoCountdownTimer) {
    clearInterval(undoCountdownTimer);
    undoCountdownTimer = null;
  }
  if (undoExpireTimer) {
    clearTimeout(undoExpireTimer);
    undoExpireTimer = null;
  }
};

/** 撤回窗口倒计时显示（mm:ss）：180 秒纯数字倒数可读性差 */
const undoRemainingLabel = computed(() => {
  const m = Math.floor(undoRemaining.value / 60);
  const s = undoRemaining.value % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
});

/** 窗口结束（到期/组件卸载）：丢弃备份，清空彻底生效 */
const expireUndoWindow = async () => {
  stopUndoTimers();
  undoActive.value = false;
  try {
    await dbService.finalizeClear();
  } catch { /* 备份清理失败无碍：下次启动仍会兜底清理 */ }
};

/** 撤回清空：整表恢复清空前的数据（剪贴板/便签/待办/统计） */
async function undoClearDatabase() {
  if (!undoActive.value) return;
  stopUndoTimers();
  undoActive.value = false;
  try {
    const ok = await dbService.undoClearDatabase();
    clearMsg.value = ok ? t('setting.general.clear_restored') : t('setting.general.cleared_detail');
    if (ok) {
      // 触发剪贴板列表刷新（若在其他页已挂载），待办/统计由各自 Tab 重新挂载时拉取
      try {
        const { fetchData } = await import('~/src/commands/local/clipboardStore');
        await fetchData();
      } catch (_) { /* 列表未挂载时忽略 */ }
    }
  } catch (e) {
    clearMsg.value = t('setting.general.clear_failed') + (e as Error).message;
  }
}

async function confirmClearDatabase() {
  if (clearing.value) return;
  clearing.value = true;
  clearMsg.value = '';
  try {
    // 连续清空：终结上一轮未过期的撤回窗口（其备份由本轮清空的备份覆盖）
    stopUndoTimers();
    undoActive.value = false;
    await dbService.finalizeClear();

    await dbService.clearDatabase();
    // 触发剪贴板列表刷新（若在其他页已挂载）
    try {
      const { fetchData } = await import('~/src/commands/local/clipboardStore');
      await fetchData();
    } catch (_) { /* 列表未挂载时忽略 */ }
    // 开启 3 分钟撤回窗口：倒计时归零后自动丢弃备份
    undoRemaining.value = 180;
    undoActive.value = true;
    undoCountdownTimer = setInterval(() => {
      undoRemaining.value = Math.max(0, undoRemaining.value - 1);
    }, 1000);
    undoExpireTimer = setTimeout(() => {
      void expireUndoWindow().then(() => {
        if (!clearMsg.value) clearMsg.value = t('setting.general.cleared_detail');
      });
    }, 180000);
  } catch (e) {
    clearMsg.value = t('setting.general.clear_failed') + (e as Error).message;
  } finally {
    clearing.value = false;
    showClearConfirm.value = false;
  }
}

// 撤回窗口不随组件卸载终结：状态与定时器在模块级（见文件顶部），
// 切走设置页后倒计时继续，超时自动 finalize；期间切回设置页仍可撤回

// ===== 数据备份：导出/导入 JSON（剪贴历史换机迁移；图片以 dataUrl 自包含） =====
const exportingData = ref(false);
const showImportConfirm = ref(false);
const importingData = ref(false);

/** 字节数格式化（导出完成提示用；JSON 字符数≈字节数，dataUrl 为 ASCII，提示用途无需精确） */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 导出全部业务与统计数据为 JSON 文件（系统保存对话框选位置） */
async function exportData() {
  if (exportingData.value) return;
  exportingData.value = true;
  try {
    const bundle = await dbService.exportData();
    const path = await save({
      defaultPath: `s1de-board-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!path) return;
    const json = JSON.stringify(bundle);
    await writeTextFile(path, json);
    // 带文件大小反馈：图片库经 base64 体积暴涨，用户导出后应能核对文件规模是否符合预期
    showHint(t('setting.general.export_data_done', { size: formatBytes(json.length) }));
  } catch (e) {
    console.error('导出数据失败:', e);
    showHint(t('setting.general.export_data_failed') + (e as Error).message, 'error');
  } finally {
    exportingData.value = false;
  }
}

/** 导入备份：选择 JSON 文件，替换式恢复全部数据（二次确认后触发） */
async function importDataConfirmed() {
  if (importingData.value) return;
  showImportConfirm.value = false;
  importingData.value = true;
  try {
    const path = await open({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!path || typeof path !== 'string') return;
    const bundle = JSON.parse(await readTextFile(path)) as DataBundle;
    if (!bundle || typeof bundle !== 'object' || !bundle.tables) {
      throw new Error('invalid backup bundle');
    }
    await dbService.importData(bundle);
    // 触发剪贴板列表刷新（若在其他页已挂载），待办/统计由各自 Tab 重新挂载时拉取
    try {
      const { fetchData } = await import('~/src/commands/local/clipboardStore');
      await fetchData();
    } catch (_) { /* 列表未挂载时忽略 */ }
    showHint(t('setting.general.import_data_done'));
  } catch (e) {
    console.error('导入数据失败:', e);
    const msg = (e as Error)?.message ?? '';
    // 常见失败本地化：JSON.parse 失败（文件不是合法 JSON）/ 备份版本不兼容——
    // 直接拼原始 e.message 对用户是英文技术乱码，其余未知错误仍拼原文便于排查
    if (e instanceof SyntaxError || /unexpected token|json/i.test(msg)) {
      showHint(t('setting.general.import_bad_file'), 'error');
    } else if (/version/i.test(msg)) {
      showHint(t('setting.general.import_bad_version'), 'error');
    } else {
      showHint(t('setting.general.import_data_failed') + msg, 'error');
    }
  } finally {
    importingData.value = false;
  }
}

// ===== 自动备份恢复：列出每日首启快照（Rust 侧 backups 目录，保留 7 份），两步确认后替换式恢复 =====
const autoBackupOpen = ref(false);
const autoBackupLoadingList = ref(false);
const autoBackupList = ref<string[]>([]);
const autoBackupPending = ref('');
const restoringBackup = ref('');

/** 备份文件名 → 展示日期（s1de-board-auto-2026-10-08.json → 2026-10-08） */
function autoBackupLabel(name: string): string {
  return name.replace(/^s1de-board-auto-/, '').replace(/\.json$/, '');
}

/** 展开/收起备份列表：每次展开重新拉取（Rust list_auto_backups，倒序新→旧） */
async function toggleAutoBackupList() {
  autoBackupOpen.value = !autoBackupOpen.value;
  if (!autoBackupOpen.value || autoBackupLoadingList.value) return;
  autoBackupLoadingList.value = true;
  autoBackupPending.value = '';
  try {
    autoBackupList.value = await listAutoBackups();
  } catch (e) {
    console.error('加载自动备份列表失败:', e);
    autoBackupList.value = [];
    showHint(t('setting.general.auto_backup_list_failed'), 'error');
  } finally {
    autoBackupLoadingList.value = false;
  }
}

/** 恢复自动备份：同一条目两步确认 → 读取 → 替换式导入（错误映射与手动导入一致） */
async function restoreAutoBackup(name: string) {
  if (restoringBackup.value) return;
  if (autoBackupPending.value !== name) {
    autoBackupPending.value = name;
    return;
  }
  autoBackupPending.value = '';
  restoringBackup.value = name;
  try {
    const bundle = JSON.parse(await readAutoBackup(name)) as DataBundle;
    if (!bundle || typeof bundle !== 'object' || !bundle.tables) {
      throw new Error('invalid backup bundle');
    }
    await dbService.importData(bundle);
    // 触发剪贴板列表刷新（若在其他页已挂载），待办/统计由各自 Tab 重新挂载时拉取
    try {
      const { fetchData } = await import('~/src/commands/local/clipboardStore');
      await fetchData();
    } catch (_) { /* 列表未挂载时忽略 */ }
    showHint(t('setting.general.import_data_done'));
  } catch (e) {
    console.error('恢复自动备份失败:', e);
    const msg = (e as Error)?.message ?? '';
    if (e instanceof SyntaxError || /unexpected token|json/i.test(msg)) {
      showHint(t('setting.general.import_bad_file'), 'error');
    } else if (/version/i.test(msg)) {
      showHint(t('setting.general.import_bad_version'), 'error');
    } else {
      showHint(t('setting.general.import_data_failed') + msg, 'error');
    }
  } finally {
    restoringBackup.value = '';
  }
}

/** 回看首次使用引导（bus 派发 → 主窗口 OnboardingOverlay 重置到第一步重新弹出） */
function replayOnboarding() {
  bus.emit('onboarding:replay');
}

const settings: SettingGroup[] = [
  {
    title: 'setting.categories.shortcuts',
    type: 'shortcut',
    items: [],
  },
  {
    title: 'setting.categories.nav',
    type: 'nav',
    items: [],
  },
  {
    // 剪贴板：存储上限 / 悬浮预览 / 隐私与安全 三个子分组
    title: 'setting.categories.clipboard',
    type: 'general',
    items: [],
    children: [
      {
        title: 'setting.subgroups.clipboard_general',
        items: [
          { label: 'setting.general.clipboard_limit', value: '', type: 'input' },
          { label: 'setting.general.image_limit', value: '', type: 'input' },
          { label: 'setting.general.popup_position', value: '', type: 'select' },
          { label: 'setting.general.search_highlight', value: '', type: 'checkbox' },
        ],
      },
      {
        title: 'setting.subgroups.preview',
        items: [
          { label: 'setting.general.tooltip_window', value: '', type: 'checkbox' },
          { label: 'setting.general.tooltip_wrap', value: '', type: 'checkbox' },
          { label: 'setting.general.paste_restore_clipboard', value: '', type: 'checkbox' },
        ],
      },
      {
        title: 'setting.subgroups.privacy',
        items: [
          { label: 'setting.general.privacy_pause', value: '', type: 'checkbox' },
          { label: 'setting.general.sensitive_filter', value: '', type: 'checkbox' },
        ],
      },
    ],
  },
  {
    // 灵动岛：显示效果子组 + 灵动岛 API 与 Webhook 配置卡片（模板尾部按 title 挂载）
    title: 'setting.categories.island',
    type: 'island',
    items: [],
    children: [
      {
        title: 'setting.subgroups.island_display',
        items: [
          { label: 'setting.general.island_hint', value: '', type: 'checkbox' },
          { label: 'setting.general.island_delay', value: '', type: 'input' },
          { label: 'setting.general.island_duration', value: '', type: 'input' },
        ],
      },
    ],
  },
  {
    // 智能与 AI：智能剪贴板专属块在前（模板按 type==='smart' 渲染），AI 分析子组卡片在后
    title: 'setting.categories.smart',
    type: 'smart',
    items: [],
    children: [
      {
        title: 'setting.subgroups.ai',
        items: [
          { label: 'setting.general.ai_provider', value: '', type: 'select' },
          { label: 'setting.general.ai_base_url', value: '', type: 'input' },
          { label: 'setting.general.ai_model', value: '', type: 'input' },
          { label: 'setting.general.ai_test', value: '', type: 'action' },
          { label: 'setting.general.api_key', value: '', type: 'input' },
          { label: 'setting.general.ai_analysis_max', value: '', type: 'input' },
        ],
      },
    ],
  },
  {
    // 通用：应用 / 外观与语言 / 待办与提醒 / 数据管理 四个子组
    title: 'setting.categories.general',
    type: 'general',
    items: [],
    children: [
      {
        title: 'setting.subgroups.app',
        items: [
          { label: 'setting.general.launch_at_startup', value: '', type: 'checkbox' },
          { label: 'setting.general.auto_hide', value: '', type: 'checkbox' },
          { label: 'setting.general.app_usage_tracking', value: '', type: 'checkbox' },
          { label: 'setting.general.replay_onboarding', value: '', type: 'action' },
        ],
      },
      {
        title: 'setting.subgroups.appearance',
        items: [
          { label: 'setting.general.color_scheme', value: '', type: 'select' },
          { label: 'setting.general.locale', value: '', type: 'select' },
        ],
      },
      {
        title: 'setting.subgroups.todo_notify',
        items: [
          { label: 'setting.general.smart_reminder', value: '', type: 'checkbox' },
          { label: 'setting.general.todo_system_notify', value: '', type: 'checkbox' },
        ],
      },
      {
        title: 'setting.subgroups.data',
        items: [
          { label: 'setting.general.clear_database', value: '', type: 'action' },
          { label: 'setting.general.export_data', value: '', type: 'action' },
          { label: 'setting.general.import_data', value: '', type: 'action' },
          { label: 'setting.general.auto_backup_restore', value: '', type: 'action' },
        ],
      },
    ],
  },
  {
    title: 'setting.categories.about',
    type: 'about',
    items: [],
  }
];

// 初始分组：优先取模块级保留值（同会话内再次进入无跳变），否则第一项
const activeSetting = ref(settings.find(s => s.title === lastActiveSettingTitle) ?? settings[0]);
// 持久化当前选中的设置分类，下次进入设置默认停在该分类
watch(activeSetting, async (val) => {
  lastActiveSettingTitle = val?.title ?? null;
  await dbService.setKeyValue('setting_active_tab', val?.title ?? '');
});

// ===== 设置搜索：跨分组按当前语言文案/键名过滤，结果复用通用渲染循环展示 =====
/** 搜索关键词（左侧导航底部搜索框输入，实时过滤无需防抖——数据全在内存） */
const settingSearch = ref('');
const searchQuery = computed(() => settingSearch.value.trim().toLowerCase());
const searchMode = computed(() => searchQuery.value.length > 0);

/** 标题命中的分组（提供「前往分组」跳转入口；顶层或子组标题命中均可） */
const matchedGroups = computed<SettingGroup[]>(() => {
  if (!searchMode.value) return [];
  const q = searchQuery.value;
  const hitTitle = (title: string) => t(title).toLowerCase().includes(q) || title.toLowerCase().includes(q);
  return settings.filter(g => g.title !== 'setting.categories.nav'
    && (hitTitle(g.title) || (g.children ?? []).some(c => hitTitle(c.title))));
});

/** 搜索结果虚拟分组：把所有分组命中项打平（附来源子分组名），复用 children 分节卡片渲染 */
const searchResultGroup = computed<SettingGroup>(() => {
  const q = searchQuery.value;
  const hit = (label: string) => t(label).toLowerCase().includes(q) || label.toLowerCase().includes(q);
  const items = settings.flatMap(g => [
    ...(g.children ?? []).flatMap(c => c.items.filter(it => hit(it.label)).map(it => ({ ...it, groupTitle: c.title }))),
    ...g.items.filter(it => hit(it.label)).map(it => ({ ...it, groupTitle: g.title })),
  ]);
  return { title: 'setting.search.results', type: 'general', items: [], children: [{ title: 'setting.search.results', items }] };
});

/** 内容区实际渲染的分组：搜索态显示结果虚拟组（与 activeSetting 解耦，清空搜索即恢复） */
const displaySetting = computed<SettingGroup>(() =>
  searchMode.value ? searchResultGroup.value : (activeSetting.value ?? settings[0]!));

/** 搜索结果跳转：清空关键词退出搜索态并切换到目标分组 */
function clearSearchAndGo(group: SettingGroup) {
  settingSearch.value = '';
  onSettingClick(group);
}

/** 搜索态下灵动岛专属卡片（API / Webhook）的可见性：
 *  非搜索态跟随当前分组；搜索态仅当搜索词与灵动岛相关（分组/子组标题或卡片标题命中）时显示，
 *  避免搜索无关关键词时残留显示 */
const islandCardsVisible = computed(() => {
  if (activeSetting.value?.title !== 'setting.categories.island') return false;
  if (!searchMode.value) return true;
  const q = searchQuery.value;
  const hit = (s: string) => t(s).toLowerCase().includes(q) || s.toLowerCase().includes(q);
  return hit('island_api.section') || hit('island_webhook.section')
    || hit('setting.categories.island') || hit('setting.subgroups.island_display');
});

// ===== Ctrl+F 聚焦设置搜索框：走快捷键命令总线（与剪贴板/待办/便签一致） =====
// find_in_tab 命令（默认 CommandOrControl+F）由 ShortcutManager 捕获阶段处理并 emit
// 'focus-search'——本页不能自行监听 keydown（命中后被 stopImmediatePropagation 收不到），
// 与其他标签页一样监听总线事件即可。
const searchInputRef = ref<HTMLInputElement | null>(null);
const onFocusSearch = () => {
  // 立即聚焦一次；页面切入动画（page-curtain）结束后再补一次，避免动画期间焦点被重置
  nextTick(() => searchInputRef.value?.focus());
  setTimeout(() => searchInputRef.value?.focus(), 400);
};
onMounted(() => bus.on('focus-search', onFocusSearch));
onBeforeUnmount(() => bus.off('focus-search', onFocusSearch));

// ===== 关于（版本 / 描述 / 作者 / 主页 / 检查更新）=====
/** 版本单一来源：tauri.conf.json 的 version（经 getVersion 读取）；纯 Web 环境回退到该常量 */
const FALLBACK_VERSION = '0.2.1';
const APP_REPO = 'https://github.com/s0uths1d3/s1d3_board';
const APP_RELEASES_API = 'https://api.github.com/repos/s0uths1d3/s1d3_board/releases/latest';
const APP_AUTHOR = 's1d3';

const appVersion = ref(FALLBACK_VERSION);

type UpdateState = 'idle' | 'checking' | 'latest' | 'available' | 'error';
const updateState = ref<UpdateState>('idle');
const latestVersion = ref('');
const releaseUrl = ref('');
let aboutAutoChecked = false;

/** 语义化版本比较：>0 表示 a 更新 */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 联网检查 GitHub Releases 最新版本（10s 超时；仓库暂无 Release 视为已最新）。
 * 手动点击时弹灵动岛给出各结果提示；进入「关于」页的自动检查静默执行（卡片内状态仍更新）。
 */
async function checkUpdate(options?: { silent?: boolean }) {
  const silent = options?.silent ?? false;
  if (updateState.value === 'checking') return;
  updateState.value = 'checking';
  if (!silent) showHint(t('setting.about.checking_hint'), 'info');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(APP_RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status === 404) {
      // 仓库还没有任何 Release：不存在更新
      latestVersion.value = '';
      updateState.value = 'latest';
      if (!silent) showHint(t('setting.about.up_to_date_hint'));
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    latestVersion.value = String(data.tag_name ?? '').replace(/^v/i, '');
    releaseUrl.value = String(data.html_url || `${APP_REPO}/releases`);
    const hasNew = compareVersions(latestVersion.value, appVersion.value) > 0;
    updateState.value = hasNew ? 'available' : 'latest';
    if (!silent) showHint(hasNew ? t('setting.about.new_version_hint', { version: latestVersion.value }) : t('setting.about.up_to_date_hint'));
  } catch (e) {
    console.error('检查更新失败:', e);
    updateState.value = 'error';
    if (!silent) showHint(t('setting.about.update_failed_hint'), 'error');
  }
}

async function openRepoPage() {
  try {
    if (isTauri()) await openUrl(APP_REPO);
    else window.open(APP_REPO, '_blank', 'noopener');
  } catch (e) {
    console.error('打开主页失败:', e);
    showHint(t('setting.about.open_repo_failed'), 'error');
  }
}

async function openReleasePage() {
  const url = releaseUrl.value || `${APP_REPO}/releases`;
  try {
    if (isTauri()) await openUrl(url);
    else window.open(url, '_blank', 'noopener');
  } catch (e) {
    console.error('打开发布页失败:', e);
    showHint(t('setting.about.open_release_failed'), 'error');
  }
}

async function copyRepoLink() {
  try {
    if (isTauri()) await writeText(APP_REPO);
    else await navigator.clipboard.writeText(APP_REPO);
    showHint(t('setting.about.repo_link_copied'));
  } catch (e) {
    console.error('复制链接失败:', e);
    showHint(t('setting.about.copy_failed'), 'error');
  }
}

// 首次进入「关于」页时自动静默检查一次更新（会话内仅一次，不弹灵动岛打扰）
watch(activeSetting, (s) => {
  if (s?.type === 'about' && !aboutAutoChecked) {
    aboutAutoChecked = true;
    void checkUpdate({ silent: true });
  }
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
    const raw = await dbService.getKeyValue(SETTING_GROUP_ORDER_KEY);
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
    void dbService.setKeyValue(SETTING_GROUP_ORDER_KEY, JSON.stringify(settingOrder.value));
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
  // row.enabled 为切换前的状态：原显示 → 现隐藏，反之亦然
  showHint(t(row.enabled ? 'setting.shortcuts.nav_row_hidden' : 'setting.shortcuts.nav_row_shown', { name: t('titlebar.' + row.key) }));
}

// ===== 快捷键录制 =====
/** 当前正在录制的快捷键 id（null 表示未在录制） */
const recordingId = ref<string | null>(null);
/** 各快捷键的错误信息（冲突等） */
const errorMap = ref<Record<string, string>>({});
let recorderHandler: ((e: KeyboardEvent) => void) | null = null;

/** 行内错误：录制/冲突错误优先，其次启动期注册失败提示（该键未生效，标红可见） */
function shortcutRowError(id: string): string {
  return errorMap.value[id]
    ?? (failedShortcutIds.value.has(id) ? t('shortcut.register_failed_hint') : '');
}

/** 快捷键设置组渲染数据 */
const shortcutItems = computed(() =>
  shortcuts.value.map(s => {
    // 数字快捷粘贴（Ctrl+1~0 / Ctrl+Shift+1~0）单独归类，默认折叠展示
    const group = s.id.startsWith('pinned_paste') ? 'pinned'
      : s.id.startsWith('slot_paste') ? 'slot' : 'normal';
    // 数字快捷粘贴共用同一个 i18n key，按 {n} 占位（标题里的数字 1~10）；其余项 title 已是 i18n key
    const mPinned = s.id.match(/^pinned_paste_(\d+)$/);
    const mSlot = s.id.match(/^slot_paste_(\d+)$/);
    const label = mPinned
      ? t('shortcut.pinned_paste', { n: Number(mPinned[1]) })
      : mSlot
        ? t('shortcut.slot_paste', { n: Number(mSlot[1]) })
        : t(s.title);
    return {
      id: s.id,
      label,
      key: s.key,
      scope: s.scope,
      display: s.key ? formatShortcutForDisplay(s.key) : t('shortcut.unbound'),
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
      title: scope === 'global' ? t('shortcut.group_global') : t('shortcut.group_local'),
      scope,
      items,
      hasModified: items.some(i => i.isModified),
    };
  })
);

/** 两组可折叠的数字快捷粘贴（默认折叠，支持一键开启/关闭/还原） */
const collapsibleGroups = computed(() => [
  { key: 'pinned', title: t('shortcut.group_pinned'), items: shortcutItems.value.filter(i => i.group === 'pinned') },
  { key: 'slot', title: t('shortcut.group_slot'), items: shortcutItems.value.filter(i => i.group === 'slot') },
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
  showHint(next ? t('setting.shortcuts.enabled_hint') : t('setting.shortcuts.disabled_hint'));
}

/** 整组胶囊开关：点击在「全部启用 / 全部禁用」间切换 */
async function toggleGroup(group: { key: string; items: { id: string; enabled: boolean }[] }) {
  const enable = !groupAllEnabled(group);
  await setShortcutGroupEnabled(group.items.map(i => i.id), enable);
  showHint(enable ? t('setting.shortcuts.group_enabled') : t('setting.shortcuts.group_disabled'));
}

/** 一键还原组内全部快捷键为默认（图标按钮） */
async function resetGroup(group: { key: string; items: { id: string }[] }) {
  await resetShortcutGroup(group.items.map(i => i.id));
  showHint(t('setting.shortcuts.group_reset'));
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
    showHint(t('setting.shortcuts.save_failed') + err, 'error');
  } else {
    delete errorMap.value[id];
    showHint(t('setting.shortcuts.saved_hint'));
  }
}

async function resetOne(id: string) {
  const err = await resetShortcut(id);
  if (err) {
    errorMap.value[id] = err;
    showHint(t('setting.shortcuts.reset_failed') + err, 'error');
  } else {
    delete errorMap.value[id];
    showHint(t('setting.shortcuts.reset_done_hint'));
  }
}

async function resetAll(scope?: 'global' | 'local') {
  cancelRecording();
  await resetAllShortcuts(scope);
  errorMap.value = {};
  showHint(t('setting.shortcuts.all_reset_hint'));
}

// 切换设置组时取消录制
watch(activeSetting, () => cancelRecording());

onBeforeUnmount(() => {
  cancelRecording();
});

onMounted(async () => {
  osType.value = getOsTypeFromNavigator();
  maxLimit.value = await dbService.getKeyValue('max_save_count');
  imageLimit.value = await dbService.getKeyValue('image_cache_max_mb');
  // 粘贴后恢复原剪贴板开关（默认关闭）
  pasteRestoreEnabled.value = (await dbService.getKeyValue('paste_restore_clipboard')) === '1';
  // 图片缓存磁盘占用查询（失败显示统计中占位，不阻塞其余设置恢复）
  void refreshImageCacheUsage();
  // API Key 加密存储：先把旧明文 KV 迁移进系统凭据库（失败保留明文），再从凭据库读取
  await migrateAiApiKey();
  const keyRes = await loadAiApiKey();
  apiKey.value = keyRes.key;
  aiKeyPlaintext.value = keyRes.source === 'plaintext';
  // AI 通道配置恢复（设计文档 §4.2）：提供商缺省 openai-compat
  aiProvider.value = ((await dbService.getKeyValue('ai_provider')) || 'openai-compat') as AiProviderKind;
  aiBaseUrl.value = await dbService.getKeyValue('ai_base_url');
  aiModel.value = await dbService.getKeyValue('ai_model');
  aiAnalysisMax.value = (await dbService.getKeyValue('ai_analysis_max_chars')) || '1000';
  // 自定义 JSON 模板恢复（custom 模式编辑器内容）；为空时编辑器显示占位提示
  aiCustomConfig.value = (await dbService.getKeyValue('ai_custom_config')) || '';
  // 智能剪贴板配置恢复（设计文档 §4.3/§4.5）+ 推送处理层快照
  try {
    // 'off' 尊重用户选择；'auto'/'scheme'/'ai'（旧值）及空值/未知值统一归一为 'on'（单一管线）
    const rawMode = await dbService.getKeyValue('smart_clip_mode');
    smartMode.value = rawMode === 'off' ? 'off' : 'on';
    // 默认方案指向：新键优先，兼容旧键 smart_default_template_id
    defaultSchemeId.value =
      (await dbService.getKeyValue('smart_default_scheme_id')) ||
      (await dbService.getKeyValue('smart_default_template_id'));
    schemes.value = await dbService.fetchClipSchemes();
    // 提取器：首次进入用内置提取器 seed 并落库，之后以库中的（用户可改的）列表为准
    extractors.value = await loadExtractors(t as Translator);
    // 方案对账：清理旧内置方案行、保证至少一条方案存在、修正默认方案指向
    await ensureSchemes();
    islandApiEnabled.value = (await dbService.getKeyValue('island_api_enabled')) === '1';
    islandApiPort.value = (await dbService.getKeyValue('island_api_port')) || String(ISLAND_API_DEFAULT_PORT);
    // 令牌强制（v1.5.0）：为空时自动生成并持久化（老配置升级 / 首次开启均覆盖）；发生在 islandApiLoading=true 期间，不触发 watch
    islandApiToken.value = await ensureIslandApiToken();
    // 回填进程内记录的最近一次启动失败（如启动时端口被占），仅开启状态下展示
    islandApiError.value = islandApiEnabled.value ? lastIslandApiFailure() : '';
    // Webhook 出站推送配置恢复（JSON 解析失败返回空配置，UI 显示空列表）
    try {
      const wh = await loadIslandWebhookConfig();
      webhookEnabled.value = wh.enabled;
      webhookTargets.value = wh.targets;
    } catch (e) {
      console.error('Webhook 配置恢复失败:', e);
    }
    // 门控必须在 nextTick 之后释放：上面赋值触发的 pre-flush watcher 在微任务里执行，
    // 同步释放时门控已开 → 每次进入设置都误弹「已开启 Webhook 出站推送」提示并回写持久化
    await nextTick();
    webhookLoading.value = false; // 填充完毕（含异常路径），此后用户改动才走持久化与提示
    aiCacheWindow.value = (await dbService.getKeyValue('ai_result_window')) || '300';
    refreshSmartClipConfig();
  } catch (e) {
    console.error('智能剪贴板配置恢复失败:', e);
  }
  // 同理：islandApiEnabled/Port/Token 恢复赋值触发的 watcher 也须等 flush 完再放行门控
  await nextTick();
  islandApiLoading.value = false; // 填充完毕（含异常路径），此后用户改动才走持久化 watch
  // 「关于」页版本号：与 tauri.conf.json 的 version 同源；纯 Web 环境保持回退常量
  if (isTauri()) {
    try {
      appVersion.value = await getVersion();
    } catch { /* 读取失败保持回退版本 */ }
  }
  // 配色的读取/应用/持久化由 useColorScheme 统一负责，这里无需处理
  // 恢复上次选中的设置分类（快捷键 / Api设置 / 通用）。
  // 仅本会话首次挂载执行：后续挂载已由模块级 lastActiveSettingTitle 同步落位，无需再跳。
  if (!lastActiveSettingTitle) {
    try {
      const savedTab = await dbService.getKeyValue('setting_active_tab');
      if (savedTab) {
        const found = settings.find(s => s.title === savedTab);
        if (found) activeSetting.value = found;
      }
    } catch (e) {
      // 忽略，使用默认第一项
    }
  }
  // 读取当前开机自启状态（仅桌面容器内可用）；
  // 用 initializingAutoStart 标记，避免触发 watch 误发 enable/disable 与提示。
  // 注意：watch 默认异步（flush: 'pre'），必须 await nextTick() 等回调执行完再清除标记，
  // 否则 watch 在下一 tick 运行时标记已为 false，仍会误发提示。
  if (isTauri()) {
    initializingAutoStart = true;
    try {
      autoStartEnabled.value = await isEnabled();
      // dev 下清理误注册的自启项（指向 debug 二进制，开机无 dev server 必然白屏）
      if (import.meta.env.DEV && autoStartEnabled.value) {
        await disable();
        autoStartEnabled.value = false;
        console.warn('[autostart] 开发模式下检测到开机自启注册，已清理');
      }
    } catch (e) {
      console.error('读取开机自启状态失败:', e);
    }
    await nextTick();
    initializingAutoStart = false;
  }
});
</script>

<template>
  <!-- 边距与宽度由外壳统一提供（main px-4 + max-w-6xl），各模块保持一致 -->
  <div>
    <div class="flex">
      <!-- 左侧分类列表：长按 1s 可拖动调整顺序，松开自动持久化；TransitionGroup 提供平滑让位。
           容器空白处 data-tauri-drag-region 可拖动主窗口（按钮点击不受影响） -->
      <div class="w-1/5 pr-4 sticky top-4 self-start" data-setting-nav data-tauri-drag-region>
        <!-- 设置搜索：位于分组列表上方，跨分组匹配设置项文案/键名与分组标题，输入即过滤；Ctrl+F 聚焦 -->
        <input
            ref="searchInputRef"
            v-model="settingSearch"
            type="text"
            class="mb-3 w-full rounded-lg border border-line bg-surface-field px-2.5 py-1.5 text-xs text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-gold"
            :placeholder="t('setting.search.placeholder')"
        />
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
              <!-- 文字左侧 grip：提示分组按钮可长按拖动排序；grip 固定列对齐，文字在其右侧左对齐 -->
              <span class="flex items-center gap-1.5">
                <svg class="h-3 w-3 shrink-0 opacity-45" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="9" cy="5" r="1.8" /><circle cx="15" cy="5" r="1.8" />
                  <circle cx="9" cy="12" r="1.8" /><circle cx="15" cy="12" r="1.8" />
                  <circle cx="9" cy="19" r="1.8" /><circle cx="15" cy="19" r="1.8" />
                </svg>
                <span class="text-left">{{ t(setting.title) }}</span>
              </span>
            </button>
          </div>
        </TransitionGroup>
      </div>
      <div class="w-4/5">
        <!-- 分类切换过渡：复用全局 page-curtain（淡入 + 上浮），key 驱动 -->
        <Transition name="page-curtain" mode="out-in">
        <div v-if="displaySetting" :key="displaySetting.title" class="min-h-[280px]">
          <!-- 快捷键设置组 -->
          <div v-if="displaySetting.type === 'shortcut'" class="flex flex-col gap-4">
            <div v-for="group in shortcutGroups" :key="group.scope">
              <ul class="glass-card rounded-2xl shadow-soft">
                <li class="border-b border-accent p-4 pb-2 text-xs uppercase tracking-wide text-ink-faint">
                  {{ group.title }}
                </li>
                <li v-for="item in group.items" :key="item.id">
                  <ShortcutRow
                      :item="item"
                      :recording="recordingId === item.id"
                      :error="shortcutRowError(item.id)"
                      @toggle="toggleShortcutWithHint(item.id)"
                      @record="startRecording(item.id)"
                      @reset="resetOne(item.id)"
                  />
                </li>
              </ul>
              <div v-if="group.hasModified" class="mt-2 flex justify-end">
                <button class="btn-soft" @click="resetAll(group.scope)">
                  <svg class="mr-1 inline h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  {{ t('shortcut.reset_all') }}
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
                      :tip-on="t('setting.shortcuts.disable_group_tip')" :tip-off="t('setting.shortcuts.enable_group_tip')"
                      :label="cg.title"
                      @change="toggleGroup(cg)"
                  />
                  <!-- 一键还原（图标按钮） -->
                  <button
                      type="button"
                      class="btn-soft p-2"
                      v-tip="t('setting.shortcuts.reset_group')"
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
                <li v-for="item in cg.items" :key="item.id">
                  <ShortcutRow
                      :item="item"
                      :recording="recordingId === item.id"
                      :error="shortcutRowError(item.id)"
                      @toggle="toggleShortcutWithHint(item.id)"
                      @record="startRecording(item.id)"
                      @reset="resetOne(item.id)"
                  />
                </li>
              </ul>
            </div>

            <p class="text-xs text-ink-faint">
              {{ t('setting.shortcuts.shortcut_hint') }}
            </p>
          </div>

          <!-- 关于：应用信息 / 主页 / 检查更新 -->
          <div v-else-if="displaySetting.type === 'about'" class="flex flex-col gap-4">
            <!-- 应用信息 -->
            <div class="glass-card rounded-2xl p-5">
              <div class="flex items-center gap-4">
                <img :src="appIcon" alt="s1d3 board" class="h-14 w-14 shrink-0 rounded-xl shadow-soft" />
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-lg font-semibold text-ink">s1d3 board</span>
                    <span class="rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 text-xs text-gold tabular-nums">v{{ appVersion }}</span>
                  </div>
                  <p class="mt-1 text-xs leading-relaxed text-ink-faint">{{ t('setting.about.description') }}</p>
                  <p class="mt-1 text-xs text-ink-faint">{{ t('setting.about.author_label') }}<span class="text-ink-soft">{{ APP_AUTHOR }}</span></p>
                </div>
              </div>
            </div>

            <!-- 项目主页 -->
            <div class="glass-card rounded-2xl p-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-ink">{{ t('setting.about.repo') }}</div>
                  <div class="truncate text-xs text-ink-faint">{{ APP_REPO }}</div>
                </div>
                <div class="flex shrink-0 gap-2">
                  <button type="button" class="btn-soft px-3 py-1.5 text-xs" v-tip="t('setting.about.copy_repo')" @click="copyRepoLink">
                    {{ t('setting.about.copy_link') }}
                  </button>
                  <button type="button" class="btn-gold px-3 py-1.5 text-xs" v-tip="t('setting.about.open_repo')" @click="openRepoPage">
                    {{ t('setting.about.open_repo_short') }}
                  </button>
                </div>
              </div>
            </div>

            <!-- 检查更新 -->
            <div class="glass-card rounded-2xl p-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-ink">{{ t('setting.about.check_update') }}</div>
                  <div class="mt-0.5 text-xs text-ink-faint">
                    <template v-if="updateState === 'checking'">{{ t('setting.about.checking_new') }}</template>
                    <template v-else-if="updateState === 'latest'">{{ t('setting.about.up_to_date_with_version', { version: appVersion }) }}</template>
                    <template v-else-if="updateState === 'available'">
                      {{ t('setting.about.new_version') }} <span class="font-semibold text-gold">v{{ latestVersion }}</span>
                      <button type="button" class="text-gold underline underline-offset-2" @click="openReleasePage">{{ t('setting.about.view_release') }}</button>
                    </template>
                    <template v-else-if="updateState === 'error'">{{ t('setting.about.check_failed') }}</template>
                    <template v-else>{{ t('setting.about.check_online') }}</template>
                  </div>
                </div>
                <button
                    type="button"
                    class="btn-soft shrink-0 px-3 py-1.5 text-xs"
                    :disabled="updateState === 'checking'"
                    @click="checkUpdate()"
                >
                  {{ updateState === 'checking' ? t('setting.about.checking') : t('setting.about.check_update') }}
                </button>
              </div>
            </div>

            <p class="text-xs text-ink-faint">
              {{ t('setting.about.star_hint') }}
            </p>
          </div>

          <!-- 智能剪贴板专属块：智能与 AI 分组的前半部分（与下方通用渲染块并存，
               同屏展示「智能剪贴板处理块 + AI 分析子组卡片」） -->
          <div v-if="displaySetting.type === 'smart'" class="mb-4 flex flex-col gap-4">
            <div class="glass-card rounded-2xl p-4 shadow-soft">
              <div class="mb-3 text-xs uppercase tracking-wide text-ink-faint">{{ t('smart.mode') }}</div>
              <UiSegmented
                  :model-value="smartMode"
                  :options="SMART_MODE_OPTIONS"
                  block
                  :label="t('smart.mode')"
                  @update:model-value="selectSmartMode"
              />
            </div>

            <!-- 方案：可自由 CRUD；默认方案作为开启态的叠加加工层，AI 可生成专属方案 -->
            <div class="glass-card mt-4 rounded-2xl p-4 shadow-soft">
              <div class="mb-3 flex items-center justify-between gap-2">
                <span class="text-xs uppercase tracking-wide text-ink-faint">{{ t('smart.schemes_section') }}</span>
                <div class="flex items-center gap-2">
                  <button type="button" class="btn-soft px-2 py-0.5 text-xs"
                          @click="addingAiScheme = !addingAiScheme">{{ t('smart.ai_generate_scheme') }}</button>
                  <button type="button" class="btn-soft btn-circle p-1.5"
                          v-tip="t('smart.add_scheme')"
                          @click="addScheme">
                    <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                </div>
              </div>

              <!-- AI 生成专属方案：一句话描述 → 标题/描述 + 成员组合 -->
              <Transition name="edit-panel">
                <div v-if="addingAiScheme" class="mb-2 rounded-xl border border-gold/40 bg-surface-field/60 p-2">
                  <div class="mb-1.5 text-[10px] uppercase tracking-wide text-ink-faint">{{ t('smart.ai_generate_scheme') }}</div>
                  <textarea v-model="aiSchemeDesc" rows="3"
                            class="w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                            :placeholder="t('smart.ai_scheme_desc_ph')"></textarea>
                  <div class="mt-1.5 flex justify-end gap-2">
                    <button type="button" class="btn-soft px-2 py-0.5 text-xs"
                            @click="addingAiScheme = false">{{ t('common.cancel') }}</button>
                    <button type="button" class="btn-gold px-2 py-0.5 text-xs"
                            :disabled="generatingScheme"
                            @click="generateSchemeByAi">
                      {{ generatingScheme ? t('smart.ai_generating') : t('smart.ai_generate') }}
                    </button>
                  </div>
                </div>
              </Transition>

              <div v-for="s in schemes" :key="s.id" class="mb-2 rounded-xl border border-line bg-surface-field/40 p-2">
                <!-- 折叠态：标题 + 描述，点「编辑」展开 -->
                <div class="flex items-center gap-2">
                  <div class="min-w-0 flex-1 cursor-pointer"
                       @click="editingSchemeId = editingSchemeId === s.id ? null : s.id">
                    <div class="truncate text-xs text-ink">{{ s.title }}</div>
                    <div class="truncate text-[10px] text-ink-faint">{{ schemeSummary(s) }}</div>
                  </div>
                  <span v-if="defaultSchemeId === s.id"
                        class="shrink-0 rounded-full border border-gold/50 bg-gold/10 px-1.5 py-0.5 text-[10px] text-gold"
                        :title="t('smart.unset_default')" @click="toggleDefaultScheme(s)">{{ t('smart.default_tag') }}</span>
                  <button v-else type="button" class="btn-soft shrink-0 px-2 py-0.5 text-xs"
                          :title="t('smart.set_default')" @click="toggleDefaultScheme(s)">{{ t('smart.set_default') }}</button>
                  <UiToggleSwitch :model-value="s.enabled === 1" :label="''"
                                  @update:model-value="(v: boolean) => { s.enabled = v ? 1 : 0; saveScheme(s); }" />
                  <button type="button" class="btn-soft shrink-0 px-2 py-0.5 text-xs"
                          @click="editingSchemeId = editingSchemeId === s.id ? null : s.id">
                    {{ editingSchemeId === s.id ? t('smart.collapse') : t('common.edit') }}
                  </button>
                  <button type="button" class="text-ink-faint transition-colors hover:text-danger"
                          @click="removeScheme(s)">✕</button>
                </div>
                <Transition name="edit-panel">
                  <div v-if="editingSchemeId === s.id" class="mt-2">
                    <input v-model="s.title" class="mb-1.5 w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                           :placeholder="t('smart.scheme_title_ph')" @change="saveScheme(s)" />
                    <input v-model="s.description" class="mb-1.5 w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-[10px] text-ink"
                           :placeholder="t('smart.scheme_desc_ph')" @change="saveScheme(s)" />

                    <!-- 成员提取器：空 = 自动接入全部；芯片可移除 -->
                    <div class="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">{{ t('smart.scheme_members_label') }}</div>
                    <p v-if="(s.members ?? []).length === 0" class="mb-1 text-[10px] text-ink-faint">{{ t('smart.scheme_members_auto') }}</p>
                    <div v-else class="mb-1 flex flex-wrap gap-1">
                      <span v-for="mid in s.members" :key="mid"
                            class="flex items-center gap-1 rounded-full border border-line bg-surface-field px-2 py-0.5 text-[10px] text-ink">
                        {{ extractorName(mid) }}
                        <button type="button" class="text-ink-faint transition-colors hover:text-danger"
                                @click="removeMember(s, mid)">✕</button>
                      </span>
                      <button type="button" class="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-faint transition-colors hover:text-gold"
                              @click="resetMembers(s)">{{ t('smart.scheme_reset_members') }}</button>
                    </div>
                    <p class="mb-1.5 text-[10px] leading-relaxed text-ink-faint">{{ t('smart.scheme_members_hint') }}</p>

                    <textarea v-model="s.body" rows="5"
                              class="w-full rounded-lg border border-line bg-surface-field px-2 py-1 font-mono text-xs leading-relaxed text-ink"
                              :placeholder="t('smart.scheme_body_ph')" @change="saveScheme(s)"></textarea>
                  </div>
                </Transition>
              </div>
            </div>

            <!-- 提取器：单个内容的提取单元（内置项同样可改可删，可恢复、可转为规则） -->
            <div class="glass-card mt-4 rounded-2xl p-4 shadow-soft">
              <div class="mb-3 flex items-center justify-between gap-2">
                <span class="text-xs uppercase tracking-wide text-ink-faint">{{ t('smart.extractors_section') }}</span>
                <div class="flex items-center gap-2">
                  <button type="button" class="btn-soft px-2 py-0.5 text-xs"
                          @click="restoreExtractors">{{ t('smart.extractors_restore') }}</button>
                  <!-- 新增入口收成一个 SVG 图标，点击展开新增面板（分隔符/正则/AI 指令三合一） -->
                  <button type="button" class="btn-soft btn-circle p-1.5"
                          v-tip="t('smart.add_extractor')"
                          @click="addingExtractor = !addingExtractor">
                    <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                </div>
              </div>

              <!-- 新增提取器：AI 快捷生成（一句话回填表单）+ 手动配置；生成后确认再添加 -->
              <Transition name="edit-panel">
                <div v-if="addingExtractor" class="mb-2 rounded-xl border border-gold/40 bg-surface-field/60 p-2">
                  <div class="mb-1.5 text-[10px] uppercase tracking-wide text-ink-faint">{{ t('smart.add_extractor') }}</div>
                  <!-- AI 快捷生成：单行输入，回车即生成，产出回填下方表单 -->
                  <div class="mb-1.5 flex items-center gap-1">
                    <input v-model="aiExtractorDesc"
                           class="min-w-0 flex-1 rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                           :placeholder="t('smart.ai_desc_ph')"
                           @keydown.enter.prevent="generateExtractorByAi" />
                    <button type="button" class="btn-soft shrink-0 px-2 py-0.5 text-xs"
                            :disabled="generatingExtractor || !aiExtractorDesc.trim()"
                            @click="generateExtractorByAi">
                      {{ generatingExtractor ? t('smart.ai_generating') : t('smart.ai_generate') }}
                    </button>
                  </div>
                  <div class="mb-1.5 grid grid-cols-2 gap-1.5">
                    <input v-model="newExtractorName"
                           class="w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                           :placeholder="t('smart.extractor_name_ph')" />
                    <input v-model="newExtractorDesc"
                           class="w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                           :placeholder="t('smart.extractor_desc_ph')" />
                  </div>
                  <div class="mb-1.5">
                    <UiSegmented :model-value="newExtractorMethod" :options="EXTRACTOR_METHOD_OPTIONS"
                                 :label="t('smart.extractor_method')"
                                 @update:model-value="(v: string) => newExtractorMethod = v as ClipExtractor['method']" />
                  </div>
                  <input v-if="newExtractorMethod === 'separator'" v-model="draftSeparator"
                         class="w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                         :placeholder="t('smart.extractor_separator_ph')" />
                  <textarea v-else-if="newExtractorMethod === 'regex'" v-model="draftRegex" rows="3"
                            class="w-full rounded-lg border border-line bg-surface-field px-2 py-1 font-mono text-xs leading-relaxed text-ink"
                            :placeholder="t('smart.extractor_regex_ph')"></textarea>
                  <textarea v-else v-model="draftAi" rows="5"
                            class="w-full rounded-lg border border-line bg-surface-field px-2 py-1 font-mono text-xs leading-relaxed text-ink"
                            :placeholder="t('smart.extractor_ai_ph')"></textarea>
                  <div class="mt-1.5 flex justify-end gap-2">
                    <button type="button" class="btn-soft px-2 py-0.5 text-xs"
                            @click="resetExtractorDrafts(); addingExtractor = false">{{ t('common.cancel') }}</button>
                    <button type="button" class="btn-gold px-2 py-0.5 text-xs"
                            @click="submitNewExtractor">{{ t('smart.add_extractor_submit') }}</button>
                  </div>
                </div>
              </Transition>

              <p v-if="extractors.length === 0" class="text-xs text-ink-faint">{{ t('smart.no_extractors') }}</p>
              <!-- 长按拖动排序（与导航配置同一套交互），TransitionGroup 提供平滑让位 -->
              <TransitionGroup name="reorder-list" tag="div" data-extractor-list>
                <div v-for="(x, index) in extractors" :key="x.id"
                     class="extractor-item mb-2 cursor-pointer rounded-xl border border-line bg-surface-field/40 p-2 transition-all duration-200 ease-soft"
                     :class="extractorDraggingKey === x.id ? 'cursor-grabbing opacity-50 scale-[0.98] shadow-float' : ''"
                     :data-reorder-key="x.id"
                     @pointerdown="onExtractorPointerDown(x, $event)">
                  <!-- 折叠态：手柄 + 名称/描述，点「编辑」展开；列表顺序 = 方案执行顺序 -->
                  <div class="flex items-center gap-2">
                    <svg class="h-4 w-4 shrink-0 cursor-grab text-ink-faint/70" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M8 9h.01M8 15h.01M16 9h.01M16 15h.01M12 9h.01M12 15h.01" />
                      <circle cx="8" cy="9" r="0.1" /><circle cx="8" cy="15" r="0.1" />
                      <circle cx="12" cy="9" r="0.1" /><circle cx="12" cy="15" r="0.1" />
                      <circle cx="16" cy="9" r="0.1" /><circle cx="16" cy="15" r="0.1" />
                    </svg>
                    <div class="min-w-0 flex-1 cursor-pointer" @click="onExtractorRowClick(x)">
                      <div class="truncate text-xs text-ink">{{ x.name }}</div>
                      <div class="truncate text-[10px] text-ink-faint">{{ extractorSummary(x) }}</div>
                    </div>
                    <span v-if="x.builtin === 1"
                          class="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[10px] text-ink-faint">{{ t('smart.extractor_builtin') }}</span>
                    <div class="flex shrink-0 flex-col leading-none">
                      <button type="button" class="text-ink-faint transition-colors hover:text-gold disabled:opacity-30"
                              :disabled="index === 0" :title="t('common.move_up')"
                              @click="moveExtractor(index, -1)">
                        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6" /></svg>
                      </button>
                      <button type="button" class="text-ink-faint transition-colors hover:text-gold disabled:opacity-30"
                              :disabled="index === extractors.length - 1" :title="t('common.move_down')"
                              @click="moveExtractor(index, 1)">
                        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                      </button>
                    </div>
                    <button type="button" class="btn-soft shrink-0 px-2 py-0.5 text-xs"
                            @click="editingExtractorId = editingExtractorId === x.id ? null : x.id">
                      {{ editingExtractorId === x.id ? t('smart.collapse') : t('common.edit') }}
                    </button>
                    <button type="button" class="text-ink-faint transition-colors hover:text-danger"
                            @click="removeExtractor(x)">✕</button>
                  </div>
                <Transition name="edit-panel">
                  <div v-if="editingExtractorId === x.id" class="mt-2">
                    <input v-model="x.name" class="mb-1.5 w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                           :placeholder="t('smart.extractor_name_ph')" @change="saveExtractor(x)" />
                    <input v-model="x.desc" class="mb-1.5 w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-[10px] text-ink"
                           :placeholder="t('smart.extractor_desc_ph')" @change="saveExtractor(x)" />
                    <div class="mb-1.5">
                      <UiSegmented :model-value="x.method" :options="EXTRACTOR_METHOD_OPTIONS"
                                   :label="t('smart.extractor_method')"
                                   @update:model-value="(v: string) => { x.method = v as ClipExtractor['method']; saveExtractor(x); }" />
                    </div>
                    <textarea v-model="x.expression" rows="6"
                              class="w-full rounded-lg border border-line bg-surface-field px-2 py-1 font-mono text-xs leading-relaxed text-ink"
                              :placeholder="x.method === 'ai' ? t('smart.extractor_ai_ph') : (x.method === 'separator' ? t('smart.extractor_separator_ph') : t('smart.extractor_regex_ph'))"
                              @change="saveExtractor(x)"></textarea>
                    <textarea v-model="x.sample" rows="3"
                              class="mt-1.5 w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-[10px] text-ink"
                              :placeholder="t('smart.extractor_sample_ph')" @change="saveExtractor(x)"></textarea>
                  </div>
                </Transition>
              </div>
              </TransitionGroup>
              <div class="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2">
                <span class="text-[10px] text-ink-faint">{{ t('smart.ai_cache_window') }}</span>
                <input v-model="aiCacheWindow"
                       class="w-24 rounded-lg border border-line bg-surface-field px-2 py-1 text-right text-xs tabular-nums text-ink" />
              </div>
            </div>
          </div>

          <!-- 通用渲染块（剪贴板/灵动岛/通用/智能与AI 的子组卡片 + 搜索结果）：
               子分组循环渲染分节卡片，卡片内复用同一套设置项控件分支。
               shortcut/about 有独立分支（上方），nav 有独立分支（下方），此处排除 -->
          <div v-if="displaySetting.type !== 'nav' && displaySetting.type !== 'shortcut' && displaySetting.type !== 'about'"
               class="flex flex-col gap-3">
            <!-- 子分组分节卡片：每子组一张（标题行 + 该节设置项）；
                 无命中项的子组（如搜索空结果）不渲染空卡片 -->
            <template v-for="(child, ci) in displaySetting.children ?? []" :key="ci">
              <ul v-if="child.items.length" class="glass-card relative z-10 rounded-2xl shadow-soft">
              <li class="border-b border-accent p-4 pb-2 text-xs uppercase tracking-wide text-ink-faint">
                {{ t(child.title) }}
              </li>
              <!-- 宽控件项（AI 提供商：分段器 + JSON 编辑器）纵向布局占满整行，其余保持左标签右控件两栏 -->
              <li v-for="(item, itemIndex) in child.items" :key="itemIndex"
                  class="p-4"
                  :class="isWideSettingItem(item) ? 'flex flex-col items-stretch gap-2' : 'flex flex-wrap items-center justify-between gap-4'">
                <div>
                  <!-- 图片缓存折叠：label 行本身即点击区（与其他设置行同构，箭头内联在名称前，不引入额外按钮盒撑高行距） -->
                  <div
                      v-if="item.type === 'input' && item.label === 'setting.general.image_limit'"
                      class="flex cursor-pointer select-none items-center gap-1.5"
                      :aria-expanded="imageCacheOpsOpen"
                      v-tip="t('setting.general.image_cache_ops')"
                      @click="imageCacheOpsOpen = !imageCacheOpsOpen"
                  >
                    <svg class="size-3 shrink-0 text-ink-faint transition-transform duration-300 ease-soft" :class="imageCacheOpsOpen ? 'rotate-90' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                    <div class="text-ink">
                      <HighlightText v-if="searchMode" :text="t(item.label)" :highlight-string="settingSearch.trim()" :active="true" :advanced="false" />
                      <template v-else>{{ t(item.label) }}</template>
                    </div>
                  </div>
                  <!-- 默认 label 行：搜索态命中文字高亮；搜索结果项附来源子分组徽章 -->
                  <div v-else class="flex flex-wrap items-center gap-2">
                    <span class="text-ink">
                      <HighlightText v-if="searchMode" :text="t(item.label)" :highlight-string="settingSearch.trim()" :active="true" :advanced="false" />
                      <template v-else>{{ t(item.label) }}</template>
                    </span>
                    <span
                        v-if="item.groupTitle"
                        class="rounded-full border border-line px-1.5 py-0.5 text-[10px] leading-none text-ink-faint"
                    >{{ t(item.groupTitle) }}</span>
                  </div>
                  <div v-if="item.type === 'action' && item.label === 'setting.general.clear_database' && (clearMsg || undoActive)"
                       class="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <span class="text-ink-faint">
                      {{ undoActive ? t('setting.general.clear_undo_hint', { time: undoRemainingLabel }) : clearMsg }}
                    </span>
                    <!-- 撤回：窗口期内整表恢复清空前的数据 -->
                    <button
                        v-if="undoActive"
                        type="button"
                        class="btn-soft px-2 py-0.5 text-xs text-gold"
                        @click="undoClearDatabase"
                    >
                      {{ t('setting.general.clear_undo_btn') }}
                    </button>
                  </div>
                  <!-- 导入确认态：名称下方红字强调替换式覆盖语义（覆盖不可逆，选错文件有代价） -->
                  <div v-if="item.type === 'action' && item.label === 'setting.general.import_data' && showImportConfirm"
                       class="mt-1 text-xs text-danger">
                    {{ t('setting.general.import_confirm_text') }}
                  </div>
                </div>
                <div class="shrink-0" :class="isWideSettingItem(item) ? 'w-full' : 'w-56'">
                  <!-- 操作型设置项（如清空数据库）：二次确认 -->
                  <template v-if="item.type === 'action' && item.label === 'setting.general.clear_database'">
                    <button v-if="!showClearConfirm" type="button"
                            class="btn-soft w-full text-danger"
                            @click="showClearConfirm = true">
                      {{ t('setting.general.clear_database') }}
                    </button>
                    <div v-else class="flex gap-2">
                      <button type="button" class="btn-soft flex-1 text-danger"
                              :disabled="clearing" @click="confirmClearDatabase">
                        {{ clearing ? t('setting.general.clearing') : t('setting.general.clear_confirm_btn') }}
                      </button>
                      <button type="button" class="btn-soft flex-1"
                              :disabled="clearing" @click="showClearConfirm = false">
                        {{ t('common.cancel') }}
                      </button>
                    </div>
                  </template>
                  <!-- 数据备份：导出 JSON（图片以 dataUrl 自包含），一键换机迁移 -->
                  <template v-else-if="item.type === 'action' && item.label === 'setting.general.export_data'">
                    <div class="group relative">
                      <button type="button" class="btn-soft w-full"
                              :disabled="exportingData" @click="exportData">
                        {{ exportingData ? t('setting.general.export_data_doing') : t('setting.general.export_data') }}
                      </button>
                      <!-- 范围说明（备份不含设置与快捷键）：hover 按钮时浮出，不常驻挤占版面 -->
                      <div class="pointer-events-none absolute right-0 top-full z-50 mt-1 hidden w-72 rounded-lg bg-black/85 px-3 py-2 text-xs leading-relaxed text-white group-hover:block">
                        {{ t('setting.general.export_scope_note') }}
                      </div>
                    </div>
                  </template>
                  <!-- 导入备份：二次确认（替换式恢复）→ 系统文件对话框 -->
                  <template v-else-if="item.type === 'action' && item.label === 'setting.general.import_data'">
                    <button v-if="!showImportConfirm" type="button" class="btn-soft w-full"
                            @click="showImportConfirm = true">
                      {{ t('setting.general.import_data') }}
                    </button>
                    <div v-else class="flex gap-2">
                      <button type="button" class="btn-soft flex-1"
                              :disabled="importingData" @click="importDataConfirmed">
                        {{ importingData ? t('setting.general.import_data_doing') : t('setting.general.import_confirm_btn') }}
                      </button>
                      <button type="button" class="btn-soft flex-1"
                              :disabled="importingData" @click="showImportConfirm = false">
                        {{ t('common.cancel') }}
                      </button>
                    </div>
                  </template>
                  <!-- 回看使用引导：bus 事件触发主窗口引导层重新弹出 -->
                  <template v-else-if="item.type === 'action' && item.label === 'setting.general.replay_onboarding'">
                    <button type="button" class="btn-soft w-full" @click="replayOnboarding">
                      {{ t('setting.general.replay_onboarding') }}
                    </button>
                  </template>
                  <!-- 自动备份恢复：展开每日快照列表（保留 7 份），同条目两步确认后替换式恢复 -->
                  <template v-else-if="item.type === 'action' && item.label === 'setting.general.auto_backup_restore'">
                    <div class="group relative">
                      <button type="button" class="btn-soft w-full"
                              :disabled="restoringBackup !== ''" @click="toggleAutoBackupList">
                        {{ autoBackupOpen ? t('common.cancel') : t('setting.general.auto_backup_restore_btn') }}
                      </button>
                      <!-- 范围与覆盖警告说明：hover 按钮时浮出，不常驻挤占版面 -->
                      <div class="pointer-events-none absolute right-0 top-full z-50 mt-1 hidden w-72 rounded-lg bg-black/85 px-3 py-2 text-xs leading-relaxed text-white group-hover:block">
                        {{ t('setting.general.auto_backup_hint') }}
                      </div>
                    </div>
                    <div v-if="autoBackupOpen" class="mt-1 space-y-1">
                      <p v-if="autoBackupLoadingList" class="text-xs text-ink-faint">
                        {{ t('setting.general.auto_backup_loading') }}
                      </p>
                      <p v-else-if="autoBackupList.length === 0" class="text-xs text-ink-faint">
                        {{ t('setting.general.auto_backup_empty') }}
                      </p>
                      <template v-else>
                        <div v-for="name in autoBackupList" :key="name" class="flex items-center gap-1">
                          <span class="flex-1 truncate text-xs text-ink-faint">{{ autoBackupLabel(name) }}</span>
                          <button type="button" class="btn-soft shrink-0 px-2 py-0.5 text-xs"
                                  :class="autoBackupPending === name ? 'text-danger' : ''"
                                  :disabled="restoringBackup !== ''" @click="restoreAutoBackup(name)">
                            {{ restoringBackup === name
                                ? t('setting.general.auto_backup_restoring')
                                : (autoBackupPending === name ? t('setting.general.auto_backup_confirm') : t('setting.general.auto_backup_restore_btn')) }}
                          </button>
                        </div>
                      </template>
                    </div>
                  </template>
                  <!-- AI 连接测试：invoke Rust ai_test_connection（设计文档 §4.2） -->
                  <template v-else-if="item.type === 'action' && item.label === 'setting.general.ai_test'">
                    <button type="button" class="btn-soft w-full"
                            :disabled="aiTestState === 'testing'" @click="testAiConnection">
                      {{ aiTestState === 'testing' ? t('setting.general.ai_testing') : t('setting.general.ai_test') }}
                    </button>
                  </template>
                  <!-- template 包裹保持 v-else-if 链完整：API Key 输入 + 凭据库降级明文警示 -->
                  <template v-else-if="item.type === 'input' && item.label === 'setting.general.api_key'">
                    <SettingInput
                        v-model="apiKey"
                        secret
                        :placeholder="t('setting.general.api_key_placeholder')"
                        @save="showHint(t('setting.general.api_key_saved'))"
                    />
                    <p v-if="aiKeyPlaintext" class="mt-1 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
                      {{ t('setting.general.api_key_plaintext_warn') }}
                    </p>
                  </template>
                  <SettingInput
                      v-else-if="item.type === 'input' && item.label === 'setting.general.ai_base_url'"
                      v-model="aiBaseUrl"
                      :placeholder="t('setting.general.ai_base_url')"
                      @save="showHint(t('setting.general.ai_base_url_saved'))"
                  />
                  <SettingInput
                      v-else-if="item.type === 'input' && item.label === 'setting.general.ai_model'"
                      v-model="aiModel"
                      :placeholder="t('setting.general.ai_model')"
                      @save="showHint(t('setting.general.ai_model_saved'))"
                  />
                  <!-- AI 分析长度上限：Ctrl+B 分析的字数门槛，钳制 100–10000（设计见 .docs/smart-clip-ai-analysis.md） -->
                  <SettingInput
                      v-else-if="item.type === 'input' && item.label === 'setting.general.ai_analysis_max'"
                      v-model="aiAnalysisMax"
                      :placeholder="t('setting.general.ai_analysis_max')"
                      @save="showHint(t('setting.general.ai_analysis_max_saved'))"
                  />
                  <!-- AI 提供商：OpenAI 兼容（默认）/ Anthropic 原生 / 自定义 JSON（设计文档 §4.2） -->
                  <template v-else-if="item.type === 'select' && item.label === 'setting.general.ai_provider'">
                    <UiSegmented
                        :model-value="aiProvider"
                        :options="AI_PROVIDER_OPTIONS"
                        block
                        :label="t('setting.general.ai_provider')"
                        @update:model-value="selectAiProvider"
                    />
                    <!-- 自定义 JSON 模板编辑器：仅 custom 模式显示；结构校验通过才防抖落库 -->
                    <div v-if="aiProvider === 'custom'" class="mt-3 rounded-xl border border-line bg-surface-field/40 p-3">
                      <div class="mb-2 flex items-center justify-between gap-2">
                        <span class="text-sm font-medium text-ink">{{ t('setting.general.ai_custom_config') }}</span>
                        <button type="button" v-tip="t('setting.general.ai_custom_template_tip')"
                                class="btn-soft shrink-0 whitespace-nowrap px-2 py-1 text-xs" @click="applyCustomTemplate">
                          {{ t('setting.general.ai_custom_template') }}
                        </button>
                      </div>
                      <textarea
                          v-model="aiCustomConfig"
                          rows="14"
                          wrap="off"
                          spellcheck="false"
                          class="w-full resize-y overflow-x-auto rounded-lg border border-line bg-surface-field px-2 py-1 font-mono text-xs leading-relaxed text-ink"
                          :placeholder="t('setting.general.ai_custom_placeholder')"
                      ></textarea>
                      <p v-if="aiCustomError" class="mt-1 text-xs text-danger">{{ aiCustomError }}</p>
                      <p v-else class="mt-1 text-xs text-ink-faint">{{ t('setting.general.ai_custom_hint') }}</p>
                    </div>
                  </template>
                  <SettingInput
                      v-else-if="item.type === 'input' && item.label === 'setting.general.clipboard_limit'"
                      v-model="maxLimit"
                      :placeholder="t('setting.general.clipboard_limit_placeholder')"
                      @save="showHint(t('setting.general.clipboard_limit_saved'))"
                  />
                  <!-- 图片缓存上限：输入框与名称同行；占用进度条/操作按钮收进名称前箭头的折叠区 -->
                  <SettingInput
                      v-else-if="item.type === 'input' && item.label === 'setting.general.image_limit'"
                      v-model="imageLimit"
                      :placeholder="t('setting.general.image_limit_placeholder')"
                      @save="showHint(t('setting.general.image_limit_saved'))"
                  />
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.launch_at_startup'"
                      v-model="autoStartEnabled"
                      :label="t('setting.general.launch_at_startup')"
                  />
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.tooltip_window'"
                      v-model="tooltipEnabled"
                      :tip-on="t('setting.general.tooltip_tip_on')" :tip-off="t('setting.general.tooltip_tip_off')"
                      :label="t('setting.general.tooltip_window')"
                      @change="showHint(tooltipEnabled ? t('setting.general.tooltip_on') : t('setting.general.tooltip_off'))"
                  />
                  <!-- 失焦自动隐藏：主窗口失焦后自动收起到托盘；关闭后保持显示，手动收起 -->
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.auto_hide'"
                      :model-value="autoHideEnabled"
                      :label="t('setting.general.auto_hide')"
                      @change="onAutoHideToggle"
                  />
                  <!-- 灵动岛提示：复制/粘贴时屏幕顶部胶囊反馈 -->
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.island_hint'"
                      :model-value="islandEnabled"
                      :tip-on="t('setting.general.island_tip_on')" :tip-off="t('setting.general.island_tip_off')"
                      :label="t('setting.general.island_hint')"
                      @change="onIslandToggle"
                  />
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.search_highlight'"
                      v-model="searchHighlightEnabled"
                      :tip-on="t('setting.shortcuts.click_disable')" :tip-off="t('setting.shortcuts.click_enable')"
                      :label="t('setting.general.search_highlight')"
                      @change="showHint(searchHighlightEnabled ? t('setting.general.highlight_on') : t('setting.general.highlight_off'))"
                  />
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.smart_reminder'"
                      :model-value="smartRemindEnabled"
                      :tip-on="t('setting.general.smart_remind_tip_on')" :tip-off="t('setting.general.smart_remind_tip_off')"
                      :label="t('setting.general.smart_reminder')"
                      @change="onSmartRemindToggle"
                  />
                  <!-- 待办系统通知：仅控制提醒是否弹 OS 级系统通知弹窗，提示音与灵动岛提醒不受影响 -->
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.todo_system_notify'"
                      :model-value="todoSystemNotifyEnabled"
                      :tip-on="t('setting.general.todo_notify_tip_on')" :tip-off="t('setting.general.todo_notify_tip_off')"
                      :label="t('setting.general.todo_system_notify')"
                      @change="onTodoSystemNotifyToggle"
                  />
                  <!-- 隐私模式：一键暂停剪贴板记录（托盘菜单同款开关；开启后复制内容不入库不弹岛） -->
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.privacy_pause'"
                      :model-value="privacyPaused"
                      :tip-on="t('setting.general.privacy_pause_tip_on')" :tip-off="t('setting.general.privacy_pause_tip_off')"
                      :label="t('setting.general.privacy_pause')"
                      @change="onPrivacyPauseToggle"
                  />
                  <!-- 敏感内容防护：命中卡号/验证码/密码形态的文本不落库 -->
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.sensitive_filter'"
                      :model-value="sensitiveFilterEnabled"
                      :tip-on="t('setting.general.sensitive_tip_on')" :tip-off="t('setting.general.sensitive_tip_off')"
                      :label="t('setting.general.sensitive_filter')"
                      @change="onSensitiveFilterToggle"
                  />
                  <!-- 粘贴后恢复原剪贴板：粘贴完成约 1 秒后写回粘贴前内容（默认关闭） -->
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.paste_restore_clipboard'"
                      :model-value="pasteRestoreEnabled"
                      :tip-on="t('setting.general.paste_restore_tip_on')" :tip-off="t('setting.general.paste_restore_tip_off')"
                      :label="t('setting.general.paste_restore_clipboard')"
                      @change="onPasteRestoreToggle"
                  />
                  <!-- 剪贴板预览换行：默认关闭（每行保持原始单行，超宽内容横向滚动） -->
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.tooltip_wrap'"
                      :model-value="tooltipWrapEnabled"
                      :tip-on="t('setting.general.tooltip_wrap_tip_on')" :tip-off="t('setting.general.tooltip_wrap_tip_off')"
                      :label="t('setting.general.tooltip_wrap')"
                      @change="onTooltipWrapToggle"
                  />
                  <!-- 应用使用时长记录：默认关闭（隐私），开启后 Rust 侧监听前台应用并按天累计 -->
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.app_usage_tracking'"
                      :model-value="appUsageEnabled"
                      :tip-on="t('setting.general.app_usage_tip_on')" :tip-off="t('setting.general.app_usage_tip_off')"
                      :label="t('setting.general.app_usage_tracking')"
                      @change="onAppUsageToggle"
                  />
                  <!-- 语言：跟随系统 / 中文 / English（放在配色兜底分支之前） -->
                  <UiDropdown
                      v-else-if="item.type === 'select' && item.label === 'setting.general.locale'"
                      class="w-full"
                      align="end"
                      match-trigger-width
                      :aria-label="t('setting.general.locale')"
                      panel-class="glass-card menu w-full rounded-2xl p-2"
                  >
                    <template #trigger="{ open }">
                      <button type="button" tabindex="-1" class="btn-soft flex w-full items-center justify-between rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink">
                        <span>{{ localeLabel }}</span>
                        <svg class="h-4 w-4 opacity-60 transition-transform duration-200" :class="open ? 'rotate-180' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                    </template>
                    <ul class="menu p-2">
                      <li v-for="opt in localeOptions" :key="opt.value">
                        <button
                            type="button"
                            class="flex w-full items-center justify-between rounded-xl"
                            :class="localeMode === opt.value ? 'text-gold' : ''"
                            @click="selectLocale(opt.value)"
                        >
                          <span>{{ opt.label }}</span>
                          <svg v-if="localeMode === opt.value" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        </button>
                      </li>
                    </ul>
                  </UiDropdown>
                  <!-- 窗口弹出位置：三选一分段控件（跟随系统风格，选中金色高亮） -->
                  <UiSegmented
                      v-else-if="item.type === 'select' && item.label === 'setting.general.popup_position'"
                      :model-value="popupPositionMode"
                      :options="POPUP_POSITION_OPTIONS"
                      block
                      :label="t('setting.general.popup_position')"
                      @update:model-value="selectPopupPosition"
                  />
                  <!-- 灵动岛出现延迟 / 停留时长：自由输入毫秒值（默认值见占位提示，失焦钳制生效） -->
                  <SettingInput
                      v-else-if="item.type === 'input' && item.label === 'setting.general.island_delay'"
                      v-model="islandDelayInput"
                      :placeholder="t('setting.general.island_delay_placeholder')"
                      @save="saveIslandDelay"
                  />
                  <SettingInput
                      v-else-if="item.type === 'input' && item.label === 'setting.general.island_duration'"
                      v-model="islandDurationInput"
                      :placeholder="t('setting.general.island_duration_placeholder')"
                      @save="saveIslandDuration"
                  />
                  <!-- 配色：琥珀/跟随系统/浅色/深色，与标题栏按钮、配色快捷键（默认不绑定）共用同一状态 -->
                  <UiDropdown
                      v-else-if="item.type === 'select'"
                      class="w-full"
                      align="end"
                      match-trigger-width
                      :aria-label="t('setting.general.color_scheme')"
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
                <!-- 图片缓存展开区：名称前箭头切换（默认折叠）；跨全行布局，进度条不再被右列宽度挤压 -->
                <div
                    v-if="item.type === 'input' && item.label === 'setting.general.image_limit' && imageCacheOpsOpen"
                    class="flex w-full min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-2"
                >
                  <div class="h-1.5 min-w-40 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div
                        class="h-full rounded-full bg-gold transition-[width] duration-500"
                        :style="{ width: imageCachePercent + '%' }"
                    />
                  </div>
                  <span class="whitespace-nowrap text-xs text-ink-soft">{{ imageCacheUsageText }}</span>
                  <!-- 立即清理：两步确认（与清空数据库同款），确认后进入 5 秒撤回窗口 -->
                  <button
                      v-if="!showCacheCleanConfirm"
                      type="button"
                      class="btn-soft whitespace-nowrap rounded-full px-3 py-1 text-xs text-danger"
                      @click="showCacheCleanConfirm = true"
                  >
                    {{ t('setting.general.image_cache_clean_now') }}
                  </button>
                  <div v-else class="flex gap-2">
                    <button
                        type="button"
                        class="btn-soft whitespace-nowrap rounded-full px-3 py-1 text-xs text-danger disabled:opacity-50"
                        :disabled="imageCacheCleaning"
                        @click="confirmCleanImageCache"
                    >
                      {{ imageCacheCleaning ? t('setting.general.image_cache_cleaning') : t('setting.general.image_cache_clean_confirm') }}
                    </button>
                    <button
                        type="button"
                        class="btn-soft whitespace-nowrap rounded-full px-3 py-1 text-xs disabled:opacity-50"
                        :disabled="imageCacheCleaning"
                        @click="showCacheCleanConfirm = false"
                    >
                      {{ t('common.cancel') }}
                    </button>
                  </div>
                  <!-- 打开缓存：资源管理器查看图片缓存目录 -->
                  <button
                      type="button"
                      class="btn-soft whitespace-nowrap rounded-full px-3 py-1 text-xs"
                      @click="openImageCacheFolder"
                  >
                    {{ t('setting.general.image_cache_open') }}
                  </button>
                  <!-- 清理结果 / 5 秒撤回窗口提示（与清空数据库同款：倒计时 + 撤回按钮） -->
                  <div
                      v-if="cacheUndoActive || cacheMsg"
                      class="flex w-full min-w-0 basis-full flex-wrap items-center gap-2 text-xs"
                  >
                    <span class="text-ink-faint">
                      {{ cacheUndoActive ? t('setting.general.image_cache_undo_hint', { mb: cacheFreedMb, n: cacheUndoRemaining }) : cacheMsg }}
                    </span>
                    <button
                        v-if="cacheUndoActive"
                        type="button"
                        class="btn-soft px-2 py-0.5 text-xs text-gold"
                        @click="undoImageCleanup"
                    >
                      {{ t('setting.general.clear_undo_btn') }}
                    </button>
                  </div>
                </div>
                <!-- AI 连接测试结果：显示在测试按钮下方（跨全行），错误格式化为状态行 + 可读原因 -->
                <div v-if="item.type === 'action' && item.label === 'setting.general.ai_test' && aiTestState !== 'idle'"
                     class="w-full min-w-0 basis-full text-xs">
                  <span :class="aiTestState === 'testing' ? 'text-ink-faint' : aiTestState === 'ok' ? aiTestLatencyClass : 'text-danger'">
                    {{ aiTestState === 'testing' ? t('setting.general.ai_testing')
                      : aiTestState === 'ok' ? t('setting.general.ai_test_ok', { ms: aiTestLatency })
                      : t('setting.general.ai_test_fail_brief') }}
                  </span>
                  <!-- 主窗口显示完整错误：状态行 + 可读原因 + 完整原文（灵动岛只提示关键内容） -->
                  <div v-if="aiTestState === 'fail' && aiTestError"
                       class="mt-1 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2">
                    <div v-if="aiTestParsed.status" class="text-[11px] font-medium tracking-wide text-danger/80">{{ aiTestParsed.status }}</div>
                    <div v-if="aiTestParsed.message !== aiTestParsed.full" class="mt-0.5 leading-relaxed text-danger">{{ aiTestParsed.message }}</div>
                    <div class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-danger/70">{{ aiTestParsed.full }}</div>
                  </div>
                </div>
              </li>
              </ul>
            </template>

            <!-- 搜索态辅助区：标题命中的分组跳转入口 + 无任何匹配时的空态提示 -->
            <template v-if="searchMode">
              <div v-if="matchedGroups.length" class="glass-card rounded-2xl p-4 shadow-soft">
                <div class="mb-2 text-xs uppercase tracking-wide text-ink-faint">{{ t('setting.search.jump') }}</div>
                <div class="flex flex-wrap gap-2">
                  <button
                      v-for="g in matchedGroups"
                      :key="g.title"
                      type="button"
                      class="btn-soft px-3 py-1.5 text-xs"
                      @click="clearSearchAndGo(g)"
                  >
                    {{ t(g.title) }}
                  </button>
                </div>
              </div>
              <p
                  v-if="!searchResultGroup.items.length && !matchedGroups.length"
                  class="mt-6 text-center text-xs text-ink-faint"
              >
                {{ t('setting.search.empty') }}
              </p>
            </template>

            <!-- 灵动岛 API：第三方应用集成入口（本地 HTTP/SSE，接入文档 .docs/island-api.md）。
                 挂在灵动岛分组尾部；用 activeSetting（非 displaySetting）守卫，搜索态不重复出现。
                 标题行点击折叠/展开（chevron 指示），开关独立于折叠 -->
            <div v-if="islandCardsVisible" class="glass-card rounded-2xl p-4 shadow-soft">
              <div class="flex items-center justify-between">
                <button type="button" class="flex select-none items-center gap-1.5 text-ink-faint transition-colors hover:text-ink"
                        :aria-expanded="islandApiOpen" @click="islandApiOpen = !islandApiOpen">
                  <svg class="h-3 w-3 transition-transform duration-200" :class="islandApiOpen ? 'rotate-90' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                  <span class="text-xs uppercase tracking-wide">
                    <!-- 搜索态标题命中高亮（与设置项 label 一致） -->
                    <HighlightText v-if="searchMode" :text="t('island_api.section')" :highlight-string="settingSearch.trim()" :active="true" :advanced="false" />
                    <template v-else>{{ t('island_api.section') }}</template>
                  </span>
                </button>
                <UiToggleSwitch v-model="islandApiEnabled" :label="''" />
              </div>
              <!-- 间距放内容区而非标题行：折叠时标题行零余量，与 Webhook 卡片同高同居中 -->
              <div v-show="islandApiOpen" class="mt-3">
                <div class="flex items-center gap-2">
                  <input v-model="islandApiPort" class="w-28 rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                         :placeholder="t('island_api.port')" @change="islandApiPort = String(Number(islandApiPort) || ISLAND_API_DEFAULT_PORT)" />
                  <input v-model="islandApiToken" type="password" autocomplete="off" spellcheck="false"
                         class="min-w-0 flex-1 rounded-lg border border-line bg-surface-field px-2 py-1 font-mono text-xs text-ink"
                         :placeholder="t('island_api.token')" />
                  <button class="shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink transition-colors hover:bg-surface-field"
                          @click="copyIslandApiToken">
                    {{ t('island_api.copy') }}
                  </button>
                  <button class="shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink transition-colors hover:bg-surface-field"
                          @click="regenerateIslandApiToken">
                    {{ t('island_api.regenerate') }}
                  </button>
                </div>
                <p class="mt-2 text-[10px] leading-relaxed text-ink-faint">
                  {{ t('island_api.hint', { port: islandApiPort }) }}
                </p>
                <p v-if="islandApiError" class="mt-1 text-[10px] leading-relaxed text-red-600 dark:text-red-400">
                  {{ t('island_api.failed', { reason: islandApiError }) }}
                </p>
              </div>
            </div>

            <!-- Webhook 出站推送：岛显示事件实时转发外部 URL（文档 §8）。
                 与灵动岛 API 平级的独立折叠卡片：折叠互不影响 -->
            <div v-if="islandCardsVisible" class="glass-card rounded-2xl p-4 shadow-soft">
              <div class="flex items-center justify-between">
                <button type="button" class="flex select-none items-center gap-1.5 text-ink-faint transition-colors hover:text-ink"
                        :aria-expanded="webhookOpen" @click="webhookOpen = !webhookOpen">
                  <svg class="h-3 w-3 transition-transform duration-200" :class="webhookOpen ? 'rotate-90' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                  <span class="text-xs uppercase tracking-wide">
                    <HighlightText v-if="searchMode" :text="t('island_webhook.section')" :highlight-string="settingSearch.trim()" :active="true" :advanced="false" />
                    <template v-else>{{ t('island_webhook.section') }}</template>
                  </span>
                </button>
                <UiToggleSwitch v-model="webhookEnabled" :label="''" />
              </div>
              <!-- 间距放内容区（与灵动岛 API 卡片同款）：折叠时标题行零余量 -->
              <div v-show="webhookOpen" class="mt-3">
                <ul v-if="webhookTargets.length" class="flex flex-col gap-2">
                  <li v-for="tg in webhookTargets" :key="tg.id" class="flex items-center gap-2">
                    <input v-model="tg.url" :placeholder="t('island_webhook.url')"
                           class="min-w-0 flex-1 rounded-lg border bg-surface-field px-2 py-1 text-xs text-ink"
                           :class="tg.url.trim() && !validateWebhookUrl(tg.url.trim()) ? 'border-danger' : 'border-line'" />
                    <input v-model="tg.secret" :placeholder="t('island_webhook.secret')"
                           class="w-24 shrink-0 rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink" />
                    <button class="shrink-0 rounded-lg p-1 text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger"
                            :title="t('island_webhook.remove')" @click="removeWebhookTarget(tg.id)">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </li>
                </ul>
                <div class="mt-2 flex items-center gap-2">
                  <button class="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink transition-colors hover:bg-surface-field"
                          @click="addWebhookTarget">
                    {{ t('island_webhook.add') }}
                  </button>
                  <button :disabled="webhookTesting || !editingWebhookTargets.length"
                          class="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink transition-colors hover:bg-surface-field disabled:cursor-not-allowed disabled:opacity-50"
                          @click="testWebhook">
                    {{ t('island_webhook.test') }}
                  </button>
                </div>
                <p class="mt-2 text-[10px] leading-relaxed text-ink-faint">
                  {{ t('island_webhook.hint') }}
                </p>
              </div>
            </div>
          </div>

          <!-- 导航栏设置：tab 顺序与显示开关（剪贴板/设置强制保留；统计受解锁门槛控制） -->
          <div v-else-if="displaySetting.type === 'nav'" class="flex flex-col gap-4">
            <div class="glass-card rounded-2xl shadow-soft" data-nav-config-list>
              <TransitionGroup name="reorder-list" tag="ul">
                <li key="__header__" class="border-b border-accent p-4 pb-2 text-xs uppercase tracking-wide text-ink-faint">
                  {{ t('setting.shortcuts.nav_section_title') }}
                </li>
                <li
                    v-for="row in navRows"
                    :key="row.key"
                    class="nav-config-item flex cursor-pointer items-center justify-between gap-4 border-b border-accent/50 p-4 last:border-b-0 transition-all duration-200 ease-soft"
                    :class="navDraggingKey === row.key ? 'cursor-grabbing bg-gold/10 opacity-50 scale-[0.98]' : ''"
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
                    <div class="flex items-center gap-1.5 text-ink" :class="{ 'opacity-50': !row.enabled }">
                      {{ t('titlebar.' + row.key) }}
                      <svg v-if="row.locked" class="h-3.5 w-3.5 text-ink-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="5" y="11" width="14" height="10" rx="2" />
                        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                      </svg>
                    </div>
                    <div v-if="row.locked" class="text-xs text-ink-faint">{{ t('setting.shortcuts.builtin_locked') }}</div>
                  </div>
                </div>
                <!-- 右侧操作：内置项显示锁定图标；未解锁统计显示禁用开关；其余为可切换胶囊开关 -->
                <svg
                    v-if="row.locked"
                    class="h-4 w-4 text-ink-faint/70"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round"
                    v-tip="t('setting.shortcuts.builtin_locked')"
                >
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
                <UiToggleSwitch
                    v-else
                    :model-value="row.enabled"
                    :tip-on="t('setting.shortcuts.nav_hide_tip')" :tip-off="t('setting.shortcuts.nav_show_tip')"
                    :label="t('titlebar.' + row.key)"
                    @change="onNavRowToggle(row)"
                />
              </li>
              </TransitionGroup>
            </div>
            <p class="text-xs text-ink-faint">
              {{ t('setting.shortcuts.nav_hint') }}
            </p>
          </div>
        </div>
        </Transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 折叠编辑区展开/收起动画：与待办卡片（Todoitem）的 edit-panel 同一套观感
   （淡入 + 轻微下移 + 缩放），保证设置页与待办页的展开反馈一致 */
.edit-panel-enter-active {
  transition: opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.edit-panel-enter-from {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}
.edit-panel-leave-active {
  transition: opacity 0.16s ease-in,
    transform 0.16s cubic-bezier(0.4, 0, 1, 1);
}
.edit-panel-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.99);
}
</style>
