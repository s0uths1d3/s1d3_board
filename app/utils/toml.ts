/**
 * 极简 TOML 解析器（仅覆盖本项目语言文件用到的子集）
 *
 * 语言文件由 i18n 迁移脚本生成，格式固定：
 * - `#` 注释行
 * - `[a.b]` 表头（点分层级；带引号的段为含特殊字符的键）
 * - `key = "value"` 基本字符串（支持 \\ \" \n \r \t 转义）
 * - 重复键后写覆盖先写（与原 TS 对象字面量行为一致）
 *
 * 不支持数组/内联表/多行字符串等完整 TOML 特性——语言文件不使用这些语法。
 */

export function parseToml(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    // 表头：[a.b.c] → 逐级创建/复用节点
    if (line.startsWith('[')) {
      const end = line.lastIndexOf(']');
      if (end === -1) continue;
      const path = line
        .slice(1, end)
        .split('.')
        .map(seg => unquoteKey(seg.trim()));
      let node: Record<string, unknown> = root;
      for (const seg of path) {
        if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
        node = node[seg] as Record<string, unknown>;
      }
      current = node;
      continue;
    }

    // 键值对
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = unquoteKey(line.slice(0, eq).trim());
    current[key] = parseValue(line.slice(eq + 1).trim());
  }
  return root;
}

/** 键：支持带引号形式（含特殊字符的键） */
function unquoteKey(key: string): string {
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) {
    return parseString(key);
  }
  return key;
}

/** 值：当前仅字符串字面量；数字/布尔兜底解析，其余原样返回 */
function parseValue(value: string): unknown {
  if (value.startsWith('"')) return parseString(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

/** 基本字符串解析（处理 \\ \" \n \r \t 转义） */
function parseString(literal: string): string {
  const inner =
    literal.length >= 2 && literal.startsWith('"') && literal.endsWith('"')
      ? literal.slice(1, -1)
      : literal;
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === '\\' && i + 1 < inner.length) {
      i += 1;
      const esc = inner[i]!;
      switch (esc) {
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        default:
          out += esc;
      }
    } else {
      out += ch;
    }
  }
  return out;
}
