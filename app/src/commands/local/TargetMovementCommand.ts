import type { Command } from '../Command';
import type {ClipboardData} from "~/src/Entities";
import clipboardService from "~/src/db/dbService";

export const selectedRowIndex = ref(0);
export const dataLength = ref(0);


const data = ref<ClipboardData[]>([]);

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
        scrollToSelectedRow().then(

        );
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

export function getSelectedRowId():number{
    const filter = ref({
        favorite: 0,
        searchContent: ''
    })
    clipboardService.fetchClipboardData(filter).then(res =>{
        data.value = res
    })
    return <number>data.value[getSelectedRowIndex()]?.id
}