import { describe, expect, it } from 'vitest';
import {
  anchorContrasts,
  anchorsFromTheme,
  buildAnchorTokens,
  checkThemeContrast,
  createThemeFromPreset,
  DEFAULT_THEME_ANCHORS,
  deriveTokens,
  enforceAnchorReadability,
  normalizeTheme,
  normalizeTokens,
  themeFromAnchors,
} from '../themeModel';
import { contrastRatio } from '../colorUtils';
import { THEME_PRESETS } from '../themePresets';
import { THEME_TOKEN_KEYS } from '../themeTokens';

describe('themeModel', () => {
  it('deriveTokens 为缺失的高级令牌生成完整集合', () => {
    const preset = THEME_PRESETS[0]!;
    const resolved = deriveTokens(preset.variants.light, 'light');
    for (const key of THEME_TOKEN_KEYS) {
      expect(resolved[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
    // 未覆盖的派生令牌应随基础色变化，而不是固定常量
    expect(resolved.secondary).not.toBe(resolved.primary);
    expect(resolved.surfaceField).not.toBe(resolved.surface);
  });

  it('手动覆盖的高级令牌优先于自动派生', () => {
    const tokens = { ...THEME_PRESETS[1]!.variants.light, secondary: '#123456' };
    expect(deriveTokens(tokens, 'light').secondary).toBe('#123456');
  });

  it('normalizeTheme 补齐基础令牌、忽略未知字段并截断名称', () => {
    const theme = normalizeTheme({
      name: '名'.repeat(40),
      variants: { light: { primary: '#ffffff', nope: '#000000' } },
      unknown: true,
    });
    expect(theme).not.toBeNull();
    expect(theme!.name.length).toBe(24);
    expect(theme!.variants.light.primary).toBe('#ffffff');
    expect(theme!.variants.light.surface).toBeDefined();
    expect((theme!.variants.light as Record<string, string>).nope).toBeUndefined();
    // 缺失的深色变体由浅色补齐，保证双变体都存在
    expect(theme!.variants.dark.primary).toBe('#ffffff');
  });

  it('normalizeTheme 拒绝没有 variants 的对象', () => {
    expect(normalizeTheme({ name: 'x' })).toBeNull();
    expect(normalizeTheme('nope')).toBeNull();
  });

  it('normalizeTokens 为基础令牌补齐默认值', () => {
    const tokens = normalizeTokens({ ink: '#112233' }, 'dark');
    expect(tokens.ink).toBe('#112233');
    expect(tokens.primary).toBe('#1e1f22');
  });

  it('createThemeFromPreset 生成可编辑副本（不共享引用）', () => {
    const preset = THEME_PRESETS[2]!;
    const theme = createThemeFromPreset(preset, '我的主题');
    theme.variants.light.primary = '#000000';
    expect(preset.variants.light.primary).not.toBe('#000000');
  });

  it('对比度检查能识别不可读的文字配色', () => {
    const tokens = deriveTokens({
      primary: '#ffffff', surface: '#ffffff', ink: '#eeeeee', accent: '#cccccc',
      line: '#f5f5f5', danger: '#eeeeee', success: '#eeeeee', shadow: '#000000',
    }, 'light');
    const issues = checkThemeContrast(tokens);
    expect(issues.some((i) => i.key === 'ink' && i.against === 'primary')).toBe(true);
  });

  it('三锚点派生完整令牌，正文/次要/按钮三项都达到 4.5:1', () => {
    const readable = enforceAnchorReadability(DEFAULT_THEME_ANCHORS, 'light');
    expect(readable.ok).toBe(true);
    expect(readable.correctedText).toBe(false);
    expect(readable.correctedAccent).toBe(false);
    const tokens = deriveTokens(buildAnchorTokens(readable.anchors, 'light'), 'light');
    for (const key of THEME_TOKEN_KEYS) {
      expect(tokens[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
    const ratios = anchorContrasts(tokens);
    expect(ratios.body).toBeGreaterThanOrEqual(4.5);
    expect(ratios.secondary).toBeGreaterThanOrEqual(4.5);
    expect(ratios.button).toBeGreaterThanOrEqual(4.5);
  });

  it('对比度不足时自动修正文字与主色明度', () => {
    const readable = enforceAnchorReadability(
      { bg: '#ffffff', accent: '#f0f0f0', ink: '#eeeeee' },
      'light',
    );
    expect(readable.ok).toBe(true);
    expect(readable.correctedText).toBe(true);
    expect(readable.correctedAccent).toBe(true);
    const tokens = deriveTokens(buildAnchorTokens(readable.anchors, 'light'), 'light');
    expect(contrastRatio(tokens.ink, tokens.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens.accent, tokens.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('themeFromAnchors 生成浅/深双变体，且可读回三锚点', () => {
    const theme = themeFromAnchors('自定义配色', DEFAULT_THEME_ANCHORS, 'custom:working');
    expect(theme.id).toBe('custom:working');
    const readable = enforceAnchorReadability(DEFAULT_THEME_ANCHORS, 'light');
    expect(anchorsFromTheme(theme, 'light')).toEqual(readable.anchors);
    const dark = deriveTokens(theme.variants.dark, 'dark');
    expect(contrastRatio(dark.ink, dark.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.accent, dark.surface)).toBeGreaterThanOrEqual(4.5);
  });
});
