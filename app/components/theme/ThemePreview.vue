<script setup lang="ts">
/**
 * 主题样张实时预览（应用真实界面缩略图）
 *
 * 直接用解析后的令牌渲染，不触碰全局 document 变量；
 * 编辑锚点时能看到效果，但不会影响正在使用的主题。
 * 缩略图模拟应用的真实构成：标题栏导航 + 待办列表 + 便签卡片 +
 * 开关/主按钮，让用户在编辑三锚点时直观看到主题在全应用的落地效果。
 */
import type { ResolvedThemeTokens } from '~/src/theme/themeModel';
import { useI18n } from '~/composables/useI18n';

defineProps<{
  tokens: ResolvedThemeTokens;
}>();

const { t } = useI18n();
</script>

<template>
  <!-- 迷你应用窗口：页面底色 + 细边 -->
  <div
      class="overflow-hidden rounded-xl border shadow-xs"
      :style="{ backgroundColor: tokens.primary, borderColor: tokens.line }"
  >
    <!-- 标题栏：应用名 + 顶部导航（选中项用主色）+ 窗口控制点 -->
    <div
        class="flex h-9 items-center justify-between border-b px-3"
        :style="{ backgroundColor: tokens.surface, borderColor: tokens.line }"
    >
      <span class="text-xs font-semibold" :style="{ color: tokens.ink }">S1d3 Board</span>

      <!-- 导航图标：选中项 = 主色淡底 + 主色图形，与真实标题栏一致 -->
      <div class="flex items-center gap-2">
        <span
            v-for="i in 4"
            :key="i"
            class="flex h-5 w-5 items-center justify-center rounded-md"
            :style="{ backgroundColor: i === 2 ? tokens.accentSoft : 'transparent' }"
        >
          <span
              class="block h-2.5 w-2.5 rounded-[3px]"
              :style="{ backgroundColor: i === 2 ? tokens.accent : tokens.inkFaint, opacity: i === 2 ? 1 : 0.55 }"
          ></span>
        </span>
      </div>

      <!-- 窗口控制：缩小/关闭的抽象点 -->
      <div class="flex items-center gap-1.5">
        <span class="block h-1.5 w-1.5 rounded-full" :style="{ backgroundColor: tokens.inkFaint }"></span>
        <span class="block h-1.5 w-1.5 rounded-full" :style="{ backgroundColor: tokens.inkFaint }"></span>
      </div>
    </div>

    <!-- 内容区：待办卡片 + 便签卡片 -->
    <div class="space-y-2 p-3">
      <!-- 待办卡片：完成态（主色勾选）+ 进行中 + 进度条 -->
      <div
          class="rounded-lg border p-2.5"
          :style="{ backgroundColor: tokens.surface, borderColor: tokens.line }"
      >
        <div class="flex items-center gap-2">
          <span
              class="rounded-full px-2 py-0.5 text-[10px]"
              :style="{ backgroundColor: tokens.accent, color: tokens.onAccent }"
          >{{ t('theme.preview.mini_status') }}</span>
          <span class="font-mono text-[11px] tabular-nums" :style="{ color: tokens.inkSoft }">
            {{ t('theme.preview.mini_progress') }}
          </span>
        </div>

        <!-- 已完成项：主色实底圆 + 对比色勾 -->
        <div class="mt-2 flex items-center gap-2">
          <span
              class="flex h-3.5 w-3.5 items-center justify-center rounded-full"
              :style="{ backgroundColor: tokens.accent }"
          >
            <svg class="h-2 w-2" viewBox="0 0 24 24" fill="none" :stroke="tokens.onAccent" stroke-width="3.4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </span>
          <span class="text-[11px] line-through" :style="{ color: tokens.inkFaint }">
            {{ t('theme.preview.mini_task_done') }}
          </span>
        </div>

        <!-- 进行中项：空圆 + 墨字 -->
        <div class="mt-1.5 flex items-center gap-2">
          <span
              class="h-3.5 w-3.5 rounded-full border"
              :style="{ borderColor: tokens.line, backgroundColor: tokens.surfaceField }"
          ></span>
          <span class="text-[11px]" :style="{ color: tokens.ink }">
            {{ t('theme.preview.mini_task_open') }}
          </span>
        </div>

        <!-- 进度条：辅助色轨道 + 主色填充 -->
        <div class="mt-2.5">
          <div class="h-1.5 w-full overflow-hidden rounded-full" :style="{ backgroundColor: tokens.secondary }">
            <div class="h-full w-[62%] rounded-full" :style="{ backgroundColor: tokens.accent }"></div>
          </div>
        </div>
      </div>

      <!-- 便签卡片 + 控件行 -->
      <div
          class="rounded-lg border p-2.5"
          :style="{ backgroundColor: tokens.surfaceField, borderColor: tokens.line }"
      >
        <div class="text-[11px] font-medium" :style="{ color: tokens.ink }">
          {{ t('theme.preview.mini_note_title') }}
        </div>
        <div class="mt-0.5 text-[11px]" :style="{ color: tokens.inkSoft }">
          {{ t('theme.preview.mini_note_line') }}
        </div>

        <!-- 开关（开启态 = 主色）+ 主按钮 -->
        <div class="mt-2.5 flex items-center justify-between">
          <div class="flex items-center gap-1.5">
            <span
                class="flex h-3.5 w-6 items-center rounded-full px-0.5"
                :style="{ backgroundColor: tokens.accent }"
            >
              <span
                  class="block h-2.5 w-2.5 translate-x-2 rounded-full"
                  :style="{ backgroundColor: tokens.onAccent }"
              ></span>
            </span>
            <span class="text-[10px]" :style="{ color: tokens.inkSoft }">
              {{ t('theme.preview.mini_toggle') }}
            </span>
          </div>
          <span
              class="rounded-md px-2 py-1 text-[10px] font-medium"
              :style="{ backgroundColor: tokens.accent, color: tokens.onAccent }"
          >{{ t('theme.preview.primary_btn') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
