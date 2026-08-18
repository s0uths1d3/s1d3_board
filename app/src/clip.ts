// import { onTextUpdate, startListening } from 'tauri-plugin-clipboard-api';
//
// import type { ClipboardData } from "~/src/ClipboardData";
// import Database from "@tauri-apps/plugin-sql";
// import {appDataDir} from "@tauri-apps/api/path";
//
// let data = ref<ClipboardData[]>([]);
// export async function addDate() {
//     const dbPath = await appDataDir() + 's1de_board.db';
//     let db = await Database.load(`sqlite:${dbPath}`);
//     await onTextUpdate(async (newText) => {
//         const now = Math.floor(Date.now())
//         console.log(`now is ${new Date(now).toLocaleString()}`)
//         // const processedText = newText.replace(/\n/g, '<(b<>r)>');
//         let existingRecord;
//         existingRecord = await db?.select(
//             "SELECT id FROM clipboard WHERE content = $1",
//             [newText]
//         );
//         data.value = existingRecord as ClipboardData[];
//         if (data.value.length === 0) {
//             const result = await db?.execute(
//                 "INSERT INTO clipboard (content, category, create_time,last_use) VALUES ($1, $2, $3,$4)",
//                 [newText, 'T', now,now]
//             );
//             console.log("New record inserted:", result);
//         } else {
//             const result = await db?.execute(
//                 "UPDATE clipboard SET count = count + 1, last_use = $2 WHERE id = $1",
//                 [data.value[0].id, now]
//             );
//             console.log("Count incremented:", result);
//         }
//     });
//
//     await startListening();
// }
