import { describe, expect, it } from 'vitest';
import { messages } from '../messages';

/** 把嵌套消息树拍平成 dotted key 集合（仅叶子） */
function flattenKeys(node: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(node).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' ? flattenKeys(v as Record<string, unknown>, path) : [path];
  });
}

/**
 * 语言包键集对齐守卫：zh-cn / en-us 任一侧新增或改名键而漏改另一侧时红灯。
 * 缺失键在 UI 上表现为 tooltip/文案直接显示裸 key（如 titlebar.calendar），人眼难以穷举排查。
 * 含 festival-eggs 模块文案（messages 装配时已并入两侧）。
 */
describe('语言包 zh-cn / en-us 键集对齐', () => {
  const zhKeys = new Set(flattenKeys(messages['zh-cn']));
  const enKeys = new Set(flattenKeys(messages['en-us']));

  it('zh-cn 侧无 en-us 缺失的键', () => {
    const missing = [...zhKeys].filter(k => !enKeys.has(k));
    expect(missing, `en-us.toml 缺失以下键: ${missing.join(', ')}`).toEqual([]);
  });

  it('en-us 侧无 zh-cn 缺失的键', () => {
    const missing = [...enKeys].filter(k => !zhKeys.has(k));
    expect(missing, `zh-cn.toml 缺失以下键: ${missing.join(', ')}`).toEqual([]);
  });
});
