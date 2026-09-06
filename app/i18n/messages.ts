
import zhCnToml from '~/assets/lang/zh-cn.toml?raw';
import enUsToml from '~/assets/lang/en-us.toml?raw';
import { parseToml } from '~/utils/toml';

export type AppLocale = 'zh-cn' | 'en-us';

export const LOCALES: { value: AppLocale; label: string }[] = [
  { value: 'zh-cn', label: '中文' },
  { value: 'en-us', label: 'English' },
];

/**
 * 语言消息已拆分为独立文件（assets/lang/*.toml，每种语言一个），
 * 层级结构与拆分前的 messages 树完全一致；启动时解析一次（纯同步、体量 ~40KB）。
 * 新增语言：在 assets/lang 下新增 <locale>.toml 并在此注册。
 */
export const messages: Record<AppLocale, Record<string, unknown>> = {
  'zh-cn': parseToml(zhCnToml),
  'en-us': parseToml(enUsToml),
};

/**
 * 统计画像标签/称号映射：已迁入语言文件 [tag_names] 表
 *  （键为英文标签名；zh-cn 值为中文显示名）。tName 在 zh-cn 下原样返回，
 *  故这里取 zh-cn 文件的映射表。
 */
export const TAG_NAMES: Record<string, string> =
  (messages['zh-cn'].tag_names ?? {}) as Record<string, string>;
