/**
 * 颜色算法（纯函数，可单测）
 *
 * - hex ↔ rgb ↔ hsl
 * - 相对亮度 / WCAG 对比度
 * - 混色、提亮/压暗、自动选择前景色
 *
 * 约定：所有颜色入参为 #rrggbb（兼容 #rgb，输出统一小写六位）；
 * 非法输入返回 null，调用方负责回退。
 */

const HEX6 = /^#([0-9a-f]{6})$/i;
const HEX3 = /^#([0-9a-f]{3})$/i;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** 规范化 hex：支持省略 # 与三位简写；非法返回 null */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let s = value.trim().toLowerCase();
  if (!s) return null;
  if (!s.startsWith('#')) s = `#${s}`;
  const short = s.match(HEX3);
  if (short) {
    const [r, g, b] = short[1]!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return HEX6.test(s) ? s : null;
}

export function isValidHex(value: unknown): boolean {
  return normalizeHex(value) !== null;
}

export function hexToRgb(value: string): Rgb | null {
  const hex = normalizeHex(value);
  if (!hex) return null;
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function rgbToHex(rgb: Rgb): string {
  const to = (n: number) => clampChannel(n).toString(16).padStart(2, '0');
  return `#${to(rgb.r)}${to(rgb.g)}${to(rgb.b)}`;
}

/** hex → "r g b"（main.css 变量使用的通道格式） */
export function hexToChannels(value: string): string | null {
  const rgb = hexToRgb(value);
  return rgb ? `${rgb.r} ${rgb.g} ${rgb.b}` : null;
}

/** 按 weight 把 a 混向 b（weight=0 → a，weight=1 → b） */
export function mixHex(a: string, b: string, weight: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return normalizeHex(a) ?? '#000000';
  const w = Math.max(0, Math.min(1, weight));
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * w,
    g: ca.g + (cb.g - ca.g) * w,
    b: ca.b + (cb.b - ca.b) * w,
  });
}

/** 向白色混合（amount 越大越亮） */
export function lighten(hex: string, amount: number): string {
  return mixHex(hex, '#ffffff', amount);
}

/** 向黑色混合（amount 越大越暗） */
export function darken(hex: string, amount: number): string {
  return mixHex(hex, '#000000', amount);
}

/** sRGB 相对亮度（WCAG 2.1） */
export function relativeLuminance(value: string): number {
  const rgb = hexToRgb(value);
  if (!rgb) return 0;
  const channel = (n: number) => {
    const s = n / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG 对比度（1 ~ 21） */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 把前景色沿明度轴调整到与所有背景都达到 min 对比度（保留色相/饱和度）。
 * 黑白都达不到（例如中灰背景）时返回 null，由调用方阻断应用。
 */
export function adjustForContrast(fg: string, backgrounds: string[], min = 4.5): string | null {
  const start = normalizeHex(fg);
  if (!start) return null;
  const bgs = backgrounds.map((bg) => normalizeHex(bg)).filter((bg): bg is string => bg !== null);
  if (!bgs.length) return start;
  const passes = (c: string) => bgs.every((bg) => contrastRatio(c, bg) >= min);
  if (passes(start)) return start;
  const toBlack = passes('#000000');
  const toWhite = passes('#ffffff');
  if (!toBlack && !toWhite) return null;
  const hsl = hexToHsl(start);
  if (!hsl) return null;
  for (let step = 1; step <= 100; step++) {
    const l = toBlack ? hsl.l - step * 0.01 : hsl.l + step * 0.01;
    if (l < 0 || l > 1) break;
    const candidate = hslToHex(hsl.h, hsl.s, l);
    if (passes(candidate)) return candidate;
  }
  return toBlack ? '#000000' : '#ffffff';
}

/** 在候选前景色中选与背景对比度最高者 */
export function pickContrastingColor(bg: string, candidates: string[] = ['#ffffff', '#1b1c1e']): string {
  let best = candidates[0] ?? '#ffffff';
  let bestRatio = 0;
  for (const c of candidates) {
    const ratio = contrastRatio(bg, c);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = c;
    }
  }
  return best;
}

/** 是否为深色（用于按变体选择透明度/前景） */
export function isDarkColor(hex: string): boolean {
  return relativeLuminance(hex) < 0.4;
}

/** hex → HSL（h 0-360，s/l 0-1）；非法输入返回 null */
export function hexToHsl(value: string): Hsl | null {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: (h + 360) % 360, s, l };
}

/** HSL → hex（h 0-360，s/l 0-1） */
export function hslToHex(h: number, s: number, l: number): string {
  const sn = Math.max(0, Math.min(1, s));
  const ln = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = ln - c / 2;
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
