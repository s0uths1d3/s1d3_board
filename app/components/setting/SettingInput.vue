<script setup lang="ts">
/**
 * 设置页文本输入行：modelValue / placeholder / 保存提示各不相同，
 * 从 SettingMain 中两段仅绑定值不同的 <input> 分支收敛而来（改交互基线只动这里）。
 * secret：密码形态（API key 等敏感值）——默认掩码显示，右侧眼睛按钮切换明文。
 */
import { ref } from 'vue';
import { useI18n } from '~/composables/useI18n';

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
  /** 掩码显示：type=password + 明暗切换按钮 */
  secret?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'save'): void;
}>();

const { t } = useI18n();
/** 明文显示状态（仅 secret 形态使用） */
const show = ref(false);

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
}
</script>

<template>
  <!-- secret 形态：掩码 + 眼睛切换（autocomplete=off 防浏览器密码管理器介入） -->
  <div v-if="props.secret" class="relative">
    <input
      :type="show ? 'text' : 'password'"
      :value="modelValue"
      :placeholder="placeholder"
      autocomplete="off"
      spellcheck="false"
      class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 pr-10 text-ink focus:border-gold focus:outline-hidden"
      @input="onInput"
      @blur="emit('save')"
    />
    <!-- 明暗切换：tabindex=-1 不参与焦点序，点击不抢走输入焦点流 -->
    <button
      type="button"
      tabindex="-1"
      class="absolute inset-y-0 right-2 my-auto flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:text-ink"
      :title="show ? t('common.hide') : t('common.show')"
      :aria-label="show ? t('common.hide') : t('common.show')"
      @click="show = !show"
    >
      <!-- eye（明文态，点击切回掩码） -->
      <svg v-if="show" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <!-- eye-off（掩码态，点击显示明文） -->
      <svg v-else class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
        <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
        <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
        <path d="m2 2 20 20" />
      </svg>
    </button>
  </div>
  <!-- 普通文本形态（保持原样式不变） -->
  <input
    v-else
    type="text"
    :value="modelValue"
    :placeholder="placeholder"
    class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-hidden"
    @input="onInput"
    @blur="emit('save')"
  />
</template>
