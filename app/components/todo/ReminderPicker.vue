<script setup lang="ts">
/**
 * 提醒设置选择器（ReminderPicker）
 *
 * 卡片铃铛（variant="icon"）与新增待办表单（variant="field"）共用的提醒配置面板：
 * - 智能（默认）：按任务长短自动分档（长任务 30/10 分钟，短任务 5 分钟）
 * - 自定义：闹钟规则列表，自由增删；每条支持 按百分比 / 提前分钟 / 指定时刻；
 *   规则条数即提醒次数
 * - 不提醒
 * 基于 UiDropdown：面板 Teleport 到 body + fixed 定位、视口收进，交互由组件统一处理。
 */
import { computed, ref } from 'vue'
import UiDropdown from '~/components/ui/UiDropdown.vue'
import UiSegmented from '~/components/ui/UiSegmented.vue'
import DatePicker from '~/components/common/DatePicker.vue'
import type { ReminderRule } from '~/src/entities'

const props = withDefaults(defineProps<{
  /** 提醒模式（v-model:mode） */
  mode: 'smart' | 'off' | 'custom'
  /** 自定义闹钟规则（v-model:rules） */
  rules: ReminderRule[]
  /** 触发器形态：icon = 图标按钮（卡片工具栏），field = 表单胶囊（新增待办行） */
  variant?: 'icon' | 'field'
  /** 是否已设置截止时间（百分比/提前分钟依赖它） */
  hasDue?: boolean
  /** 智能策略摘要（悬停提示用） */
  smartHint?: string
  /** 禁用（逾期/已完成的卡片） */
  disabled?: boolean
}>(), {
  variant: 'icon',
  hasDue: false,
  smartHint: '',
  disabled: false,
})

const emit = defineEmits<{
  (e: 'update:mode', v: 'smart' | 'off' | 'custom'): void
  (e: 'update:rules', v: ReminderRule[]): void
}>()

const MODE_OPTIONS = [
  { value: 'smart', label: '智能', tip: '按任务长短自动提前提醒' },
  { value: 'custom', label: '自定义', tip: '自由添加多个闹钟' },
  { value: 'off', label: '不提醒', tip: '关闭全部提前提醒' },
]

/** 触发器文案（field 形态） */
const fieldLabel = computed(() => {
  if (props.mode === 'off') return '提醒：关'
  if (props.mode === 'custom') return `提醒：${props.rules.length} 个闹钟`
  return '提醒：智能'
})

const iconTip = computed(() => {
  if (props.mode === 'off') return '提醒：已关闭（点击开启）'
  if (props.mode === 'custom') return `提醒：${props.rules.length} 个自定义闹钟（点击修改）`
  return `提醒：智能（${props.smartHint || '按任务长短自动'}）`
})

function setMode(v: string) {
  emit('update:mode', v as 'smart' | 'off' | 'custom')
}

let ruleSeq = Date.now()
function newRuleId() {
  ruleSeq += 1
  return `r${ruleSeq.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`
}

function addRule() {
  const rules = [...props.rules, { id: newRuleId(), kind: 'offset' as const, value: 30 }]
  emit('update:rules', rules)
  if (props.mode !== 'custom') emit('update:mode', 'custom')
}

/**
 * 数值规则输入钳制（与 reminderPolicy 的合法性校验同口径）：
 * percent 1-99、offset 1-10080。此前只钳下限，手输 500 也会提交，
 * 策略端对越界值直接判非法 → 规则永不触发。
 */
function clampRuleValue(kind: ReminderRule['kind'], raw: string): number {
  const n = Math.round(Number(raw) || 1)
  const max = kind === 'percent' ? 99 : 10080
  return Math.min(max, Math.max(1, n))
}

// ===== 「指定时刻」：统一 DatePicker（mode="datetime"）面板，编程控制开关 =====
/** 当前展开指定时刻选择面板的规则下标（null = 全部收起） */
const atPickerIdx = ref<number | null>(null)

function toggleAtPicker(idx: number) {
  atPickerIdx.value = atPickerIdx.value === idx ? null : idx
}

/** 触发按钮文案：MM-DD HH:mm；未选择时给占位提示 */
function formatAtValue(v: string): string {
  return v ? v.replace('T', ' ').slice(5) : '选择时刻'
}

function onAtValue(idx: number, v: string) {
  // 面板的"清空"对指定时刻无意义（空值永不触发），忽略
  if (!v) return
  updateRule(idx, { value: v })
}

function updateRule(idx: number, patch: Partial<ReminderRule>) {
  const cur = props.rules[idx]
  if (!cur) return
  const rules = props.rules.map((r, i) => (i === idx ? ({ ...r, ...patch } as ReminderRule) : r))
  emit('update:rules', rules)
}

function removeRule(idx: number) {
  emit('update:rules', props.rules.filter((_, i) => i !== idx))
}

const RULE_HINT: Record<ReminderRule['kind'], string> = {
  percent: '剩余时长降到该比例时提醒',
  offset: '截止前该时间提醒',
  at: '到该时刻提醒',
}

function ruleSummary(r: ReminderRule): string {
  if (r.kind === 'percent') return `剩余 ${r.value}%`
  if (r.kind === 'offset') return `提前 ${r.value} 分钟`
  return `时刻 ${r.value.replace('T', ' ').slice(5)}`
}

function onKindChange(idx: number, kind: ReminderRule['kind'], cur: ReminderRule) {
  // 切换类型时给一个合理的默认值；同时收起可能展开的时刻选择面板
  atPickerIdx.value = null
  const value = kind === 'percent' ? 25 : kind === 'offset' ? 30 : cur.kind === 'at' ? cur.value : ''
  updateRule(idx, { kind, value } as Partial<ReminderRule>)
}
</script>

<template>
  <UiDropdown
      align="center"
      :close-on-select="false"
      :disabled="disabled"
      aria-label="提醒设置"
      panel-class="glass-card w-72 rounded-2xl p-3 shadow-float"
  >
    <template #trigger>
      <!-- 卡片工具栏：铃铛图标 -->
      <label
          v-if="variant === 'icon'"
          class="btn-soft flex h-8 w-8 cursor-pointer items-center justify-center p-2"
          :class="mode === 'custom' && rules.length > 0 ? 'text-gold' : ''"
          v-tip="iconTip"
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.7V5a2 2 0 10-4 0v.3A6 6 0 006 11v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path>
        </svg>
      </label>
      <!-- 新增表单：胶囊选择框 -->
      <label
          v-else
          class="flex h-10 w-auto max-w-[13rem] cursor-pointer items-center gap-2 whitespace-nowrap rounded-xl border border-accent bg-surface-field px-3 text-sm transition-colors duration-300 ease-soft hover:border-gold"
      >
        <svg class="h-3.5 w-3.5 shrink-0 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.7V5a2 2 0 10-4 0v.3A6 6 0 006 11v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path>
        </svg>
        <span class="truncate text-ink">{{ fieldLabel }}</span>
      </label>
    </template>

    <div class="space-y-2.5">
      <UiSegmented :model-value="mode" :options="MODE_OPTIONS" block label="提醒模式" @update:model-value="setMode" />

      <!-- 智能：零配置说明 -->
      <p v-if="mode === 'smart'" class="px-1 text-xs leading-relaxed text-ink-faint">
        长任务（距截止 ≥ 1 小时）提前 30/10 分钟各提醒一次；短任务提前 5 分钟提醒一次。
      </p>

      <!-- 不提醒 -->
      <p v-else-if="mode === 'off'" class="px-1 text-xs leading-relaxed text-ink-faint">
        已关闭提前提醒（截止时刻的通知保留）。
      </p>

      <!-- 自定义：闹钟规则列表 -->
      <div v-else class="space-y-1.5">
        <p v-if="!hasDue" class="rounded-lg bg-danger/10 px-2 py-1 text-[11px] text-danger">
          未设置截止时间：百分比与提前分钟需要截止时间，仅"指定时刻"可用。
        </p>
        <div
            v-for="(rule, idx) in rules"
            :key="rule.id"
            class="rounded-lg border border-accent/50 p-1.5"
        >
          <div class="flex items-center gap-1.5">
            <select
                :value="rule.kind"
                class="h-7 shrink-0 cursor-pointer rounded-md border border-accent bg-surface-field px-1 text-xs text-ink focus:border-gold focus:outline-none"
                @change="onKindChange(idx, ($event.target as HTMLSelectElement).value as ReminderRule['kind'], rule)"
            >
              <option value="percent">按百分比</option>
              <option value="offset">提前分钟</option>
              <option value="at">指定时刻</option>
            </select>
            <div v-if="rule.kind === 'at'" class="relative min-w-0 flex-1">
              <!-- 触发按钮：展示当前指定时刻，点击打开统一日期时间选择面板 -->
              <button
                  type="button"
                  class="w-full cursor-pointer truncate rounded-md border bg-surface-field px-1.5 py-1 text-left text-xs tabular-nums transition-colors duration-300 ease-soft hover:border-gold focus:outline-none"
                  :class="atPickerIdx === idx ? 'border-gold' : 'border-accent'"
                  @click.stop="toggleAtPicker(idx)"
              >
                <span :class="rule.value ? 'text-ink' : 'text-ink-faint'">{{ formatAtValue(rule.value) }}</span>
              </button>
              <!-- 隐藏的统一 DatePicker：仅作面板容器，由本组件编程控制开关
                   （与 DueTimeSelect 的自定义截止时刻同一模式；datetime 面板 Teleport 到 body，
                   已带 dd-keep-open-panel 标记，不会误触发外层下拉收起） -->
              <DatePicker
                  :model-value="rule.value"
                  mode="datetime"
                  :open="atPickerIdx === idx"
                  :hide-trigger="true"
                  :live-emit="false"
                  class="pointer-events-none absolute inset-0 opacity-0"
                  @update:open="(v: boolean) => { atPickerIdx = v ? idx : null }"
                  @update:model-value="(v: string) => onAtValue(idx, v)"
              />
            </div>
            <template v-else>
              <input
                  type="number"
                  :min="1"
                  :max="rule.kind === 'percent' ? 99 : 10080"
                  :value="rule.value"
                  class="min-w-0 flex-1 rounded-md border border-accent bg-surface-field px-1.5 py-1 text-xs tabular-nums text-ink focus:border-gold focus:outline-none"
                  @change="updateRule(idx, { value: clampRuleValue(rule.kind, ($event.target as HTMLInputElement).value) })"
              />
              <span class="shrink-0 text-xs text-ink-faint">{{ rule.kind === 'percent' ? '%' : '分钟' }}</span>
            </template>
            <button
                type="button"
                v-tip="'删除该闹钟'"
                class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-danger transition-colors hover:bg-danger/10"
                @click="removeRule(idx)"
            >
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p class="mt-0.5 px-1 text-[10px] text-ink-faint">{{ ruleSummary(rule) }} · {{ RULE_HINT[rule.kind] }}</p>
        </div>

        <p v-if="rules.length === 0" class="px-1 py-1.5 text-center text-xs text-ink-faint">
          暂无自定义闹钟，点击下方添加
        </p>

        <div class="flex items-center justify-between border-t border-accent/60 pt-1.5">
          <button
              type="button"
              class="cursor-pointer rounded-lg px-2 py-1 text-xs text-ink-soft transition-colors hover:bg-secondary hover:text-ink"
              @click="addRule"
          >
            + 添加闹钟
          </button>
          <span class="px-1 text-[10px] text-ink-faint">共 {{ rules.length }} 次提醒</span>
        </div>
      </div>
    </div>
  </UiDropdown>
</template>
