<script setup lang="ts">
/**
 * 循环规则选择器（RecurrencePicker，待办 §1）
 *
 * 面板：不循环 / 频率（天·周·月·年）+ 间隔 + 周几多选（周）+ 几号（月）+ 下一期起算基准。
 * v-model 绑定 TodoRecurrence（undefined = 不循环）；变更即时上抛（不落库，由父级持久化）。
 * 基于 UiDropdown：面板 Teleport 到 body + fixed 定位，交互由组件统一处理。
 */
import { ref, watch, computed } from 'vue'
import type { TodoRecurrence } from '~/src/entities'
import { describeRecurrence } from '~/src/todo/recurrence'
import { useI18n } from '~/composables/useI18n'
import UiDropdown from '~/components/ui/UiDropdown.vue'

const props = withDefaults(defineProps<{
  /** 循环规则；undefined = 不循环 */
  modelValue?: TodoRecurrence
  /** 无截止时间时禁用（循环推算依赖 dueDate） */
  disabled?: boolean
}>(), { disabled: false })

const emit = defineEmits<{
  (e: 'update:modelValue', value: TodoRecurrence | undefined): void
}>()

const { t } = useI18n()

/** 面板草稿：打开时从 props 克隆，编辑中即时上抛（v-model 单向数据流） */
const draft = ref<TodoRecurrence>({ freq: 'daily', interval: 1, from: 'due' })
watch(() => props.modelValue, (v) => {
  draft.value = v ? { ...v, weekdays: v.weekdays ? [...v.weekdays] : undefined } : { freq: 'daily', interval: 1, from: 'due' }
}, { immediate: true })

const FREQS: TodoRecurrence['freq'][] = ['daily', 'weekly', 'monthly', 'yearly']
const freqLabel = (f: TodoRecurrence['freq']) => t(`todo.freq_${f}`)

/** 是否已设置循环 */
const active = computed(() => !!props.modelValue)

/** 触发按钮摘要（与卡片徽章同文案） */
const summary = computed(() => {
  const r = props.modelValue
  if (!r) return t('todo.recurrence')
  return describeRecurrence(r, t)
})

function push() {
  const d = draft.value
  const out: TodoRecurrence = {
    freq: d.freq,
    interval: Math.min(999, Math.max(1, Math.round(Number(d.interval)) || 1)),
    from: d.from,
  }
  if (d.freq === 'weekly' && d.weekdays?.length) out.weekdays = [...d.weekdays].sort((a, b) => a - b)
  if (d.freq === 'monthly' && d.monthDay) out.monthDay = Math.min(31, Math.max(1, Math.round(Number(d.monthDay))))
  emit('update:modelValue', out)
}

function clearRule() {
  emit('update:modelValue', undefined)
}

function toggleWeekday(day: number) {
  const cur = draft.value.weekdays ?? []
  const next = cur.includes(day) ? cur.filter(x => x !== day) : [...cur, day]
  draft.value.weekdays = next.sort((a, b) => a - b)
  push()
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]

const intervalInput = (e: Event) => {
  draft.value.interval = Math.round(Number((e.target as HTMLInputElement).value)) || 1
  push()
}

const monthDayInput = (e: Event) => {
  const v = Math.round(Number((e.target as HTMLInputElement).value))
  draft.value.monthDay = Number.isFinite(v) && v >= 1 && v <= 31 ? v : undefined
  push()
}
</script>

<template>
  <UiDropdown
      align="center"
      :close-on-select="false"
      :aria-label="t('todo.recurrence')"
      panel-class="glass-card w-72 rounded-2xl p-3 shadow-float"
  >
    <template #trigger="{ open }">
      <button
          type="button"
          class="flex h-9 w-full cursor-pointer items-center justify-between gap-2 whitespace-nowrap rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm transition-colors duration-300 ease-soft focus:border-gold focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-50"
          :class="open ? 'border-gold' : ''"
          :disabled="disabled"
          v-tip="summary"
      >
        <span class="flex min-w-0 items-center gap-2">
          <svg class="h-4 w-4 shrink-0" :class="active ? 'text-gold' : 'text-ink-faint'" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 2l4 4-4 4" />
            <path d="M3 11v-1a4 4 0 014-4h14" />
            <path d="M7 22l-4-4 4-4" />
            <path d="M21 13v1a4 4 0 01-4 4H3" />
          </svg>
          <span class="truncate" :class="active ? 'text-ink' : 'text-ink-faint'">{{ summary }}</span>
        </span>
        <svg v-if="active" class="h-3.5 w-3.5 shrink-0 text-ink-faint hover:text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" @click.stop="clearRule" v-tip="t('todo.rec_none')">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </template>

    <template #default>
      <div class="space-y-3" data-dd-keep-open>
        <!-- 频率 -->
        <div>
          <p class="mb-1.5 text-xs text-ink-faint">{{ t('todo.rec_freq') }}</p>
          <div class="grid grid-cols-4 gap-1.5">
            <button
                v-for="f in FREQS"
                :key="f"
                type="button"
                class="rounded-lg border border-accent px-2 py-1.5 text-xs transition-colors hover:bg-secondary"
                :class="draft.freq === f ? 'border-gold bg-gold/15 font-semibold text-gold' : 'text-ink-soft'"
                @click="draft.freq = f; push()"
            >
              {{ freqLabel(f) }}
            </button>
          </div>
        </div>

        <!-- 间隔：每 N 天/周/月/年 -->
        <div class="flex items-center gap-2">
          <span class="whitespace-nowrap text-xs text-ink-faint">{{ t('todo.rec_interval') }}</span>
          <span class="whitespace-nowrap text-xs text-ink-soft">{{ t('todo.rec_every') }}</span>
          <input
              type="number" min="1" max="999"
              :value="draft.interval"
              class="w-16 rounded-lg border border-accent bg-surface-field px-2 py-1 text-center text-sm tabular-nums text-ink focus:border-gold focus:outline-hidden"
              @change="intervalInput"
          />
          <span class="whitespace-nowrap text-xs text-ink-soft">{{ freqLabel(draft.freq) }}</span>
        </div>

        <!-- 周几（仅每周） -->
        <div v-if="draft.freq === 'weekly'">
          <p class="mb-1.5 text-xs text-ink-faint">{{ t('todo.rec_weekdays') }}</p>
          <div class="grid grid-cols-7 gap-1">
            <button
                v-for="d in WEEKDAYS"
                :key="d"
                type="button"
                class="rounded-md py-1 text-xs transition-colors"
                :class="(draft.weekdays ?? []).includes(d) ? 'bg-gold text-white' : 'border border-accent text-ink-soft hover:bg-secondary'"
                @click="toggleWeekday(d)"
            >
              {{ t(`todo.day_${d}`) }}
            </button>
          </div>
        </div>

        <!-- 几号（仅每月） -->
        <div v-if="draft.freq === 'monthly'" class="flex items-center gap-2">
          <span class="whitespace-nowrap text-xs text-ink-faint">{{ t('todo.rec_month_day') }}</span>
          <input
              type="number" min="1" max="31"
              :value="draft.monthDay ?? ''"
              :placeholder="t('todo.rec_month_day_hint')"
              class="w-20 rounded-lg border border-accent bg-surface-field px-2 py-1 text-center text-sm tabular-nums text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
              @change="monthDayInput"
          />
        </div>

        <!-- 下一期起算基准 -->
        <div>
          <p class="mb-1.5 text-xs text-ink-faint">{{ t('todo.rec_from') }}</p>
          <div class="space-y-1">
            <button
                type="button"
                class="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary"
                :class="draft.from === 'due' ? 'bg-gold/15 text-gold' : 'text-ink-soft'"
                @click="draft.from = 'due'; push()"
            >
              <span class="mt-0.5 h-2 w-2 shrink-0 rounded-full border" :class="draft.from === 'due' ? 'border-gold bg-gold' : 'border-line'" />
              <span>
                <span class="block">{{ t('todo.rec_from_due') }}</span>
                <span class="block text-[10px] text-ink-faint">{{ t('todo.rec_from_due_hint') }}</span>
              </span>
            </button>
            <button
                type="button"
                class="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-secondary"
                :class="draft.from === 'complete' ? 'bg-gold/15 text-gold' : 'text-ink-soft'"
                @click="draft.from = 'complete'; push()"
            >
              <span class="mt-0.5 h-2 w-2 shrink-0 rounded-full border" :class="draft.from === 'complete' ? 'border-gold bg-gold' : 'border-line'" />
              <span>
                <span class="block">{{ t('todo.rec_from_complete') }}</span>
                <span class="block text-[10px] text-ink-faint">{{ t('todo.rec_from_complete_hint') }}</span>
              </span>
            </button>
          </div>
        </div>

        <!-- 清除循环 -->
        <button
            v-if="active"
            type="button"
            class="w-full rounded-lg border border-accent px-2 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10"
            @click="clearRule"
        >
          {{ t('todo.rec_none') }}
        </button>
      </div>
    </template>
  </UiDropdown>
</template>
