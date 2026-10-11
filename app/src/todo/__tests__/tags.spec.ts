import { describe, expect, it } from 'vitest';
import { parseTagsText } from '../tags';

/** 标签文本解析：切分/去重/数量上限（编辑面板与新增表单共用实现） */
describe('parseTagsText 标签文本解析', () => {
    it('空格/逗号/顿号混合分隔均可切分', () => {
        expect(parseTagsText('工作 学习，生活、购物')).toEqual(['工作', '学习', '生活', '购物']);
    });

    it('去空白与重复，保留首次出现顺序', () => {
        expect(parseTagsText('  a  , b ,, a   b ')).toEqual(['a', 'b']);
    });

    it('最多保留 8 个标签', () => {
        const out = parseTagsText('1 2 3 4 5 6 7 8 9 10');
        expect(out).toHaveLength(8);
        expect(out).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    });

    it('空串与纯分隔符返回空数组', () => {
        expect(parseTagsText('')).toEqual([]);
        expect(parseTagsText(' , 、 ')).toEqual([]);
    });
});
