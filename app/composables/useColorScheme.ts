import { ref, computed, watch } from 'vue';
import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import dbService from '~/src/db/dbService';
import { bus } from '~/src/core/events';
import { isTauri } from '~/utils/env';

/**
 * 配色模式：
 * - system：跟随系统深浅色（默认模式；系统深色 → dark 配色，系统浅色 → amber 暖米色）
 * - default（琥珀）/ light / dark：固定使用指定配色
 */
export type ColorSchemeMode = 'system' | 'default' | 'light' | 'dark';
/** 实际渲染用的配色（解析 system 之后） */
export type ColorScheme = 'default' | 'light' | 'dark';

const SCHEME_KEY = 'color_scheme';
/** localStorage 镜像键：KV（SQLite 经 IPC）读取是异步的，等它回来才应用持久化配色
 *  会让首帧先渲染默认配色再「快切」到真实配色。镜像在每次切换时同步双写，
 *  启动时首帧前同步恢复；所有 Tauri 窗口同源共享，子窗口同样受益 */
const SCHEME_LS_KEY = 'color_scheme';
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
    // 启动恢复配色：先同步读 localStorage 镜像（首帧前生效，消除启动快切），
    // KV 异步读为准校正（首次使用/镜像缺失时才可能不同）并回写镜像
    try {
      const cached = localStorage.getItem(SCHEME_LS_KEY);
      if (isColorSchemeMode(cached)) mode.value = cached;
    } catch { /* localStorage 不可用退回纯异步恢复 */ }
    dbService.getKeyValue(SCHEME_KEY).then((v) => {
      if (isColorSchemeMode(v)) {
        if (v !== mode.value) mode.value = v;
        try { localStorage.setItem(SCHEME_LS_KEY, v); } catch { /* 镜像写失败不影响功能 */ }
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
    // 原生 UI（托盘右键菜单等）跟随应用配色：解析配色变化时（模式切换/系统深浅色变化/启动恢复）
    // 通知 Rust 侧强制原生菜单深浅色（Windows SetPreferredAppMode；其他平台 no-op 跟随系统）；
    // 同时派发事件让 init.ts 重建托盘菜单——菜单窗口在创建时快照主题，
    // 仅改 PreferredAppMode 对已存在的菜单不生效，必须重建才能实时跟随。
    if (isTauri()) {
      watch(resolvedScheme, (s) => {
        invoke('set_menu_theme', { theme: s === 'dark' ? 'dark' : 'light' }).catch(() => { /* 菜单主题跟随失败不影响应用 */ });
        if (typeof window !== 'undefined') {
          bus.emit('resolved-scheme-changed');
        }
      }, { immediate: true });
      // 窗口原生主题（标题栏/原生控件明暗）跟随配色：跟随系统模式传 null 恢复系统跟随，
      // 固定模式映射 light/dark（琥珀为暖米色浅色系 → light）。每窗口独立执行，各自同步。
      watch([mode, systemDark], ([m]) => {
        const theme = m === 'system' ? null : (m === 'dark' ? 'dark' : 'light');
        getCurrentWindow().setTheme(theme).catch(() => { /* 原生主题跟随失败不影响应用 */ });
      }, { immediate: true });
    }
  }
  return { scheme: mode, resolvedScheme };
}

/** 切换配色模式：应用 + 双写（localStorage 同步镜像 + KV 持久化）+ 广播给其他窗口 */
export async function setColorScheme(m: ColorSchemeMode): Promise<void> {
  mode.value = m;
  applyScheme(resolvedScheme.value);
  try {
    localStorage.setItem(SCHEME_LS_KEY, m);
  } catch { /* 镜像写失败仅损失下次启动的同步恢复 */ }
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
