import { invoke } from "@tauri-apps/api/core";
import { onTextUpdate, onSomethingUpdate, readImageBase64, startListening } from 'tauri-plugin-clipboard-api';
import { bus } from "../core/events";
import { appConnection } from "../core/db/appConnection";
import { runDatabaseMigrations } from "../core/db/migrator";
import { createSettingsRepository } from "../core/db/repositories/settingsRepository";
import { createClipboardRepository, type ClipboardRepository } from "../core/db/repositories/clipboardRepository";
import { prewarmImageCache } from "../core/db/imageRef";
import statsService from "../statistics/statsService";

/**
 * 剪贴板监听管道（自 dbService.startClipboardListener 平移，逻辑不重写）：
 * 文本/图片监听 → 落库（island:copy 双派发去重 / smart-clip:copy 仅文本 / clipboard:changed）→
 * 按上限裁剪。职责归 clipboard 模块（modules/clipboard.module.ts 的 start/stop 调用点）；
 * dbService 门面的同名方法与 suppressUseCountBump 委托至此，保证调用方与抑制语义不变。
 *
 * 仓储实例单例化：suppressUseCountBump 的抑制窗口（useCountSuppressUntil）存活在
 * 仓储闭包内——门面转发与本管道必须命中同一实例，应用自身粘贴才不会双计。
 */

// 组合装配（与原 dbService 构造器一致：appConnection 单例 + 设置仓储 + 统计埋点注入）
const settings = createSettingsRepository({ conn: appConnection });
const repo: ClipboardRepository = createClipboardRepository({
    conn: appConnection,
    getKeyValue: (key) => settings.getKeyValue(key),
    recordStats: (partial) => statsService.record(partial),
});

/** 已注册的监听反挂函数（stop 时反挂；start 前为空） */
const unlisteners: Array<() => void> = [];

/** 标记"即将由本应用粘贴流程写剪贴板"（门面 suppressUseCountBump 的委托目标） */
export function suppressUseCountBump(ms?: number): void {
    repo.suppressUseCountBump(ms);
}

/**
 * 启动剪贴板监听（先确保数据库迁移完成）：
 * 文本/图片更新 → 来源应用查询 → 落库 → 事件派发 → 裁剪。行为逐字保留原实现。
 */
export async function startClipboardListener(): Promise<void> {
    await runDatabaseMigrations(appConnection);

    // 复制瞬间的来源应用：查询当前前台进程名（复制不切换焦点，监听回调触发时前台仍是复制方）。
    // 查询失败不阻断入库（来源留空，UI 不显示）。
    const queryForegroundApp = async (): Promise<string | null> => {
        try {
            return (await invoke<string | null>('foreground_app_name')) ?? null;
        } catch { return null; }
    };

    // 文本更新
    unlisteners.push(await onTextUpdate(async (newText) => {
        try {
            await repo.saveClipboard(newText, 'text', await queryForegroundApp());
            // 写库成功后通知前端列表立即刷新（事件驱动，替代每秒轮询）
            bus.emit('clipboard:changed');
        } catch (err) {
            console.error('保存剪贴板文本失败:', err);
        }
    }));

    // 图片更新：onImageUpdate 在某些平台/格式下回传的是文件路径而非 base64，
    // 改用 onSomethingUpdate 判定类型后主动 readImageBase64() 获取真实数据。
    unlisteners.push(await onSomethingUpdate(async (updated) => {
        if (!updated.image) return;
        try {
            // ===== 快速通道（Windows）：单命令捕获 =====
            // 旧链路 readImageBase64（数 MB IPC）→ save_clipboard_image（数 MB 回传落盘）→
            // clipboard_image_thumb（重复读剪贴板）把原图跨进程搬运 3 次，串行排队是
            // 截图后延迟入列的主因；快速通道剪贴板位图在 Rust 侧读一次，落盘/缩略图/
            // 二维码一并完成，原图只随命令返回一次（预热解析缓存后列表刷新零读盘）。
            // 捕获不可用（非 Windows/剪贴板锁冲突/格式不支持/超限）回退旧链路，行为不劣化。
            const captured = await invoke<{ fileRef: string; thumb: string | null; qrText: string | null; original: string } | null>(
                'clipboard_capture_image', { maxH: 384 },
            ).catch(() => null);
            if (captured?.fileRef && captured.original) {
                prewarmImageCache(captured.fileRef, captured.original);
                // 先派发岛事件（缩略图直显，不等写库）；content 保持原图语义（历史/出站不变），
                // saveClipboard 写库后的二次派发按同内容去重跳过
                bus.emit('island:copy', { content: captured.original, type: 'image', thumb: captured.thumb, qrText: captured.qrText });
                // 落盘已由捕获命令完成，直接存 imgfile: 引用；QR 已扫：无码写 '' 哨兵不再补扫
                await repo.saveClipboard(captured.fileRef, 'image', await queryForegroundApp(), captured.qrText ?? '', captured.original);
                // 写库成功后通知前端列表立即刷新（事件驱动，替代每秒轮询）
                bus.emit('clipboard:changed');
                return;
            }
            // ===== 旧链路（回退） =====
            const base64 = await readImageBase64();
            if (!base64) return;
            // 拼上 data URL 前缀（无前缀时浏览器会把它当相对路径向 dev server 发请求导致 431）
            const dataUrl = base64.startsWith('data:')
                ? base64
                : `data:image/png;base64,${base64}`;
            // 原图落文件（Rust 侧 sha256 内容寻址去重 + 20MB 单条上限）：DB 只存 imgfile: 引用，
            // 原图字节不再进 SQLite。落盘失败/超限返回 null，回退存 dataUrl 兜底（不丢数据）
            let storeContent = dataUrl;
            try {
                const fileRef = await invoke<string | null>('save_clipboard_image', { dataUrl });
                if (fileRef) storeContent = fileRef;
            } catch { /* 落盘不可用：存 dataUrl 兜底 */ }
            // 岛显示级缩略图 + 二维码识别：Rust 侧从剪贴板位图（解码好的像素）直接
            // resize+编码（毫秒级，几十 KB）并顺手扫描 QR——原图（数 MB）整包广播给岛窗口
            // + 全图解码是复杂图片岛显示慢的根因。非 Windows/读取失败返回 null：岛回退原图渲染
            let thumb: string | null = null;
            let qrText: string | null = null;
            let qrScanned = false; // 二维码扫描是否已执行（决定无码时写 '' 哨兵还是留 NULL）
            try {
                const info = await invoke<{ thumb: string | null; qrText: string | null } | null>('clipboard_image_thumb', { maxH: 384 });
                thumb = info?.thumb ?? null;
                qrText = info?.qrText ?? null;
                qrScanned = info !== null;
            } catch { /* 命令不可用：回退 */ }
            if (!qrScanned) {
                // 缩略命令不可用（非 Windows）或剪贴板读取冲突：data URL 纯 Rust 解码兜底二维码
                // 复制路径时序敏感（弹岛延迟敏感）：走单档 512px 快扫；彻底多尺度留给右键判定/懒解码
                try { qrText = (await invoke<string | null>('clipboard_qr_from_data_url', { dataUrl, thorough: false })) ?? null; qrScanned = true; } catch { /* ignore */ }
            }
            // 先派发岛事件（带缩略图/二维码链接，弹岛不等写库），saveClipboard 写库后的二次派发由内容去重跳过
            bus.emit('island:copy', { content: dataUrl, type: 'image', thumb, qrText });
            // 已扫无码写 '' 哨兵（qr_text 非 NULL 不再补扫）；扫描完全不可用留 NULL（列表可见时补解码重试）。
            // 尾参 dataUrl：岛事件语义需要原图（DB 存的是文件引用，见 saveClipboard 注释）
            await repo.saveClipboard(storeContent, 'image', await queryForegroundApp(), qrScanned ? (qrText ?? '') : null, dataUrl);
            // 写库成功后通知前端列表立即刷新（事件驱动，替代每秒轮询）
            bus.emit('clipboard:changed');
        } catch (err) {
            console.error('读取剪贴板图片失败:', err);
        }
    }));

    // 注意：startListening 的 listenTypes 参数会整体覆盖默认值
    // （默认 text/html/rtf/image/files 全开），必须显式传入 text + image，
    // 只传 { image: true } 会关闭文本监听，导致 TEXT_CHANGED 永不触发。
    await startListening({ text: true, image: true });
    console.log("Clipboard listener started");
}

/** 停止监听（模块 stop）：反挂文本/图片监听。startListening 无对应停止 API，保持插件级监听 */
export async function stopClipboardListener(): Promise<void> {
    while (unlisteners.length) {
        const off = unlisteners.pop();
        try { off?.(); } catch { /* 反挂失败不阻断其余收尾 */ }
    }
}
