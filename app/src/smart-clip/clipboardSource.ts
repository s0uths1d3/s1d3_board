import { invoke } from '@tauri-apps/api/core';
import { readFiles, readText } from 'tauri-plugin-clipboard-api';
import dbService from '../db/dbService';

/**
 * Ctrl+B 内容源（设计文档 .docs/ctrl-b-refactor-design.md §5.1 / §24）：
 *
 * 主窗口可见时，优先分析「当前选中的列表条目」（用户显式指定的对象）；
 * 窗口不可见时只读当前系统剪贴板，绝不使用可能已过期的选中项，也不回退任何历史解析结果。
 */

/** 取选中条目作为分析内容：仅文本/富文本、非空内容才采用（图片/文件返回 null 走剪贴板） */
export function pickSelectedRingContent(
    item?: { type?: string; content: string },
): string | null {
    if (!item) return null;
    const type = item.type ?? 'text';
    if (type !== 'text' && type !== 'html') return null;
    const content = item.content ?? '';
    return content.trim() ? content : null;
}

/** 图片二维码的新鲜度窗口：剪贴板监听在变更后 ~100ms 内落库，超出视为历史图片不采用 */
const QR_FRESH_MS = 10_000;

export type ClipSource =
    | { kind: 'text'; content: string; origin: 'text' | 'image-qr' }
    | { kind: 'empty' }
    | { kind: 'unsupported'; reason: 'files' | 'image' }
    | { kind: 'error'; error: unknown };

/** 读取重试：Windows 下剪贴板可能被其他进程（含本应用的位图轮询）短暂占用，单次失败不代表读不到 */
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 40;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 「剪贴板没有该格式」不是读取故障：Win32 ERROR_NOT_FOUND=1168，
 * 底层 clipboard-rs 以 "Get text error, code = 1168" 抛出。
 * 这类错误按「无文本」继续下探图片 / 文件 / 空，而不是直接报读取失败。
 */
function isFormatMissing(err: unknown): boolean {
    const msg = String(err ?? '');
    return /code\s*=\s*1168\b/.test(msg) || /not available|no .*format/i.test(msg);
}

/** 读取错误转人话：把 Win32 错误码翻成用户能理解的原因，其余原样保留 */
export function describeClipboardReadError(err: unknown): string {
    const msg = String(err ?? '').trim();
    if (/code\s*=\s*5\b|access is denied|拒绝访问/i.test(msg)) return '剪贴板被其他程序占用';
    return msg || '未知错误';
}

/** 剪贴板位图探测（原生侧只查序列号与格式位，不搬运图片字节） */
async function hasClipboardImage(): Promise<boolean> {
    try {
        const probe = await invoke<{ seq: number; hasDib: boolean }>('clipboard_image_probe');
        return !!probe?.hasDib;
    } catch {
        return false;
    }
}

/** 剪贴板文件列表探测（CF_HDROP，仅路径字符串，开销可忽略） */
async function hasClipboardFiles(): Promise<boolean> {
    try {
        const files = await readFiles();
        return Array.isArray(files) && files.length > 0;
    } catch {
        return false;
    }
}

/**
 * 解析唯一内容源，固定判定顺序（首个命中即返回）：
 * 文本 → 图片（仅取当前粘贴的图片二维码）→ 文件 → 空 / 读取失败。
 *
 * 读取文本失败时先做短暂重试（剪贴板锁冲突多为瞬态），仍失败再继续探测图片/文件——
 * 粘的是图片或文件时底层同样会因「无文本格式」抛错，此时绝不能报「读取剪贴板失败」。
 */
export async function resolveClipboardSource(): Promise<ClipSource> {
    let text = '';
    let readError: unknown = null;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
        try {
            text = (await readText()) ?? '';
            readError = null;
            break;
        } catch (error) {
            readError = error;
            if (isFormatMissing(error)) { // 无文本格式：等同文本为空，直接下探
                text = '';
                readError = null;
                break;
            }
            if (attempt < READ_ATTEMPTS - 1) await sleep(READ_RETRY_MS);
        }
    }
    if (text.trim().length > 0) return { kind: 'text', content: text, origin: 'text' };

    if (await hasClipboardImage()) {
        // 仅采用「10 秒内落库」的图片条目：超窗说明当前剪贴板图片尚未入库或已过期，
        // 宁可不支持也不引用旧内容
        const recent = await dbService
            .fetchRecentImageQr(Date.now() - QR_FRESH_MS)
            .catch(() => null);
        if (recent?.qrText) {
            return { kind: 'text', content: recent.qrText, origin: 'image-qr' };
        }
        return { kind: 'unsupported', reason: 'image' };
    }

    if (await hasClipboardFiles()) return { kind: 'unsupported', reason: 'files' };

    // 文本读不到、也没有图片/文件：只有此时才算真正的读取失败（原始错误交给岛展示）
    if (readError !== null) return { kind: 'error', error: readError };

    return { kind: 'empty' };
}
