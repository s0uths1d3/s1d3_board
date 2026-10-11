/**
 * 标签文本解析（编辑面板与新增表单共用）：
 * 按空白/逗号/顿号切分，去空白去重，最多保留 8 个。
 */
export function parseTagsText(text: string): string[] {
    return [...new Set(
        text.split(/[\s,，、]+/).map(s => s.trim()).filter(Boolean),
    )].slice(0, 8);
}
