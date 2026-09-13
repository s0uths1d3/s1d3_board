<script lang="ts">
// 模块级：跨组件挂载保留选中的设置分类。设置页随 Tab 切换被卸载/重建，
// 组件内 ref 会重置为第一项，导致每次进入设置都先闪现第一组、再跳到上次分类。
let lastActiveSettingTitle: string | null = null;
</script>

<script setup lang="ts">
import { ref, computed, onMounted, watch, onBeforeUnmount, nextTick } from 'vue';
import {
  shortcuts, updateShortcutKey, resetShortcut, resetAllShortcuts,
  toggleShortcutEnabled, setShortcutGroupEnabled, resetShortcutGroup,
} from "~/src/commands/shortcuts/InitShortcuts";
import { formatShortcutForDisplay, parseKeyEvent } from "~/utils/shortcutFormat";
import { getOsTypeFromNavigator } from "~/utils/systemOS";
import dbService from '~/src/db/dbService';
import { invoke } from '@tauri-apps/api/core';
import type { ClipRule, ClipTemplate } from '~/src/entities';
import type { SmartClipMode } from '~/src/smart-clip/types';
import { updateSmartClipConfig } from '~/src/smart-clip/smartClip';
import { OPEN_API_DEFAULT_PORT, applyOpenApi } from '~/src/smart-clip/openApi';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { isTauri } from '~/utils/env';
import { useTooltipEnabled } from '~/composables/useTooltipEnabled';
import { usePopupPosition, setPopupPositionMode, type PopupPositionMode } from '~/composables/usePopupPosition';
import { useColorScheme, setColorScheme, COLOR_SCHEME_LABELS, COLOR_SCHEME_ORDER, type ColorSchemeMode } from '~/composables/useColorScheme';
import { useI18n, setLocaleMode, LOCALES, type LocaleMode } from '~/composables/useI18n';
import { useTodoSmartRemind, setTodoSmartRemindEnabled } from '~/composables/useTodoSmartRemind';
import { useSearchHighlight } from '~/composables/useSearchHighlight';
import { appUsageEnabled, setAppUsageEnabled } from '~/composables/useAppUsage';
import { navRows, reorderTab, persistNavConfig, setTabEnabled } from '~/composables/useTabs';
import { useLongPressReorder } from '~/composables/useLongPressReorder';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { writeText } from 'tauri-plugin-clipboard-api';
import appIcon from '~/assets/icon/icon.png';
import ShortcutRow from '~/components/setting/ShortcutRow.vue';

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
  await setLocaleMode(value);
  showHint(t('setting.general.locale_changed', { name: localeOptions.value.find(o => o.value === value)?.label ?? '' }));
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
  await dbService.setKeyValue('tooltip_enabled', val ? '1' : '0');
});

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

/** 应用使用时长记录开关：默认关闭（隐私）；切换失败时 composable 已回滚 UI，这里提示重试 */
async function onAppUsageToggle(val: boolean) {
  try {
    await setAppUsageEnabled(val);
    showHint(val ? t('setting.general.app_usage_on') : t('setting.general.app_usage_off'));
  } catch {
    showHint(t('setting.general.app_usage_failed'));
  }
}
watch(searchHighlightEnabled, async (val) => {
  await dbService.setKeyValue('search_highlight_enabled', val ? '1' : '0');
});
// 实时保存：文本输入加 400ms 防抖——API key / 最大数量是逐字符输入，
// 每键一次 INSERT...ON CONFLICT 写库纯属浪费；停止输入后统一落库一次。
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
function debouncePersist(key: string, write: () => Promise<void>, delay = 400) {
  const t = pendingWrites.get(key);
  if (t) clearTimeout(t);
  pendingWrites.set(key, setTimeout(() => {
    pendingWrites.delete(key);
    void write();
  }, delay));
}
onBeforeUnmount(() => {
  // 卸载时把未落库的输入立即写库，避免最后一段输入丢失
  for (const t of pendingWrites.values()) clearTimeout(t);
  pendingWrites.clear();
});
watch(apiKey, async (val) => {
  debouncePersist('api_key', () => dbService.setKeyValue('api_key', val ?? ''));
});
watch(maxLimit, async (val) => {
  debouncePersist('max_save_count', () => dbService.setKeyValue('max_save_count', val ?? ''));
});

// ===== AI 通道配置（设计文档 §4.2）：提供商 / 地址 / 模型 + 连接测试 =====
type AiProviderKind = 'openai-compat' | 'anthropic';
const aiProvider = ref<AiProviderKind>('openai-compat');
const aiBaseUrl = ref('');
const aiModel = ref('');
const aiTestState = ref<'idle' | 'testing' | 'ok' | 'fail'>('idle');
const aiTestLatency = ref(0);
const aiTestError = ref('');
const AI_PROVIDER_OPTIONS = computed(() => [
  { value: 'openai-compat' as const, label: t('setting.general.ai_provider_openai') },
  { value: 'anthropic' as const, label: t('setting.general.ai_provider_anthropic') },
]);
function selectAiProvider(v: string) {
  aiProvider.value = v as AiProviderKind;
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
/** 连接测试：invoke Rust ai_test_connection（请求细节在 Rust 侧，Key 不进 fetch） */
async function testAiConnection(): Promise<void> {
  if (aiTestState.value === 'testing') return;
  const key = await dbService.getKeyValue('api_key');
  if (!key) {
    showHint(t('setting.general.api_key_missing'));
    return;
  }
  aiTestState.value = 'testing';
  try {
    const res = await invoke<{ ok: boolean; latency_ms: number; error?: string }>(
      'ai_test_connection',
      { provider: aiProvider.value, baseUrl: aiBaseUrl.value, apiKey: key, model: aiModel.value },
    );
    aiTestLatency.value = res.latency_ms;
    aiTestState.value = res.ok ? 'ok' : 'fail';
    aiTestError.value = res.error ?? '';
    showHint(res.ok
      ? t('setting.general.ai_test_ok', { ms: res.latency_ms })
      : t('setting.general.ai_test_fail', { error: res.error ?? '' }));
  } catch (e) {
    aiTestState.value = 'fail';
    aiTestError.value = String(e);
    showHint(t('setting.general.ai_test_fail', { error: String(e) }));
  }
}

// ===== 智能剪贴板（设计文档 §4.1/§4.3/§4.5）：模式 / 规则 / 模板 / 开放 API =====
const smartMode = ref<SmartClipMode>('off');
const rules = ref<ClipRule[]>([]);
const templates = ref<ClipTemplate[]>([]);
const defaultRuleId = ref('');
const defaultTemplateId = ref('');
const openApiEnabled = ref(false);
const openApiPort = ref(String(OPEN_API_DEFAULT_PORT));
const openApiToken = ref('');

const SMART_MODE_OPTIONS = computed(() => [
  { value: 'off' as const, label: t('smart.mode_off') },
  { value: 'rule' as const, label: t('smart.mode_rule') },
  { value: 'ai' as const, label: t('smart.mode_ai') },
]);
function selectSmartMode(v: string) {
  smartMode.value = v as SmartClipMode;
}
const RULE_TYPE_OPTIONS = computed(() => [
  { value: 'separator' as const, label: t('smart.type_separator') },
  { value: 'regex' as const, label: t('smart.type_regex') },
]);
const defaultRuleLabel = computed(() => {
  const r = rules.value.find((x) => x.id === defaultRuleId.value);
  return r ? r.name : t('smart.none');
});
const defaultTemplateLabel = computed(() => {
  const tpl = templates.value.find((x) => x.id === defaultTemplateId.value);
  return tpl ? tpl.name : t('smart.none');
});

/** 把当前配置快照推送给处理层（smartClip 的 mode/rule/template 缓存） */
function refreshSmartClipConfig(): void {
  const rule = rules.value.find((r) => r.id === defaultRuleId.value && r.enabled === 1) ?? null;
  const template = templates.value.find((x) => x.id === defaultTemplateId.value && x.enabled === 1) ?? null;
  updateSmartClipConfig({ mode: smartMode.value, rule, template });
}

function addRule(): void {
  const rule: ClipRule = {
    id: crypto.randomUUID(),
    name: t('smart.new_rule'),
    type: 'separator',
    pattern: '\n',
    priority: 0,
    enabled: 1,
  };
  rules.value.unshift(rule);
  defaultRuleId.value = rule.id;
  void dbService.saveClipRule(rule);
  refreshSmartClipConfig();
}

function saveRule(rule: ClipRule): void {
  if (!rule.name.trim() || !rule.pattern.trim()) return;
  void dbService.saveClipRule(rule);
  refreshSmartClipConfig();
}

async function removeRule(rule: ClipRule): Promise<void> {
  rules.value = rules.value.filter((r) => r.id !== rule.id);
  if (defaultRuleId.value === rule.id) defaultRuleId.value = '';
  await dbService.deleteClipRule(rule.id);
  refreshSmartClipConfig();
}

function addTemplate(): void {
  const tpl: ClipTemplate = {
    id: crypto.randomUUID(),
    name: t('smart.new_template'),
    body: '{content}',
    enabled: 1,
  };
  templates.value.unshift(tpl);
  defaultTemplateId.value = tpl.id;
  void dbService.saveClipTemplate(tpl);
  refreshSmartClipConfig();
}

function saveTemplate(tpl: ClipTemplate): void {
  if (!tpl.name.trim() || !tpl.body.trim()) return;
  void dbService.saveClipTemplate(tpl);
  refreshSmartClipConfig();
}

async function removeTemplate(tpl: ClipTemplate): Promise<void> {
  templates.value = templates.value.filter((x) => x.id !== tpl.id);
  if (defaultTemplateId.value === tpl.id) defaultTemplateId.value = '';
  await dbService.deleteClipTemplate(tpl.id);
  refreshSmartClipConfig();
}

// 开放 API：开关/端口/令牌任一变化即应用（非法端口不应用，避免打字过程误触发）
watch([openApiEnabled, openApiPort, openApiToken], async ([en, p, tk]) => {
  const portNum = Number(p);
  if (!en) {
    await applyOpenApi(false, portNum || OPEN_API_DEFAULT_PORT, tk);
    return;
  }
  if (!portNum || portNum < 1 || portNum > 65535) return;
  await applyOpenApi(true, portNum, tk);
});

// 处理模式/默认规则/默认模板变化：持久化 + 推送配置快照给处理层
watch(smartMode, (val) => {
  void dbService.setKeyValue('smart_clip_mode', val);
  refreshSmartClipConfig();
});
watch(defaultRuleId, (val) => {
  void dbService.setKeyValue('smart_default_rule_id', val);
  refreshSmartClipConfig();
});
watch(defaultTemplateId, (val) => {
  void dbService.setKeyValue('smart_default_template_id', val);
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
      showHint(t('setting.general.startup_dev_unsupported'));
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
    showHint(t('setting.general.startup_failed'));
  }
});

// 清空数据库：二次确认状态
const showClearConfirm = ref(false);
const clearing = ref(false);
const clearMsg = ref('');

// ===== 5 秒撤回窗口：清空后数据先备份到 clear_backup_* 表，期间可整表恢复，超时丢弃备份 =====
const undoActive = ref(false);
const undoRemaining = ref(5);
let undoCountdownTimer: ReturnType<typeof setInterval> | null = null;
let undoExpireTimer: ReturnType<typeof setTimeout> | null = null;

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
    // 开启 5 秒撤回窗口：倒计时归零后自动丢弃备份
    undoRemaining.value = 5;
    undoActive.value = true;
    undoCountdownTimer = setInterval(() => {
      undoRemaining.value = Math.max(0, undoRemaining.value - 1);
    }, 1000);
    undoExpireTimer = setTimeout(() => {
      void expireUndoWindow().then(() => {
        if (!clearMsg.value) clearMsg.value = t('setting.general.cleared_detail');
      });
    }, 5000);
  } catch (e) {
    clearMsg.value = t('setting.general.clear_failed') + (e as Error).message;
  } finally {
    clearing.value = false;
    showClearConfirm.value = false;
  }
}

// 组件卸载（切走设置页）时窗口随界面结束：停表并丢弃备份，避免备份悬挂到下次启动
onBeforeUnmount(() => {
  if (undoActive.value) {
    void expireUndoWindow();
  } else {
    stopUndoTimers();
  }
});

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
    title: 'setting.categories.api',
    type: 'ai_setting',
    items: [
      {
        label: 'setting.general.ai_provider',
        value: '',
        type: 'select'
      },
      {
        label: 'setting.general.ai_base_url',
        value: '',
        type: 'input'
      },
      {
        label: 'setting.general.ai_model',
        value: '',
        type: 'input'
      },
      {
        label: 'setting.general.ai_test',
        value: '',
        type: 'action'
      },
      {
        label: 'setting.general.api_key',
        value: '',
        type: 'input'
      }
    ]
  },
  {
    title: 'setting.categories.smart',
    type: 'smart',
    items: []
  },
  {
    title: 'setting.categories.general',
    type: 'general',    items: [
      {
        label: 'setting.general.clipboard_limit',
        value: '',
        type: 'input'
      },
      {
        label: 'setting.general.launch_at_startup',
        value: '',
        type: 'checkbox'
      },
      {
        label: 'setting.general.tooltip_window',
        value: '',
        type: 'checkbox'
      },
      {
        label: 'setting.general.smart_reminder',
        value: '',
        type: 'checkbox'
      },
      {
        label: 'setting.general.app_usage_tracking',
        value: '',
        type: 'checkbox'
      },
      {
        label: 'setting.general.popup_position',
        value: '',
        type: 'select'
      },
      {
        label: 'setting.general.search_highlight',
        value: '',
        type: 'checkbox'
      },
      {
        label: 'setting.general.color_scheme',
        value: '',
        type: 'select'
      },
      {
        label: 'setting.general.locale',
        value: '',
        type: 'select'
      },
      {
        label: 'setting.general.clear_database',
        value: '',
        type: 'action'
      }
    ]
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
 * 手动点击时用 toast 给出各结果提示；进入「关于」页的自动检查静默执行（卡片内状态仍更新）。
 */
async function checkUpdate(options?: { silent?: boolean }) {
  const silent = options?.silent ?? false;
  if (updateState.value === 'checking') return;
  updateState.value = 'checking';
  if (!silent) showHint(t('setting.about.checking_hint'));
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
    if (!silent) showHint(t('setting.about.update_failed_hint'));
  }
}

async function openRepoPage() {
  try {
    if (isTauri()) await openUrl(APP_REPO);
    else window.open(APP_REPO, '_blank', 'noopener');
  } catch (e) {
    console.error('打开主页失败:', e);
    showHint(t('setting.about.open_repo_failed'));
  }
}

async function openReleasePage() {
  const url = releaseUrl.value || `${APP_REPO}/releases`;
  try {
    if (isTauri()) await openUrl(url);
    else window.open(url, '_blank', 'noopener');
  } catch (e) {
    console.error('打开发布页失败:', e);
    showHint(t('setting.about.open_release_failed'));
  }
}

async function copyRepoLink() {
  try {
    if (isTauri()) await writeText(APP_REPO);
    else await navigator.clipboard.writeText(APP_REPO);
    showHint(t('setting.about.repo_link_copied'));
  } catch (e) {
    console.error('复制链接失败:', e);
    showHint(t('setting.about.copy_failed'));
  }
}

// 首次进入「关于」页时自动静默检查一次更新（会话内仅一次，不弹 toast 打扰）
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
    showHint(t('setting.shortcuts.save_failed') + err);
  } else {
    delete errorMap.value[id];
    showHint(t('setting.shortcuts.saved_hint'));
  }
}

async function resetOne(id: string) {
  const err = await resetShortcut(id);
  if (err) {
    errorMap.value[id] = err;
    showHint(t('setting.shortcuts.reset_failed') + err);
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
  if (hintTimer) clearTimeout(hintTimer);
});

onMounted(async () => {
  osType.value = getOsTypeFromNavigator();
  maxLimit.value = await dbService.getKeyValue('max_save_count');
  apiKey.value = await dbService.getKeyValue('api_key');
  // AI 通道配置恢复（设计文档 §4.2）：提供商缺省 openai-compat
  aiProvider.value = ((await dbService.getKeyValue('ai_provider')) || 'openai-compat') as AiProviderKind;
  aiBaseUrl.value = await dbService.getKeyValue('ai_base_url');
  aiModel.value = await dbService.getKeyValue('ai_model');
  // 智能剪贴板配置恢复（设计文档 §4.1/§4.3/§4.5）+ 推送处理层快照
  try {
    smartMode.value = ((await dbService.getKeyValue('smart_clip_mode')) || 'off') as SmartClipMode;
    defaultRuleId.value = await dbService.getKeyValue('smart_default_rule_id');
    defaultTemplateId.value = await dbService.getKeyValue('smart_default_template_id');
    rules.value = await dbService.fetchClipRules();
    templates.value = await dbService.fetchClipTemplates();
    openApiEnabled.value = (await dbService.getKeyValue('open_api_enabled')) === '1';
    openApiPort.value = (await dbService.getKeyValue('open_api_port')) || String(OPEN_API_DEFAULT_PORT);
    openApiToken.value = await dbService.getKeyValue('open_api_token');
    refreshSmartClipConfig();
  } catch (e) {
    console.error('智能剪贴板配置恢复失败:', e);
  }
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
              {{ t(setting.title) }}
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
                <li v-for="item in group.items" :key="item.id">
                  <ShortcutRow
                      :item="item"
                      :recording="recordingId === item.id"
                      :error="errorMap[item.id]"
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
                      :error="errorMap[item.id]"
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
          <div v-else-if="activeSetting.type === 'about'" class="flex flex-col gap-4">
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

          <!-- 智能剪贴板：处理模式 / 默认规则与模板 / 规则与模板管理 / 开放 API（设计文档 §4/§5） -->
          <div v-else-if="activeSetting.type === 'smart'">
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

            <!-- 默认规则与模板（下拉，选项来自下方列表） -->
            <div class="glass-card mt-4 rounded-2xl p-4 shadow-soft">
              <div class="mb-2 text-xs uppercase tracking-wide text-ink-faint">{{ t('smart.defaults_section') }}</div>
              <div class="mb-3">
                <div class="mb-1 text-xs text-ink-faint">{{ t('smart.default_rule') }}</div>
                <select v-model="defaultRuleId" class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink">
                  <option value="">{{ t('smart.none') }}</option>
                  <option v-for="r in rules" :key="r.id" :value="r.id">{{ r.name }}</option>
                </select>
              </div>
              <div>
                <div class="mb-1 text-xs text-ink-faint">{{ t('smart.default_template') }}</div>
                <select v-model="defaultTemplateId" class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink">
                  <option value="">{{ t('smart.none') }}</option>
                  <option v-for="tpl in templates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
                </select>
              </div>
            </div>

            <!-- 规则管理 -->
            <div class="glass-card mt-4 rounded-2xl p-4 shadow-soft">
              <div class="mb-3 flex items-center justify-between">
                <span class="text-xs uppercase tracking-wide text-ink-faint">{{ t('smart.rules_section') }}</span>
                <button type="button" class="btn-soft px-2 py-0.5 text-xs" @click="addRule">{{ t('smart.add_rule') }}</button>
              </div>
              <p v-if="rules.length === 0" class="text-xs text-ink-faint">{{ t('smart.no_rules') }}</p>
              <div v-for="rule in rules" :key="rule.id" class="mb-2 rounded-xl border border-line bg-surface-field/40 p-2">
                <div class="mb-1.5 flex items-center gap-2">
                  <input v-model="rule.name" class="min-w-0 flex-1 rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                         :placeholder="t('smart.rule_name_ph')" @change="saveRule(rule)" />
                  <UiToggleSwitch :model-value="rule.enabled === 1" :label="''"
                                  @update:model-value="(v: boolean) => { rule.enabled = v ? 1 : 0; saveRule(rule); }" />
                  <button type="button" class="text-ink-faint transition-colors hover:text-danger"
                          @click="removeRule(rule)">✕</button>
                </div>
                <div class="flex items-center gap-2">
                  <UiSegmented :model-value="rule.type" :options="RULE_TYPE_OPTIONS"
                               :label="t('smart.type')" @update:model-value="(v: string) => { rule.type = v as ClipRule['type']; saveRule(rule); }" />
                  <input v-model="rule.pattern" class="min-w-0 flex-1 rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                         :placeholder="t('smart.rule_pattern_ph')" @change="saveRule(rule)" />
                </div>
              </div>
            </div>

            <!-- 模板管理 -->
            <div class="glass-card mt-4 rounded-2xl p-4 shadow-soft">
              <div class="mb-3 flex items-center justify-between">
                <span class="text-xs uppercase tracking-wide text-ink-faint">{{ t('smart.templates_section') }}</span>
                <button type="button" class="btn-soft px-2 py-0.5 text-xs" @click="addTemplate">{{ t('smart.add_template') }}</button>
              </div>
              <p v-if="templates.length === 0" class="text-xs text-ink-faint">{{ t('smart.no_templates') }}</p>
              <div v-for="tpl in templates" :key="tpl.id" class="mb-2 rounded-xl border border-line bg-surface-field/40 p-2">
                <div class="mb-1.5 flex items-center gap-2">
                  <input v-model="tpl.name" class="min-w-0 flex-1 rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                         :placeholder="t('smart.template_name_ph')" @change="saveTemplate(tpl)" />
                  <UiToggleSwitch :model-value="tpl.enabled === 1" :label="''"
                                  @update:model-value="(v: boolean) => { tpl.enabled = v ? 1 : 0; saveTemplate(tpl); }" />
                  <button type="button" class="text-ink-faint transition-colors hover:text-danger"
                          @click="removeTemplate(tpl)">✕</button>
                </div>
                <textarea v-model="tpl.body" rows="3"
                          class="w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                          :placeholder="t('smart.template_body_ph')" @change="saveTemplate(tpl)"></textarea>
              </div>
            </div>

            <!-- 开放 API -->
            <div class="glass-card mt-4 rounded-2xl p-4 shadow-soft">
              <div class="mb-3 flex items-center justify-between">
                <span class="text-xs uppercase tracking-wide text-ink-faint">{{ t('openapi.section') }}</span>
                <UiToggleSwitch v-model="openApiEnabled" :label="''" />
              </div>
              <div class="flex items-center gap-2">
                <input v-model="openApiPort" class="w-28 rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                       :placeholder="t('openapi.port')" @change="openApiPort = String(Number(openApiPort) || OPEN_API_DEFAULT_PORT)" />
                <input v-model="openApiToken" class="min-w-0 flex-1 rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                       :placeholder="t('openapi.token')" />
              </div>
              <p class="mt-2 text-[10px] leading-relaxed text-ink-faint">
                {{ t('openapi.hint', { port: openApiPort }) }}
              </p>
            </div>
          </div>

          <!-- 其他设置组（排除导航栏设置，导航栏有独立分支） -->
          <div v-else-if="activeSetting.type !== 'nav'">
            <ul class="glass-card rounded-2xl shadow-soft">
              <li class="border-b border-accent p-4 pb-2 text-xs uppercase tracking-wide text-ink-faint">
                {{ t(activeSetting.title) }}
              </li>
              <li v-for="(item, itemIndex) in activeSetting.items" :key="itemIndex"
                  class="flex items-center justify-between gap-4 p-4">
                <div>
                  <div class="text-ink">{{ t(item.label) }}</div>
                  <div v-if="item.type === 'action' && item.label === 'setting.general.clear_database' && (clearMsg || undoActive)"
                       class="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <span class="text-ink-faint">
                      {{ undoActive ? t('setting.general.clear_undo_hint', { n: undoRemaining }) : clearMsg }}
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
                  <div v-if="item.type === 'action' && item.label === 'setting.general.ai_test' && aiTestState !== 'idle'"
                       class="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <span :class="aiTestState === 'ok' ? 'text-gold' : 'text-danger'">
                      {{ aiTestState === 'testing' ? t('setting.general.ai_testing')
                        : aiTestState === 'ok' ? t('setting.general.ai_test_ok', { ms: aiTestLatency })
                        : t('setting.general.ai_test_fail', { error: aiTestError }) }}
                    </span>
                  </div>
                </div>
                <div class="w-56 shrink-0">
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
                  <!-- AI 连接测试：invoke Rust ai_test_connection（设计文档 §4.2） -->
                  <template v-else-if="item.type === 'action' && item.label === 'setting.general.ai_test'">
                    <button type="button" class="btn-soft w-full"
                            :disabled="aiTestState === 'testing'" @click="testAiConnection">
                      {{ aiTestState === 'testing' ? t('setting.general.ai_testing') : t('setting.general.ai_test') }}
                    </button>
                  </template>
                  <SettingInput
                      v-else-if="item.type === 'input' && item.label === 'setting.general.api_key'"
                      v-model="apiKey"
                      :placeholder="t('setting.general.api_key_placeholder')"
                      @save="showHint(t('setting.general.api_key_saved'))"
                  />
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
                  <!-- AI 提供商：OpenAI 兼容（默认）/ Anthropic 原生（设计文档 §4.2） -->
                  <UiSegmented
                      v-else-if="item.type === 'select' && item.label === 'setting.general.ai_provider'"
                      :model-value="aiProvider"
                      :options="AI_PROVIDER_OPTIONS"
                      block
                      :label="t('setting.general.ai_provider')"
                      @update:model-value="selectAiProvider"
                  />
                  <SettingInput
                      v-else-if="item.type === 'input' && item.label === 'setting.general.clipboard_limit'"
                      v-model="maxLimit"
                      :placeholder="t('setting.general.clipboard_limit_placeholder')"
                      @save="showHint(t('setting.general.clipboard_limit_saved'))"
                  />                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.launch_at_startup'"
                      v-model="autoStartEnabled"
                      :label="t('setting.general.launch_at_startup')"
                  />
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.tooltip_window'"
                      v-model="tooltipEnabled"
                      :tip-on="t('setting.shortcuts.click_disable')" :tip-off="t('setting.shortcuts.click_enable')"
                      :label="t('setting.general.tooltip_window')"
                      @change="showHint(tooltipEnabled ? t('setting.general.tooltip_on') : t('setting.general.tooltip_off'))"
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
              </li>
            </ul>
          </div>

          <!-- 导航栏设置：tab 顺序与显示开关（剪贴板/设置强制保留；统计受解锁门槛控制） -->
          <div v-else-if="activeSetting.type === 'nav'" class="flex flex-col gap-4">
            <div class="glass-card rounded-2xl shadow-soft" data-nav-config-list>
              <TransitionGroup name="reorder-list" tag="ul">
                <li key="__header__" class="border-b border-accent p-4 pb-2 text-xs uppercase tracking-wide text-ink-faint">
                  {{ t('setting.shortcuts.nav_section_title') }}
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

    <!-- 即时反馈提示（toast） -->
    <div
        v-if="hint"
        class="pointer-events-none fixed left-1/2 top-20 z-[90] -translate-x-1/2 rounded-full border border-accent bg-surface-field/95 px-4 py-2 text-sm text-ink shadow-float backdrop-blur"
    >
      {{ hint }}
    </div>
  </div>
</template>
