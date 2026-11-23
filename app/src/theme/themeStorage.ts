/**
 * 主题存储层
 *
 * - settings KV：唯一事实源（主题列表 / 启用 ID / 变体策略）
 * - localStorage：运行快照，仅用于首帧同步恢复，避免启动时先闪默认配色
 */
import { normalizeTheme, type ThemeDefinition } from './themeModel';
import { MAX_THEMES } from './themeValidation';
import type { ThemeVariant } from './themeTokens';

/** 动态加载 DB 门面：主题存储只需 KV 读写，避免模块加载期拉起整条数据库依赖链 */
async function settingsDb() {
  const { default: dbService } = await import('~/src/db/dbService');
  return dbService;
}

export type ThemeVariantPolicy = 'system' | 'light' | 'dark';

export interface StoredThemeState {
  themes: ThemeDefinition[];
  /** 当前「应用此主题」生成的工作主题（未命名保存，单独存放） */
  working: ThemeDefinition | null;
  activeId: string;
  policy: ThemeVariantPolicy;
}

export interface ThemeRuntimeSnapshot {
  themeId: string;
  variant: ThemeVariant;
  /** CSS 变量名 → 值（RGB 通道或透明度数字） */
  vars: Record<string, string>;
  updatedAt: number;
}

const KV_THEMES = 'theme_custom_themes_v1';
const KV_WORKING = 'theme_working_v1';
const KV_ACTIVE = 'theme_active_id_v1';
const KV_POLICY = 'theme_variant_policy_v1';
const LS_SNAPSHOT = 'theme_runtime_snapshot_v1';

function isPolicy(value: unknown): value is ThemeVariantPolicy {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function isThemeVariant(value: unknown): value is ThemeVariant {
  return value === 'light' || value === 'dark';
}

function parseThemes(raw: string): ThemeDefinition[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeTheme(item))
      .filter((t): t is ThemeDefinition => t !== null)
      .slice(0, MAX_THEMES);
  } catch {
    return [];
  }
}

export async function loadThemeState(): Promise<StoredThemeState> {
  const db = await settingsDb();
  const [rawThemes, rawWorking, rawActive, rawPolicy] = await Promise.all([
    db.getKeyValue(KV_THEMES).catch(() => ''),
    db.getKeyValue(KV_WORKING).catch(() => ''),
    db.getKeyValue(KV_ACTIVE).catch(() => ''),
    db.getKeyValue(KV_POLICY).catch(() => ''),
  ]);
  const themes = parseThemes(rawThemes ?? '');
  let working: ThemeDefinition | null = null;
  if (rawWorking) {
    try {
      working = normalizeTheme(JSON.parse(rawWorking));
    } catch { /* 工作主题解析失败按未存在处理 */ }
  }
  const activeId = typeof rawActive === 'string' ? rawActive.trim() : '';
  const policy = isPolicy(rawPolicy) ? rawPolicy : 'system';
  return { themes, working, activeId, policy };
}

export async function saveThemes(themes: ThemeDefinition[]): Promise<void> {
  const db = await settingsDb();
  await db.setKeyValue(KV_THEMES, JSON.stringify(themes.slice(0, MAX_THEMES)));
}

export async function saveWorkingTheme(theme: ThemeDefinition | null): Promise<void> {
  const db = await settingsDb();
  await db.setKeyValue(KV_WORKING, theme ? JSON.stringify(theme) : '');
}

export async function saveActiveId(id: string): Promise<void> {
  const db = await settingsDb();
  await db.setKeyValue(KV_ACTIVE, id);
}

export async function saveVariantPolicy(policy: ThemeVariantPolicy): Promise<void> {
  const db = await settingsDb();
  await db.setKeyValue(KV_POLICY, policy);
}

export function readRuntimeSnapshot(): ThemeRuntimeSnapshot | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LS_SNAPSHOT);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ThemeRuntimeSnapshot>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.themeId !== 'string' || !parsed.themeId) return null;
    if (!isThemeVariant(parsed.variant)) return null;
    if (!parsed.vars || typeof parsed.vars !== 'object') return null;
    const vars: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.vars)) {
      if (key.startsWith('--') && typeof value === 'string') vars[key] = value;
    }
    return {
      themeId: parsed.themeId,
      variant: parsed.variant,
      vars,
      updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : 0,
    };
  } catch {
    return null;
  }
}

export function writeRuntimeSnapshot(snapshot: ThemeRuntimeSnapshot): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_SNAPSHOT, JSON.stringify(snapshot));
  } catch { /* 快照写失败仅影响下次启动的首帧恢复 */ }
}

export function clearRuntimeSnapshot(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(LS_SNAPSHOT);
  } catch { /* ignore */ }
}

export const THEME_STORAGE_KEYS = {
  themes: KV_THEMES,
  working: KV_WORKING,
  activeId: KV_ACTIVE,
  policy: KV_POLICY,
  snapshot: LS_SNAPSHOT,
};
