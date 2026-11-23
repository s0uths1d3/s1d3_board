/**
 * 内置预设模板（6 套，均含浅/深双变体）
 *
 * 预设只保存基础令牌，派生令牌由 deriveTokens 自动生成；
 * 「一键应用」= 克隆为用户主题，不修改预设本身。
 */
import type { ThemeAnchors, ThemePreset, ThemeTokens } from './themeModel';

function v(light: ThemeTokens, dark: ThemeTokens): ThemePreset['variants'] {
  return { light, dark };
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    // 与内置「琥珀」同源的浅色 + 暖褐深色变体
    id: 'amber',
    variants: v(
      {
        primary: '#f0e9e1', surface: '#ece1d0', ink: '#4a4438', accent: '#c4a77d',
        line: '#cbbfa9', danger: '#b05c5c', success: '#6f8a55', shadow: '#4a4034',
      },
      {
        primary: '#221e1a', surface: '#2c2722', ink: '#e9e1d4', accent: '#c9ab7e',
        line: '#4a4136', danger: '#d97a6c', success: '#8fa86b', shadow: '#000000',
      },
    ),
  },
  {
    // 中性石墨：与内置 light / dark 同源
    id: 'graphite',
    variants: v(
      {
        primary: '#f5f6f8', surface: '#ffffff', ink: '#1f2124', accent: '#3e4146',
        line: '#cfd4dc', danger: '#cd4444', success: '#4c8a5c', shadow: '#283246',
        highlight: '#e9be46', highlightInk: '#1f2124',
      },
      {
        primary: '#1e1f22', surface: '#2b2d30', ink: '#dfe1e5', accent: '#b0b3b8',
        line: '#42454a', danger: '#db5c5c', success: '#6ca876', shadow: '#000000',
        highlight: '#aa913c', highlightInk: '#ebdcb4',
      },
    ),
  },
  {
    // IDEA Darcula 风：深色为主，浅色变体保持蓝灰强调
    id: 'darcula',
    variants: v(
      {
        primary: '#f2f2f2', surface: '#ffffff', ink: '#2b2b2b', accent: '#4b6eaf',
        line: '#d0d0d0', danger: '#c75450', success: '#3d7b3d', shadow: '#2b2b2b',
      },
      {
        primary: '#2b2b2b', surface: '#3c3f41', ink: '#dfe1e5', accent: '#a9b7c6',
        line: '#4e5254', danger: '#db5c5c', success: '#6a8759', shadow: '#000000',
      },
    ),
  },
  {
    id: 'forest',
    variants: v(
      {
        primary: '#f2f6ef', surface: '#ffffff', ink: '#253226', accent: '#4f7a4a',
        line: '#cfdcc9', danger: '#b04a4a', success: '#3f7d4f', shadow: '#26351f',
      },
      {
        primary: '#1a211a', surface: '#232c23', ink: '#dde8da', accent: '#7fa87a',
        line: '#3b4a3a', danger: '#d47b6f', success: '#8fbf8a', shadow: '#000000',
      },
    ),
  },
  {
    id: 'ocean',
    variants: v(
      {
        primary: '#eef3f7', surface: '#ffffff', ink: '#1c2b36', accent: '#2f6f8f',
        line: '#c8d6e0', danger: '#b74f4f', success: '#3d7f6a', shadow: '#1a3245',
      },
      {
        primary: '#121b22', surface: '#1b262f', ink: '#d8e3ea', accent: '#6fa8c4',
        line: '#2f4050', danger: '#d97a6f', success: '#79b89f', shadow: '#000000',
      },
    ),
  },
  {
    id: 'rose',
    variants: v(
      {
        primary: '#f8f1f2', surface: '#ffffff', ink: '#3a2529', accent: '#a8556b',
        line: '#e2cdd1', danger: '#b03a4a', success: '#4f7f62', shadow: '#3a2026',
      },
      {
        primary: '#221619', surface: '#2d1d21', ink: '#ecdde0', accent: '#d98fa2',
        line: '#4d3238', danger: '#e07b81', success: '#86b393', shadow: '#000000',
      },
    ),
  },
];

export function getPreset(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((p) => p.id === id);
}

/** 快捷起点：只读入三锚点，不落库、不自动应用 */
export interface ThemeAnchorPreset {
  /** i18n 名称 key 后缀：theme.anchor_presets.<id> */
  id: string;
  anchors: ThemeAnchors;
}

export const THEME_ANCHOR_PRESETS: ThemeAnchorPreset[] = [
  { id: 'forest', anchors: { bg: '#e9efe3', accent: '#2f5d3a', ink: '#1b2a1d' } },
  { id: 'indigo', anchors: { bg: '#edf1f8', accent: '#33518f', ink: '#161b2b' } },
  { id: 'ochre', anchors: { bg: '#f3ede1', accent: '#8a5a2b', ink: '#241c12' } },
];
