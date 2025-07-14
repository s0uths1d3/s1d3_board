// src/db/init.ts
import Database from '@tauri-apps/plugin-sql';

import {TrayIcon} from '@tauri-apps/api/tray';
import {Menu} from '@tauri-apps/api/menu';
import {getCurrentWindow} from "@tauri-apps/api/window";

const dbName = 'sqlite:s1de_board.db';
export let db: Database;

export default defineNuxtPlugin(async (nuxtApp) => {
    try {
        const menu = await Menu.new({
            items: [
                {
                    id: 'quit',
                    text: 'Quit',
                    action: async () => {
                        await getCurrentWindow().close();
                    }
                },
            ],
        });

        const options = {
            menu,
            menuOnLeftClick: true,
            title: 's1de board',
            icon: '../assets/icon/icon_64x64.ico'
        };
        await TrayIcon.new(options);
        await getCurrentWindow().setIcon('../assets/icon/icon.png')
        await createDB();
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Error initializing database:', error);
    }
});

async function createDB() {
    db = await Database.load(dbName);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS clipboard
        (
            id
            INTEGER
            PRIMARY
            KEY
            AUTOINCREMENT,
            content
            TEXT
            NOT
            NULL
            UNIQUE,
            create_time
            TEXT,
            source
            TEXT,
            is_favorite
            INTEGER
            DEFAULT
            0
            CHECK (
            is_favorite
            IN
        (
            0,
            1
        )),
            category TEXT,
            count INTEGER DEFAULT 1,
            last_use TEXT
            );
    `);
    await db.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_fts USING fts5
    (
        content,
        content=clipboard,
        content_rowid=id
    );
  `);

    await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_timestamp ON clipboard (create_time DESC);
    `);

    await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_source ON clipboard (source);
    `);

    await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_favorite ON clipboard (is_favorite);
    `);

    await db.execute(`
    CREATE TRIGGER IF NOT EXISTS clipboard_after_insert
        AFTER INSERT ON clipboard
    BEGIN
        INSERT INTO clipboard_fts (rowid, content) VALUES (new.id, new.content);
    END;
  `);

    await db.execute(`
    CREATE TRIGGER IF NOT EXISTS clipboard_after_update
        AFTER UPDATE ON clipboard
    BEGIN
        UPDATE clipboard_fts SET content = new.content WHERE rowid = old.id;
    END;
  `);

    await db.execute(`
    CREATE TRIGGER IF NOT EXISTS clipboard_after_delete
        AFTER DELETE ON clipboard
    BEGIN
        DELETE FROM clipboard_fts WHERE rowid = old.id;
    END;  
  `);
}
