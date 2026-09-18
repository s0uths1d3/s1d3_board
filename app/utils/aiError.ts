/**
 * AI 通道错误串格式化（设置页连接测试与 Ctrl+B 解析失败提示共用）。
 * Rust 侧非 2xx 时错误形如「AI API 返回 400 Bad Request: {body}」。
 */

/** 解析错误串：status = 状态码行；message = 提取的可读原因；full = 完整内容（JSON 缩进格式化，非 JSON 原样） */
export function parseAiError(raw: string): { status: string; message: string; full: string } {
  const m = raw.match(/AI API 返回\s*(\d{3}[^\n:]*?)\s*:\s*([\s\S]+)$/);
  const body = m?.[2];
  if (!m || !body) return { status: '', message: raw, full: raw };
  let message = body.trim();
  let full = body.trim();
  try {
    const j = JSON.parse(message);
    const e = j?.error;
    const cand = e?.message ?? (typeof e === 'string' ? e : undefined) ?? j?.message ?? j?.detail;
    if (typeof cand === 'string' && cand) message = cand;
    full = JSON.stringify(j, null, 2);
  } catch { /* 响应体非 JSON，原样展示 */ }
  return { status: m[1]?.trim() ?? '', message, full };
}

/** 关键摘要（灵动岛提示用）：状态码 + 可读原因，压平空白并截断（完整详情在主窗口展示） */
export function briefAiError(raw: string): string {
  const p = parseAiError(raw);
  const flat = (p.status ? `${p.status} · ${p.message}` : p.message).replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

// ===== 错误分类（灵动岛失败提示用）：类型标识 + 简明原因，用户无需读懂原始报错串 =====

export type AiErrKind = 'network' | 'timeout' | 'http' | 'model' | 'unknown';

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/**
 * 错误分类：kind 决定类型标识文案（island.ai_err_*），detail 为可省略的简明原因。
 * - network：fetch 失败 / DNS / 连接重置等网络层异常
 * - timeout：请求超时（15 秒上限）
 * - http：Rust 侧非 2xx（「AI API 返回 400 …」形态）
 * - model：模型返回无法解析 / 产出为空
 * - unknown：未识别错误，透传简明原文
 */
export function classifyAiError(raw: string): { kind: AiErrKind; detail: string } {
  const p = parseAiError(raw);
  if (p.status) {
    return { kind: 'http', detail: truncate(`${p.status} · ${p.message}`, 60) };
  }
  if (/failed to fetch|fetch failed|network\s?error|networkerror|econnrefused|econnreset|enotfound|ehostunreach|enetunreach|err_network|err_connection|proxy/i.test(raw)) {
    return { kind: 'network', detail: '' };
  }
  if (/timed?\s?out|timeout|aborterror|\babort\b/i.test(raw)) {
    return { kind: 'timeout', detail: '' };
  }
  if (/产出为空|无法解析|unexpected|invalid json|\bjson\b|\bparse\b/i.test(raw)) {
    return { kind: 'model', detail: truncate(raw.replace(/^error:\s*/i, ''), 60) };
  }
  return { kind: 'unknown', detail: truncate(raw.replace(/^error:\s*/i, ''), 60) };
}
