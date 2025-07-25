import type { Command } from '../Command';

export const selectedRowIndex = ref(0);
export const dataLength = ref(0);

export class ArrowUpTargetMovementCommand implements Command {
    async execute(): Promise<void> {
        const newIndex = selectedRowIndex.value - 1;
        if (newIndex >= 0) {
            selectedRowIndex.value = newIndex;
            await scrollToSelectedRow();
        }
    }
}

export class ArrowDownTargetMovementCommand implements Command {
    async execute(): Promise<void> {
        console.log(123)
        const newIndex = selectedRowIndex.value + 1;
        if (newIndex < dataLength.value) {
            selectedRowIndex.value = newIndex;
            await scrollToSelectedRow();
        }
    }
}

export function selectRow(index: number) {
    if (index >= 0 && index < dataLength.value) {
        selectedRowIndex.value = index;
        scrollToSelectedRow();
    }
}

async function scrollToSelectedRow() {
    await nextTick();
    const listElement = document.querySelector('.list');
    const listItems = listElement?.querySelectorAll('.list-row');
    const currentItem = listItems?.[selectedRowIndex.value];
    currentItem?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function getSelectedRowIndex(){
    return selectedRowIndex.value;
}