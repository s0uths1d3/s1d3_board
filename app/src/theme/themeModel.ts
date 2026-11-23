/**
 * 主题领域模型
 *
 * 存储层只保存用户显式指定的令牌（基础 8 项必填，其余可省略），
 * 运行时由 deriveTokens 补全派生令牌——这样「自动派生 / 手动覆盖」
 * 不需要额外开关：字段存在即覆盖，删除即回到自动派生。
 */
import {
  adjustForContrast,
  contrastRatio,
  darken,
  hexToHsl,
  hslToHex,
  isValidHex,
  lighten,
  mixHex,
  normalizeHex,
  pickContrastingColor,
} from './colorUtils';
import {
  BASIC_TOKEN_KEYS,
  THEME_TOKEN_KEYS,
  THEME_TOKEN_MAP,
  type ThemeTokenKey,
  type ThemeVariant,
} from './themeTokens';

export const THEME_SCHEMA_VERSION = 1 as const;
export const THEME_NAME_MAX = 24;
export const THEME_DESC_MAX = 120;

export type ThemeTokens = Partial<Record<ThemeTokenKey, string>>;
export type ResolvedThemeTokens = Record<ThemeTokenKey, string>;

export interface ThemeDefinition {
  schemaVersion: typeof THEME_SCHEMA_VERSION;
  id: string;
  name: string;
  description?: string;
  /** 预设副本也为 false：预设只读，用户副本可编辑 */
  builtin?: boolean;
  createdAt: number;
  updatedAt: number;
  variants: Record<ThemeVariant, ThemeTokens>;
}

export interface ThemePreset {
  /** i18n 名称 key 后缀：theme.presets.<id> */
  id: string;
  variants: Record<ThemeVariant, ThemeTokens>;
}

/** UUID（crypto.randomUUID 在 Tauri/现代 WebView/Node 19+ 均可用，保留兜底） */
export function createThemeId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const rnd = () => Math.random().toString(16).slice(2, 10);
  return `${rnd()}${rnd()}-${rnd()}-${rnd()}`;
}

function now(): number {
  return Date.now();
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** 只保留白名单内且合法的颜色值 */
function sanitizeTokenSet(raw: unknown): ThemeTokens {
  const out: ThemeTokens = {};
  if (!raw || typeof raw !== 'object') return out;
  const source = raw as Record<string, unknown>;
  for (const key of THEME_TOKEN_KEYS) {
    const hex = normalizeHex(source[key]);
    if (hex) out[key] = hex;
  }
  return out;
}

/** 补齐基础令牌：缺失时按变体取兜底值，保证任何主题都能完整渲染 */
export function normalizeTokens(tokens: ThemeTokens, variant: ThemeVariant): ThemeTokens {
  const out: ThemeTokens = { ...tokens };
  for (const key of BASIC_TOKEN_KEYS) {
    if (!out[key]) out[key] = THEME_TOKEN_MAP[key].defaults[variant];
  }
  return out;
}

/** 三锚点：底色（页面背景）/ 主色（品牌强调）/ 文字色 */
export interface ThemeAnchors {
  bg: string;
  accent: string;
  ink: string;
}

/** 首次打开自定义主题时的锚点（与设计参考一致） */
export const DEFAULT_THEME_ANCHORS: ThemeAnchors = {
  bg: '#f3ede1',
  accent: '#c4442b',
  ink: '#1e1b16',
};

/** 从已存主题读回三锚点（默认取浅色变体） */
export function anchorsFromTheme(theme: ThemeDefinition, variant: ThemeVariant = 'light'): ThemeAnchors {
  const tokens = normalizeTokens(sanitizeTokenSet(theme.variants[variant]), variant);
  return { bg: tokens.primary!, accent: tokens.accent!, ink: tokens.ink! };
}

/** 变体下由底色派生的卡片面/输入面（对比度修正时作为背景集合） */
function anchorSurfaces(bg: string, variant: ThemeVariant): { surface: string; field: string } {
  return {
    surface: variant === 'dark' ? lighten(bg, 0.06) : mixHex(bg, '#ffffff', 0.5),
    field: variant === 'dark' ? lighten(bg, 0.12) : lighten(bg, 0.72),
  };
}

export interface AnchorReadability {
  ok: boolean;
  anchors: ThemeAnchors;
  correctedText: boolean;
  correctedAccent: boolean;
}

/**
 * 三锚点可读性修正：文字色/主色沿明度轴自动调整到与底色、卡片面
 * 均达到 4.5:1；两者都调整失败（如中灰底）时 ok=false，调用方阻止应用。
 */
export function enforceAnchorReadability(anchors: ThemeAnchors, variant: ThemeVariant): AnchorReadability {
  const bg = normalizeHex(anchors.bg) ?? DEFAULT_THEME_ANCHORS.bg;
  const rawInk = normalizeHex(anchors.ink) ?? DEFAULT_THEME_ANCHORS.ink;
  const rawAccent = normalizeHex(anchors.accent) ?? DEFAULT_THEME_ANCHORS.accent;
  const { surface, field } = anchorSurfaces(bg, variant);
  // 正文要读在卡片面与输入面上；主色按钮落在卡片面上，按卡片面对齐参考稿的“按钮”指标
  const ink = adjustForContrast(rawInk, [bg, surface, field], 4.5);
  const accent = adjustForContrast(rawAccent, [surface], 4.5);
  return {
    ok: ink !== null && accent !== null,
    anchors: { bg, ink: ink ?? rawInk, accent: accent ?? rawAccent },
    correctedText: ink !== null && ink !== rawInk,
    correctedAccent: accent !== null && accent !== rawAccent,
  };
}

/** 由三锚点构造某一变体的基础令牌（其余令牌交给 deriveTokens 派生） */
export function buildAnchorTokens(anchors: ThemeAnchors, variant: ThemeVariant): ThemeTokens {
  const bg = normalizeHex(anchors.bg) ?? DEFAULT_THEME_ANCHORS.bg;
  const ink = normalizeHex(anchors.ink) ?? DEFAULT_THEME_ANCHORS.ink;
  const accent = normalizeHex(anchors.accent) ?? DEFAULT_THEME_ANCHORS.accent;
  const { surface } = anchorSurfaces(bg, variant);
  const lineBase = mixHex(bg, ink, 0.22);
  const line = adjustForContrast(lineBase, [surface], 1.5) ?? lineBase;
  const dark = variant === 'dark';
  return {
    primary: bg,
    surface,
    ink,
    accent,
    line,
    danger: dark ? '#d97a6c' : '#b05c5c',
    success: dark ? '#8fa86b' : '#6f8a55',
    shadow: dark ? '#000000' : darken(bg, 0.5),
  };
}

/** 由浅色锚点推导深色锚点：保留品牌色相，压暗底色、提亮文字与主色 */
export function deriveDarkAnchors(anchors: ThemeAnchors): ThemeAnchors {
  const bgHsl = hexToHsl(normalizeHex(anchors.bg) ?? DEFAULT_THEME_ANCHORS.bg);
  const inkHsl = hexToHsl(normalizeHex(anchors.ink) ?? DEFAULT_THEME_ANCHORS.ink);
  const accentHsl = hexToHsl(normalizeHex(anchors.accent) ?? DEFAULT_THEME_ANCHORS.accent);
  const bg = hslToHex(bgHsl?.h ?? 35, Math.min(bgHsl?.s ?? 0.2, 0.16), 0.11);
  const ink = hslToHex(inkHsl?.h ?? 35, Math.min(inkHsl?.s ?? 0.2, 0.12), 0.88);
  const accent = hslToHex(
    accentHsl?.h ?? 10,
    Math.max(accentHsl?.s ?? 0.6, 0.35),
    Math.min(0.72, Math.max(0.52, accentHsl?.l ?? 0.5)),
  );
  return enforceAnchorReadability({ bg, accent, ink }, 'dark').anchors;
}

/** 由三锚点生成完整主题（浅色用锚点，深色自动推导）；同一 ID 用于覆盖 */
export function themeFromAnchors(name: string, anchors: ThemeAnchors, id = createThemeId()): ThemeDefinition {
  const lightAnchors = enforceAnchorReadability(anchors, 'light').anchors;
  const darkAnchors = deriveDarkAnchors(lightAnchors);
  const at = now();
  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    id,
    name: truncate(name.trim() || '未命名主题', THEME_NAME_MAX),
    builtin: false,
    createdAt: at,
    updatedAt: at,
    variants: {
      light: buildAnchorTokens(lightAnchors, 'light'),
      dark: buildAnchorTokens(darkAnchors, 'dark'),
    },
  };
}

export interface AnchorContrast {
  body: number;
  secondary: number;
  button: number;
}

/** 预览用三项对比度：正文 / 次要文字 / 按钮主色（均以卡片面为背景） */
export function anchorContrasts(tokens: ResolvedThemeTokens): AnchorContrast {
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    body: round(contrastRatio(tokens.ink, tokens.surface)),
    secondary: round(contrastRatio(tokens.inkSoft, tokens.surface)),
    button: round(contrastRatio(tokens.accent, tokens.surface)),
  };
}

/**
 * 规范化任意来源的主题对象（存储读取 / 导入）。
 * - 未知字段忽略
 * - 名称/描述截断
 * - 缺失变体互相补齐，基础令牌补默认值
 */
export function normalizeTheme(raw: unknown, options: { regenerateId?: boolean } = {}): ThemeDefinition | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const rawVariants = (source.variants && typeof source.variants === 'object')
    ? source.variants as Record<string, unknown>
    : null;
  if (!rawVariants) return null;

  const lightRaw = sanitizeTokenSet(rawVariants.light);
  const darkRaw = sanitizeTokenSet(rawVariants.dark);
  // 只有一个变体时互相补齐：旧文件/手工编辑也不至于整半套缺失
  const light = normalizeTokens(Object.keys(lightRaw).length ? lightRaw : darkRaw, 'light');
  const dark = normalizeTokens(Object.keys(darkRaw).length ? darkRaw : lightRaw, 'dark');

  const rawName = typeof source.name === 'string' ? source.name.trim() : '';
  const createdAt = Number.isFinite(source.createdAt) ? Number(source.createdAt) : now();
  const updatedAt = Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : createdAt;
  const id = options.regenerateId
    ? createThemeId()
    : (typeof source.id === 'string' && source.id.trim() ? source.id.trim() : createThemeId());

  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    id,
    name: truncate(rawName || '未命名主题', THEME_NAME_MAX),
    description: typeof source.description === 'string'
      ? truncate(source.description.trim(), THEME_DESC_MAX)
      : undefined,
    builtin: source.builtin === true,
    createdAt,
    updatedAt,
    variants: { light, dark },
  };
}

export function cloneTheme(theme: ThemeDefinition): ThemeDefinition {
  return {
    ...theme,
    variants: {
      light: { ...theme.variants.light },
      dark: { ...theme.variants.dark },
    },
  };
}

/** 从预设克隆出可编辑的用户主题（不修改预设本身） */
export function createThemeFromPreset(preset: ThemePreset, name: string): ThemeDefinition {
  const t = now();
  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    id: createThemeId(),
    name: truncate(name.trim() || '未命名主题', THEME_NAME_MAX),
    builtin: false,
    createdAt: t,
    updatedAt: t,
    variants: {
      light: normalizeTokens(sanitizeTokenSet(preset.variants.light), 'light'),
      dark: normalizeTokens(sanitizeTokenSet(preset.variants.dark), 'dark'),
    },
  };
}

/**
 * 派生补全：基础令牌 + 可选手动覆盖 → 完整令牌集。
 * 所有派生都是确定性的，同输入同输出，便于单测与预览。
 */
export function deriveTokens(tokens: ThemeTokens, variant: ThemeVariant): ResolvedThemeTokens {
  const base = normalizeTokens(sanitizeTokenSet(tokens), variant);
  const pick = (key: ThemeTokenKey, fallback: string): string => base[key] ?? fallback;

  const primary = base.primary!;
  const surface = base.surface!;
  const ink = base.ink!;
  const accent = base.accent!;
  const line = base.line!;
  const dark = variant === 'dark';

  const secondary = pick('secondary', mixHex(primary, ink, 0.08));
  const borderAccent = pick('borderAccent', mixHex(line, surface, 0.7));
  const accentSoft = pick('accentSoft', mixHex(accent, primary, 0.35));
  const surfaceField = pick('surfaceField', dark ? lighten(surface, 0.06) : lighten(surface, 0.55));
  const onAccent = pick('onAccent', pickContrastingColor(accent, ['#ffffff', dark ? '#1b1c1e' : '#2b2620']));
  const inkSoft = pick('inkSoft', mixHex(ink, primary, 0.22));
  const inkFaint = pick('inkFaint', mixHex(ink, primary, 0.5));
  const code = pick('code', dark ? darken(primary, 0.4) : darken(primary, 0.82));
  const highlight = pick('highlight', accent);
  const highlightInk = pick('highlightInk', pickContrastingColor(highlight, ['#ffffff', '#1b1c1e']));

  const bgA = pick('bgA', dark ? primary : lighten(primary, 0.04));
  const bgB = pick('bgB', dark ? lighten(primary, 0.045) : darken(primary, 0.02));
  const bgC = pick('bgC', dark ? lighten(primary, 0.09) : darken(primary, 0.05));
  const glowA = pick('glowA', accent);
  const glowB = pick('glowB', line);

  const tipBg = pick('tipBg', dark ? ink : darken(ink, 0.2));
  const tipText = pick('tipText', pickContrastingColor(tipBg, [dark ? primary : '#f5efe3', '#ffffff']));

  return {
    primary,
    surface,
    ink,
    accent,
    line,
    danger: base.danger!,
    success: base.success!,
    shadow: base.shadow!,
    borderAccent,
    secondary,
    accentSoft,
    surfaceField,
    onAccent,
    inkSoft,
    inkFaint,
    code,
    highlight,
    highlightInk,
    bgA,
    bgB,
    bgC,
    glowA,
    glowB,
    tipBg,
    tipText,
  };
}

export interface ContrastIssue {
  key: ThemeTokenKey;
  against: ThemeTokenKey;
  ratio: number;
  min: number;
}

/** WCAG 对比度检查（编辑器提示用；不阻断保存） */
export function checkThemeContrast(tokens: ResolvedThemeTokens): ContrastIssue[] {
  const rules: Array<{ key: ThemeTokenKey; against: ThemeTokenKey; min: number }> = [
    { key: 'ink', against: 'primary', min: 4.5 },
    { key: 'ink', against: 'surface', min: 4.5 },
    { key: 'danger', against: 'surface', min: 4.5 },
    { key: 'success', against: 'surface', min: 4.5 },
    { key: 'line', against: 'surface', min: 1.5 },
  ];
  const issues: ContrastIssue[] = [];
  for (const rule of rules) {
    const ratio = contrastRatio(tokens[rule.key], tokens[rule.against]);
    if (ratio < rule.min) {
      issues.push({ ...rule, ratio: Math.round(ratio * 100) / 100 });
    }
  }
  return issues;
}

/** 变体令牌整体是否合法（导入/保存前快速自检） */
export function hasValidBasicTokens(tokens: ThemeTokens): boolean {
  return BASIC_TOKEN_KEYS.every((key) => isValidHex(tokens[key]));
}
