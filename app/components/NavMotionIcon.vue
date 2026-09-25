<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { bind, type NavMotionController } from '~/composables/navIconMotion'

/**
 * 通用弹簧动效图标。
 *
 * 图标不是组件里的模板，而是 `app/assets/svg/nav/*.svg` 目录下的文件——这里用
 * glob 全部收进来，按文件名查找。所以新增一个带 `data-icon` / `data-part` 的
 * 分层 SVG（设计稿在 CodexPlayground/svg-anim）丢进该目录即可，无需改代码；
 * 未在弹簧模型里登记过的图标名也安全，退化成整体轻微压缩。
 *
 * 用 v-html 而非模板渲染是有意的：动效每帧直接 setAttribute 操作这些节点，
 * 交给 Vue 托管反而会被 patch 打架。内容是本仓库自有的静态资产。
 */
const registry = import.meta.glob<string>('../assets/svg/nav/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
})

const props = withDefaults(defineProps<{
  /** 图标名 = 文件名（不含 .svg），须与 SVG 上的 data-icon 一致 */
  icon: string
  /**
   * 上升沿表示「这次按压被外部接管」（例如长按进入了拖拽排序）：
   * 反向回到起点，而不是让旋转类图标顺势转完。
   */
  interrupt?: boolean
}>(), { interrupt: false })

const markup = computed(() => registry[`../assets/svg/nav/${props.icon}.svg`] ?? '')

const host = ref<HTMLElement | null>(null)
let motion: NavMotionController | null = null

onMounted(() => {
  const el = host.value
  if (!el || !el.querySelector('svg[data-icon]')) return
  // 交互挂在按钮上（键盘、pointer capture、失焦、触摸取消都按按钮语义走），
  // 组件自身只负责渲染；脱离按钮使用时退化为挂在图标容器上
  motion = bind(el.closest('button') ?? el)
})

watch(() => props.interrupt, (on) => {
  if (on) motion?.reverse()
})

onBeforeUnmount(() => {
  motion?.destroy()
  motion = null
})
</script>

<template>
  <span ref="host" class="inline-flex" v-html="markup" />
</template>

<style scoped>
/* 尺寸由使用处的 class 给（组件根就是这个 span），SVG 铺满它。
   overflow 必须可见：图钉抬起、图钉底座横向展开、便签倾斜都会越出 24 的 viewBox，
   默认的 hidden 会把这些动作裁掉。 */
:deep(.nav-icon) {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}
</style>
