/**
 * 自定义主题状态与操作（单例）
 *
 * - 列表 / 启用 ID / 变体策略：KV 为唯一事实源，localStorage 只做首帧快照
 * - 启用主题 = 切到 color_scheme='custom' 并注入变量；切回内置四档由
 *   useColorScheme 负责清除变量
 * - 跨窗口：写库后广播 theme:changed，其他窗口重新读库并重注入
 */
import { computed, ref } from 'vue';
import { emit, listen } from '@tauri-apps/api/event';
import { isTauri } from '~/utils/env';
import { setColorScheme, useColorScheme } from '~/composables/useColorScheme';
import {
  applyCustomTheme,
  runtimeVariantPolicy,
  setRuntimeTheme,
} from '~/src/theme/themeApply';
import {
  cloneTheme,
  createThemeFromPreset,
  createThemeId,
  DEFAULT_THEME_ANCHORS,
  themeFromAnchors,
  type ThemeAnchors,
  type ThemeDefinition,
  type ThemePreset,
} from '~/src/theme/themeModel';
import { getPreset } from '~/src/theme/themePresets';
import {
  loadThemeState,
  saveActiveId,
  saveThemes,
  saveVariantPolicy,
  saveWorkingTheme,
  type ThemeVariantPolicy,
} from '~/src/theme/themeStorage';
import {
  dedupeThemeName,
  MAX_THEMES,
  parseThemeFile,
  serializeThemeFile,
} from '~/src/theme/themeValidation';

const THEME_EVENT = 'theme:changed';
/** 「应用此主题」生成的工作主题 ID（与命名模板分开存放，不占用模板名额） */
export const WORKING_THEME_ID = 'custom:working';

const themes = ref<ThemeDefinition[]>([]);
const workingTheme = ref<ThemeDefinition | null>(null);
const activeId = ref('');
const variantPolicy = ref<ThemeVariantPolicy>('system');
const loading = ref(false);
const ready = ref(false);

const activeTheme = computed<ThemeDefinition | null>(() => {
  const saved = themes.value.find((t) => t.id === activeId.value);
  if (saved) return saved;
  return activeId.value === WORKING_THEME_ID ? workingTheme.value : null;
});
/** 是否真正处于自定义主题（配色模式为 custom 且主题存在） */
const customActive = computed(() => useColorScheme().scheme.value === 'custom' && !!activeTheme.value);

let initPromise: Promise<void> | null = null;

function systemDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyRuntime(): void {
  setRuntimeTheme(activeTheme.value, variantPolicy.value);
}

function reapplyIfCustom(): void {
  if (useColorScheme().scheme.value !== 'custom') return;
  if (!applyCustomTheme(systemDark())) {
    // 启用的主题已不存在：回退系统配色，避免 custom 模式下无变量可用
    void setColorScheme('system');
  }
}

async function loadIntoState(): Promise<void> {
  const state = await loadThemeState();
  themes.value = state.themes;
  workingTheme.value = state.working;
  activeId.value = state.activeId;
  variantPolicy.value = state.policy;
  applyRuntime();
}

async function broadcast(): Promise<void> {
  if (!isTauri()) return;
  await emit(THEME_EVENT, { at: Date.now() }).catch(() => {});
}

async function persistThemes(): Promise<void> {
  await saveThemes(themes.value);
}

function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    loading.value = true;
    try {
      await loadIntoState();
    } catch {
      // KV 暂不可用（例如纯 Web 预览）：保持内置四档，面板展示空态即可
    }
    if (isTauri()) {
      listen(THEME_EVENT, () => {
        void (async () => {
          try {
            await loadIntoState();
            reapplyIfCustom();
          } catch { /* 读库失败时保持当前主题 */ }
        })();
      }).catch(() => {});
    }
    loading.value = false;
    ready.value = true;
    reapplyIfCustom();
  })();
  return initPromise;
}

async function ensureReady(): Promise<void> {
  await init();
}

/** 新建主题：默认克隆当前启用主题，否则用琥珀预设 */
async function createTheme(name: string): Promise<ThemeDefinition | null> {
  await ensureReady();
  if (themes.value.length >= MAX_THEMES) return null;
  const base = activeTheme.value;
  const uniqueName = dedupeThemeName(name, themes.value.map((t) => t.name));
  const theme = base
    ? cloneTheme({ ...base, name: uniqueName })
    : createThemeFromPreset(getPreset('amber')!, uniqueName);
  theme.id = createThemeId();
  theme.createdAt = Date.now();
  theme.updatedAt = theme.createdAt;
  theme.builtin = false;
  themes.value = [theme, ...themes.value];
  await persistThemes();
  await broadcast();
  return theme;
}

async function duplicateTheme(id: string): Promise<ThemeDefinition | null> {
  await ensureReady();
  const source = themes.value.find((t) => t.id === id);
  if (!source || themes.value.length >= MAX_THEMES) return null;
  const copy = cloneTheme(source);
  copy.id = createThemeId();
  copy.name = dedupeThemeName(`${source.name} 副本`, themes.value.map((t) => t.name));
  copy.builtin = false;
  copy.createdAt = Date.now();
  copy.updatedAt = copy.createdAt;
  themes.value = [copy, ...themes.value];
  await persistThemes();
  await broadcast();
  return copy;
}

async function updateTheme(next: ThemeDefinition): Promise<boolean> {
  await ensureReady();
  const index = themes.value.findIndex((t) => t.id === next.id);
  if (index < 0) return false;
  const updated: ThemeDefinition = { ...cloneTheme(next), updatedAt: Date.now() };
  themes.value = themes.value.map((t, i) => (i === index ? updated : t));
  await persistThemes();
  if (activeId.value === updated.id) {
    applyRuntime();
    reapplyIfCustom();
  }
  await broadcast();
  return true;
}

async function renameTheme(id: string, name: string): Promise<void> {
  await ensureReady();
  const theme = themes.value.find((t) => t.id === id);
  if (!theme) return;
  theme.name = name.trim().slice(0, 24) || theme.name;
  theme.updatedAt = Date.now();
  await persistThemes();
  await broadcast();
}

async function deleteTheme(id: string): Promise<boolean> {
  await ensureReady();
  const index = themes.value.findIndex((t) => t.id === id);
  if (index < 0) return false;
  const wasActive = activeId.value === id;
  themes.value = themes.value.filter((t) => t.id !== id);
  if (wasActive) {
    if (themes.value[0]) {
      activeId.value = themes.value[0].id;
    } else if (workingTheme.value) {
      activeId.value = WORKING_THEME_ID;
    } else {
      activeId.value = '';
    }
    await saveActiveId(activeId.value);
  }
  await persistThemes();
  if (wasActive) {
    if (activeId.value) {
      applyRuntime();
      reapplyIfCustom();
    } else {
      applyRuntime();
      await setColorScheme('system');
    }
  }
  await broadcast();
  return true;
}

async function activateTheme(id: string): Promise<boolean> {
  await ensureReady();
  const theme = themes.value.find((t) => t.id === id);
  if (!theme) return false;
  activeId.value = id;
  await saveActiveId(id);
  applyRuntime();
  await setColorScheme('custom');
  await broadcast();
  return true;
}

/** 应用当前三锚点：生成/更新工作主题（独立 KV，不占模板名额），切到 custom */
async function applyAnchors(anchors: ThemeAnchors): Promise<ThemeDefinition> {
  await ensureReady();
  const theme = themeFromAnchors('自定义配色', anchors, WORKING_THEME_ID);
  theme.createdAt = workingTheme.value?.createdAt ?? theme.createdAt;
  workingTheme.value = theme;
  await saveWorkingTheme(theme);
  activeId.value = WORKING_THEME_ID;
  await saveActiveId(WORKING_THEME_ID);
  applyRuntime();
  await setColorScheme('custom');
  await broadcast();
  return theme;
}

/** 切到自定义模式：没有可用主题时先用默认锚点落一套 */
async function ensureCustomApplied(): Promise<ThemeDefinition> {
  await ensureReady();
  if (activeTheme.value) {
    await setColorScheme('custom');
    return activeTheme.value;
  }
  return applyAnchors(DEFAULT_THEME_ANCHORS);
}

export type SaveTemplateResult = 'created' | 'updated' | 'limit';

/** 存为模板：同名覆盖；工作主题不占模板名额 */
async function saveTemplate(name: string, anchors: ThemeAnchors): Promise<SaveTemplateResult> {
  await ensureReady();
  const trimmed = name.trim().slice(0, 24);
  const existing = trimmed ? themes.value.find((t) => t.name === trimmed) : null;
  if (!existing && themes.value.length >= MAX_THEMES) return 'limit';
  const theme = themeFromAnchors(trimmed || '未命名模板', anchors, existing?.id);
  theme.createdAt = existing?.createdAt ?? theme.createdAt;
  if (existing) {
    themes.value = themes.value.map((t) => (t.id === existing.id ? theme : t));
  } else {
    themes.value = [theme, ...themes.value];
  }
  await persistThemes();
  if (activeId.value === theme.id) {
    applyRuntime();
    reapplyIfCustom();
  }
  await broadcast();
  return existing ? 'updated' : 'created';
}

async function setVariantPolicy(policy: ThemeVariantPolicy): Promise<void> {
  await ensureReady();
  variantPolicy.value = policy;
  runtimeVariantPolicy.value = policy;
  await saveVariantPolicy(policy);
  reapplyIfCustom();
  await broadcast();
}

async function applyPreset(preset: ThemePreset, name: string): Promise<ThemeDefinition | null> {
  await ensureReady();
  if (themes.value.length >= MAX_THEMES) return null;
  const theme = createThemeFromPreset(preset, dedupeThemeName(name, themes.value.map((t) => t.name)));
  themes.value = [theme, ...themes.value];
  await persistThemes();
  await activateTheme(theme.id);
  return theme;
}

function exportPayload(ids?: string[]): ThemeDefinition[] {
  if (!ids || !ids.length) return themes.value;
  return themes.value.filter((t) => ids.includes(t.id));
}

function defaultExportName(): string {
  return `s1de-board-themes-${new Date().toISOString().slice(0, 10)}.json`;
}

function downloadText(filename: string, text: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 导出主题文件：Tauri 用系统保存框，Web 回退浏览器下载 */
async function exportToFile(ids?: string[]): Promise<boolean> {
  await ensureReady();
  const list = exportPayload(ids);
  if (!list.length) return false;
  const text = serializeThemeFile(list);

  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({
      defaultPath: defaultExportName(),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!path) return false;
    await writeTextFile(path, text);
    return true;
  }
  downloadText(defaultExportName(), text);
  return true;
}

function pickTextFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}

/** 选择并解析主题文件（Tauri 系统打开框 / Web 文件选择） */
async function pickImportFile(): Promise<ReturnType<typeof parseThemeFile>> {
  await ensureReady();
  let text: string | null = null;
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({ multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!path || typeof path !== 'string') return { ok: false, error: { code: 'empty' } };
    text = await readTextFile(path);
  } else {
    text = await pickTextFile();
  }
  if (!text) return { ok: false, error: { code: 'empty' } };
  return parseThemeFile(text);
}

/** 落库导入结果：名称去重 + 数量上限，导入后不自动启用 */
async function importThemes(incoming: ThemeDefinition[]): Promise<number> {
  await ensureReady();
  const room = Math.max(0, MAX_THEMES - themes.value.length);
  if (!room) return 0;
  const names = new Set(themes.value.map((t) => t.name));
  const added: ThemeDefinition[] = [];
  for (const theme of incoming.slice(0, room)) {
    const copy = cloneTheme(theme);
    copy.name = dedupeThemeName(theme.name, [...names]);
    names.add(copy.name);
    added.push(copy);
  }
  themes.value = [...added, ...themes.value];
  await persistThemes();
  await broadcast();
  return added.length;
}

export function useTheme() {
  void init();
  return {
    themes,
    workingTheme,
    activeId,
    activeTheme,
    variantPolicy,
    customActive,
    loading,
    ready,
    createTheme,
    duplicateTheme,
    updateTheme,
    renameTheme,
    deleteTheme,
    activateTheme,
    applyAnchors,
    ensureCustomApplied,
    saveTemplate,
    setVariantPolicy,
    applyPreset,
    exportToFile,
    exportPayload,
    pickImportFile,
    importThemes,
    ensureReady,
  };
}
