<script setup lang="ts">
import {ref} from 'vue';
import {shortcuts} from "~/src/commands/shortcuts/InitShortcuts";
import {getOsTypeFromNavigator} from "~/src/utils/SystemOS";

const osTye = ref('')

interface SettingItem {
  label: string;
  value: string;
  type: 'input' | 'select' | 'checkbox';
}

interface SettingGroup {
  title: string;
  items: SettingItem[];
}

const settings:SettingGroup[] = [
  {
    title: '快捷键设置',
    items: shortcuts.map(shortcut => ({label: shortcut.title, value: controlDisplayText(shortcut.key), type: 'input'})),
  },
  {
    title: 'Api设置',
    items: [
      {
        label: 'API key',
        value: 'b06b8bd1-8511-4d61-9752-7863f523ddb3',
        type: 'input'
      }
    ]
  },
  {
    title: '通用设置',
    items: [
      {
        label: '最大查询数量',
        value: '500',
        type: 'input'
      },
      {
        label: '配色',
        value: '深色',
        type: 'select'
      }
    ]
  }
];

const activeSetting = ref(settings[0]);

onMounted(async () => {
  osTye.value = getOsTypeFromNavigator()
})

function controlDisplayText(key: string): any {
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
            <li class="p-4 pb-2 text-xs opacity-60 tracking-wide">{{ activeSetting.title + '\t暂时不支持修改' }}</li>
            <li v-for="(item, itemIndex) in activeSetting.items" :key="itemIndex"
                class="list-row flex justify-between items-center p-4">
              <div>
                <div>{{ item.label }}</div>
              </div>
              <div>
                <input v-if="item.type === 'input'" type="text" :placeholder="item.value"
                       class="input input-neutral w-fit"/>

                <select v-if="item.type === 'select'" class="select">
                      <option>{{item.value}}</option>
                </select>
              </div>
            </li>
            <li>
              <button class="btn btn-ghost btn-block ">
                {{ '应用' }}
              </button>
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
