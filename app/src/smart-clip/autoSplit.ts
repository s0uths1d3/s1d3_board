import type { Segment } from './types';

/**
 * 智能切分器（处理管道「智能切分」模式的核心）：
 * 无需用户配置规则，按文本**结构**自动识别切分方式，把一段文本拆成
 * 有意义的关键片段（关键词/字段/行/链接），供环形气泡逐段快捷粘贴。
 *
 * 设计原则（与 parseByRule 一致）：
 * - 纯函数、无 IO、永不抛错：任何异常都降级为「原文单段」；
 * - 永不丢内容：切分只拆不改，除空白修剪外保留原文；
 * - 结构化优先：识别精度 JSON > 链接/邮箱 > 多行 > 分隔符 > 关键词 > 原文。
 */

/** 降级兜底：返回原文单段 */
function single(content: string): Segment[] {
    return [{ index: 0, text: content, source: 'auto' }];
}

function toSegments(parts: string[]): Segment[] {
    return parts.map((text, index) => ({ index, text, source: 'auto' as const }));
}

/** 切分候选统一产出：修剪 + 去空；零产出时由调用方兜底 */
function clean(parts: string[]): string[] {
    return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 上限保护：极端输入（巨量行/匹配）防气泡环爆炸；超出部分拼接回末段不丢内容 */
const MAX_PARTS = 24;

function capped(parts: string[], content: string): string[] {
    if (parts.length <= MAX_PARTS) return parts;
    const head = parts.slice(0, MAX_PARTS - 1);
    head.push(parts.slice(MAX_PARTS - 1).join(' '));
    return head;
}

/** 清洗 BOM / 零宽字符（复制自网页/Word 的常见隐形字符） */
export function sanitize(content: string): string {
    return content
        .replace(/^\uFEFF/, '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .trim();
}

// ---------------------------------------------------------------------------
// 1. JSON：顶层 array → 元素；顶层 object → 「键: 值」对
// ---------------------------------------------------------------------------
function tryJson(content: string): string[] | null {
    if (!/^[[{]/.test(content) || !/[\]}]$/.test(content)) return null;
    try {
        const data: unknown = JSON.parse(content);
        const out: string[] = [];
        const scalar = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');
        if (Array.isArray(data)) {
            for (const item of data) {
                if (item !== null && typeof item === 'object') {
                    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
                        const s = scalar(v);
                        if (s) out.push(`${k}: ${s}`);
                    }
                } else {
                    const s = scalar(item);
                    if (s) out.push(s);
                }
            }
        } else if (data !== null && typeof data === 'object') {
            for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
                const s = scalar(v);
                if (s) out.push(`${k}: ${s}`);
            }
        } else {
            return null;
        }
        return out.length >= 2 ? capped(out, content) : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// 2. 链接 / 邮箱：命中 ≥2 且覆盖文本大半 → 提取项即关键信息
// ---------------------------------------------------------------------------
function tryLinks(content: string): string[] | null {
    const matches = content.match(/https?:\/\/[^\s，,；;）)"'<>]+|[\w.+-]+@[\w-]+\.[\w.-]+/g);
    if (!matches || matches.length < 2) return null;
    const covered = matches.reduce((n, m) => n + m.length, 0) / content.length;
    return covered >= 0.5 ? capped([...new Set(matches)], content) : null;
}

// ---------------------------------------------------------------------------
// 3. 日志行：`[ts][target][LEVEL] message` 方括号头部结构 →
//    时间 / 来源 / 级别 / 错误码 / 消息（日志排查场景的关键信息分离）
// ---------------------------------------------------------------------------
const LOG_LEVELS = new Set(['ERROR', 'WARN', 'WARNING', 'INFO', 'DEBUG', 'TRACE', 'FATAL']);

function isTimeTag(tag: string): boolean {
    return /^\d{4}-\d{2}-\d{2}/.test(tag) || /^\d{1,2}:\d{2}(:\d{2})?/.test(tag);
}

function tryLogLine(content: string): string[] | null {
    const m = content.match(/^((?:\[[^\[\]]+\]){2,})\s*([\s\S]+)$/);
    if (!m) return null;
    const tags = (m[1].match(/\[([^\[\]]+)\]/g) ?? []).map((t) => t.slice(1, -1));
    const message = m[2].trim();
    if (tags.length < 2 || !message) return null;

    const times: string[] = [];
    const levels: string[] = [];
    const sources: string[] = [];
    for (const tag of tags) {
        if (isTimeTag(tag)) times.push(tag);
        else if (LOG_LEVELS.has(tag.toUpperCase())) levels.push(tag.toUpperCase());
        else sources.push(tag);
    }
    if (times.length === 0 || levels.length === 0) return null;

    const out = [times.join(' '), ...sources, ...levels];
    // 错误码：HRESULT(0x…) / 0x… / E_* 常量——日志排查最高频的检索键
    const code = message.match(/HRESULT\(0x[0-9A-Fa-f]+\)|0x[0-9A-Fa-f]{4,}|E_[A-Z_]{2,}/);
    if (code) out.push(code[0]);
    out.push(message);
    return capped(out, content);
}

// ---------------------------------------------------------------------------
// 3.5 路径：单行无空白 + ≥2 个路径分隔符 + 路径形态（盘符/UNC/./~/扩展名/全标识符段）→
//     按分隔符拆成层级片段（尾段文件名天然在列）。
//     e:\dev\s1d3\app\utils\aiError.ts → [e:\dev, s1d3, app, utils, aiError.ts]
// ---------------------------------------------------------------------------
function tryPath(content: string): string[] | null {
    if (content.includes('\n') || /\s/.test(content)) return null;
    if ((content.match(/[\\/]/g) ?? []).length < 2) return null;
    if (/^[a-zA-Z][\w+.-]*:\/\//.test(content)) return null; // URL（http:// 等）交给链接层
    const shape = /^[a-zA-Z]:[\\/]/.test(content)   // 盘符
        || /^\\\\/.test(content)                     // UNC
        || /^[./~]/.test(content)                    // ./ 相对路径 / ~ 家目录
        || /\.[A-Za-z0-9]{1,8}$/.test(content)       // 末段带扩展名
        || content.split(/[\\/]/).every((p) => /^[\w.-]{1,64}$/.test(p)); // 全段标识符形态
    if (!shape) return null;
    const drive = content.match(/^[a-zA-Z]:[\\/]/)?.[0];
    const body = drive ? content.slice(drive.length) : content;
    const parts = clean(body.split(/[\\/]/));
    if (parts.length < 2) return null;
    if (drive) parts[0] = drive + parts[0]; // 盘符并入首段（e:\dev 而非孤立的 e:）
    return capped(parts, content);
}

// ---------------------------------------------------------------------------
// 4. 多行：≥2 非空行逐行成段（地址块 / 逐行列表 / 表格行）
// ---------------------------------------------------------------------------
function tryLines(content: string): string[] | null {
    const lines = clean(content.split(/\r?\n/));
    if (lines.length < 2) return null;
    // 行均再窄于 2 字视为噪声（纯符号行），不切
    if (lines.every((l) => l.length < 2)) return null;
    return capped(lines, content);
}

// ---------------------------------------------------------------------------
// 4. 分隔符竞标：多候选各切一次，选「段数合适 + 长度均衡」的最优解
//    避免英文句子里的逗号（e.g. 后逗号）或小数点把语义切碎
// ---------------------------------------------------------------------------
const SEPARATORS = ['\t', '|', '，', '；', '、', ',', ';'];

function scoreSplit(parts: string[]): number | null {
    if (parts.length < 2 || parts.length > MAX_PARTS) return null;
    const lens = parts.map((p) => p.length);
    // 短段（<2 字符）占比过高 = 误切（如 "1, 2, 3" 的空壳）
    if (lens.filter((l) => l < 2).length > parts.length / 3) return null;
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    // 段均太短 = 把句子切碎（<2：单字符碎片）；太长 = 没切中分隔层级
    if (avg < 2 || avg > 80) return null;
    const variance = lens.reduce((a, l) => a + (l - avg) ** 2, 0) / lens.length;
    // 得分：段数越多信息越足（轻微奖励），方差越小越均匀越好，段均长度适中加分
    return parts.length * 2 - variance / 40 + Math.min(avg, 24) * 0.5;
}

/**
 * 深度感知切分：仅在括号深度 0 且不在引号内的位置下刀。
 * 避免把 `WindowsError(Error { code: …, message: … })` 从括号内拦腰切开，
 * 也避免把 `"a, b"` 引号内的逗号当作分隔点。
 */
function splitTopLevel(content: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let i = 0; i < content.length; i++) {
        const ch = content[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
        else if (depth === 0 && ch === sep) {
            out.push(content.slice(start, i));
            start = i + 1;
        }
    }
    out.push(content.slice(start));
    return out;
}

function trySeparators(content: string): string[] | null {
    if (content.includes('\n')) return null; // 多行场景已由 tryLines 处理
    let best: { parts: string[]; score: number } | null = null;
    for (const sep of SEPARATORS) {
        const parts = clean(splitTopLevel(content, sep));
        const score = scoreSplit(parts);
        if (score !== null && (!best || score > best.score)) best = { parts, score };
    }
    return best ? capped(best.parts, content) : null;
}

// ---------------------------------------------------------------------------
// 5. 关键词提取（散文兜底）：无结构可切时提取高频/关键实词
//    英文按词（滤停用词），中文按 2-gram 频次；Top N 去重输出
// ---------------------------------------------------------------------------
const EN_STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by',
    'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'it', 'its', 'this', 'that', 'these', 'those', 'not', 'no', 'do', 'does', 'did',
    'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'shall', 'may',
    'my', 'your', 'our', 'their', 'his', 'her', 'we', 'you', 'they', 'he', 'she',
]);

/** 含虚字的中文 bigram 视为停用（的了在是和与及或对从被把让向等） */
const ZH_STOP_CHARS = '的了着在是和与及或对从被把让向给上下中个也很就都而及并但';

const KEYWORD_LIMIT = 8;

function tryKeywords(content: string): string[] | null {
    const freq = new Map<string, number>();
    const bump = (w: string): void => { freq.set(w, (freq.get(w) ?? 0) + 1); };

    // 英文/数字词（含 _ # . / 的技术词如 Node.js、C#、v1.2）
    const enWords = content.match(/[A-Za-z][A-Za-z0-9_+#./-]{1,31}|\d[\d.:]{1,15}/g) ?? [];
    for (const w of enWords) {
        if (!EN_STOPWORDS.has(w.toLowerCase()) && w.length >= 2) bump(w);
    }
    // 中文 2-gram：连续汉字串内滑窗，过滤含虚字的组合
    const zhRuns = content.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    for (const run of zhRuns) {
        for (let i = 0; i + 2 <= run.length; i++) {
            const gram = run.slice(i, i + 2);
            if (![...gram].some((c) => ZH_STOP_CHARS.includes(c))) bump(gram);
        }
    }

    const keys = [...freq.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
        .slice(0, KEYWORD_LIMIT)
        .map(([w]) => w);
    return keys.length >= 2 ? [...new Set(keys)] : null;
}

// ---------------------------------------------------------------------------
// 6. 简单词串：无句读的短空格词串（< 60 字、空白分隔 ≥2 词）按空白直拆，
//    不再送 AI 分析（与 analyzeVerdict 的 'words' 判定共用同一helper）
// ---------------------------------------------------------------------------
export const SIMPLE_WORDS_MAX_CHARS = 60;

export function isSimpleWords(content: string): boolean {
    if (content.length >= SIMPLE_WORDS_MAX_CHARS) return false;
    if (!/\s/.test(content)) return false;
    // 句读（含英文句点/小数点形态）视为句子散文形态 → 交 AI 分析
    if (/[.。．!！?？;；]/.test(content)) return false;
    return clean(content.split(/\s+/)).length >= 2;
}

// ---------------------------------------------------------------------------
// 7. 超长分块兜底：> 1000 字仍无任何结构/分隔可切的单块内容 → 按句读/空白边界
//    直接分成多个部分（预判 too_long 的「直接分部分」本地路径），避免整段
//    落在单个气泡里；超出 MAX_PARTS 的剩余内容并入末段不丢内容
// ---------------------------------------------------------------------------
const CHUNK_THRESHOLD = 1000;
const CHUNK_TARGET = 300;

function tryChunks(content: string): string[] | null {
    if (content.length <= CHUNK_THRESHOLD) return null;
    const out: string[] = [];
    let start = 0;
    while (start < content.length && out.length < MAX_PARTS) {
        // 剩余不足两段目标长度时直接收尾，避免出现碎尾段
        if (content.length - start <= CHUNK_TARGET * 2) {
            out.push(content.slice(start));
            break;
        }
        // 优先在硬上限附近回退找句读/空白边界下刀；无边界（无空格长串）硬切
        const hardEnd = start + CHUNK_TARGET;
        let end = -1;
        for (let i = hardEnd; i > start + CHUNK_TARGET / 2; i--) {
            if (/[\s。．,，.!？?；;、]/.test(content.charAt(i - 1))) { end = i; break; }
        }
        if (end < 0) end = hardEnd;
        out.push(content.slice(start, end));
        start = end;
    }
    if (start < content.length && out.length >= MAX_PARTS) {
        out[out.length - 1] += content.slice(start);
    }
    return out.length >= 2 ? out : null;
}

// ---------------------------------------------------------------------------
// 6.5 代码相关性：代码形态 token（snake/camel/点分/代码符号/关键字）占比 ≥ 20%
//     视为代码相关——预判落 tech（不送 AI，灵动岛「代码或技术内容」提示），
//     autoSplit 跳过分词（空格拆词/关键词提取），仅保留结构层切分
// ---------------------------------------------------------------------------
export const CODE_RATIO_THRESHOLD = 0.2;

const CODE_KEYWORD_RE = /^(?:function|def|const|var|async|await|import|fn|func|void|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|ALTER)$/;

/** 单 token 代码形态判定：snake_case / 小驼峰（≥8 字符或 ≥2 驼峰）/ 点分 / 代码符号 / 关键字 / 十六进制 */
function isCodeToken(t: string): boolean {
    if (!/[a-zA-Z]/.test(t)) return false; // 纯数字/符号不计（避免小数、运算符误判）
    if (CODE_KEYWORD_RE.test(t)) return true;
    if (/[a-zA-Z]_[a-zA-Z0-9]/.test(t)) return true; // snake_case（含 MAX_SIZE 常量）
    if (/[(){}\[\];=<>$\\]/.test(t)) return true;    // 代码符号（不含 / ：防 and/or、24/7 误判）
    if (/^\w+(\.\w+)+$/.test(t)) return true;        // 点分形态 a.b / main.py / v1.2.3
    if (/^0x[0-9a-f]+$/i.test(t)) return true;       // 十六进制字面量
    // 小驼峰：限定小写开头（排除 GitHub/iPhone 等品牌大写开头），≥8 字符或 ≥2 驼峰
    return /^[a-z]/.test(t) && /[a-z][A-Z]/.test(t) && (t.length >= 8 || /[a-z][A-Z][a-z]*[A-Z]/.test(t));
}

/** 代码形态 token 占比（代码 token / 全部空白分隔 token） */
export function codeTokenRatio(content: string): number {
    const tokens = content.match(/\S+/g);
    if (!tokens || tokens.length === 0) return 0;
    return tokens.filter(isCodeToken).length / tokens.length;
}

/** 代码相关判定：占比 ≥ 20% 即不分词、不送 AI */
export function isCodeRelated(content: string): boolean {
    return codeTokenRatio(content) >= CODE_RATIO_THRESHOLD;
}

// ---------------------------------------------------------------------------
// 主入口：结构化分层尝试，全部未命中 → 关键词 → 超长分块 → 原文
// ---------------------------------------------------------------------------
export type StructuredLayer = 'json' | 'links' | 'log' | 'path' | 'multiline' | 'separators';

/** 分层顺序与 autoSplit 主入口一致；多行命中但平均行长 > 60 字视为分段散文（AI 分析预判的误伤修正），不判结构化 */
export function detectStructured(raw: string): StructuredLayer | null {
    try {
        const content = sanitize(raw);
        if (!content) return null;
        if (tryJson(content)) return 'json';
        if (tryLinks(content)) return 'links';
        if (tryLogLine(content)) return 'log';
        if (tryPath(content)) return 'path';
        const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length >= 2 && !lines.every((l) => l.length < 2)) {
            const avg = lines.reduce((a, l) => a + l.length, 0) / lines.length;
            if (avg <= 60) return 'multiline';
        }
        if (trySeparators(content)) return 'separators';
        return null;
    } catch {
        return null;
    }
}

export function autoSplit(raw: string): Segment[] {
    try {
        const content = sanitize(raw);
        if (!content) return single(raw);

        const layers = [tryJson, tryLinks, tryLogLine, tryPath, tryLines, trySeparators];
        for (const layer of layers) {
            const parts = layer(content);
            if (parts && parts.length >= 2) return toSegments(parts);
        }

        // 代码相关（代码形态 token 占比 ≥ 20%）不分词：跳过空格拆词与关键词提取，
        // 结构层切分（多行/JSON/路径/分隔符）保留——对代码仍是正确粒度；预判落 tech
        const codeRelated = isCodeRelated(content);

        // 简单词串直拆：无句读的空格词串（含 20~60 字区间）本地按空格切分，不走 AI（仅非代码内容）
        if (!codeRelated && isSimpleWords(content)) return toSegments(clean(content.split(/\s+/)));

        // 短文本兜底：20 字以内未命中简单词串（含句读等）时仍按空白拆词（≥2 段才有意义），
        // 短片段不再整段落在单气泡里（仅非代码内容）
        if (!codeRelated && content.length < 20) {
            const words = clean(content.split(/\s+/));
            if (words.length >= 2) return toSegments(words);
        }

        const keys = codeRelated ? null : tryKeywords(content);
        if (keys) return toSegments(keys);

        // 超长分块：> 1000 字的单块内容（无结构/分隔/关键词可切）直接分部分，
        // 灵动岛由预判 too_long 提示「内容超过 {n} 字，已跳过 AI 分析」
        const chunks = tryChunks(content);
        if (chunks) return toSegments(chunks);

        return single(content);
    } catch (e) {
        console.error('[smart-clip] 智能切分失败，降级为原文单段:', e);
        return single(raw);
    }
}
