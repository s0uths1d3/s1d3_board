import type { ClipExtractor } from '../entities';
import { aiComplete, loadAiConfig } from './aiClient';

/**
 * AI 辅助新建：用一句自然语言描述生成「提取器」或「方案」的配置草稿。
 *
 * 与内容加工管道（template.ts）的区别：这里只产出**配置 JSON**，不加工剪贴板内容，
 * 因此要求模型只输出一个 JSON 对象（不带解释与代码围栏），解析/校验失败即视为生成失败，
 * 由调用方提示用户重试——绝不把脏数据写进配置。
 */

/** JSON 输出契约（中英双语：用户描述可能是任一种语言） */
const JSON_CONTRACT = [
    '',
    '---',
    '输出要求 / Output rules:',
    '1. 只输出一个 JSON 对象，不要任何解释、前后缀或 Markdown 代码围栏 / Output exactly one JSON object, no explanations or code fences.',
    '2. 文案语言与用户描述保持一致 / Use the same language as the user description.',
].join('\n');

/** 去掉代码围栏与非 JSON 前后缀后解析首个 JSON 对象 */
function parseJson<T>(raw: string): T {
    let text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI 未返回 JSON');
    return JSON.parse(text.slice(start, end + 1)) as T;
}

async function requestJson<T>(instruction: string, content: string): Promise<T> {
    const cfg = await loadAiConfig();
    const out = await aiComplete(cfg, instruction + JSON_CONTRACT, content);
    return parseJson<T>(out);
}

/** 生成的提取器草稿（未落库，供设置页表单回填确认） */
export interface ExtractorDraft {
    name: string;
    desc: string;
    method: ClipExtractor['method'];
    expression: string;
}

/**
 * 按描述生成提取器：
 * - 能用正则/分隔符解决就用本地规则（离线、稳定），需要语义理解时才走 AI 指令；
 * - 正则会做可编译校验，非法直接抛错，避免生成一条永远降级为原文的配置。
 */
export async function generateExtractorDraft(description: string, sample?: string): Promise<ExtractorDraft> {
    const instruction = [
        '你是智能剪贴板「提取器」配置生成器：提取器是**单个内容的提取单元**。',
        '根据用户描述生成一个提取器，输出 JSON：',
        '{"name":"简短名称","desc":"一句话说明","method":"regex|separator|ai","expression":"<表达式>"}',
        '- method = regex：expression 为 JavaScript 正则表达式（不含首尾斜杠、不带 flags），能从原文提取片段时优先用它',
        '- method = separator：expression 为分隔符字面量（如 \\n、逗号），用于按该分隔符拆分原文',
        '- method = ai：需要理解语义、整理、改写、翻译等无法用正则或分隔符完成时，expression 为给 AI 的指令',
        '- name / desc 使用与用户描述相同的语言',
    ].join('\n');
    const content = sample && sample.trim() ? `${description}\n\n示例文本：\n${sample}` : description;
    const raw = await requestJson<Record<string, unknown>>(instruction, content);

    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : description.slice(0, 20);
    const desc = typeof raw.desc === 'string' ? raw.desc.trim() : '';
    const method: ClipExtractor['method'] =
        raw.method === 'separator' || raw.method === 'ai' ? raw.method : 'regex';
    const expression = typeof raw.expression === 'string' ? raw.expression.trim() : '';
    if (!expression) throw new Error('AI 未返回表达式');
    if (method === 'regex') {
        try {
            new RegExp(expression);
        } catch {
            throw new Error('AI 生成的正则表达式无法编译');
        }
    }
    return { name, desc, method, expression };
}

/** 生成的方案草稿（members 已过滤为实际存在的提取器 id） */
export interface SchemeDraft {
    title: string;
    description: string;
    members: string[];
}

/** 按描述生成专属方案：从已有提取器中挑选成员并排序（不存在的 id 一律丢弃） */
export async function generateSchemeDraft(
    description: string,
    extractors: ClipExtractor[],
): Promise<SchemeDraft> {
    const catalog = extractors
        .map((x) => `- ${x.id} | ${x.name}${x.desc ? ' | ' + x.desc : ''}`)
        .join('\n');
    const instruction = [
        '你是智能剪贴板「方案」配置生成器：方案按成员提取器顺序依次提取并合并片段。',
        '可选提取器（id | 名称 | 说明）：',
        catalog || '（暂无可选提取器）',
        '根据用户描述生成一个专属方案，输出 JSON：',
        '{"title":"方案标题","description":"一句话说明","members":["<提取器 id>"]}',
        '- members 只能从上述 id 中选取，按执行顺序排列；即使用户没有点名，也要挑出最贴合描述的成员组合',
        '- title / description 使用与用户描述相同的语言',
    ].join('\n');
    const raw = await requestJson<Record<string, unknown>>(instruction, description);

    const ids = new Set(extractors.map((x) => x.id));
    const members = Array.isArray(raw.members)
        ? raw.members.filter((v): v is string => typeof v === 'string' && ids.has(v))
        : [];
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : description.slice(0, 20);
    const descriptionOut = typeof raw.description === 'string' ? raw.description.trim() : '';
    return { title, description: descriptionOut, members };
}
