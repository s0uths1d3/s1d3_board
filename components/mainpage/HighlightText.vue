<template>
    <span v-for="(charInfo, index) in processedText" :key="index"
          :class="{ 'rounded bg-gold/30 text-ink': charInfo.isHighlight }">
      {{ charInfo.char }}
    </span>
</template>

<script lang="ts" setup>
import { computed } from 'vue';

const props = defineProps({
  text: String,
  highlightString: String,
  active: Boolean,
});

// 处理文本，标记需要高亮的字符
const processedText = computed(() => {
  // 基础验证
  if (props.active || !props.highlightString || !props.text) {
    return props.text?.split('').map(char => ({ char, isHighlight: false })) || [];
  }

  const escapeRegExp = (string: string) =>
      string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const text = props.text;
  const highlightStr = props.highlightString;
  const result: { char: string; isHighlight: boolean }[] = [];

  // 处理大小写不敏感的匹配
  const regex = new RegExp(escapeRegExp(highlightStr), 'gi');
  let lastIndex = 0;

  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {

      console.log(result)
      result.push(
          ...text.slice(lastIndex, match.index).split('')
              .map(char => ({ char, isHighlight: false }))
      );
    }

    result.push(
        ...text.slice(match.index, match.index + match[0].length).split('')
            .map(char => ({ char, isHighlight: true }))
    );

    lastIndex = regex.lastIndex;
  }


  if (lastIndex < text.length) {
    result.push(
        ...text.slice(lastIndex).split('')
            .map(char => ({ char, isHighlight: false }))
    );
  }

  return result;
});

</script>
