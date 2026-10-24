import { ref, computed } from 'vue';
import { listen, emit } from '@tauri-apps/api/event';
import dbService from '~/src/db/dbService';
import { isTauri } from '~/utils/env';
import { messages, TAG_NAMES, LOCALES, type AppLocale } from '~/i18n/messages';

/**
 * 轻量 i18n：
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
/** 初始化单例 promise：init.ts 的模块级预热调用与 i18n 插件的 await 共享同一次初始化，
 *  保证插件真正等到 KV 读取落定——否则 inited 布尔会让第二个调用方立即返回，
 *  应用带着「跟随系统」的临时语言首帧渲染（子窗口读库成功/失败时序不同 → 各窗口语言不一致） */
let initPromise: Promise<void> | null = null;

/** 按系统语言探测（仅 system 模式使用） */
function detectSystemLocale(): AppLocale {
  if (typeof navigator === 'undefined') return 'en-us';
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

/** 读持久化语言模式；失败短暂重试（启动瞬间的锁竞争不该永久降级为跟随系统），
 *  最终失败保持 system 并告警——静默吞掉会让「主窗口跟随系统、子窗口读到旧值」的
 *  跨窗口语言不一致难以排查 */
async function loadLocaleMode(): Promise<void> {
  const attempts = isTauri() ? 3 : 1;
  for (let i = 0; ; i++) {
    try {
      const v = await dbService.getKeyValue(LOCALE_KEY);
      if (isLocaleMode(v)) localeMode.value = v;
      else await dbService.setKeyValue(LOCALE_KEY, 'system').catch(() => {}); // 首次落库
      return;
    } catch (e) {
      if (i >= attempts - 1) {
        console.warn('[i18n] 语言模式读取失败，本次保持跟随系统:', e);
        return;
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

/** 初始化：读持久化语言模式；无记录时默认 system（跟随系统）。每个窗口启动时调用一次（幂等） */
export function initI18n(): Promise<void> {
  initPromise ??= (async () => {
    applyLocale(locale.value);
    await loadLocaleMode();
    applyLocale(locale.value);
    if (isTauri()) {
      listen<LocaleMode>(LOCALE_EVENT, (ev) => {
        if (isLocaleMode(ev.payload)) {
          localeMode.value = ev.payload;
          applyLocale(locale.value);
        }
      }).catch(() => { /* 监听失败仅影响跨窗口同步 */ });
    }
  })();
  return initPromise;
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
  // 写库失败重试一次（瞬时的 database is locked）：静默失败 + 无条件 reload 的组合
  // 会把用户刚选的语言悄悄回退成旧值，且各窗口内存态与 KV 分叉（跨窗口语言不一致的根源）
  for (let i = 0; ; i++) {
    try {
      await dbService.setKeyValue(LOCALE_KEY, m);
      break;
    } catch (e) {
      if (i >= 1) throw e; // 交给调用方给出可见失败反馈；不 reload——reload 会读回旧值
      await new Promise(r => setTimeout(r, 300));
    }
  }
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
  const tName = (name: string): string => {
    // 标签数据名为英文；en-us 原样返回，zh-cn 查语言文件的中文显示名
    if (locale.value === 'en-us' || !name) return name;
    // 键为 snake_case 裸键（英文标签名小写、空格转下划线）
    const key = name.toLowerCase().replace(/ /g, '_');
    return TAG_NAMES[key] ?? name;
  };
  return { locale, localeMode, t, tName };
}

export { LOCALES };
export type { AppLocale };
