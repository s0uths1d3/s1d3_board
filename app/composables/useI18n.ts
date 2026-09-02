import { ref, computed } from 'vue';
import { listen, emit } from '@tauri-apps/api/event';
import dbService from '~/src/db/dbService';
import { isTauri } from '~/utils/env';
import { messages, TAG_NAMES, LOCALES, type AppLocale } from '~/i18n/messages';

/**
 * 轻量 i18n（自研，替代 vue-i18n）：
 * - 语言模式 localeMode：system（跟随系统）/ zh-cn / en-us，reactive
 * - resolvedLocale：system 模式下按 navigator.language 探测（zh* → zh-cn，其余 → en-us）
 * - 持久化到 settings 表（app_locale，存模式值）；首次无记录时默认 system（跟随系统）
 * - 跨窗口同步：切换语言后 emit 'locale:changed'，子窗口监听跟随
 * - 切换语言时调用 Nuxt 的 reloadNuxtApp() 强制整页重新挂载：
 *   setup 中读取 locale.value 时拿到最新值；模板中所有 `t('...')` 重新求值。
 *   （若改为响应式 ComputedRef<fn>，模板调用 `_ctx.t('x')` 仍为字符串 ref 而非可调用，
 *    需要所有模板改 `t.value('x')`；reload 方案以一次刷新换零侵入式改写，代价可接受。）
 */

const LOCALE_KEY = 'app_locale';
const LOCALE_EVENT = 'locale:changed';

export type LocaleMode = 'system' | 'zh-cn' | 'en-us';

const localeMode = ref<LocaleMode>('system');
let inited = false;

/** 按系统语言探测（仅 system 模式使用） */
function detectSystemLocale(): AppLocale {
  if (typeof navigator === 'undefined') return 'zh-cn';
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en-us';
}

/** 解析后的实际语言 */
const locale = computed<AppLocale>(() =>
  localeMode.value === 'system' ? detectSystemLocale() : localeMode.value,
);

/** 把语言应用到 <html lang>（可访问性/字体语义） */
function applyLocale(l: AppLocale) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l === 'zh-cn' ? 'zh-CN' : 'en-US';
  }
}

function isLocaleMode(v: unknown): v is LocaleMode {
  return v === 'system' || v === 'zh-cn' || v === 'en-us';
}

/** 点路径取值 + {param} 参数替换；缺失回退为 key 本身 */
function resolve(m: Record<string, unknown>, path: string, params?: Record<string, string | number>): string {
  let cur: unknown = m;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return path;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (typeof cur !== 'string') return path;
  if (!params) return cur;
  return cur.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
}

/** 初始化：读持久化语言模式；无记录时默认 system（跟随系统）。每个窗口启动时调用一次 */
export async function initI18n(): Promise<void> {
  if (inited) return;
  inited = true;
  applyLocale(locale.value);
  try {
    const v = await dbService.getKeyValue(LOCALE_KEY);
    if (isLocaleMode(v)) localeMode.value = v;
    else await dbService.setKeyValue(LOCALE_KEY, 'system').catch(() => {}); // 首次落库
  } catch {
    /* 读不到则保持跟随系统 */
  }
  applyLocale(locale.value);
  if (isTauri()) {
    listen<LocaleMode>(LOCALE_EVENT, (ev) => {
      if (isLocaleMode(ev.payload)) {
        localeMode.value = ev.payload;
        applyLocale(locale.value);
      }
    }).catch(() => { /* 监听失败仅影响跨窗口同步 */ });
  }
}

/**
 * 切换语言：先 persist + 广播（让子窗口跟随），再重载整页使所有 useI18n 重新 setup
 * 拿到新 locale。用 location.reload 而非 reloadNuxtApp：
 *  - dev 模式：reloadNuxtApp 会让 dev server / HMR 客户端状态紊乱（chrome-error）
 *  - prod 模式：location.reload 同样刷新 WebView，且不依赖 Nuxt 内部 HMR
 *  切语言是低频操作，短暂闪烁可接受。
 */
export async function setLocaleMode(m: LocaleMode): Promise<void> {
  localeMode.value = m;
  applyLocale(locale.value);
  try {
    await dbService.setKeyValue(LOCALE_KEY, m);
  } catch { /* 写入失败不影响本次会话 */ }
  if (isTauri()) {
    emit(LOCALE_EVENT, m).catch(() => {});
  }
  if (typeof window !== 'undefined') {
    // 短暂延迟让 persist + 广播完成
    setTimeout(() => window.location.reload(), 50);
  }
}

/** 使用 i18n：返回响应式 locale/localeMode 与翻译函数 t(path, params?)
 *  t 是普通函数（每次调用读 locale.value），在 setup 一次性绑定；切换语言后 location.reload 重挂再读新 locale。
 *  tName(zh)：统计画像标签/称号中文名 → 当前语言（zh-cn 原样；en-us 查 TAG_NAMES 映射） */
export function useI18n() {
  const t = (path: string, params?: Record<string, string | number>): string =>
    resolve(messages[locale.value] as Record<string, unknown>, path, params);
  const tName = (zh: string): string => {
    if (locale.value === 'zh-cn' || !zh) return zh;
    return TAG_NAMES[zh] ?? zh;
  };
  return { locale, localeMode, t, tName };
}

export { LOCALES };
export type { AppLocale };
