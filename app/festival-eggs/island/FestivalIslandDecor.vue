<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '~/composables/useI18n';
import { useFestivalEgg } from '../state';

/**
 * 岛装饰组件（bubble.vue 的通用挂载点）：按 kind 渲染当前节日的装饰 DOM，
 * 全部节日 SVG 分支收口在本组件——bubble.vue 不含任何节日知识，开关关闭或
 * 无节日时输出空（v-if 链全部不命中）。样式在 festival-eggs/styles/festival.css
 * （装饰 DOM 属本组件、容器属 bubble.vue，跨组件选择器必须全局样式才能命中）。
 *
 * kind：
 * - border：胶囊边框动效层（积雪檐/飘雪/流光环；辉光呼吸类节日走纯 CSS 无 DOM）
 * - badges：骑缘徽章（符号坐进小圆底座半出半入压在边框线上，悬停 v-tip 节日名）
 * - panel ：下拉面板装饰层（彩灯串/水印/彩旗，随 [data-festival] 皮肤变量染色）
 */
defineProps<{ kind: 'border' | 'badges' | 'panel' }>();

const { t } = useI18n();
const { festival } = useFestivalEgg();
/** 徽章悬停提示：当前节日名（与全站 v-tip 同一气泡语言） */
const tip = computed(() => (festival.value ? t(`festival.tip_${festival.value}`) : ''));
</script>

<template>
  <!-- ===== 边框动效层：与胶囊边框本身结合的节日特效（区别于骑缘徽章的符号装饰）=====
       圣诞=顶部积雪檐+循环飘雪；愚人节=彩带流光环绕边框；程序员节=终端扫描光沿边框跑；
       七夕=星河流光；万圣节/元旦/中秋/春节/元宵/端午=辉光呼吸（纯 CSS box-shadow 动画，无 DOM）。全部 pointer-events:none -->
  <template v-if="kind === 'border' && festival">
    <template v-if="festival === 'christmas'">
      <div class="fest-border" aria-hidden="true">
        <!-- 积雪檐：沿胶囊顶缘的弧形雪层（ink 色随皮肤，两端收进避开圆角弧） -->
        <svg class="fest-snow-cap" viewBox="0 0 320 10" preserveAspectRatio="none" fill="none">
          <path d="M0 0h320v2.5q-16 4.5-30 1.5t-26 .8-26 1.2-26 .6-26 1.4-26 .8-26 1.2-26 .6-26 1.4-26 .8-26 1.2-26 .6-25 1.3-.5-1.4z" fill="rgb(var(--c-ink) / 0.9)" />
        </svg>
        <!-- 循环飘雪：两朵雪花从檐上落入，错峰不同速 -->
        <svg class="fest-flake fest-flake-a text-gold" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="M7 1v12M1.7 4l10.6 6M12.3 4L1.7 10" />
        </svg>
        <svg class="fest-flake fest-flake-b text-gold-soft" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <path d="M7 1v12M1.7 4l10.6 6M12.3 4L1.7 10" />
        </svg>
      </div>
    </template>
    <template v-else-if="festival === 'fools'">
      <!-- 愚人节：三色彩带流光沿胶囊边框循环流动（mask 圆环 = 只留边框厚度） -->
      <div class="fest-border" aria-hidden="true">
        <div class="fest-ring fest-ring-fools"></div>
      </div>
    </template>
    <template v-else-if="festival === 'programmer'">
      <!-- 程序员节：终端扫描光沿边框慢速巡游（同流光环结构，单色亮尾） -->
      <div class="fest-border" aria-hidden="true">
        <div class="fest-ring fest-ring-programmer"></div>
      </div>
    </template>
    <template v-else-if="festival === 'qixi'">
      <!-- 七夕：星河流光沿边框缓行（同流光环结构，喜鹊蓝双段亮带如银河横渡） -->
      <div class="fest-border" aria-hidden="true">
        <div class="fest-ring fest-ring-qixi"></div>
      </div>
    </template>
  </template>

  <!-- ===== 骑缘徽章：符号坐进与胶囊同底色/同描边的小圆底座，圆心压在胶囊边框线上（半出半入），
       与边框"生长"为一体而非外挂贴纸；位置为确定性散点（同一节日每次弹岛相同），
       底座仅向左右越缘（窗口 440 > 胶囊 344，顶部无余量不越顶）；
       悬停弹 v-tip 节日名（与全站同款气泡），徽章只落在边缘空隙，不遮胶囊内容交互 ===== -->
  <template v-else-if="kind === 'badges' && festival">
    <!-- 万圣节：幽灵徽章骑左缘中段（飘浮）+ 南瓜徽章骑右缘上段（缓慢眨眼） -->
    <template v-if="festival === 'halloween'">
      <span v-tip="tip" class="fest-badge fest-b-ghost text-gold" aria-hidden="true">
        <svg viewBox="0 0 16 18" fill="none" stroke="none">
          <g class="fest-float">
            <path d="M2 17.2v-8a6 6 0 0 1 12 0v8l-2-1.8-2 1.8-2-1.8-2 1.8-2-1.8z" fill="currentColor" />
            <circle cx="5.9" cy="8.6" r="0.95" style="fill: rgb(var(--c-surface))" />
            <circle cx="10.1" cy="8.6" r="0.95" style="fill: rgb(var(--c-surface))" />
          </g>
        </svg>
      </span>
      <span v-tip="tip" class="fest-badge fest-b-pumpkin text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
          <ellipse cx="7" cy="7.2" rx="5.6" ry="4.1" fill="currentColor" />
          <path d="M7 3.1c0-1 .7-1.5 1.4-1.8" fill="none" />
          <g class="fest-blink-slow">
            <path d="M5 5.9l.85 1.4h-1.7zM9 5.9l.85 1.4h-1.7z" style="fill: rgb(var(--c-surface))" stroke="none" />
            <path d="M5.2 8.4l.9.65.9-.65.9.65.9-.65" style="stroke: rgb(var(--c-surface))" stroke-width="0.9" fill="none" />
          </g>
        </svg>
      </span>
    </template>
    <!-- 圣诞：圣诞帽徽章骑右缘中下段（绒球镂空呼吸）+ 雪花徽章骑左缘上段（慢转） -->
    <template v-else-if="festival === 'christmas'">
      <span v-tip="tip" class="fest-badge fest-b-hat text-gold" aria-hidden="true">
        <svg viewBox="0 0 18 16" fill="none" stroke="none">
          <path d="M4 12.5Q5.6 4 13.6 3.4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" />
          <rect x="2.4" y="11.6" width="13.2" height="3.2" rx="1.6" fill="currentColor" />
          <circle class="fest-blink-slow" cx="14.6" cy="3.2" r="2" style="fill: rgb(var(--c-surface))" />
        </svg>
      </span>
      <span v-tip="tip" class="fest-badge fest-b-snow text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <g class="fest-spin"><path d="M7 1v12M1.7 4l10.6 6M12.3 4L1.7 10" /></g>
        </svg>
      </span>
    </template>
    <!-- 程序员节：像素条码徽章骑右缘下段（三段错峰闪烁）+ 终端徽章骑左缘中段（光标硬切） -->
    <template v-else-if="festival === 'programmer'">
      <span v-tip="tip" class="fest-badge fest-b-bars text-gold" aria-hidden="true">
        <svg viewBox="0 0 16 12" fill="currentColor" stroke="none">
          <rect x="0.5" y="2" width="1.3" height="8" rx="0.4" class="fest-blink" />
          <rect x="2.8" y="1" width="1.3" height="10" rx="0.4" />
          <rect x="5.1" y="3" width="1.3" height="6" rx="0.4" class="fest-blink" style="animation-delay: 0.35s" />
          <rect x="7.4" y="0.5" width="1.3" height="11" rx="0.4" />
          <rect x="9.7" y="2.5" width="1.3" height="7" rx="0.4" class="fest-blink" style="animation-delay: 0.7s" />
          <rect x="12" y="1.5" width="1.3" height="9" rx="0.4" />
          <rect x="14.3" y="3" width="1.3" height="6" rx="0.4" class="fest-blink" style="animation-delay: 1.05s" />
        </svg>
      </span>
      <span v-tip="tip" class="fest-badge fest-b-term text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="0.8" y="0.8" width="12.4" height="10.4" rx="2" fill="currentColor" stroke="none" />
          <path d="M3.5 4l2.4 2-2.4 2" style="stroke: rgb(var(--c-surface))" />
          <path class="fest-blink" d="M8.3 8h2.4" style="stroke: rgb(var(--c-surface))" />
        </svg>
      </span>
    </template>
    <!-- 愚人节：派对帽徽章骑左缘上段（摇摆）+ 笑脸徽章骑右缘下段 -->
    <template v-else-if="festival === 'fools'">
      <span v-tip="tip" class="fest-badge fest-b-party text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 15" fill="none" stroke="none">
          <g class="fest-sway">
            <path d="M7 2.2L12 13.4H2z" fill="currentColor" />
            <path d="M4.9 8.3q2.1 1 4.2 0M4 10.6q3 1.3 6 0" style="stroke: rgb(var(--c-surface))" stroke-width="0.9" stroke-linecap="round" fill="none" />
            <circle cx="7" cy="2" r="1.2" style="fill: rgb(var(--c-surface))" />
          </g>
        </svg>
      </span>
      <span v-tip="tip" class="fest-badge fest-b-smile text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 14" fill="none" stroke="none">
          <circle cx="7" cy="7" r="5.6" fill="currentColor" />
          <circle cx="5.1" cy="5.9" r="0.8" style="fill: rgb(var(--c-surface))" />
          <circle cx="8.9" cy="5.9" r="0.8" style="fill: rgb(var(--c-surface))" />
          <path d="M4.6 8.2q2.4 2.2 4.8 0" style="stroke: rgb(var(--c-surface))" stroke-width="1.1" stroke-linecap="round" fill="none" />
        </svg>
      </span>
    </template>
    <!-- 七夕：织女星（四芒长针）骑左缘上段 + 牛郎星骑右缘中下段，对角错落似两星隔银河；错峰闪烁 -->
    <template v-else-if="festival === 'qixi'">
      <span v-tip="tip" class="fest-badge fest-b-qixi-a text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 14" fill="none" stroke="none">
          <g class="fest-twinkle"><path d="M7 0L8.3 5.7L14 7L8.3 8.3L7 14L5.7 8.3L0 7L5.7 5.7Z" fill="currentColor" /></g>
        </svg>
      </span>
      <span v-tip="tip" class="fest-badge fest-b-qixi-b text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 14" fill="none" stroke="none">
          <g class="fest-twinkle" style="animation-delay: 1.1s"><path d="M7 2.5L8 6L11.5 7L8 8L7 11.5L6 8L2.5 7L6 6Z" fill="currentColor" /></g>
        </svg>
      </span>
    </template>
    <!-- 中秋：满月徽章骑左缘中段（月盘 + 环形山镂空 + 静态月晕光圈） -->
    <template v-else-if="festival === 'midautumn'">
      <span v-tip="tip" class="fest-badge fest-b-moon text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 14" fill="none" stroke="none">
          <circle cx="7" cy="7" r="5" fill="currentColor" />
          <circle cx="5.3" cy="5.6" r="1.05" style="fill: rgb(var(--c-surface))" opacity="0.5" />
          <circle cx="8.8" cy="8.6" r="0.75" style="fill: rgb(var(--c-surface))" opacity="0.4" />
        </svg>
      </span>
    </template>
    <!-- 除夕：爆竹徽章骑左缘上段（引线火花硬切闪烁）+ 守岁烛徽章骑右缘中下段（火苗摇摆） -->
    <template v-else-if="festival === 'chuxi'">
      <span v-tip="tip" class="fest-badge fest-b-firecracker text-gold" aria-hidden="true">
        <svg viewBox="0 0 12 14" fill="none" stroke="none">
          <rect x="4.4" y="3.4" width="3.2" height="7.6" rx="1" fill="currentColor" />
          <path d="M4.4 5.8h3.2M4.4 8.2h3.2" style="stroke: rgb(var(--c-surface))" stroke-width="0.8" />
          <path d="M6 3.4V2.2q0-0.9 1.2-0.9h1.9" stroke="currentColor" stroke-width="0.8" fill="none" stroke-linecap="round" />
          <g class="fest-blink">
            <path d="M10.4 0.5v1.6M9.6 1.3h1.6" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" />
          </g>
        </svg>
      </span>
      <span v-tip="tip" class="fest-badge fest-b-candle text-gold" aria-hidden="true">
        <svg viewBox="0 0 10 14" fill="none" stroke="none">
          <path d="M5 5.8v0.8" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" />
          <g class="fest-sway">
            <path d="M5 0.9q2.3 2.7 0 4.9q-2.3-2.2 0-4.9z" fill="currentColor" />
            <circle cx="5" cy="3.4" r="0.65" style="fill: rgb(var(--c-surface))" opacity="0.6" />
          </g>
          <rect x="2.8" y="6.6" width="4.4" height="6.2" rx="1.1" fill="currentColor" />
        </svg>
      </span>
    </template>
    <!-- 春节：红灯笼双盏骑缘（左缘上段 + 右缘中下段），悬垂慢摆错峰似挂檐下 -->
    <template v-else-if="festival === 'chunjie'">
      <span v-tip="tip" class="fest-badge fest-b-lant-a text-gold" aria-hidden="true">
        <svg viewBox="0 0 12 14" fill="none" stroke="none">
          <g class="fest-sway fest-sway-lantern">
            <path d="M6 0.7v1" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
            <rect x="3.8" y="1.5" width="4.4" height="1.1" rx="0.55" fill="currentColor" />
            <ellipse cx="6" cy="6.9" rx="4.5" ry="4" fill="currentColor" />
            <path d="M4.3 3.5q-1.2 3.4 0 6.8M7.7 3.5q1.2 3.4 0 6.8" style="stroke: rgb(var(--c-surface))" stroke-width="0.8" fill="none" />
            <rect x="4.2" y="10.7" width="3.6" height="1" rx="0.5" fill="currentColor" />
            <path d="M6 11.7v1.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
          </g>
        </svg>
      </span>
      <span v-tip="tip" class="fest-badge fest-b-lant-b text-gold" aria-hidden="true">
        <svg viewBox="0 0 12 14" fill="none" stroke="none">
          <g class="fest-sway fest-sway-lantern" style="animation-delay: 1.4s">
            <path d="M6 0.7v1" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
            <rect x="3.8" y="1.5" width="4.4" height="1.1" rx="0.55" fill="currentColor" />
            <ellipse cx="6" cy="6.9" rx="4.5" ry="4" fill="currentColor" />
            <path d="M4.3 3.5q-1.2 3.4 0 6.8M7.7 3.5q1.2 3.4 0 6.8" style="stroke: rgb(var(--c-surface))" stroke-width="0.8" fill="none" />
            <rect x="4.2" y="10.7" width="3.6" height="1" rx="0.5" fill="currentColor" />
            <path d="M6 11.7v1.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
          </g>
        </svg>
      </span>
    </template>
    <!-- 元宵：汤圆碗徽章骑左缘中段（白玉汤圆卧于碗沿，随浮感轻轻浮动） -->
    <template v-else-if="festival === 'yuanxiao'">
      <span v-tip="tip" class="fest-badge fest-b-tang text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 12" fill="none" stroke="none">
          <g class="fest-float">
            <circle cx="4.6" cy="4.6" r="1.5" style="fill: rgb(var(--c-ink))" />
            <circle cx="9.4" cy="4.6" r="1.5" style="fill: rgb(var(--c-ink))" />
            <circle cx="7" cy="3.5" r="1.5" style="fill: rgb(var(--c-ink))" />
            <path d="M1.8 5.2h10.4q-1.2 2.8-5.2 2.8Q3 8 1.8 5.2z" fill="currentColor" />
            <rect x="5.4" y="8.9" width="3.2" height="0.9" rx="0.45" fill="currentColor" opacity="0.85" />
          </g>
        </svg>
      </span>
    </template>
    <!-- 端午：三角粽徽章骑右缘上段（绳结交叉镂空） -->
    <template v-else-if="festival === 'duanwu'">
      <span v-tip="tip" class="fest-badge fest-b-zong text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 14" fill="none" stroke="none">
          <path d="M7 1.4L13.2 12.4H0.8z" fill="currentColor" />
          <path d="M3.4 6.8l7.2 4M10.6 6.8l-7.2 4" style="stroke: rgb(var(--c-surface))" stroke-width="1.1" stroke-linecap="round" fill="none" />
        </svg>
      </span>
    </template>
    <!-- 元旦：实心双星对角错落（右缘中段大星 + 左缘上段小星），错峰呼吸闪烁 -->
    <template v-else>
      <span v-tip="tip" class="fest-badge fest-b-star-a text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 14" fill="none" stroke="none">
          <g class="fest-twinkle">
            <path d="M7 1l1.5 4.5L13 7l-4.5 1.5L7 13l-1.5-4.5L1 7l4.5-1.5z" fill="currentColor" />
          </g>
        </svg>
      </span>
      <span v-tip="tip" class="fest-badge fest-b-star-b text-gold" aria-hidden="true">
        <svg viewBox="0 0 14 14" fill="none" stroke="none">
          <g class="fest-twinkle" style="animation-delay: 0.9s">
            <path d="M7 3l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" fill="currentColor" />
          </g>
        </svg>
      </span>
    </template>
  </template>

  <!-- ===== 面板装饰层：随节日皮肤染色（面板容器在 island-wrap 内，变量天然继承），不遮文本 ===== -->
  <template v-else-if="kind === 'panel' && festival">
    <template v-if="festival === 'christmas'">
      <!-- 圣诞：面板顶部彩灯串（三色灯珠错峰呼吸）+ 右上角雪花水印 -->
      <div class="fest-panel-deco" aria-hidden="true">
        <div class="fest-lights">
          <i v-for="i in 10" :key="i" class="fest-light" :class="`fest-light-${(i % 3) + 1}`" :style="{ animationDelay: `${i * 0.28}s` }"></i>
        </div>
        <svg class="fest-panel-badge text-gold" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <g class="fest-spin"><path d="M7 1v12M1.7 4l10.6 6M12.3 4L1.7 10" /></g>
        </svg>
      </div>
    </template>
    <template v-else-if="festival === 'halloween'">
      <!-- 万圣节：右上角蝙蝠剪影（缓慢浮动） -->
      <div class="fest-panel-deco" aria-hidden="true">
        <svg class="fest-panel-badge text-gold" viewBox="0 0 18 10" fill="currentColor" stroke="none">
          <g class="fest-float"><path d="M9 4.6Q7.6 1.2 5.4 1.9Q3.3 2.5 3 4.9Q1.6 4.2 0.6 5.2q1.5 0.4 2.3 1.6Q4.4 8.6 6.5 8.9Q8.2 9.1 9 7.9Q9.8 9.1 11.5 8.9Q13.6 8.6 15.1 6.8Q15.9 5.6 17.4 5.2Q16.4 4.2 15 4.9Q14.7 2.5 12.6 1.9Q10.4 1.2 9 4.6z" /></g>
        </svg>
      </div>
    </template>
    <template v-else-if="festival === 'programmer'">
      <!-- 程序员节：面板背景终端网格线（伪元素绘制，不占 DOM）+ 右上角终端窗水印 -->
      <div class="fest-panel-deco fest-panel-grid" aria-hidden="true">
        <svg class="fest-panel-badge text-gold" viewBox="0 0 14 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.55">
          <rect x="0.7" y="0.7" width="12.6" height="10.6" rx="2" />
          <path d="M3.5 4l2.5 2-2.5 2" />
          <path class="fest-blink" d="M8.5 8h2.5" />
        </svg>
      </div>
    </template>
    <template v-else-if="festival === 'qixi'">
      <!-- 七夕：右上角双星水印 + 虚线鹊桥相连 -->
      <div class="fest-panel-deco" aria-hidden="true">
        <svg class="fest-panel-badge text-gold" viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" style="width: 17px; height: 13px">
          <path d="M3.2 1.5L4 3.5L6 4.3L4 5.1L3.2 7.1L2.4 5.1L0.4 4.3L2.4 3.5Z" fill="currentColor" stroke="none" />
          <path d="M12.8 5.4L13.45 6.95L15 7.6L13.45 8.25L12.8 9.8L12.15 8.25L10.6 7.6L12.15 6.95Z" fill="currentColor" stroke="none" />
          <path d="M5.2 5.4L11 7" stroke-dasharray="1.5 2" opacity="0.65" />
        </svg>
      </div>
    </template>
    <template v-else-if="festival === 'midautumn'">
      <!-- 中秋：右上角满月水印（外圈月晕静挂，环形山镂空） -->
      <div class="fest-panel-deco" aria-hidden="true">
        <svg class="fest-panel-badge text-gold" viewBox="0 0 14 14" fill="none" stroke="none">
          <circle cx="7" cy="7" r="5.6" fill="currentColor" opacity="0.16" />
          <circle cx="7" cy="7" r="4" fill="currentColor" />
          <circle cx="5.8" cy="5.8" r="0.85" style="fill: rgb(var(--c-surface))" opacity="0.5" />
          <circle cx="8.4" cy="8.2" r="0.6" style="fill: rgb(var(--c-surface))" opacity="0.4" />
        </svg>
      </div>
    </template>
    <template v-else-if="festival === 'fools'">
      <!-- 愚人节：面板顶部三角彩旗串（随风轻摆） -->
      <div class="fest-panel-deco" aria-hidden="true">
        <svg class="fest-bunting" viewBox="0 0 320 12" preserveAspectRatio="none" fill="none" stroke="none">
          <path d="M0 1.5h320" stroke="rgb(var(--c-gold) / 0.5)" stroke-width="1" />
          <g class="fest-sway">
            <path d="M10 2l7 0-3.5 8z" fill="rgb(var(--c-gold) / 0.75)" />
            <path d="M50 2l7 0-3.5 8z" fill="rgb(var(--c-gold-soft) / 0.75)" />
            <path d="M90 2l7 0-3.5 8z" fill="rgb(var(--c-line) / 0.9)" />
            <path d="M130 2l7 0-3.5 8z" fill="rgb(var(--c-gold) / 0.75)" />
            <path d="M170 2l7 0-3.5 8z" fill="rgb(var(--c-gold-soft) / 0.75)" />
            <path d="M210 2l7 0-3.5 8z" fill="rgb(var(--c-line) / 0.9)" />
            <path d="M250 2l7 0-3.5 8z" fill="rgb(var(--c-gold) / 0.75)" />
            <path d="M290 2l7 0-3.5 8z" fill="rgb(var(--c-gold-soft) / 0.75)" />
          </g>
        </svg>
      </div>
    </template>
    <template v-else-if="festival === 'chuxi'">
      <!-- 除夕：右上一对守岁烛水印（高低错落，火苗微光，案面横线收底） -->
      <div class="fest-panel-deco" aria-hidden="true">
        <svg class="fest-panel-badge text-gold" viewBox="0 0 16 12" fill="none" stroke="none" style="width: 16px; height: 12px">
          <g class="fest-float">
            <path d="M5 2.4q1.7 1.9 0 3.6q-1.7-1.7 0-3.6z" fill="currentColor" />
            <rect x="3.9" y="6.6" width="2.2" height="4.4" rx="0.8" fill="currentColor" />
            <path d="M10.6 1.2q1.9 2.1 0 4q-1.9-1.9 0-4z" fill="currentColor" />
            <rect x="9.5" y="5.6" width="2.4" height="5.4" rx="0.9" fill="currentColor" />
            <path d="M1.6 11h12.8" stroke="currentColor" stroke-width="0.9" stroke-linecap="round" opacity="0.5" />
          </g>
        </svg>
      </div>
    </template>
    <template v-else-if="festival === 'chunjie'">
      <!-- 春节：右上角福字菱印（菱形春联 + 福字，静态水印） -->
      <div class="fest-panel-deco" aria-hidden="true">
        <svg class="fest-panel-badge text-gold" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.1" style="width: 15px; height: 15px">
          <rect x="3" y="3" width="8" height="8" rx="1" transform="rotate(45 7 7)" opacity="0.8" />
          <text x="7" y="9.4" text-anchor="middle" font-size="6.2" fill="currentColor" stroke="none" font-family="'Noto Sans SC', 'Microsoft YaHei', sans-serif">福</text>
        </svg>
      </div>
    </template>
    <template v-else-if="festival === 'yuanxiao'">
      <!-- 元宵：右上角花灯水印（提梁灯笼 + 流苏） -->
      <div class="fest-panel-deco" aria-hidden="true">
        <svg class="fest-panel-badge text-gold" viewBox="0 0 12 14" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" style="width: 13px; height: 15px">
          <path d="M4.2 1.4h3.6" />
          <ellipse cx="6" cy="7" rx="4.6" ry="4.1" opacity="0.75" />
          <path d="M4.2 3.5q-1.3 3.5 0 7M7.8 3.5q1.3 3.5 0 7" opacity="0.55" />
          <path d="M6 11.1v1.4M4.9 12.5h2.2" opacity="0.75" />
        </svg>
      </div>
    </template>
    <template v-else-if="festival === 'duanwu'">
      <!-- 端午：右上角龙舟水印（船身 + 龙首 + 双桨水纹） -->
      <div class="fest-panel-deco" aria-hidden="true">
        <svg class="fest-panel-badge text-gold" viewBox="0 0 16 10" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" style="width: 17px; height: 11px">
          <path d="M1.6 5h11.6q-1.2 2.8-5.8 2.8Q2.8 7.8 1.6 5z" fill="currentColor" stroke="none" opacity="0.9" />
          <path d="M13.2 5q1.9-.3 1.9-2.3q-1 1.1-2.3.9" opacity="0.85" />
          <path d="M4.8 6.4l1.3 2M9.4 6.4l1.3 2" opacity="0.55" />
          <path d="M2.6 9.4q1 .7 2 0M7.4 9.4q1 .7 2 0M12.2 9.4q1 .7 2 0" opacity="0.4" />
        </svg>
      </div>
    </template>
    <template v-else>
      <!-- 元旦：右上角烟花星芒水印（呼吸闪烁） -->
      <div class="fest-panel-deco" aria-hidden="true">
        <svg class="fest-panel-badge text-gold" viewBox="0 0 14 14" fill="none" stroke="none">
          <g class="fest-twinkle"><path d="M7 1l1.5 4.5L13 7l-4.5 1.5L7 13l-1.5-4.5L1 7l4.5-1.5z" fill="currentColor" /></g>
        </svg>
      </div>
    </template>
  </template>
</template>
