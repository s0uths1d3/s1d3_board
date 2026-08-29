<template>
    <template v-for="(seg, index) in processedSegments" :key="index">
      <span v-if="seg.isHighlight" class="rounded bg-gold/30 text-ink">{{ seg.text }}</span>
      <template v-else>{{ seg.text }}</template>
    </template>
</template>

<script lang="ts" setup>
import { computed } from 'vue';

const props = defineProps({
  text: String,
  highlightString: String,
  active: Boolean,
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
  // 未启用高亮、无搜索词：整段作为一个普通片段
  if (!props.active || !props.highlightString) {
    return [{ text, isHighlight: false }];
  }

  const escapeRegExp = (string: string) =>
      string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const segments: TextSegment[] = [];
  const regex = new RegExp(escapeRegExp(props.highlightString), 'gi');
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
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
