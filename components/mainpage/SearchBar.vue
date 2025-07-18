<script setup lang="ts">
import {showSearch} from "~/src/commands/local/SearchCommand";

function closeSearch() {
  showSearch.value = false;
}
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
            type="text"
            placeholder="搜索内容..."
            class="input input-ghost w-full focus:outline-none bg-transparent"
        />
        <button
            type="button"
            class="btn btn-ghost btn-sm p-0 ml-2"
            @click="closeSearch"
            aria-label="关闭搜索框"
        >
          <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  </transition>

</template>

<style>
.slide-from-top-enter-active,
.slide-from-top-leave-active {
  transition: transform 1s ease, opacity 1s ease;
}
.slide-from-top-enter-from {
  transform: translateY(-100%);
  opacity: 0;
}
.slide-from-top-enter-to {
  transform:  translateY(0);
  opacity: 1;
}
.slide-from-top-leave-from {
  transform: translateY(0);
  opacity: 1;
}
.slide-from-top-leave-to {
  transform:translateY(-100%);
  opacity: 0;
}
</style>