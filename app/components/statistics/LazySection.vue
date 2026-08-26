<script setup lang="ts">
/**
 * 流式加载区块（LazySection）
 *
 * 包装一个统计页区块：进入视口前显示骨架占位，进入后渲染真实内容并带渐入动画。
 * 用 IntersectionObserver 监听（rootMargin 提前预加载），已加载后断开观察；
 * 不支持 IntersectionObserver 的环境（极旧 WebView）直接渲染内容。
 * 配合 §14.8 按需加载：统计页首屏只渲染必要区块，长页面随滚动渐进出现，降低首屏 DOM 成本。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue';

const props = withDefaults(defineProps<{
  /** 骨架占位高度类（如 h-32） */
  skeletonClass?: string;
  /** 提前触发阈值（像素），默认提前 160px 预加载 */
  rootMargin?: string;
}>(), {
  skeletonClass: 'h-32',
  rootMargin: '160px 0px',
});

const entered = ref(false);
const elRef = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') {
    entered.value = true;
    return;
  }
  observer = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) {
      entered.value = true;
      observer?.disconnect();
      observer = null;
    }
  }, { rootMargin: props.rootMargin });
  if (elRef.value) observer.observe(elRef.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <div ref="elRef">
    <Transition name="section-fade">
      <div v-if="entered" class="section-fade">
        <slot />
      </div>
    </Transition>
    <div v-if="!entered" class="glass-card animate-pulse rounded-2xl" :class="skeletonClass"></div>
  </div>
</template>

<style scoped>
.section-fade-enter-active {
  transition: opacity 0.35s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}
.section-fade-enter-from {
  opacity: 0;
  transform: translateY(14px);
}
</style>
