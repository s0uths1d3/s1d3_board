
import zhCnToml from '~/assets/lang/zh-cn.toml?raw';
import enUsToml from '~/assets/lang/en-us.toml?raw';
import eggZhToml from '~/festival-eggs/lang/zh-cn.toml?raw';
import eggEnToml from '~/festival-eggs/lang/en-us.toml?raw';
import { parseToml } from '~/utils/toml';

export type AppLocale = 'zh-cn' | 'en-us';

export const LOCALES: { value: AppLocale; label: string }[] = [
  { value: 'zh-cn', label: '中文' },
  { value: 'en-us', label: 'English' },
];

/**
 * 功能模块自带文案（lang/<locale>.toml，顶层表），启动时浅并入主消息树——
 * 模块文案与业务语言包解耦：改/增模块文案只动模块目录，业务包零改动。
 * 通用机制不含任何具体模块知识；新增自带文案的模块在此追加一个 raw 导入即可。
 * 顶层表名冲突属于装配错误（后并入者覆盖，排查时以模块目录为准）。
 */
function withModuleMessages(base: Record<string, unknown>, ...raws: string[]): Record<string, unknown> {
  return raws.reduce((acc, raw) => ({ ...acc, ...parseToml(raw) }), base);
}

/**
 * 语言消息已拆分为独立文件（assets/lang/*.toml，每种语言一个），
 * 层级结构与拆分前的 messages 树完全一致；启动时解析一次（纯同步、体量 ~40KB）。
 * 新增语言：在 assets/lang 下新增 <locale>.toml 并在此注册。
 */
export const messages: Record<AppLocale, Record<string, unknown>> = {
  'zh-cn': withModuleMessages(parseToml(zhCnToml), eggZhToml),
  'en-us': withModuleMessages(parseToml(enUsToml), eggEnToml),
};

/**
 * 统计画像标签/称号映射：已迁入语言文件 [tag_names] 表
 *  （键为英文标签名；zh-cn 值为中文显示名）。tName 在 zh-cn 下原样返回，
 *  故这里取 zh-cn 文件的映射表。
 */
export const TAG_NAMES: Record<string, string> =
  (messages['zh-cn'].tag_names ?? {}) as Record<string, string>;
