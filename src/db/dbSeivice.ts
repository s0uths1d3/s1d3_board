import Database from "@tauri-apps/plugin-sql";
import type { ClipboardData } from "../ClipboardData";

const dbPromise = Database.load("sqlite:s1de_board.db");

export async function fetchClipboardData(filter:any): Promise<ClipboardData[]> {
    const favorite:number = filter.value.favorite
    const content:string = filter.value.searchContent
    const db = await dbPromise;
    let sql= `SELECT * FROM clipboard WHERE content like '%${content}%' ORDER BY last_use DESC LIMIT 100`
    if (favorite===1)
        sql = `SELECT * FROM clipboard WHERE is_favorite = ${favorite} and content like '%${content}%' ORDER BY last_use DESC LIMIT 100`
    return await db.select(sql) as ClipboardData[]
}

export async function updateFavorite(id: number, value: number): Promise<void> {
    const db = await dbPromise;
    await db.execute("UPDATE clipboard SET is_favorite = $2 WHERE id = $1", [id, value]);
}

export async function increaseUseCount(id: number): Promise<void> {
    const db = await dbPromise;
    const now = Math.floor(Date.now());
    await db.execute("UPDATE clipboard SET count = count + 1, last_use = $2 WHERE id = $1", [id, now]);
}

export async function deleteClipboardData(id: number): Promise<void> {
    const db = await dbPromise;
    await db.execute("DELETE FROM clipboard WHERE id = $1", [id]);
}

export async function searchClipboardData(query: string): Promise<ClipboardData[]> {
    const db = await dbPromise;
    const result = await db.select("SELECT * FROM clipboard WHERE content LIKE $1 ORDER BY last_use DESC LIMIT 100", [`%${query}%`]);
    return result as ClipboardData[];
}