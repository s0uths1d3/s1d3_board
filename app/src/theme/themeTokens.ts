/**
 * 自定义主题令牌白名单（单一来源）
 *
 * 每个令牌描述：编辑器 key、注入的 CSS 变量名、分组、是否高级、浅/深变体兜底值。
 * CSS 变量沿用 main.css 的 RGB 通道格式（"r g b"），保证 Tailwind 透明度
 * 修饰符与 color-mix 行为与内置四档主题完全一致。
 *
 * 注意：令牌值在主题定义中统一存 #rrggbb；注入时再由 colorUtils 转成通道。
 */
export type ThemeVariant = 'light' | 'dark';

export type ThemeTokenGroup = 'core' | 'text' | 'state' | 'effect';

export type ThemeTokenKey =
  | 'primary'
  | 'surface'
  | 'ink'
  | 'accent'
  | 'line'
  | 'danger'
  | 'success'
  | 'shadow'
  | 'borderAccent'
  | 'secondary'
  | 'accentSoft'
  | 'surfaceField'
  | 'onAccent'
  | 'inkSoft'
  | 'inkFaint'
  | 'code'
  | 'highlight'
  | 'highlightInk'
  | 'bgA'
  | 'bgB'
  | 'bgC'
  | 'glowA'
  | 'glowB'
  | 'tipBg'
  | 'tipText';

export interface ThemeTokenMeta {
  key: ThemeTokenKey;
  /** 注入的 CSS 变量名（main.css 中已存在，内联覆盖即可） */
  cssVar: string;
  group: ThemeTokenGroup;
  /** 高级令牌默认折叠，避免首次进入被 20+ 项淹没 */
  advanced: boolean;
  /** 缺失时的兜底值（浅色取内置琥珀、深色取内置深色） */
  defaults: Record<ThemeVariant, string>;
}

export const THEME_TOKEN_LIST: ThemeTokenMeta[] = [
  // ===== 基础：页面/卡片/文字/品牌/语义 =====
  {
    key: 'primary', cssVar: '--c-primary', group: 'core', advanced: false,
    defaults: { light: '#f0e9e1', dark: '#1e1f22' },
  },
  {
    key: 'surface', cssVar: '--c-surface', group: 'core', advanced: false,
    defaults: { light: '#ece1d0', dark: '#2b2d30' },
  },
  {
    key: 'ink', cssVar: '--c-ink', group: 'core', advanced: false,
    defaults: { light: '#4a4438', dark: '#dfe1e5' },
  },
  {
    key: 'accent', cssVar: '--c-gold', group: 'core', advanced: false,
    defaults: { light: '#c4a77d', dark: '#b0b3b8' },
  },
  {
    key: 'line', cssVar: '--c-line', group: 'state', advanced: false,
    defaults: { light: '#cbbfa9', dark: '#42454a' },
  },
  {
    key: 'danger', cssVar: '--c-danger', group: 'state', advanced: false,
    defaults: { light: '#b05c5c', dark: '#db5c5c' },
  },
  {
    key: 'success', cssVar: '--c-success', group: 'state', advanced: false,
    defaults: { light: '#6f8a55', dark: '#6ca876' },
  },
  {
    key: 'shadow', cssVar: '--c-shadow', group: 'state', advanced: false,
    defaults: { light: '#4a4034', dark: '#000000' },
  },

  // ===== 高级：派生令牌（可手动覆盖，留空则自动派生） =====
  {
    key: 'borderAccent', cssVar: '--c-accent', group: 'core', advanced: true,
    defaults: { light: '#d4c9b8', dark: '#3a3c40' },
  },
  {
    key: 'secondary', cssVar: '--c-secondary', group: 'effect', advanced: true,
    defaults: { light: '#e8e0d5', dark: '#2b2d30' },
  },
  {
    key: 'accentSoft', cssVar: '--c-gold-soft', group: 'core', advanced: true,
    defaults: { light: '#d9c3a3', dark: '#d2d5da' },
  },
  {
    key: 'surfaceField', cssVar: '--c-surface-field', group: 'core', advanced: true,
    defaults: { light: '#f6efe3', dark: '#35373b' },
  },
  {
    key: 'onAccent', cssVar: '--c-on-gold', group: 'core', advanced: true,
    defaults: { light: '#ffffff', dark: '#1b1c1e' },
  },
  {
    key: 'inkSoft', cssVar: '--c-ink-soft', group: 'text', advanced: true,
    defaults: { light: '#6b6354', dark: '#a7aab0' },
  },
  {
    key: 'inkFaint', cssVar: '--c-ink-faint', group: 'text', advanced: true,
    defaults: { light: '#9a9080', dark: '#7a7d83' },
  },
  {
    key: 'code', cssVar: '--c-code', group: 'effect', advanced: true,
    defaults: { light: '#2d2d2d', dark: '#2d2d2d' },
  },
  {
    key: 'highlight', cssVar: '--c-hl', group: 'effect', advanced: true,
    defaults: { light: '#c4a77d', dark: '#aa913c' },
  },
  {
    key: 'highlightInk', cssVar: '--c-hl-ink', group: 'effect', advanced: true,
    defaults: { light: '#4a4438', dark: '#ebdcb4' },
  },
  {
    key: 'bgA', cssVar: '--bg-a', group: 'effect', advanced: true,
    defaults: { light: '#faf6f2', dark: '#1e1f22' },
  },
  {
    key: 'bgB', cssVar: '--bg-b', group: 'effect', advanced: true,
    defaults: { light: '#f5ede4', dark: '#27292c' },
  },
  {
    key: 'bgC', cssVar: '--bg-c', group: 'effect', advanced: true,
    defaults: { light: '#ebe0d4', dark: '#303236' },
  },
  {
    key: 'glowA', cssVar: '--glow-a', group: 'effect', advanced: true,
    defaults: { light: '#c4a77d', dark: '#a0a3a8' },
  },
  {
    key: 'glowB', cssVar: '--glow-b', group: 'effect', advanced: true,
    defaults: { light: '#d4c9b8', dark: '#606368' },
  },
  {
    key: 'tipBg', cssVar: '--tip-bg', group: 'effect', advanced: true,
    defaults: { light: '#3a342a', dark: '#dfe1e5' },
  },
  {
    key: 'tipText', cssVar: '--tip-text', group: 'effect', advanced: true,
    defaults: { light: '#f5efe3', dark: '#1e1f22' },
  },
];

export const THEME_TOKEN_MAP: Record<ThemeTokenKey, ThemeTokenMeta> = Object.fromEntries(
  THEME_TOKEN_LIST.map((t) => [t.key, t]),
) as Record<ThemeTokenKey, ThemeTokenMeta>;

export const THEME_TOKEN_KEYS: ThemeTokenKey[] = THEME_TOKEN_LIST.map((t) => t.key);

/** 基础令牌（必须存在；缺失时用兜底值补齐） */
export const BASIC_TOKEN_KEYS: ThemeTokenKey[] = THEME_TOKEN_LIST
  .filter((t) => !t.advanced)
  .map((t) => t.key);

/** 分组顺序：编辑器按此顺序渲染 */
export const THEME_GROUP_ORDER: ThemeTokenGroup[] = ['core', 'text', 'state', 'effect'];

export function tokensByGroup(group: ThemeTokenGroup, includeAdvanced: boolean): ThemeTokenMeta[] {
  return THEME_TOKEN_LIST.filter((t) => t.group === group && (includeAdvanced || !t.advanced));
}
