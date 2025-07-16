// src/commands/SearchCommand.ts
import type { Command } from '~/src/commands/Command';

// 导出响应式状态，组件可以从这里导入使用
export const showSearch = ref(false);

export class SearchCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        showSearch.value = !showSearch.value;
        console.log('Search toggled:', showSearch.value);
    }
}
