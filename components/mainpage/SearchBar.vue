<script setup lang="ts">
import { ref } from 'vue';
import { showSearch } from "~/src/commands/local/SearchCommand";
import { debounce } from "perfect-debounce";

const emit = defineEmits<{
  (e: 'update:search', content: string): void;
  (e: 'update:highlight', value: boolean): void;
}>();

function closeSearch() {
  showSearch.value = false;
}

const searchContent = ref('')

const debouncedSearch = debounce(() => {
  emit('update:search', searchContent.value);
}, 300)

function clearSearchBox() {
  searchContent.value = ''
  emit('update:search', searchContent.value);
}

const props = defineProps({
  highlight: Boolean,
  search: String, // 添加search prop 来接收更新的search值
});

const setHighlightState = () => {
  emit('update:highlight', !props.highlight);
};
</script>

<template>
  <div
      v-if="showSearch"
      class="fixed inset-0 z-40 bg-transparent"
      @click="closeSearch"
  ></div>

  <transition name="slide-from-top" mode="out-in">
    <div
        v-if="showSearch"
        key="searchbox"
        class="fixed left-1/2 top-6 transform -translate-x-1/2 z-50 w-full max-w-xl px-4"
        @click.stop
    >
      <div
          class="bg-base-200 text-base-content shadow-lg rounded-xl p-3 flex items-center gap-2"
      >
        <svg
            class="h-5 w-5 opacity-60"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
        >
          <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.5 4.5a7.5 7.5 0 0012.15 12.15z"
          />
        </svg>
        <input
            @input="debouncedSearch"
            v-model="searchContent"
            type="text"
            placeholder="搜索内容..."
            class="input input-ghost w-full focus:outline-none bg-transparent"
        />
        <button
            type="button"
            class="btn btn-ghost btn-sm p-0 ml-2"
            @click="setHighlightState"
        >
          <svg v-if="props.highlight" class="h-6 w-6" viewBox="0 0 1024 1024"
               xmlns="http://www.w3.org/2000/svg" p-id="29136">
            <path
                d="M160.6 512c0-19.1-15.5-34.6-34.6-34.6H34.6C15.5 477.4 0 492.9 0 512s15.5 34.6 34.6 34.6H126c19.1 0 34.6-15.5 34.6-34.6z m30.8 273l-65.6 63.8c-13.5 13.4-13.6 35.3-0.1 48.8l0.1 0.1 1.3 0.5c13.4 13.5 35.3 13.6 48.8 0.1l0.1-0.1 64.4-64.4c13.5-13.5 13.5-35.4 0-48.9-13.6-13.4-35.5-13.4-49 0.1z m641.2-546l65.6-63.8c13.5-13.4 13.6-35.3 0.1-48.8l-0.1-0.1-1.3-0.5c-13.4-13.5-35.3-13.6-48.8-0.1l-0.1 0.1-64.4 64.4c-13.5 13.5-13.5 35.4 0 48.9 13.6 13.4 35.5 13.4 49-0.1z m-320.7-78.8h0.3c19.1 0 34.5-15.4 34.5-34.5V34.6C546.6 15.5 531.1 0 512 0s-34.6 15.5-34.6 34.6v91.1c0 19.1 15.4 34.5 34.5 34.5z m-316.7 79c13.4 13.5 35.3 13.6 48.8 0.1l0.1-0.1 0.3 1c13.5-13.4 13.6-35.3 0.1-48.8l-0.1-0.1-62-65.9c-13.2-13.8-35.1-14.3-48.9-1-13.8 13.2-14.3 35.1-1 48.9l62.7 65.9z m633.6 545.6c-13.4-13.5-35.3-13.6-48.8-0.1l-0.1 0.1-0.3-1c-13.5 13.4-13.6 35.3-0.1 48.8l0.1 0.1 62 65.9c13.2 13.8 35.1 14.3 48.9 1 13.8-13.2 14.3-35.1 1-48.9l-62.7-65.9z m160.6-307.4h-91.1c-19.1 0-34.6 15.5-34.6 34.6s15.5 34.6 34.6 34.6h91.1c19.1 0 34.6-15.5 34.6-34.6s-15.5-34.6-34.6-34.6zM511.1 241.1c-149.4 0-270.9 121.5-270.9 270.9s121.5 270.9 270.9 270.9S781.9 661.4 781.9 512 660.4 241.1 511.1 241.1z m0 461.5c-105.3 0-190.6-85.4-190.6-190.6s85.4-190.6 190.6-190.6S701.7 406.7 701.7 512s-85.4 190.6-190.6 190.6z m1 161.2h-0.3c-19.1 0-34.5 15.4-34.5 34.5v91.1c0 19.1 15.5 34.6 34.6 34.6s34.6-15.5 34.6-34.6v-91.1c0.1-19.1-15.3-34.5-34.4-34.5z"
                fill="#040000" p-id="29137"></path>
          </svg>
          <svg v-else class="h-6 w-6" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"
               p-id="32551" width="200" height="200">
            <path
                d="M512 824c-172.313 0-312-139.687-312-312s139.687-312 312-312 312 139.687 312 312-139.687 312-312 312z m0-64c136.967 0 248-111.033 248-248 0-136.967-111.033-248-248-248-136.967 0-248 111.033-248 248 0 136.967 111.033 248 248 248z m0-696c17.673 0 32 14.327 32 32v51c0 17.673-14.327 32-32 32-17.673 0-32-14.327-32-32V96c0-17.673 14.327-32 32-32z m0 785c17.673 0 32 14.327 32 32v51c0 17.673-14.327 32-32 32-17.673 0-32-14.327-32-32v-51c0-17.673 14.327-32 32-32z m325.945-11.055c-12.497 12.496-32.758 12.496-45.255 0l-36.063-36.063c-12.496-12.497-12.496-32.758 0-45.255 12.497-12.496 32.758-12.496 45.255 0l36.063 36.063c12.496 12.497 12.496 32.758 0 45.255z m-568-565c-12.497 12.496-32.758 12.496-45.255 0l-36.063-36.063c-12.496-12.497-12.496-32.758 0-45.255 12.497-12.496 32.758-12.496 45.255 0l36.063 36.063c12.496 12.497 12.496 32.758 0 45.255z m561-81.318c12.496 12.497 12.496 32.758 0 45.255l-36.063 36.063c-12.497 12.496-32.758 12.496-45.255 0-12.496-12.497-12.496-32.758 0-45.255l36.063-36.063c12.497-12.496 32.758-12.496 45.255 0z m-563.572 565c12.496 12.497 12.496 32.758 0 45.255l-36.063 36.063c-12.497 12.496-32.758 12.496-45.255 0-12.496-12.497-12.496-32.758 0-45.255l36.063-36.063c12.497-12.496 32.758-12.496 45.255 0zM960 512c0 17.673-14.327 32-32 32h-51c-17.673 0-32-14.327-32-32 0-17.673 14.327-32 32-32h51c17.673 0 32 14.327 32 32z m-781 0c0 17.673-14.327 32-32 32H96c-17.673 0-32-14.327-32-32 0-17.673 14.327-32 32-32h51c17.673 0 32 14.327 32 32z"
                fill="#D8D8D8" p-id="32552"></path>
          </svg>
        </button>

        <button
            type="button"
            class="btn btn-ghost btn-sm p-0 ml-2"
            @click="clearSearchBox"
        >
          <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.slide-from-top-enter-active,
.slide-from-top-leave-active {
  transition: transform 1s ease, opacity 1s ease;
}

.slide-from-top-enter-from {
  transform: translateY(-100%);
  opacity: 0;
}

.slide-from-top-enter-to {
  transform: translateY(0);
  opacity: 1;
}

.slide-from-top-leave-from {
  transform: translateY(0);
  opacity: 1;
}

.slide-from-top-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
</style>
