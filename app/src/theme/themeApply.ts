/**
 * 主题运行时注入
 *
 * 采用「内联 CSS 变量」而非动态 <style>：批量 setProperty 单帧内完成，
 * 无样式表解析/级联抖动，切回内置主题时逐项 removeProperty 无残留。
 *
 * 运行时状态（当前主题 / 变体策略）放在本模块，供 useTheme（写入）
 * 与 useColorScheme（custom 模式重注入）共享，避免循环依赖。
 */
import { ref, shallowRef } from 'vue';
import { hexToChannels } from './colorUtils';
import { deriveTokens, type ResolvedThemeTokens, type ThemeDefinition } from './themeModel';
import { THEME_TOKEN_LIST } from './themeTokens';
import {
  clearRuntimeSnapshot,
  readRuntimeSnapshot,
  writeRuntimeSnapshot,
  type ThemeVariantPolicy,
} from './themeStorage';
import type { ThemeVariant } from './themeTokens';

export type { ThemeVariantPolicy } from './themeStorage';

/** 当前启用的自定义主题（null = 未启用） */
export const runtimeTheme = shallowRef<ThemeDefinition | null>(null);
/** 变体策略：system 跟随系统，light/dark 固定 */
export const runtimeVariantPolicy = ref<ThemeVariantPolicy>('system');

const GLASS_BG = '255 255 255';
const GLASS_ALPHA: Record<ThemeVariant, { bg: string; border: string }> = {
  light: { bg: '0.55', border: '0.6' },
  dark: { bg: '0.04', border: '0.08' },
};
const GLOW_ALPHA: Record<ThemeVariant, { a: string; b: string }> = {
  light: { a: '0.3', b: '0.32' },
  dark: { a: '0.1', b: '0.1' },
};

/** 除令牌变量外，注入时还需要补齐的透明度/玻璃变量 */
export const DERIVED_ALPHA_VARS = [
  '--glow-a-alpha',
  '--glow-b-alpha',
  '--glass-bg',
  '--glass-bg-alpha',
  '--glass-border-alpha',
];

export function resolveThemeVariant(policy: ThemeVariantPolicy, systemDark: boolean): ThemeVariant {
  if (policy === 'light' || policy === 'dark') return policy;
  return systemDark ? 'dark' : 'light';
}

/** 纯函数：令牌 → CSS 变量表（便于单测；DOM 注入在下方） */
export function buildThemeVars(tokens: ResolvedThemeTokens, variant: ThemeVariant): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const token of THEME_TOKEN_LIST) {
    const channels = hexToChannels(tokens[token.key]);
    if (channels) vars[token.cssVar] = channels;
  }
  const glow = GLOW_ALPHA[variant];
  vars['--glow-a-alpha'] = glow.a;
  vars['--glow-b-alpha'] = glow.b;
  vars['--glass-bg'] = GLASS_BG;
  vars['--glass-bg-alpha'] = GLASS_ALPHA[variant].bg;
  vars['--glass-border-alpha'] = GLASS_ALPHA[variant].border;
  return vars;
}

export function themeVarsFor(theme: ThemeDefinition, variant: ThemeVariant): Record<string, string> {
  return buildThemeVars(deriveTokens(theme.variants[variant], variant), variant);
}

function injectVars(vars: Record<string, string>): void {
  if (typeof document === 'undefined') return;
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(vars)) style.setProperty(name, value);
}

/**
 * 应用当前自定义主题到文档。
 * @returns 是否成功应用（未启用主题时返回 false，由调用方回退内置配色）
 */
export function applyCustomTheme(systemDark: boolean): boolean {
  const theme = runtimeTheme.value;
  if (!theme || typeof document === 'undefined') return false;
  const variant = resolveThemeVariant(runtimeVariantPolicy.value, systemDark);
  const vars = themeVarsFor(theme, variant);
  injectVars(vars);
  const html = document.documentElement;
  html.dataset.scheme = 'custom';
  html.dataset.themeVariant = variant;
  html.style.setProperty('color-scheme', variant);
  writeRuntimeSnapshot({ themeId: theme.id, variant, vars, updatedAt: Date.now() });
  return true;
}

/** 清除自定义主题的全部内联变量与属性（切回内置四档时调用） */
export function clearCustomTheme(): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  const style = html.style;
  for (const token of THEME_TOKEN_LIST) style.removeProperty(token.cssVar);
  for (const name of DERIVED_ALPHA_VARS) style.removeProperty(name);
  style.removeProperty('color-scheme');
  delete html.dataset.themeVariant;
  if (html.dataset.scheme === 'custom') delete html.dataset.scheme;
  clearRuntimeSnapshot();
}

/**
 * 首帧同步恢复：localStorage 快照里的变量直接写入，
 * 不必等 KV（SQLite IPC）异步返回，消除启动配色快切。
 */
export function restoreThemeSnapshot(): boolean {
  if (typeof document === 'undefined') return false;
  const snapshot = readRuntimeSnapshot();
  if (!snapshot || !Object.keys(snapshot.vars).length) return false;
  injectVars(snapshot.vars);
  const html = document.documentElement;
  html.dataset.scheme = 'custom';
  html.dataset.themeVariant = snapshot.variant;
  html.style.setProperty('color-scheme', snapshot.variant);
  return true;
}

export function setRuntimeTheme(theme: ThemeDefinition | null, policy: ThemeVariantPolicy): void {
  runtimeTheme.value = theme;
  runtimeVariantPolicy.value = policy;
}
