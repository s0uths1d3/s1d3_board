/**
 * 敏感内容检测（纯函数层）：剪贴板是密码 / 银行卡号 / 验证码的高频中转站，
 * 命中敏感形态的文本条目不应永久明文落库。检测刻意保守——只抓高置信度形态：
 * - 银行卡号：13~19 位数字（允许空格 / 连字符 / 点分隔）且通过 Luhn 校验位算法
 *   （纯数字串如时间戳 / 订单号几乎不可能同时满足长度与校验位，误报极低）；
 * - 验证码：明示语义关键词（验证码 / 校验码 / OTP / verification code 等）
 *   紧随 4~8 位数字（更长的数字串按订单 / 编号处理不命中）；
 * - 密码：明示键值形态（密码 / password / pwd 后接冒号 / 等号 + ASCII 值）——
 *   值限定 ASCII 可打印字符，规避「重置密码：点击这里」这类中文说明文案误报。
 * 普通散文、未过 Luhn 的长数字串、不含值的 "password" 单词均不命中。
 */

/** Luhn 校验（银行卡号校验位算法）：从右向左，奇数位原样、偶数位倍增叠根，总和被 10 整除 */
export function luhnValid(digits: string): boolean {
    if (!/^\d{13,19}$/.test(digits)) return false;
    let sum = 0;
    let dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (dbl) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
        dbl = !dbl;
    }
    return sum % 10 === 0;
}

/** 卡号候选串：13 位以上数字（允许空格/连字符/点分隔），首尾不得粘连字母数字（排除长编号片段） */
const CARD_CANDIDATE = /(?<!\w)\d[\d \-.]{11,36}\d(?!\w)/g;

/** 验证码：语义关键词 + 4~8 位数字（\b 使更长的数字串不命中） */
const OTP_LABELED =
    /(?:验证码|校验码|动态码|动态密码|确认码|verification\s*code|security\s*code|one[-\s]?time\s*(?:code|password)|\botp\b)\D{0,12}\d{4,8}\b/i;

/** 密码键值形态：键（密码/口令/password/pwd）+ 冒号/等号 + ASCII 可打印值（≥4 字符） */
const PASSWORD_LABELED = /(?:密码|口令|password|passwd|pwd)\s*[:：=]\s*[!-~]{4,}/i;

export type SensitiveKind = 'card' | 'otp' | 'password';

/**
 * 判定文本是否为敏感内容，命中返回类别（'card' | 'otp' | 'password'），未命中返回 null。
 * 卡号候选串先去分隔符再过 Luhn；验证码 / 密码按明示语义判定。
 */
export function detectSensitive(content: string): SensitiveKind | null {
    const candidates = content.match(CARD_CANDIDATE) ?? [];
    for (const c of candidates) {
        if (luhnValid(c.replace(/[ \-.]/g, ''))) return 'card';
    }
    if (OTP_LABELED.test(content)) return 'otp';
    if (PASSWORD_LABELED.test(content)) return 'password';
    return null;
}

/** 监听管道用布尔判定（真 = 建议不落库） */
export function isSensitiveText(content: string): boolean {
    return detectSensitive(content) !== null;
}
