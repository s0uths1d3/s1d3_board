import type { ClipboardData,Note,Todo,PinnedClip,ClipScheme } from "../entities";
import { appConnection } from "../core/db/appConnection";
import { runDatabaseMigrations } from "../core/db/migrator";
import { createSettingsRepository, type SettingsRepository } from "../core/db/repositories/settingsRepository";
import { createClipboardRepository, type ClipboardRepository } from "../core/db/repositories/clipboardRepository";
import { createPinnedClipRepository, type PinnedClipRepository } from "../core/db/repositories/pinnedClipRepository";
import { createTodoRepository, type TodoRepository } from "../core/db/repositories/todoRepository";
import { createNoteRepository, type NoteRepository } from "../core/db/repositories/noteRepository";
import { createSchemeRepository, type SchemeRepository } from "../core/db/repositories/schemeRepository";
import { createIslandHistoryRepository, type IslandHistoryRepository } from "../core/db/repositories/islandHistoryRepository";
import { createBackupRepository, type BackupRepository } from "../core/db/repositories/backupRepository";
import type { PageQuery } from "../core/db/sql";
import statsService from "~/src/statistics/statsService";
import { startClipboardListener, suppressUseCountBump } from "../clipboard/clipboardListener";

/**
 * 数据库服务门面：
 * 领域逻辑已拆分至 core/db/repositories/*（每领域一个仓储）与 core/db/migrator.ts，
 * 本文件只做**兼容门面**——对外公有方法签名逐一保留（27+ 处调用方零改动），内部一行委托；
 * 事件派发（island:copy 双派发去重 / smart-clip:copy 仅文本 / clipboard:changed）、
 * SQL（ON CONFLICT upsert、imgfile: 解析、500/批裁剪、NOT EXISTS 守卫、
 * source_app/qr_text 仅 INSERT 写入、islandImageContent 尾参）等隐式行为在仓储内逐字平移。
 */
export type { PageQuery } from "../core/db/sql";

class DatabaseService {
    private static instance: DatabaseService;
    private readonly settings: SettingsRepository;
    private readonly clipboard: ClipboardRepository;
    private readonly pinnedClip: PinnedClipRepository;
    private readonly todo: TodoRepository;
    private readonly note: NoteRepository;
    private readonly scheme: SchemeRepository;
    private readonly islandHistory: IslandHistoryRepository;
    private readonly backup: BackupRepository;

    private constructor() {
        // 仓储装配（组合根）：统一走 appConnection 单例（WAL/busy_timeout/quick_check/execWithRetry）；
        // 统计埋点与统计清空注入 statsService（服务层），设置 KV 注入设置仓储——仓储不反向依赖服务实现
        this.settings = createSettingsRepository({ conn: appConnection });
        this.clipboard = createClipboardRepository({
            conn: appConnection,
            getKeyValue: (key) => this.settings.getKeyValue(key),
            recordStats: (partial) => statsService.record(partial),
        });
        this.pinnedClip = createPinnedClipRepository({ conn: appConnection });
        this.todo = createTodoRepository({ conn: appConnection, recordStats: (partial) => statsService.record(partial) });
        this.note = createNoteRepository({ conn: appConnection, recordStats: (partial) => statsService.record(partial) });
        this.scheme = createSchemeRepository({ conn: appConnection });
        this.islandHistory = createIslandHistoryRepository({ conn: appConnection });
        this.backup = createBackupRepository({ conn: appConnection });
    }

    public static getInstance(): DatabaseService {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }

    public async ensureDbInitialized() {
        await runDatabaseMigrations(appConnection);
    }

    /**
     * 启动剪贴板监听：监听管道职责归 clipboard 模块
     * （app/src/clipboard/clipboardListener.ts，经 modules/clipboard.module 的 start 调用）；
     * 门面保留方法签名转发，兼容直接调用方。
     */
    public async startClipboardListener() {
        await startClipboardListener();
    }

    /** 标记"即将由本应用粘贴流程写剪贴板"：与 suppressIslandCopy 同源时序，写入前调用 */
    public suppressUseCountBump(ms = 1200): void {
        suppressUseCountBump(ms);
    }

    public async decodeQrText(id: number, content: string): Promise<string | null> {
        return this.clipboard.decodeQrText(id, content);
    }

    public async fetchClipboardData(filter: any, page?: PageQuery): Promise<ClipboardData[]> {
        await this.ensureDbInitialized();
        return this.clipboard.fetchClipboardData(filter, page);
    }

    public async fetchClipboardSingleData(id: number): Promise<ClipboardData | undefined> {
        await this.ensureDbInitialized();
        return this.clipboard.fetchClipboardSingleData(id);
    }

    public async updateFavorite(id: number, value: number): Promise<void> {
        await this.ensureDbInitialized();
        return this.clipboard.updateFavorite(id, value);
    }

    public async increaseUseCount(id: number): Promise<void> {
        await this.ensureDbInitialized();
        return this.clipboard.increaseUseCount(id);
    }

    public async increaseUseCountByContent(content: string): Promise<void> {
        await this.ensureDbInitialized();
        return this.clipboard.increaseUseCountByContent(content);
    }

    public async deleteClipboardData(id: number): Promise<void> {
        await this.ensureDbInitialized();
        return this.clipboard.deleteClipboardData(id);
    }

    // ===== 常用剪贴（pinned_clip）=====

    public async fetchPinnedClips(page?: PageQuery): Promise<PinnedClip[]> {
        await this.ensureDbInitialized();
        return this.pinnedClip.fetchPinnedClips(page);
    }

    public async fetchPinnedClip(id: number): Promise<PinnedClip | undefined> {
        await this.ensureDbInitialized();
        return this.pinnedClip.fetchPinnedClip(id);
    }

    public async insertPinnedClip(content: string, type: 'text' | 'image', name?: string, source?: string): Promise<void> {
        await this.ensureDbInitialized();
        return this.pinnedClip.insertPinnedClip(content, type, name, source);
    }

    public async isPinnedContentExist(content: string, type: 'text' | 'image'): Promise<boolean> {
        await this.ensureDbInitialized();
        return this.pinnedClip.isPinnedContentExist(content, type);
    }

    public async updatePinnedClip(id: number, content: string, name: string, type: 'text' | 'image'): Promise<void> {
        await this.ensureDbInitialized();
        return this.pinnedClip.updatePinnedClip(id, content, name, type);
    }

    public async pinPinnedClip(id: number, pinned: boolean): Promise<void> {
        await this.ensureDbInitialized();
        return this.pinnedClip.pinPinnedClip(id, pinned);
    }

    public async deletePinnedClip(id: number): Promise<void> {
        await this.ensureDbInitialized();
        return this.pinnedClip.deletePinnedClip(id);
    }

    /**
     * 清空业务数据（剪贴板 / 便签 / 待办）与统计数据（daily_stat），
     * 保留配置表（settings、shortcut_binding）与常用剪贴（pinned_clip）。
     * 统计清空钩子注入备份仓储，保持原调用顺序（业务表 → 统计 → 自增计数重置）。
     */
    public async clearDatabase(): Promise<void> {
        await this.ensureDbInitialized();
        return this.backup.clearDatabase(() => statsService.clearAll());
    }

    public async undoClearDatabase(): Promise<boolean> {
        await this.ensureDbInitialized();
        return this.backup.undoClearDatabase();
    }

    public async finalizeClear(): Promise<void> {
        await this.ensureDbInitialized();
        return this.backup.finalizeClear();
    }

    /**
     * 保存单个快捷键到 shortcut_binding 规范化表（按 shortcut_id upsert）
     */
    public async saveShortcutSetting(id: string, value: string, scope: string, title: string): Promise<void> {
        await this.ensureDbInitialized();
        return this.settings.saveShortcutSetting(id, value, scope, title);
    }

    /** 加载已保存的快捷键配置（返回 { id, value }[]） */
    public async loadShortcutSettings(): Promise<{ id: string; value: string }[]> {
        await this.ensureDbInitialized();
        return this.settings.loadShortcutSettings();
    }

    public async setKeyValue(key : string,value: string): Promise<void> {
        await this.ensureDbInitialized();
        return this.settings.setKeyValue(key, value);
    }

    public async getKeyValue(key:string): Promise<string> {
        await this.ensureDbInitialized();
        return this.settings.getKeyValue(key);
    }

    // ===================== 智能剪贴板：方案（smart-clip，设计文档 §4.3） =====================

    public async fetchClipSchemes(): Promise<ClipScheme[]> {
        await this.ensureDbInitialized();
        return this.scheme.fetchClipSchemes();
    }

    public async saveClipScheme(scheme: ClipScheme): Promise<void> {
        await this.ensureDbInitialized();
        return this.scheme.saveClipScheme(scheme);
    }

    public async deleteClipScheme(id: string): Promise<void> {
        await this.ensureDbInitialized();
        return this.scheme.deleteClipScheme(id);
    }

    // ===================== 智能剪贴板：用户习惯记录 + AI 结果冷却缓存 =====================

    public async insertClipHabit(h: {
        contentHash: string;
        extractorId: string;
        action: 'paste' | 'pin';
        segmentText: string;
    }): Promise<void> {
        await this.ensureDbInitialized();
        return this.scheme.insertClipHabit(h);
    }

    /** 灵动岛历史：全部弹岛来源（复制/粘贴/AI/设置操作/第三方 API）汇聚写入，FIFO 保留最近 500 条 */
    public async insertIslandHistory(h: { kind: string; text: string }): Promise<void> {
        await this.ensureDbInitialized();
        return this.islandHistory.insertIslandHistory(h);
    }

    /** 灵动岛历史查询（GET /api/history 的数据源）：按时间倒序（最新在前） */
    public async getIslandHistory(
        limit = 500,
        filter?: { kind?: string; from?: number; to?: number },
    ): Promise<Array<{ id: number; kind: string; text: string; createdAt: number }>> {
        await this.ensureDbInitialized();
        return this.islandHistory.getIslandHistory(limit, filter);
    }

    /** 清空灵动岛历史 */
    public async clearIslandHistory(): Promise<void> {
        await this.ensureDbInitialized();
        return this.islandHistory.clearIslandHistory();
    }

    /** 偏好摘要：最近 100 次 paste 中，各提取器产出被粘贴的次数（降序 Top5） */
    public async fetchHabitDigest(): Promise<Array<{ extractorId: string; count: number }>> {
        await this.ensureDbInitialized();
        return this.scheme.fetchHabitDigest();
    }

    /** 读取 AI 结果缓存：窗口期内命中返回输出，过期/不存在返回 null（windowSec = 0 表示每次重新生成） */
    public async getAiCache(key: string, windowSec: number): Promise<string | null> {
        await this.ensureDbInitialized();
        return this.scheme.getAiCache(key, windowSec);
    }

    /** 写入/刷新 AI 结果缓存 */
    public async setAiCache(key: string, output: string): Promise<void> {
        await this.ensureDbInitialized();
        return this.scheme.setAiCache(key, output);
    }

    public async insertNote(note: Note): Promise<void> {
        await this.ensureDbInitialized();
        return this.note.insertNote(note);
    }

    public async updateNote(note: Note): Promise<void> {
        await this.ensureDbInitialized();
        return this.note.updateNote(note);
    }

    public async deleteNote(noteId: string): Promise<void> {
        await this.ensureDbInitialized();
        return this.note.deleteNote(noteId);
    }

    public async fetchNotes(filter: any, page?: PageQuery): Promise<Note[]> {
        await this.ensureDbInitialized();
        return this.note.fetchNotes(filter, page);
    }

    public async fetchSingleNote(noteId: string): Promise<Note | undefined> {
        await this.ensureDbInitialized();
        return this.note.fetchSingleNote(noteId);
    }

    public async insertTodo(todo: Todo): Promise<void> {
        await this.ensureDbInitialized();
        return this.todo.insertTodo(todo);
    }

    public async updateTodo(todo: Todo): Promise<void> {
        await this.ensureDbInitialized();
        return this.todo.updateTodo(todo);
    }

    public async deleteTodo(todoId: string): Promise<void> {
        await this.ensureDbInitialized();
        return this.todo.deleteTodo(todoId);
    }

    public async fetchTodos(filter: any, page?: PageQuery): Promise<Todo[]> {
        await this.ensureDbInitialized();
        return this.todo.fetchTodos(filter, page);
    }

    public async fetchSingleTodo(todoId: string): Promise<Todo | undefined> {
        await this.ensureDbInitialized();
        return this.todo.fetchSingleTodo(todoId);
    }
}

const clipboardService = DatabaseService.getInstance();

export default clipboardService
