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
import type { ClipExtractor, ClipScheme } from '~/src/entities';
import type { SmartClipMode } from '~/src/smart-clip/types';
import { updateSmartClipConfig } from '~/src/smart-clip/smartClip';
import { ISLAND_API_DEFAULT_PORT, applyIslandApi } from '~/src/island/islandApi';
import {
  loadExtractors, persistExtractors, missingBuiltinExtractors,
  type Translator,
} from '~/src/smart-clip/extractors';
import { generateExtractorDraft, generateSchemeDraft } from '~/src/smart-clip/aiGenerate';
import { clampAnalysisMaxChars } from '~/src/smart-clip/analyzer';
import { AI_CUSTOM_TEMPLATE } from '~/src/smart-clip/aiClient';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { isTauri } from '~/utils/env';
import { useTooltipEnabled } from '~/composables/useTooltipEnabled';
import { useIslandEnabled, setIslandEnabled, useIslandTiming, ensureIslandTimingLoaded, setIslandDelayMs, setIslandDurationMs, notifyIsland, type IslandKind, ISLAND_DELAY_DEFAULT, ISLAND_DURATION_DEFAULT } from '~/composables/useCopyIsland';
import { usePopupPosition, setPopupPositionMode, type PopupPositionMode } from '~/composables/usePopupPosition';
import { useColorScheme, setColorScheme, COLOR_SCHEME_LABELS, COLOR_SCHEME_ORDER, type ColorSchemeMode } from '~/composables/useColorScheme';
import { useI18n, setLocaleMode, LOCALES, type LocaleMode } from '~/composables/useI18n';
import { briefAiError, parseAiError } from '~/utils/aiError';
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

/** 应用使用时长记录开关：默认关闭（隐私）；切换失败时 composable 已回滚 UI，这里提示重试 */
async function onAppUsageToggle(val: boolean) {
  try {
    await setAppUsageEnabled(val);
    showHint(val ? t('setting.general.app_usage_on') : t('setting.general.app_usage_off'));
  } catch {
    showHint(t('setting.general.app_usage_failed'), 'error');
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
  const key = await dbService.getKeyValue('api_key');
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
// ===== 方案：多条可 CRUD；一条「默认方案」供方案加工模式使用 =====
const DEFAULT_SCHEME_ID = 'scheme_default';

const smartMode = ref<SmartClipMode>('auto');
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
  { value: 'auto' as const, label: t('smart.mode_auto') },
  { value: 'scheme' as const, label: t('smart.mode_scheme') },
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

// ===== 方案：可自由 CRUD；一条「默认方案」供方案加工模式使用 =====
/**
 * 方案对账（每次进入设置页执行）：
 * - 清理已下线的旧内置方案行（历史 seed 产物）；
 * - 一条方案都没有时自动创建「默认方案」（保证方案加工模式始终可用）；
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

/** 设为/取消默认方案（默认方案 = 方案加工模式实际执行的方案） */
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
    addingExtractor.value = true;
    showHint(t('smart.ai_generate_done'));
  } catch (e) {
    showHint(t('smart.ai_generate_failed', { error: String(e) }), 'error');
  } finally {
    generatingExtractor.value = false;
  }
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
    newExtractorName.value = '';
    newExtractorDesc.value = '';
    aiExtractorDesc.value = '';
    draftSeparator.value = '';
    draftRegex.value = '';
    draftAi.value = '';
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

// ===== 灵动岛 API（第三方应用集成）：开关/端口/令牌任一变化即应用（非法端口不应用，避免打字过程误触发） =====
const islandApiEnabled = ref(false);
const islandApiPort = ref(String(ISLAND_API_DEFAULT_PORT));
const islandApiToken = ref('');
watch([islandApiEnabled, islandApiPort, islandApiToken], async ([en, p, tk]) => {
  const portNum = Number(p);
  if (!en) {
    await applyIslandApi(false, portNum || ISLAND_API_DEFAULT_PORT, tk);
    return;
  }
  if (!portNum || portNum < 1 || portNum > 65535) return;
  await applyIslandApi(true, portNum, tk);
});
// 开关切换提示（端口/令牌输入过程不弹提示，避免干扰）
watch(islandApiEnabled, (en) => {
  showHint(t(en ? 'island_api.on' : 'island_api.off'));
});

// 处理模式/默认方案变化：持久化 + 推送配置快照给处理层
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
      },
      {
        label: 'setting.general.ai_analysis_max',
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
        label: 'setting.general.island_hint',
        value: '',
        type: 'checkbox'
      },
      {
        label: 'setting.general.island_delay',
        value: '',
        type: 'input'
      },
      {
        label: 'setting.general.island_duration',
        value: '',
        type: 'input'
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
  apiKey.value = await dbService.getKeyValue('api_key');
  // AI 通道配置恢复（设计文档 §4.2）：提供商缺省 openai-compat
  aiProvider.value = ((await dbService.getKeyValue('ai_provider')) || 'openai-compat') as AiProviderKind;
  aiBaseUrl.value = await dbService.getKeyValue('ai_base_url');
  aiModel.value = await dbService.getKeyValue('ai_model');
  aiAnalysisMax.value = (await dbService.getKeyValue('ai_analysis_max_chars')) || '1000';
  // 自定义 JSON 模板恢复（custom 模式编辑器内容）；为空时编辑器显示占位提示
  aiCustomConfig.value = (await dbService.getKeyValue('ai_custom_config')) || '';
  // 智能剪贴板配置恢复（设计文档 §4.3/§4.5）+ 推送处理层快照
  try {
    // 'off' 尊重用户选择；'scheme'/'ai'（旧值）归一到 'scheme'；空值/未知值按「智能切分」（新默认）
    const rawMode = await dbService.getKeyValue('smart_clip_mode');
    smartMode.value = rawMode === 'off' ? 'off' : (rawMode === 'scheme' || rawMode === 'ai') ? 'scheme' : 'auto';
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
    islandApiToken.value = await dbService.getKeyValue('island_api_token');
    aiCacheWindow.value = (await dbService.getKeyValue('ai_result_window')) || '300';
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

            <!-- 方案：可自由 CRUD；默认方案供方案加工模式使用，AI 可生成专属方案 -->
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

              <!-- 新增提取器：三种方式三合一，输入各自独立 -->
              <Transition name="edit-panel">
                <div v-if="addingExtractor" class="mb-2 rounded-xl border border-gold/40 bg-surface-field/60 p-2">
                  <div class="mb-1.5 text-[10px] uppercase tracking-wide text-ink-faint">{{ t('smart.add_extractor') }}</div>
                  <!-- 一句话描述 → AI 生成配置（回填下方表单，确认后再添加） -->
                  <div class="mb-1.5 flex items-start gap-1">
                    <textarea v-model="aiExtractorDesc" rows="3"
                              class="min-w-0 flex-1 rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                              :placeholder="t('smart.ai_desc_ph')"></textarea>
                    <button type="button" class="btn-soft shrink-0 px-2 py-0.5 text-xs"
                            :disabled="generatingExtractor"
                            @click="generateExtractorByAi">
                      {{ generatingExtractor ? t('smart.ai_generating') : t('smart.ai_generate') }}
                    </button>
                  </div>
                  <input v-model="newExtractorName"
                         class="mb-1.5 w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                         :placeholder="t('smart.extractor_name_ph')" />
                  <input v-model="newExtractorDesc"
                         class="mb-1.5 w-full rounded-lg border border-line bg-surface-field px-2 py-1 text-[10px] text-ink"
                         :placeholder="t('smart.extractor_desc_ph')" />
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
                            @click="addingExtractor = false">{{ t('common.cancel') }}</button>
                    <button type="button" class="btn-gold px-2 py-0.5 text-xs"
                            @click="submitNewExtractor">{{ t('smart.add_extractor_submit') }}</button>
                  </div>
                </div>
              </Transition>

              <p v-if="extractors.length === 0" class="text-xs text-ink-faint">{{ t('smart.no_extractors') }}</p>
              <!-- 长按拖动排序（与导航配置同一套交互），TransitionGroup 提供平滑让位 -->
              <TransitionGroup name="reorder-list" tag="div" data-extractor-list>
                <div v-for="(x, index) in extractors" :key="x.id"
                     class="extractor-item mb-2 rounded-xl border border-line bg-surface-field/40 p-2 transition-all duration-200 ease-soft"
                     :class="extractorDraggingKey === x.id ? 'opacity-50 scale-[0.98] shadow-float' : ''"
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

          <!-- 其他设置组（排除导航栏设置，导航栏有独立分支） -->
          <div v-else-if="activeSetting.type !== 'nav'">
            <ul class="glass-card rounded-2xl shadow-soft">
              <li class="border-b border-accent p-4 pb-2 text-xs uppercase tracking-wide text-ink-faint">
                {{ t(activeSetting.title) }}
              </li>
              <!-- 宽控件项（AI 提供商：分段器 + JSON 编辑器）纵向布局占满整行，其余保持左标签右控件两栏 -->
              <li v-for="(item, itemIndex) in activeSetting.items" :key="itemIndex"
                  class="p-4"
                  :class="isWideSettingItem(item) ? 'flex flex-col items-stretch gap-2' : 'flex flex-wrap items-center justify-between gap-4'">
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
                      secret
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
                  <!-- 灵动岛提示：复制/粘贴时屏幕顶部胶囊反馈 -->
                  <UiToggleSwitch
                      v-else-if="item.type === 'checkbox' && item.label === 'setting.general.island_hint'"
                      :model-value="islandEnabled"
                      :tip-on="t('setting.shortcuts.click_disable')" :tip-off="t('setting.shortcuts.click_enable')"
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
                <!-- AI 连接测试结果：显示在测试按钮下方（跨全行），错误格式化为状态行 + 可读原因 -->
                <div v-if="item.type === 'action' && item.label === 'setting.general.ai_test' && aiTestState !== 'idle'"
                     class="w-full min-w-0 basis-full text-xs">
                  <span :class="aiTestState === 'ok' ? 'text-gold' : aiTestState === 'testing' ? 'text-ink-faint' : 'text-danger'">
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

            <!-- 灵动岛 API：第三方应用集成入口（本地 HTTP/SSE，接入文档 .docs/island-api.md）。
                 仅通用标签渲染：本分支为 通用/API设置 共用，不守卫会两边重复出现 -->
            <div v-if="activeSetting.type === 'general'" class="glass-card mt-4 rounded-2xl p-4 shadow-soft">
              <div class="mb-3 flex items-center justify-between">
                <span class="text-xs uppercase tracking-wide text-ink-faint">{{ t('island_api.section') }}</span>
                <UiToggleSwitch v-model="islandApiEnabled" :label="''" />
              </div>
              <div class="flex items-center gap-2">
                <input v-model="islandApiPort" class="w-28 rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                       :placeholder="t('island_api.port')" @change="islandApiPort = String(Number(islandApiPort) || ISLAND_API_DEFAULT_PORT)" />
                <input v-model="islandApiToken" class="min-w-0 flex-1 rounded-lg border border-line bg-surface-field px-2 py-1 text-xs text-ink"
                       :placeholder="t('island_api.token')" />
              </div>
              <p class="mt-2 text-[10px] leading-relaxed text-ink-faint">
                {{ t('island_api.hint', { port: islandApiPort }) }}
              </p>
            </div>
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
