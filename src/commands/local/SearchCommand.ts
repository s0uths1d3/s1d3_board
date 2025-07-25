import type { Command } from '~/src/commands/Command';
export const showSearch = ref(false);

export class SearchCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        showSearch.value = !showSearch.value;
        console.log('Search toggled:', showSearch.value);
    }
}
