import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  hexToChannels,
  hexToHsl,
  hexToRgb,
  hslToHex,
  mixHex,
  normalizeHex,
  pickContrastingColor,
  relativeLuminance,
} from '../colorUtils';

describe('colorUtils', () => {
  it('normalizeHex 兼容三位简写与省略 #，非法输入返回 null', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('c4a77d')).toBe('#c4a77d');
    expect(normalizeHex('#GGGGGG')).toBeNull();
    expect(normalizeHex('')).toBeNull();
  });

  it('hexToRgb / hexToChannels 使用 RGB 通道格式', () => {
    expect(hexToRgb('#c4a77d')).toEqual({ r: 196, g: 167, b: 125 });
    expect(hexToChannels('#c4a77d')).toBe('196 167 125');
    expect(hexToChannels('zzz')).toBeNull();
  });

  it('WCAG 黑白对比度为 21:1', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('pickContrastingColor 在黑白候选里选对比度更高者', () => {
    expect(pickContrastingColor('#f0e9e1')).toBe('#1b1c1e');
    expect(pickContrastingColor('#1e1f22')).toBe('#ffffff');
  });

  it('mixHex 按权重线性混合', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('hex ↔ hsl 往返稳定', () => {
    const hsl = hexToHsl('#4f7a4a');
    expect(hsl).not.toBeNull();
    const hex = hslToHex(hsl!.h, hsl!.s, hsl!.l);
    expect(hex).toBe('#4f7a4a');
  });
});
