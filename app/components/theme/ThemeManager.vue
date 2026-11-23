<script setup lang="ts">
/**
 * 自定义主题面板（设置 → 外观内嵌）
 *
 * 只暴露三个锚点（底色/主色/文字色），其余令牌由 themeModel 自动派生；
 * 文字与主色按 WCAG 自动修正明度，修不动的组合阻止应用。
 * 当前配色可直接应用，也可命名保存为模板；快捷起点只读入锚点，不落库。
 */
import { computed, reactive, ref, watch } from 'vue';
import UiColorPicker from '~/components/ui/UiColorPicker.vue';
import ThemePreview from '~/components/theme/ThemePreview.vue';
import DeleteConfirm from '~/components/common/DeleteConfirm.vue';
import { WORKING_THEME_ID, useTheme } from '~/composables/useTheme';
import { useI18n } from '~/composables/useI18n';
import { notifyIsland, type IslandKind } from '~/composables/useCopyIsland';
import {
  anchorContrasts,
  anchorsFromTheme,
  buildAnchorTokens,
  DEFAULT_THEME_ANCHORS,
  deriveTokens,
  enforceAnchorReadability,
  type ThemeAnchors,
  type ThemeDefinition,
} from '~/src/theme/themeModel';
import { THEME_ANCHOR_PRESETS } from '~/src/theme/themePresets';
import { MAX_THEMES } from '~/src/theme/themeValidation';
import { darken, isValidHex, lighten, normalizeHex } from '~/src/theme/colorUtils';

const { t } = useI18n();

const {
  themes,
  activeId,
  activeTheme,
  customActive,
  ready,
  applyAnchors,
  saveTemplate,
  activateTheme,
  deleteTheme,
} = useTheme();

const draft = reactive<ThemeAnchors>({ ...DEFAULT_THEME_ANCHORS });
const templateName = ref('');
const activeField = ref<keyof ThemeAnchors | ''>('');
/** 待删除模板：非空时显示删除确认框 */
const pendingDelete = ref<ThemeDefinition | null>(null);
let loadedId = '';

const anchorFields = computed(() => [
  { key: 'bg' as const, label: t('theme.anchor_bg') },
  { key: 'accent' as const, label: t('theme.anchor_accent') },
  { key: 'ink' as const, label: t('theme.anchor_ink') },
]);

const activeColor = computed({
  get: () => (activeField.value ? draft[activeField.value] : ''),
  set: (v: string) => {
    if (activeField.value) draft[activeField.value] = v;
  },
});

const anchorPalette = [
  '#f3ede1', '#e9efe3', '#edf1f8', '#ffffff', '#1e1b16',
  '#c4442b', '#2f5d3a', '#33518f', '#8a5a2b', '#d4c9b8',
];

const hexValid = computed(() => isValidHex(draft.bg) && isValidHex(draft.accent) && isValidHex(draft.ink));
const readable = computed(() => enforceAnchorReadability(draft, 'light'));
const previewTokens = computed(() =>
  deriveTokens(buildAnchorTokens(readable.value.anchors, 'light'), 'light'),
);
const ratios = computed(() => anchorContrasts(previewTokens.value));
const chips = computed(() => [
  { key: 'body', label: t('theme.contrast_body'), ratio: ratios.value.body, pass: ratios.value.body >= 4.5, color: previewTokens.value.ink },
  { key: 'secondary', label: t('theme.contrast_secondary'), ratio: ratios.value.secondary, pass: ratios.value.secondary >= 4.5, color: previewTokens.value.inkSoft },
  { key: 'button', label: t('theme.contrast_button'), ratio: ratios.value.button, pass: ratios.value.button >= 4.5, color: previewTokens.value.accent },
]);
const canApply = computed(() => hexValid.value && readable.value.ok);
const corrected = computed(() => readable.value.correctedText || readable.value.correctedAccent);

const quickStarts = computed(() =>
  THEME_ANCHOR_PRESETS.map((preset) => ({
    ...preset,
    swatches: [
      darken(preset.anchors.bg, 0.62),
      preset.anchors.accent,
      lighten(preset.anchors.bg, 0.55),
    ],
  })),
);

// 启用中的主题变化时读回锚点；同一 ID 内的草稿编辑不被覆盖
watch([ready, activeTheme], () => {
  if (!ready.value) return;
  const theme = activeTheme.value;
  const id = theme?.id ?? '';
  if (id === loadedId) return;
  loadedId = id;
  if (!theme) return;
  const anchors = anchorsFromTheme(theme, 'light');
  draft.bg = anchors.bg;
  draft.accent = anchors.accent;
  draft.ink = anchors.ink;
}, { immediate: true });

/** 操作反馈 → 灵动岛（屏幕顶部全局胶囊），与应用其余反馈通道一致 */
function notify(text: string, kind: IslandKind = 'success'): void {
  notifyIsland({ kind, text });
}

/** 模板行的三色小样：底色 / 主色 / 文字色 */
function themeSwatches(theme: ThemeDefinition): string[] {
  const anchors = anchorsFromTheme(theme, 'light');
  return [anchors.bg, anchors.accent, anchors.ink];
}

function togglePicker(key: keyof ThemeAnchors): void {
  activeField.value = activeField.value === key ? '' : key;
}

/** 输入到一半的非法 hex 不污染色块 */
function anchorSwatch(key: keyof ThemeAnchors): string {
  return normalizeHex(draft[key]) ?? 'transparent';
}

function onQuickStart(anchors: ThemeAnchors): void {
  draft.bg = anchors.bg;
  draft.accent = anchors.accent;
  draft.ink = anchors.ink;
  activeField.value = '';
  notify(t('theme.quick_start_loaded'));
}

async function onApply(): Promise<void> {
  if (!canApply.value) {
    notify(t('theme.apply_blocked'), 'error');
    return;
  }
  const anchors = { ...readable.value.anchors };
  draft.bg = anchors.bg;
  draft.accent = anchors.accent;
  draft.ink = anchors.ink;
  await applyAnchors(anchors);
  loadedId = WORKING_THEME_ID;
  notify(t('theme.apply_done'));
}

async function onSaveTemplate(): Promise<void> {
  if (!canApply.value) {
    notify(t('theme.apply_blocked'), 'error');
    return;
  }
  if (!templateName.value.trim()) {
    notify(t('theme.name_required'), 'error');
    return;
  }
  const result = await saveTemplate(templateName.value, readable.value.anchors);
  if (result === 'limit') {
    notify(t('theme.limit_reached'), 'error');
    return;
  }
  templateName.value = '';
  notify(result === 'updated' ? t('theme.template_overwritten') : t('theme.template_saved'));
}

async function onApplyTemplate(id: string): Promise<void> {
  const ok = await activateTheme(id);
  notify(ok ? t('theme.activated') : t('theme.activate_failed'), ok ? 'success' : 'error');
}

/** 点击右上角删除图标：先弹确认框，用户确认后才真正删除 */
function onDeleteTemplate(theme: ThemeDefinition): void {
  pendingDelete.value = theme;
}

async function confirmDelete(): Promise<void> {
  const theme = pendingDelete.value;
  pendingDelete.value = null;
  if (!theme) return;
  const ok = await deleteTheme(theme.id);
  notify(ok ? t('theme.deleted') : t('theme.delete_failed'), ok ? 'success' : 'error');
}
</script>

<template>
  <div class="space-y-5">
    <!-- 自定义主题：三个锚点 -->
    <section>
      <h3 class="text-sm text-ink">{{ t('theme.custom_title') }}</h3>
      <p class="mt-1 text-xs leading-relaxed text-ink-soft">{{ t('theme.custom_desc') }}</p>

      <div class="mt-3 grid grid-cols-3 gap-3">
        <div v-for="field in anchorFields" :key="field.key" class="min-w-0">
          <div class="mb-1.5 text-[11px] text-ink-soft">{{ field.label }}</div>
          <div class="flex items-center gap-2 rounded-xl border border-line bg-surface-field px-2.5 py-2 shadow-xs transition-colors focus-within:border-gold/60">
            <button
                type="button"
                class="h-5 w-5 shrink-0 rounded-md border border-black/10 shadow-xs"
                :style="{ backgroundColor: anchorSwatch(field.key) }"
                :aria-label="field.label"
                @click="togglePicker(field.key)"
            />
            <input
                v-model="draft[field.key]"
                maxlength="7"
                spellcheck="false"
                class="min-w-0 flex-1 bg-transparent font-mono text-[11px] uppercase tracking-wide text-ink focus:outline-hidden"
            />
            <button
                type="button"
                class="shrink-0 text-ink-faint transition-colors hover:text-gold"
                :title="t('theme.pick_color')"
                @click="togglePicker(field.key)"
            >
              <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="m2 22 1-1h3l9-9" />
                <path d="M3 21v-3l9-9" />
                <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div v-if="activeField" class="mt-2 rounded-xl border border-gold/30 bg-surface-field/70 p-2 shadow-xs">
        <UiColorPicker v-model="activeColor" :presets="anchorPalette" />
      </div>
    </section>

    <!-- 预览 + 对比度 + 应用 -->
    <section>
      <div class="mb-1.5 text-xs text-ink-soft">{{ t('theme.preview_label') }}</div>
      <ThemePreview :tokens="previewTokens" />

      <div class="mt-2 flex flex-wrap gap-2">
        <span
            v-for="chip in chips"
            :key="chip.key"
            class="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[11px] tabular-nums"
            :class="chip.pass ? 'border-line text-ink-soft' : 'border-danger/60 text-danger'"
        >
          <span class="h-1.5 w-1.5 rounded-full" :style="{ backgroundColor: chip.color }" />
          {{ chip.label }} {{ chip.ratio.toFixed(2) }}:1
        </span>
      </div>

      <p v-if="corrected" class="mt-1.5 text-[11px] text-ink-faint">{{ t('theme.auto_corrected') }}</p>
      <p v-if="!readable.ok" class="mt-1.5 text-[11px] text-danger">{{ t('theme.apply_blocked') }}</p>

      <div class="mt-3 flex items-center justify-end">
        <button
            type="button"
            class="rounded-xl px-4 py-2 text-xs font-medium shadow-soft transition-all duration-300 ease-soft hover:-translate-y-0.5 hover:shadow-float disabled:translate-y-0 disabled:opacity-40 disabled:shadow-none"
            :style="{ backgroundColor: previewTokens.accent, color: previewTokens.onAccent }"
            :disabled="!canApply"
            @click="onApply"
        >
          {{ t('theme.apply') }}
        </button>
      </div>
    </section>

    <!-- 我的模板 -->
    <section class="border-t border-accent pt-4">
      <div class="flex items-center justify-between gap-3">
        <h3 class="text-sm text-ink">{{ t('theme.my_templates') }}</h3>
        <span class="text-[11px] tabular-nums text-ink-faint">{{ themes.length }} / {{ MAX_THEMES }}</span>
      </div>
      <p v-if="!themes.length" class="mt-1 text-xs leading-relaxed text-ink-faint">
        {{ t('theme.templates_hint_empty') }}
      </p>
      <ul v-else class="mt-2 space-y-1">
        <li
            v-for="theme in themes"
            :key="theme.id"
            class="group relative flex items-center gap-2 rounded-xl border px-2.5 py-2 transition-colors"
            :class="customActive && activeId === theme.id ? 'border-gold/60 bg-gold/10' : 'border-line hover:border-gold/30'"
        >
          <span class="flex shrink-0 overflow-hidden rounded border border-black/10">
            <span
                v-for="(color, ci) in themeSwatches(theme)"
                :key="ci"
                class="h-3.5 w-2.5"
                :style="{ backgroundColor: color }"
            />
          </span>
          <span class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{{ theme.name }}</span>
          <button
              type="button"
              class="mr-5 shrink-0 text-[11px] font-medium text-gold disabled:opacity-40"
              :disabled="customActive && activeId === theme.id"
              @click="onApplyTemplate(theme.id)"
          >{{ t('theme.apply') }}</button>
          <!-- 删除：hover 行时右上角浮现垃圾桶图标，点击弹确认框 -->
          <button
              type="button"
              class="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md text-ink-faint opacity-0 transition-opacity duration-200 hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
              v-tip="t('theme.delete')"
              @click="onDeleteTemplate(theme)"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18" />
              <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          </button>
        </li>
      </ul>

      <div class="mt-2 flex flex-wrap items-center gap-2">
        <input
            v-model="templateName"
            maxlength="24"
            spellcheck="false"
            :placeholder="t('theme.template_name_placeholder')"
            class="min-w-40 flex-1 rounded-xl border border-line bg-surface-field px-2.5 py-2 text-xs text-ink shadow-xs transition-colors focus:border-gold/60 focus:outline-hidden"
            @keyup.enter="onSaveTemplate"
        />
        <button type="button" class="btn-soft px-3 py-2 text-xs" @click="onSaveTemplate">
          {{ t('theme.save_template') }}
        </button>
        <span class="text-[11px] text-ink-faint">{{ t('theme.same_name_overwrite') }}</span>
      </div>
    </section>

    <!-- 快捷起点 -->
    <section class="border-t border-accent pt-4">
      <h3 class="text-sm text-ink">{{ t('theme.quick_start') }}</h3>
      <p class="mt-1 text-xs text-ink-faint">{{ t('theme.quick_start_hint') }}</p>
      <div class="mt-2 flex flex-wrap gap-2">
        <button
            v-for="preset in quickStarts"
            :key="preset.id"
            type="button"
            class="flex items-center gap-2 rounded-xl border border-line bg-surface-field px-2.5 py-2 text-xs text-ink shadow-xs transition-all duration-300 ease-soft hover:-translate-y-0.5 hover:border-gold/50 hover:shadow-float"
            @click="onQuickStart(preset.anchors)"
        >
          <span class="flex overflow-hidden rounded border border-black/10">
            <span
                v-for="(color, ci) in preset.swatches"
                :key="ci"
                class="h-3.5 w-2.5"
                :style="{ backgroundColor: color }"
            />
          </span>
          {{ t(`theme.anchor_presets.${preset.id}`) }}
        </button>
      </div>
    </section>

    <!-- 删除模板确认框：视口居中浮动模态，Enter 确认 / Esc 取消 -->
    <DeleteConfirm
        :visible="!!pendingDelete"
        :message="t('theme.delete_confirm_msg', { name: pendingDelete?.name ?? '' })"
        @confirm="confirmDelete"
        @cancel="pendingDelete = null"
    />
  </div>
</template>
