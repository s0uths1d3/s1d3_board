import { detectStructured, isSimpleWords, sanitize } from './autoSplit';

/**
 * AI 分析预判打标（.docs/smart-clip-ai-analysis.md）：
 * 纯本地判定剪贴板文本的分流去向——只有 prose（自然语言散文）送 AI，
 * 其余分支本地处理并由调用方按原因弹灵动岛提示。全部为微秒级纯函数，无 IO。
 */

export type Verdict = 'too_long' | 'structured' | 'encoded' | 'tech' | 'noise' | 'words' | 'too_short' | 'prose';

/** 过短阈值：低于此长度视为无 AI 分析/提取价值（too_short 判定与方案 AI 提取器门控共用） */
export const PROSE_MIN_CHARS = 20;

export interface VerdictResult {
    verdict: Verdict;
    /** structured 命中的层（仅日志/调试用，提示不区分） */
    layer?: string;
}

/** 长度上限钳制：设置页与分析侧共用同一规则，非法输入回落 1000 */
export function clampAnalysisMaxChars(raw: unknown): number {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return 1000;
    return Math.min(10000, Math.max(100, n));
}

// ---------------------------------------------------------------------------
// 高熵内容（密钥 / 编码 / 哈希）
// ---------------------------------------------------------------------------
const SECRET_PREFIXES = ['sk-', 'ghp_', 'gho_', 'ghu_', 'AKIA', 'ASIA', 'AIza', 'xoxb-', 'xoxp-', 'xoxa-', 'eyJ'];

const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64_RE = /^[A-Za-z0-9+/=]{41,}$/;

/** 赋值形态：api_key=… / Authorization: Bearer … / token: … */
const SECRET_ASSIGN_RE = /\b(?:api[_-]?key|secret|token|authorization|credential)\b\s*[:=]\s*\S+|\bBearer\s+\S+/i;

/** 单 token 级高熵判定：已知密钥前缀 / 哈希 / base64 / 通用长混合串 */
function isHighEntropyToken(t: string): boolean {
    if (t.length >= 20 && SECRET_PREFIXES.some((p) => t.startsWith(p))) return true;
    if (t.length === 32 || t.length === 40 || t.length === 64) {
        if (HEX_RE.test(t)) return true;
    }
    if (BASE64_RE.test(t)) return true;
    // 通用：超长无空格且大小写数字混杂（自然语言 token 几乎不会同时满足）
    return t.length > 32 && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t);
}

function highEntropyTokens(content: string): string[] {
    return (content.match(/\S+/g) ?? []).filter(isHighEntropyToken);
}

// ---------------------------------------------------------------------------
// 技术工件（代码 / SQL / 命令 / 配置 / diff）：≥2 类互异信号命中即判定，
// 单类信号不触发——避免误伤含少量括号/引号的正常散文
// ---------------------------------------------------------------------------
const TECH_KEYWORD_RE = /\b(?:function|def|class|import|export|const|let|var|return|void|fn|func|package|public|private|static|async|await|throw|try|catch|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|ALTER)\b/;

/** 技术工件判定（≥2 类互异信号）：habitProfile 的粘贴类型归类复用 */
export function detectTechArtifact(content: string): boolean {
    let signals = 0;
    const lines = content.split(/\r?\n/);

    // 1. 语言关键词（≥2 个）
    if ((content.match(new RegExp(TECH_KEYWORD_RE.source, 'g')) ?? []).length >= 2) signals++;

    // 2. 代码符号密度 > 15%
    const symbols = (content.match(/[{}()[\];=<>/\\]/g) ?? []).length;
    if (symbols / content.length > 0.15) signals++;

    // 3. 缩进结构：行首空白行占比 > 40%（≥2 行才有意义）
    if (lines.length >= 2 && lines.filter((l) => /^[ \t]+\S/.test(l)).length / lines.length > 0.4) signals++;

    // 4. 注释形态：// 、/* 、行首 # 、<!--
    if (/(?:\/\/|\/\*|<!--)/.test(content) || lines.some((l) => /^#\s?\S/.test(l))) signals++;

    // 5. Markdown 代码围栏
    if (content.includes('```')) signals++;

    // 6. diff / patch：--- / +++ / @@ 头，或 ≥4 个行首 +/- 行
    if (lines.some((l) => /^(?:---|\+\+\+|@@ )/.test(l)) || lines.filter((l) => /^[+-]\S/.test(l)).length >= 4) signals++;

    // 7. shell 命令：$ 引导行或常见命令词引导
    if (lines.some((l) => /^\$\s+\S/.test(l)) ||
        lines.some((l) => /^(?:sudo|git|npm|npx|pnpm|yarn|pip|python3?|docker|curl|wget|cd|ls|mkdir|rm|mv|cp)\s+\S/.test(l.trim()))) signals++;

    // 8. 标签结构：≥2 个 <tag> 形态（HTML/XML/JSX）
    if ((content.match(/<\/?[a-zA-Z][^<>]*>/g) ?? []).length >= 2) signals++;

    // 9. 调用 / 赋值链：x.y( 或 foo(...) 模式 ≥3 处
    if ((content.match(/[A-Za-z_]\w*\.[A-Za-z_]\w*\(|[A-Za-z_]\w*\([^)]*\)/g) ?? []).length >= 3) signals++;

    return signals >= 2;
}

// ---------------------------------------------------------------------------
// 噪声（纯数字 / 符号堆）：有效字符（字母/汉字）占比 < 20% 无语义可分析
// ---------------------------------------------------------------------------
function isNoise(content: string): boolean {
    const compact = content.replace(/\s/g, '');
    if (!compact) return true;
    const meaningful = compact.replace(/[^\p{L}]/gu, '').length;
    return meaningful / compact.length < 0.2;
}

// ---------------------------------------------------------------------------
// 主判定：顺序固定（结构层 → 高熵 → 技术工件 → 噪声 → 过短），
// 后三者为「散文层排污阀」，防止大段 base64 / 代码 / 纯数字误入散文分支
// ---------------------------------------------------------------------------
export function analyzeVerdict(raw: string, maxChars: number): VerdictResult {
    const content = sanitize(raw);
    if (!content) return { verdict: 'too_short' };
    if (content.length > maxChars) return { verdict: 'too_long' };

    const layer = detectStructured(content);
    if (layer) return { verdict: 'structured', layer };

    // 高熵：token 长度对无空白文本的覆盖率 > 60% → 整段编码/密钥
    const hi = highEntropyTokens(content);
    const compactLen = Math.max(1, content.replace(/\s/g, '').length);
    const covered = hi.reduce((n, t) => n + t.length, 0) / compactLen;
    if (covered > 0.6) return { verdict: 'encoded' };

    if (detectTechArtifact(content)) return { verdict: 'tech' };
    if (isNoise(content)) return { verdict: 'noise' };
    // 简单词串（无句读、<60 字、≥2 词）：本地按空格直拆，不送 AI
    if (isSimpleWords(content)) return { verdict: 'words' };
    if (content.length < PROSE_MIN_CHARS) return { verdict: 'too_short' };
    return { verdict: 'prose' };
}

// ---------------------------------------------------------------------------
// 散文夹密钥的脱敏：覆盖率 ≤ 60% 时内容仍按散文送 AI（见 analyzeVerdict），
// 但明确密钥形态（前缀 / JWT / 赋值值）在发送前替换为 [REDACTED]
// ---------------------------------------------------------------------------
export function redactSecrets(content: string): string {
    let out = content;
    if (SECRET_ASSIGN_RE.test(content)) {
        out = out.replace(
            /(\b(?:api[_-]?key|secret|token|authorization|credential)\b\s*[:=]\s*|\bBearer\s+)(\S+)/gi,
            (_, prefix: string) => `${prefix}[REDACTED]`,
        );
    }
    const secrets = highEntropyTokens(content).filter((t) =>
        SECRET_PREFIXES.some((p) => t.startsWith(p)) || t.startsWith('eyJ'),
    );
    for (const s of secrets) out = out.split(s).join('[REDACTED]');
    return out;
}
