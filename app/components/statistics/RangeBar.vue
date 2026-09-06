<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '~/composables/useI18n';
import DatePicker from '~/components/common/DatePicker.vue';

/**
 * 统计类页面共用的范围切换栏（§7.2）
 *
 * 预设范围按钮（每日/每周/每月/年度/自定义…）+ 阶段切换箭头（上一阶段/下一阶段）
 * + 自定义起止日期选择。统计页与应用时长页共用，保证交互与外观一致。
 * 阶段偏移与范围日期的计算由页面各自维护（通过 props/事件同步）。
 */
export interface RangeBarOption {
  key: string;
  name: string;
}

const props = withDefaults(defineProps<{
  /** 当前选中的范围 key（v-model） */
  modelValue: string;
  /** 范围选项 */
  options: RangeBarOption[];
  /** 阶段偏移（v-model:offset）：0 = 当前阶段，-1 = 上一阶段；自定义范围无阶段概念 */
  offset?: number;
  /** 自定义起止日期（v-model:custom-from / v-model:custom-to） */
  customFrom?: string;
  customTo?: string;
  /** 范围文案（显示在阶段箭头中间，如 "2026-09-01 ~ 2026-09-30"） */
  label?: string;
}>(), {
  offset: 0,
  customFrom: '',
  customTo: '',
  label: '',
});

const emit = defineEmits<{
  (e: 'update:modelValue', key: string): void;
  (e: 'update:offset', offset: number): void;
  (e: 'update:customFrom', v: string): void;
  (e: 'update:customTo', v: string): void;
}>();

const { t } = useI18n();

const isCustom = computed(() => props.modelValue === 'custom');
/** 左箭头禁用：自定义范围无"阶段"概念 */
const leftDisabled = computed(() => isCustom.value);
/** 右箭头禁用：自定义范围，或已处于当前（最新）阶段不可再往后 */
const rightDisabled = computed(() => isCustom.value || props.offset >= 0);

function select(key: string) {
  if (props.modelValue !== key) {
    emit('update:modelValue', key);
    // 切换范围时重置阶段偏移（回到当前阶段）
    emit('update:offset', 0);
  }
}

/** 阶段切换：delta=-1 上一阶段，delta=1 下一阶段；不允许进入未来阶段 */
function shift(delta: number) {
  if (isCustom.value) return;
  const next = props.offset + delta;
  if (next > 0) return;
  emit('update:offset', next);
}
</script>

<template>
  <div class="glass-card card-lift rounded-2xl p-4">
    <!-- 默认窗口尺寸下始终单行：禁用换行，靠紧凑间距 + 日期控件定宽保证 -->
    <div class="flex flex-nowrap items-center gap-2">
      <button
        v-for="opt in options"
        :key="opt.key"
        type="button"
        class="btn-soft shrink-0 whitespace-nowrap px-2.5 py-1.5 text-sm"
        :class="modelValue === opt.key ? 'border-gold bg-secondary text-gold' : ''"
        @click="select(opt.key)"
      >
        {{ opt.name }}
      </button>
      <div class="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-ink-faint">
        <span v-if="isCustom" class="flex min-w-0 items-center gap-1">
          <span class="w-36 min-w-0">
            <DatePicker
              :model-value="customFrom"
              :placeholder="t('statistics.from_date')"
              :max="customTo || undefined"
              @update:model-value="emit('update:customFrom', $event)"
            />
          </span>
          <span class="text-ink-faint">—</span>
          <span class="w-36 min-w-0">
            <DatePicker
              :model-value="customTo"
              :placeholder="t('statistics.to_date')"
              :min="customFrom || undefined"
              @update:model-value="emit('update:customTo', $event)"
            />
          </span>
        </span>
        <!-- 阶段切换箭头：左右选择上一阶段/下一阶段，无可用方向时置灰禁用 -->
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-300 ease-soft"
            :class="leftDisabled ? 'cursor-not-allowed text-ink-faint/40' : 'text-gold hover:bg-secondary'"
            :disabled="leftDisabled"
            v-tip="t('statistics.prev_phase')"
            @click="shift(-1)"
          >
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <span class="min-w-[8.5rem] max-w-full truncate whitespace-nowrap text-center tabular-nums">{{ label }}</span>
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-300 ease-soft"
            :class="rightDisabled ? 'cursor-not-allowed text-ink-faint/40' : 'text-gold hover:bg-secondary'"
            :disabled="rightDisabled"
            v-tip="t('statistics.next_phase')"
            @click="shift(1)"
          >
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
