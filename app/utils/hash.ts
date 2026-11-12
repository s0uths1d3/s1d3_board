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

/**
 * 内容指纹（AI 结果缓存的内容身份）：双 32 位哈希（djb2 + FNV-1a）与长度拼接。
 *
 * 与 `hashText` 的区别：`hashText` 是单一 32 位 djb2，仅用于「同一内容」的习惯分组，
 * 碰撞影响可接受；而缓存命中会直接把历史结果当作当前对象的结果展示，必须用更强的
 * 身份标识。指纹仍不是密码学哈希，因此缓存值里同时保存长度与首尾采样，读取时逐项
 * 比对（见 smart-clip/analysisCache.ts），任一不符即视为未命中。
 */
export function contentFingerprint(s: string): string {
  let djb2 = 5381;
  let fnv = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    djb2 = ((djb2 << 5) + djb2 + c) >>> 0;
    fnv = Math.imul(fnv ^ c, 0x01000193) >>> 0;
  }
  return `${djb2.toString(16)}-${fnv.toString(16)}-${s.length.toString(16)}`;
}
