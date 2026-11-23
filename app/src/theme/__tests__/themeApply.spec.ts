import { beforeEach, describe, expect, it } from 'vitest';
import { applyCustomTheme, buildThemeVars, clearCustomTheme, setRuntimeTheme } from '../themeApply';
import { createThemeFromPreset, deriveTokens } from '../themeModel';
import { THEME_PRESETS } from '../themePresets';

describe('themeApply', () => {
  beforeEach(() => {
    clearCustomTheme();
  });

  it('buildThemeVars 输出 RGB 通道与玻璃/光晕透明度', () => {
    const tokens = deriveTokens(THEME_PRESETS[0]!.variants.light, 'light');
    const vars = buildThemeVars(tokens, 'light');
    expect(vars['--c-primary']).toBe('240 233 225');
    expect(vars['--glass-bg']).toBe('255 255 255');
    expect(vars['--glass-bg-alpha']).toBe('0.55');
    expect(vars['--glow-a-alpha']).toBe('0.3');
  });

  it('应用/清除自定义主题不残留内联变量', () => {
    const theme = createThemeFromPreset(THEME_PRESETS[1]!, '石墨');
    setRuntimeTheme(theme, 'light');
    expect(applyCustomTheme(false)).toBe(true);

    const html = document.documentElement;
    expect(html.dataset.scheme).toBe('custom');
    expect(html.dataset.themeVariant).toBe('light');
    expect(html.style.getPropertyValue('--c-primary')).toBe('245 246 248');
    expect(html.style.getPropertyValue('color-scheme')).toBe('light');

    clearCustomTheme();
    expect(html.dataset.scheme).toBeUndefined();
    expect(html.dataset.themeVariant).toBeUndefined();
    expect(html.style.getPropertyValue('--c-primary')).toBe('');
    expect(html.style.getPropertyValue('--glass-bg-alpha')).toBe('');
  });

  it('变体策略固定深色时注入深色令牌', () => {
    const theme = createThemeFromPreset(THEME_PRESETS[1]!, '石墨');
    setRuntimeTheme(theme, 'dark');
    expect(applyCustomTheme(false)).toBe(true);
    expect(document.documentElement.dataset.themeVariant).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--c-primary')).toBe('30 31 34');
    setRuntimeTheme(null, 'system');
  });
});
