import { describe, expect, it } from 'vitest';
import { parseSearchTokens, likePatternFromToken, buildLikeGroups, matchesSearch } from '../sql';

/**
 * 搜索输入解析（引号 / 通配符 / OR 语法）纯函数测试：
 * 返回 OR 分组（组内任一命中、组间 AND）；双引号短语为整句词元（内部空格与 | 按字面），
 * 未闭合引号按字面，缺操作数的孤立 | 忽略。
 */
describe('parseSearchTokens', () => {
    it('普通多词：按空白拆分为多个组（组间 AND）', () => {
        expect(parseSearchTokens('  会议   记录 ')).toEqual([['会议'], ['记录']]);
    });

    it('引号短语：整体为单词元，内部空格保留', () => {
        expect(parseSearchTokens('"项目 周报"')).toEqual([['项目 周报']]);
    });

    it('混合：普通词与引号短语按出现顺序分组', () => {
        expect(parseSearchTokens('会议 "v1.2 计划" fix')).toEqual([['会议'], ['v1.2 计划'], ['fix']]);
    });

    it('未闭合引号：视为普通字符按字面匹配', () => {
        expect(parseSearchTokens('"项目 周报')).toEqual([['"项目'], ['周报']]);
    });

    it('| OR：独立成词或紧贴词元均生效', () => {
        expect(parseSearchTokens('小曲 | 空城')).toEqual([['小曲', '空城']]);
        expect(parseSearchTokens('小曲|空城')).toEqual([['小曲', '空城']]);
    });

    it('| 与空白混排：OR 只结合相邻词元，组间仍 AND', () => {
        // 会议 AND (a OR b) AND c
        expect(parseSearchTokens('会议 a|b c')).toEqual([['会议'], ['a', 'b'], ['c']]);
        // (a OR b) AND c
        expect(parseSearchTokens('a|b c')).toEqual([['a', 'b'], ['c']]);
    });

    it('短语可作为 | 操作数；短语内 | 按字面', () => {
        expect(parseSearchTokens('a | "b c"')).toEqual([['a', 'b c']]);
        expect(parseSearchTokens('"a | b"')).toEqual([['a | b']]);
    });

    it('孤立 |（缺操作数）：开头/结尾/连续均忽略', () => {
        expect(parseSearchTokens('| a')).toEqual([['a']]);
        expect(parseSearchTokens('a |')).toEqual([['a']]);
        expect(parseSearchTokens('a || b')).toEqual([['a', 'b']]);
        expect(parseSearchTokens('|')).toEqual([]);
    });

    it('空/纯空白：无词元', () => {
        expect(parseSearchTokens('')).toEqual([]);
        expect(parseSearchTokens('   ')).toEqual([]);
    });

    it('关闭高级搜索（advanced=false）：整串 trim 后按字面单词元，引号与 | 均不生效', () => {
        expect(parseSearchTokens('  会议 记录 ', false)).toEqual([['会议 记录']]);
        expect(parseSearchTokens('"项目 周报"', false)).toEqual([['"项目 周报"']]);
        expect(parseSearchTokens('a | b', false)).toEqual([['a | b']]);
        expect(parseSearchTokens('   ', false)).toEqual([]);
    });
});

/** 高级搜索词元 → LIKE 模式（* 任意串、? 单字符，其余字面） */
describe('likePatternFromToken', () => {
    it('前缀通配：*小曲 → %小曲（命中"空城计の小曲"）', () => {
        expect(likePatternFromToken('*小曲')).toBe('%小曲');
    });

    it('中缀/后缀通配与多个 *', () => {
        expect(likePatternFromToken('a*b')).toBe('a%b');
        expect(likePatternFromToken('a*b*c')).toBe('a%b%c');
        expect(likePatternFromToken('*')).toBe('%');
    });

    it('? 映射为单字符通配符 _（与 * 的 % 对应）', () => {
        expect(likePatternFromToken('第?章')).toBe('第_章');
        expect(likePatternFromToken('a?b*c')).toBe('a_b%c');
        expect(likePatternFromToken('?')).toBe('_');
    });

    it('LIKE 通配符仍按字面转义（% _ \\ 不受 * ? 映射影响）', () => {
        expect(likePatternFromToken('50%')).toBe('50\\%');
        expect(likePatternFromToken('a_b')).toBe('a\\_b');
        expect(likePatternFromToken('a\\b')).toBe('a\\\\b');
    });
});

/** 大小写区分（GLOB 词法）与前端统一匹配 */
describe('case-sensitive search', () => {
    it('buildLikeGroups：caseSensitive 切 GLOB 算子（*x* 包裹，无 ESCAPE 子句）', () => {
        const { sql, params } = buildLikeGroups('会议', 'title', true, true);
        expect(sql).toBe('title GLOB $1');
        expect(params).toEqual(['*会议*']);
    });

    it('buildLikeGroups：caseSensitive + advanced 词法——* ? 保留为 GLOB 通配符，[ 按字面转义', () => {
        const { sql, params } = buildLikeGroups('"*曲 [a]"', 'title', true, true);
        expect(sql).toBe('title GLOB $1');
        // 前缀 * 与包裹 * 叠加为 **（同 LIKE 的 %%x% 形态，语义仍为前缀通配）
        expect(params).toEqual(['**曲 [[]a]*']);
    });

    it('buildLikeGroups：caseSensitive + 关闭高级搜索——整串字面（* ? [ 均转义）', () => {
        const { params } = buildLikeGroups('a*b', 'title', false, true);
        expect(params).toEqual(['*a[*]b*']);
    });

    it('matchesSearch：与 SQL 词法同源（组内 OR、组间 AND、* ? 通配）', () => {
        expect(matchesSearch('会议记录', '会议 记录')).toBe(true);
        expect(matchesSearch('会议记录', '会议 纪要')).toBe(false);
        expect(matchesSearch('小曲', '小曲 | 空城')).toBe(true);
        expect(matchesSearch('空城计', '小曲 | 空城')).toBe(true);
        expect(matchesSearch('第3章', '第?章')).toBe(true);
        expect(matchesSearch('第33章', '第?章')).toBe(false);
        expect(matchesSearch('空城计の小曲', '*小曲')).toBe(true);
    });

    it('matchesSearch：caseSensitive 按字面大小写，默认忽略', () => {
        expect(matchesSearch('Hello World', 'hello')).toBe(true);
        expect(matchesSearch('Hello World', 'hello', true, true)).toBe(false);
        expect(matchesSearch('Hello World', 'Hello', true, true)).toBe(true);
    });
});
