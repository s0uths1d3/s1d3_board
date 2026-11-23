/**
 * 主题文件导入校验 / 导出序列化
 *
 * 导入是唯一的外部数据入口，必须在落库前完成：
 * 体积、数量、格式标识、版本、颜色白名单、结构完整性校验。
 */
import { normalizeHex } from './colorUtils';
import {
  normalizeTheme,
  THEME_DESC_MAX,
  THEME_NAME_MAX,
  THEME_SCHEMA_VERSION,
  type ThemeDefinition,
} from './themeModel';
import { THEME_TOKEN_KEYS } from './themeTokens';

export const THEME_FILE_FORMAT = 's1de-board-theme';
export const MAX_THEMES = 24;
export const MAX_THEME_FILE_BYTES = 256 * 1024;

export type ThemeFileErrorCode =
  | 'invalid_json'
  | 'invalid_format'
  | 'unsupported_version'
  | 'too_large'
  | 'too_many'
  | 'empty'
  | 'invalid_theme';

export interface ThemeFileError {
  code: ThemeFileErrorCode;
  /** 出错的主题下标（invalid_theme 时提供） */
  index?: number;
}

export type ThemeFileParseResult =
  | { ok: true; themes: ThemeDefinition[] }
  | { ok: false; error: ThemeFileError };

function byteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  return text.length * 2;
}

/** 主题对象是否有实际内容（避免导入空壳） */
function hasThemeContent(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const variants = (raw as { variants?: unknown }).variants;
  if (!variants || typeof variants !== 'object') return false;
  const v = variants as Record<string, unknown>;
  for (const variant of ['light', 'dark']) {
    const set = v[variant];
    if (!set || typeof set !== 'object') continue;
    const source = set as Record<string, unknown>;
    if (THEME_TOKEN_KEYS.some((key) => normalizeHex(source[key]) !== null)) return true;
  }
  return false;
}

export function parseThemeFile(text: string): ThemeFileParseResult {
  if (byteLength(text) > MAX_THEME_FILE_BYTES) return { ok: false, error: { code: 'too_large' } };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: 'invalid_json' } };
  }
  if (!json || typeof json !== 'object') return { ok: false, error: { code: 'invalid_format' } };

  const file = json as Record<string, unknown>;
  if (file.format !== THEME_FILE_FORMAT) return { ok: false, error: { code: 'invalid_format' } };
  if (file.schemaVersion !== THEME_SCHEMA_VERSION) {
    return { ok: false, error: { code: 'unsupported_version' } };
  }
  if (!Array.isArray(file.themes)) return { ok: false, error: { code: 'invalid_format' } };
  if (!file.themes.length) return { ok: false, error: { code: 'empty' } };
  if (file.themes.length > MAX_THEMES) return { ok: false, error: { code: 'too_many' } };

  const themes: ThemeDefinition[] = [];
  for (let i = 0; i < file.themes.length; i++) {
    const raw = file.themes[i];
    if (!hasThemeContent(raw)) return { ok: false, error: { code: 'invalid_theme', index: i } };
    // 导入时一律重建 ID，避免与本地已有主题冲突
    const theme = normalizeTheme(raw, { regenerateId: true });
    if (!theme) return { ok: false, error: { code: 'invalid_theme', index: i } };
    themes.push(theme);
  }
  return { ok: true, themes };
}

export function serializeThemeFile(themes: ThemeDefinition[]): string {
  return JSON.stringify({
    format: THEME_FILE_FORMAT,
    schemaVersion: THEME_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    themes,
  });
}

/** 名称冲突时追加 (2)/(3)…，并受长度上限约束 */
export function dedupeThemeName(name: string, existing: string[]): string {
  const base = name.trim().slice(0, THEME_NAME_MAX) || '未命名主题';
  if (!existing.includes(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `(${n})`;
    const candidate = `${base.slice(0, Math.max(1, THEME_NAME_MAX - suffix.length))}${suffix}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return base;
}

export const THEME_LIMITS = {
  maxThemes: MAX_THEMES,
  maxFileBytes: MAX_THEME_FILE_BYTES,
  maxName: THEME_NAME_MAX,
  maxDescription: THEME_DESC_MAX,
};
