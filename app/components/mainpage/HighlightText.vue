<template>
    <template v-for="(seg, index) in processedSegments" :key="index">
      <span v-if="seg.isHighlight" class="rounded bg-hl/40 text-hl-ink">{{ seg.text }}</span>
      <template v-else>{{ seg.text }}</template>
    </template>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import { parseSearchTokens } from '~/src/core/db/sql';

const props = defineProps({
  text: String,
  highlightString: String,
  active: Boolean,
  // 高级搜索开关（与剪贴板 filter.advanced 同源）：false 时整串按字面单个词元匹配
  advanced: { type: Boolean, default: true },
});

interface TextSegment {
  text: string;
  isHighlight: boolean;
}

/**
 * 按"普通片段 + 命中片段"分片渲染，替代此前逐字符拆 span：
 * - 每键搜索时不再为每个可见行重建上百个 span（50 行 × 百余字符 ≈ 上万节点/键）；
 * - 直接输出纯文本节点，不再按 UTF-16 码元拆分，emoji 等代理对不会被拆散成乱码；
 * - 未开启高亮时整个字符串就是单个片段，零拆分开销。
 */
const processedSegments = computed<TextSegment[]>(() => {
  const text = props.text ?? '';
  if (!text) return [];
  // 高亮词与搜索共用同一解析（advanced 同值）：开启=多词 AND + 引号整句；关闭=整串字面
  const tokens = parseSearchTokens(props.highlightString ?? '', props.advanced);
  // 未启用高亮、无搜索词：整段作为一个普通片段
  if (!props.active || tokens.length === 0) {
    return [{ text, isHighlight: false }];
  }

  const escapeRegExp = (string: string) =>
      string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 高级搜索下 `*` 为通配符：正则侧同步映射（\* → .*），与 SQL LIKE 语义一致
  const pattern = tokens.map(escapeRegExp).join('|').replace(/\\\*/g, '.*');
  const regex = new RegExp(pattern, 'gi');

  const segments: TextSegment[] = [];
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      // 通配符可产生空匹配（如搜索词全为 *）：前进一位防死循环
      regex.lastIndex++;
      continue;
    }
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), isHighlight: false });
    }
    segments.push({ text: text.slice(match.index, match.index + match[0].length), isHighlight: true });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isHighlight: false });
  }

  return segments;
});

</script>
