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
