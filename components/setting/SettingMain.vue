<script setup lang="ts">
import {ref} from 'vue';
import {shortcuts} from "~/src/commands/shortcuts/InitShortcuts";
import {getOsTypeFromNavigator} from "~/src/utils/SystemOS";

const osTye =ref('')

const settings = [
  {
    title: '快捷键设置',
    items: shortcuts.map(shortcut => ({label: shortcut.title, value: controlDisplayText(shortcut.key)}))
  },
  {
    title: 'Api设置',
    items:[
      {
        label: 'API key',
        value: 'b06b8bd1-8511-4d61-9752-7863f523ddb3'
      }
    ]
  }
];

const activeSetting = ref(settings[0]);

onMounted(async () => {
 osTye.value = getOsTypeFromNavigator()
})

function controlDisplayText(key:string):any{
    let modifiedKey = key;
    if (modifiedKey.includes('Or')) {
      if (osTye.value === 'Darwin') {
        console.log(1)
        return modifiedKey.replace('CommandOrControl', 'Command');
      } else {
        return modifiedKey.replace('CommandOrControl', 'Control');
      }
    }
  return key;
}


</script>

<template>
  <div class="container mx-auto p-4">
    <div class="flex">
      <div class="w-1/5 pr-4">
        <div v-for="(setting, index) in settings" :key="index" class="mb-2">
          <button
              class="btn btn-ghost btn-block"
              :class="{ 'btn-active': activeSetting === setting }"
              @click="activeSetting = setting"
          >
            {{ setting.title }}
          </button>
        </div>
      </div>
      <div class="w-4/5">
        <div v-if="activeSetting">
          <ul class="list bg-base-100 rounded-box shadow-md">
            <li class="p-4 pb-2 text-xs opacity-60 tracking-wide">{{ activeSetting.title + '\t暂时不支持修改快捷键' }}</li>
            <li v-for="(item, itemIndex) in activeSetting.items" :key="itemIndex" class="list-row flex justify-between items-center p-4">
              <div>
                <div>{{ item.label }}</div>
              </div>
              <div>
                <input type="text" :placeholder="item.value" class="input input-neutral w-fit" />
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.btn-active {
  background-color: #e0e0e0;
}
</style>
