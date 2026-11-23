import { describe, expect, it } from 'vitest';
import { dedupeThemeName, parseThemeFile, serializeThemeFile } from '../themeValidation';
import { createThemeFromPreset } from '../themeModel';
import { THEME_PRESETS } from '../themePresets';

describe('themeValidation', () => {
  it('导出 → 导入语义无损', () => {
    const theme = createThemeFromPreset(THEME_PRESETS[0]!, '琥珀副本');
    const parsed = parseThemeFile(serializeThemeFile([theme]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.themes).toHaveLength(1);
    expect(parsed.themes[0]!.name).toBe('琥珀副本');
    expect(parsed.themes[0]!.variants.light).toEqual(theme.variants.light);
    // 导入时重建 ID，避免覆盖本地同 ID 主题
    expect(parsed.themes[0]!.id).not.toBe(theme.id);
  });

  it('拒绝非法 JSON / 错误格式 / 不支持版本', () => {
    expect(parseThemeFile('{')).toMatchObject({ ok: false, error: { code: 'invalid_json' } });
    expect(parseThemeFile('{"format":"other","schemaVersion":1,"themes":[]}'))
      .toMatchObject({ ok: false, error: { code: 'invalid_format' } });
    expect(parseThemeFile('{"format":"s1de-board-theme","schemaVersion":9,"themes":[]}'))
      .toMatchObject({ ok: false, error: { code: 'unsupported_version' } });
  });

  it('拒绝空列表、超量与空壳主题', () => {
    expect(parseThemeFile('{"format":"s1de-board-theme","schemaVersion":1,"themes":[]}'))
      .toMatchObject({ ok: false, error: { code: 'empty' } });
    const many = Array.from({ length: 51 }, () => ({ variants: { light: { primary: '#ffffff' } } }));
    expect(parseThemeFile(JSON.stringify({ format: 's1de-board-theme', schemaVersion: 1, themes: many })))
      .toMatchObject({ ok: false, error: { code: 'too_many' } });
    const empty = [{ name: '空壳', variants: { light: {}, dark: {} } }];
    expect(parseThemeFile(JSON.stringify({ format: 's1de-board-theme', schemaVersion: 1, themes: empty })))
      .toMatchObject({ ok: false, error: { code: 'invalid_theme', index: 0 } });
  });

  it('名称冲突时追加序号', () => {
    expect(dedupeThemeName('森林', [])).toBe('森林');
    expect(dedupeThemeName('森林', ['森林'])).toBe('森林(2)');
    expect(dedupeThemeName('森林', ['森林', '森林(2)'])).toBe('森林(3)');
  });
});
