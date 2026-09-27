import { describe, expect, it } from 'vitest';
import { parseSearchTokens, likePatternFromToken } from '../sql';

/**
 * 搜索输入解析（引号语法）纯函数测试：
 * 双引号短语为整句词元（内部空格不拆分），其余按空白拆分多词 AND，未闭合引号按字面。
 */
describe('parseSearchTokens', () => {
    it('普通多词：按空白拆分（多词 AND 的词元）', () => {
        expect(parseSearchTokens('  会议   记录 ')).toEqual(['会议', '记录']);
    });

    it('引号短语：整体为单词元，内部空格保留', () => {
        expect(parseSearchTokens('"项目 周报"')).toEqual(['项目 周报']);
    });

    it('混合：普通词与引号短语按出现顺序合并', () => {
        expect(parseSearchTokens('会议 "v1.2 计划" fix')).toEqual(['会议', 'v1.2 计划', 'fix']);
    });

    it('未闭合引号：视为普通字符按字面匹配', () => {
        expect(parseSearchTokens('"项目 周报')).toEqual(['"项目', '周报']);
    });

    it('空/纯空白：无词元', () => {
        expect(parseSearchTokens('')).toEqual([]);
        expect(parseSearchTokens('   ')).toEqual([]);
    });

    it('关闭高级搜索（advanced=false）：整串 trim 后按字面单词元，引号不拆词', () => {
        expect(parseSearchTokens('  会议 记录 ', false)).toEqual(['会议 记录']);
        expect(parseSearchTokens('"项目 周报"', false)).toEqual(['"项目 周报"']);
        expect(parseSearchTokens('   ', false)).toEqual([]);
    });
});

/** 高级搜索词元 → LIKE 模式（* 为任意串通配符，其余字面） */
describe('likePatternFromToken', () => {
    it('前缀通配：*小曲 → %小曲（命中"空城计の小曲"）', () => {
        expect(likePatternFromToken('*小曲')).toBe('%小曲');
    });

    it('中缀/后缀通配与多个 *', () => {
        expect(likePatternFromToken('a*b')).toBe('a%b');
        expect(likePatternFromToken('a*b*c')).toBe('a%b%c');
        expect(likePatternFromToken('*')).toBe('%');
    });

    it('LIKE 通配符仍按字面转义（% _ \\ 不受 * 映射影响）', () => {
        expect(likePatternFromToken('50%')).toBe('50\\%');
        expect(likePatternFromToken('a_b')).toBe('a\\_b');
        expect(likePatternFromToken('a\\b')).toBe('a\\\\b');
    });
});
