import Database from "@tauri-apps/plugin-sql";
import type { ClipboardData } from "../ClipboardData";

const dbPromise = Database.load("sqlite:s1de_board.db");

export async function fetchClipboardData(): Promise<ClipboardData[]> {
    const db = await dbPromise;
    const result = await db.select("SELECT * FROM clipboard ORDER BY last_use DESC LIMIT 100");
    return result as ClipboardData[];
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