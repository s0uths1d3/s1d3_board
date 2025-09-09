import Database from "@tauri-apps/plugin-sql";
import { onTextUpdate, startListening } from 'tauri-plugin-clipboard-api';
import type { ClipboardData } from "../ClipboardData";

class ClipboardService {
    private static instance: ClipboardService;
    private db: Database | undefined;

    private constructor() {}

    public static getInstance(): ClipboardService {
        if (!ClipboardService.instance) {
            ClipboardService.instance = new ClipboardService();
        }
        return ClipboardService.instance;
    }

    private async initDatabase() {
        const dbName = 'sqlite:s1de_board.db';
        this.db = await Database.load(dbName);
    }

    public async ensureDbInitialized() {
        if (!this.db) {
            await this.initDatabase();
        }
    }

    public async startClipboardListener() {
        await this.ensureDbInitialized();

        await onTextUpdate(async (newText) => {
            const now = Math.floor(Date.now());
            // console.log(`now is ${new Date(now).toLocaleString()}`);
            const existingRecord: ClipboardData[] = await this.db!.select(
                "SELECT id FROM clipboard WHERE content = $1",
                [newText]
            );

            if (existingRecord.length === 0) {
                const result = await this.db!.execute(
                    "INSERT INTO clipboard (content, category, create_time, last_use) VALUES ($1, $2, $3, $4) ",
                    [newText, 'T', now, now]
                );
                console.log("New record inserted:", result);
            } else {
                const result = await this.db!.execute(
                    "UPDATE clipboard SET count = count + 1, last_use = $2 WHERE id = $1",
                    [existingRecord[0].id, now]
                );
                console.log("Count incremented:", result);
            }
        });

        await startListening();
        console.log("Clipboard listener started");
    }

    public async fetchClipboardData(filter: any): Promise<ClipboardData[]> {
        await this.ensureDbInitialized();

        const favorite: number = filter.value.favorite;
        const content: string = filter.value.searchContent;

        let sql = `SELECT * FROM clipboard WHERE content like '%${content}%' ORDER BY last_use DESC LIMIT 500`;
        if (favorite === 1) {
            sql = `SELECT * FROM clipboard WHERE is_favorite = ${favorite} and content like '%${content}%' ORDER BY last_use DESC LIMIT 100`;
        }

        return await this.db!.select(sql) as ClipboardData[];
    }

    public async fetchClipboardSingleData(id: number): Promise<ClipboardData> {
        let sql = `SELECT * FROM clipboard WHERE id = ${id}`;
        const data =  await this.db!.select(sql) as ClipboardData[]
        return data[0]
    }

    public async updateFavorite(id: number, value: number): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("UPDATE clipboard SET is_favorite = $2 WHERE id = $1", [id, value]);
    }

    public async increaseUseCount(id: number): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute("UPDATE clipboard SET count = count + 1, last_use = $2 WHERE id = $1", [id, now]);
    }

    public async deleteClipboardData(id: number): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM clipboard WHERE id = $1", [id]);
    }
}

const clipboardService = ClipboardService.getInstance();

export default clipboardService
