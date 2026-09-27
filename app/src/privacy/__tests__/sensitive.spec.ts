import { describe, expect, it } from 'vitest';
import { detectSensitive, isSensitiveText, luhnValid } from '../sensitive';

describe('luhnValid（银行卡号校验位）', () => {
    it('经典测试卡号通过', () => {
        expect(luhnValid('4111111111111111')).toBe(true);
        expect(luhnValid('4532015112830366')).toBe(true);
    });
    it('长度不足 13 位或超过 19 位不通过', () => {
        expect(luhnValid('411111111111')).toBe(false);
        expect(luhnValid('41111111111111111111')).toBe(false);
    });
    it('校验位错误的长数字串不通过（时间戳 / 订单号形态）', () => {
        expect(luhnValid('1234567890123')).toBe(false);
        expect(luhnValid('1758960000001')).toBe(false);
    });
});

describe('detectSensitive（敏感形态判定）', () => {
    it('银行卡号：空格 / 连字符分隔均命中 card', () => {
        expect(detectSensitive('卡号 4111 1111 1111 1111')).toBe('card');
        expect(detectSensitive('4111-1111-1111-1111')).toBe('card');
        expect(detectSensitive('4111111111111111')).toBe('card');
    });
    it('未过 Luhn 的长数字串 / 时间戳不命中', () => {
        expect(detectSensitive('订单号 1234567890123')).toBeNull();
        expect(detectSensitive('时间戳 1758960000001')).toBeNull();
    });
    it('粘连字母数字的长编号不命中（首尾边界守卫）', () => {
        expect(detectSensitive('id4111111111111111x')).toBeNull();
    });
    it('验证码：中英文关键词 + 4~8 位数字命中 otp', () => {
        expect(detectSensitive('您的验证码：482913，请查收')).toBe('otp');
        expect(detectSensitive('Your verification code is 4829')).toBe('otp');
        expect(detectSensitive('otp 123456')).toBe('otp');
    });
    it('关键词后数字串过长（订单 / 编号）不命中', () => {
        expect(detectSensitive('验证码 123456789012')).toBeNull();
    });
    it('密码键值形态命中 password', () => {
        expect(detectSensitive('密码：abc123')).toBe('password');
        expect(detectSensitive('password: hunter2')).toBe('password');
        expect(detectSensitive('pwd=admin&user=x')).toBe('password');
    });
    it('中文说明文案 / 裸单词不命中密码', () => {
        expect(detectSensitive('重置密码：点击这里')).toBeNull();
        expect(detectSensitive('请输入 password 后回车')).toBeNull();
    });
    it('普通文本不命中', () => {
        expect(detectSensitive('今天下午三点开会，记得带笔记本')).toBeNull();
        expect(detectSensitive('https://example.com/path?query=1')).toBeNull();
        expect(detectSensitive('')).toBeNull();
    });
    it('isSensitiveText 与 detectSensitive 同步', () => {
        expect(isSensitiveText('密码：abc123')).toBe(true);
        expect(isSensitiveText('普通内容')).toBe(false);
    });
});
