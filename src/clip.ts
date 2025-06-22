import { onTextUpdate, startListening } from 'tauri-plugin-clipboard-api';

import type { ClipboardData } from "~/src/ClipboardData";
import Database from "@tauri-apps/plugin-sql";

let data = ref<ClipboardData[]>([]);

export async function addDate() {
    const dbName = 'sqlite:s1de_board.db';
    const db = await Database.load(`${dbName}`);

    const now = Math.floor(Date.now())

    await onTextUpdate(async (newText) => {
        // const processedText = newText.replace(/\n/g, '<(b<>r)>');

        let existingRecord;
        existingRecord = await db?.select(
            "SELECT id FROM clipboard WHERE content = $1",
            [newText]
        );
        data.value = existingRecord as ClipboardData[];
        if (data.value.length === 0) {
            const result = await db?.execute(
                "INSERT INTO clipboard (content, category, create_time) VALUES ($1, $2, $3)",
                [newText, 'T', now]
            );
            console.log("New record inserted:", result);
        } else {
            const result = await db?.execute(
                "UPDATE clipboard SET count = count + 1, last_use = $2 WHERE id = $1",
                [data.value[0].id, now]
            );
            console.log("Count incremented:", result);
        }
    });

    await startListening();
}
