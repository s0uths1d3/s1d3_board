import { ref, computed } from 'vue';
import { listen, emit } from '@tauri-apps/api/event';
import dbService from '~/src/db/dbService';
import { isTauri } from '~/src/utils/env';

/**
 * 配色模式：
 * - system：跟随系统深浅色（默认模式；系统深色 → dark 配色，系统浅色 → amber 暖米色）
 * - default（琥珀）/ light / dark：固定使用指定配色
 */
export type ColorSchemeMode = 'system' | 'default' | 'light' | 'dark';
/** 实际渲染用的配色（解析 system 之后） */
export type ColorScheme = 'default' | 'light' | 'dark';

const SCHEME_KEY = 'color_scheme';
/** 跨窗口同步事件：设置页/快捷键切换后广播给 tooltip/viewer 等子窗口 */
const SCHEME_EVENT = 'scheme:changed';

export const COLOR_SCHEME_LABELS: Record<ColorSchemeMode, string> = {
  system: '跟随系统',
  default: '琥珀',
  light: '浅色',
  dark: '深色',
};

export const COLOR_SCHEME_ORDER: ColorSchemeMode[] = ['system', 'default', 'light', 'dark'];

/** 用户选择的配色模式（单例 ref；system 为默认，未手动选择过即跟随系统） */
const mode = ref<ColorSchemeMode>('system');
/** 系统当前是否深色（matchMedia 实时监听） */
const systemDark = ref(false);
/** 实际渲染配色：system 模式按系统深浅解析，其余直出 */
const resolvedScheme = computed<ColorScheme>(() => {
  if (mode.value !== 'system') return mode.value;
  return systemDark.value ? 'dark' : 'default';
});

let inited = false;
let mediaQuery: MediaQueryList | null = null;

/** 把配色应用到本窗口：<html data-scheme="...">，CSS 按属性选择器整体换肤 */
function applyScheme(s: ColorScheme) {
  if (typeof document === 'undefined') return;
  if (s === 'default') delete document.documentElement.dataset.scheme;
  else document.documentElement.dataset.scheme = s;
}

function isColorSchemeMode(v: unknown): v is ColorSchemeMode {
  return v === 'system' || v === 'default' || v === 'light' || v === 'dark';
}

function readSystemDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function useColorScheme() {
  if (!inited) {
    inited = true;
    // 系统深浅色初始化 + 实时监听（系统切换深浅色时跟随刷新）
    systemDark.value = readSystemDark();
    if (typeof window !== 'undefined' && window.matchMedia) {
      mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const onMediaChange = (e: MediaQueryListEvent) => {
        systemDark.value = e.matches;
        if (mode.value === 'system') applyScheme(resolvedScheme.value);
      };
      // 现代 WebView 走 addEventListener；旧实现回退 addListener
      if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', onMediaChange);
      else (mediaQuery as unknown as { addListener: (cb: (e: MediaQueryListEvent) => void) => void }).addListener(onMediaChange);
    }
    // 启动时读取持久化的配色模式（每个窗口独立执行，子窗口也能正确着色）
    dbService.getKeyValue(SCHEME_KEY).then((v) => {
      if (isColorSchemeMode(v)) {
        mode.value = v;
        applyScheme(resolvedScheme.value);
      }
    }).catch(() => { /* 读不到则保持跟随系统 */ });
    applyScheme(resolvedScheme.value);
    // 监听其他窗口的切换广播（主窗口切换时 tooltip/viewer 实时跟随）
    if (isTauri()) {
      listen<ColorSchemeMode>(SCHEME_EVENT, (ev) => {
        if (!isColorSchemeMode(ev.payload)) return;
        mode.value = ev.payload;
        applyScheme(resolvedScheme.value);
      }).catch(() => { /* 监听失败仅影响跨窗口同步 */ });
    }
  }
  return { scheme: mode, resolvedScheme };
}

/** 切换配色模式：应用 + 持久化 + 广播给其他窗口 */
export async function setColorScheme(m: ColorSchemeMode): Promise<void> {
  mode.value = m;
  applyScheme(resolvedScheme.value);
  try {
    await dbService.setKeyValue(SCHEME_KEY, m);
  } catch { /* 写入失败不影响本次会话 */ }
  if (isTauri()) {
    emit(SCHEME_EVENT, m).catch(() => {});
  }
}

/** 快速切换：跟随系统 → 琥珀 → 浅色 → 深色 → 跟随系统 循环 */
export async function cycleColorScheme(): Promise<ColorSchemeMode> {
  const idx = COLOR_SCHEME_ORDER.indexOf(mode.value);
  const next = COLOR_SCHEME_ORDER[(idx + 1) % COLOR_SCHEME_ORDER.length]!;
  await setColorScheme(next);
  return next;
}
