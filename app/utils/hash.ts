/**
 * 轻量字符串哈希（djb2 → 16 进制）。
 * 用于"同一份内容"的分组判定（AI 结果冷却缓存、用户习惯记录），
 * 不是安全哈希——碰撞概率对本场景可接受，且不存储原文以外的敏感信息。
 */
export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}
