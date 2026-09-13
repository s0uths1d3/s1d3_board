import type { ClipExtractor, ClipRule, ClipScheme } from '../entities';

/**
 * 智能剪贴板类型定义（设计文档 §2/§4）
 *
 * Segment 是处理管道的统一产物：所有消费者（气泡窗口 / 开放 API / 未来功能）只依赖此结构，
 * 不感知上游是规则拆分、模板渲染还是 AI 加工（source 字段仅作来源标注）。
 */

/** 处理管道统一产物 */
export interface Segment {
    index: number;
    text: string;
    source: 'rule' | 'ai' | 'template';
}

/** 处理模式（settings: smart_clip_mode）：off 关闭 / rule 纯规则 / ai 规则 + AI 加工 */
export type SmartClipMode = 'off' | 'rule' | 'ai';

/** 一次复制事件解析所需的配置快照（由设置页变更时推送，避免每次解析都查库） */
export interface ProcessContext {
    mode: SmartClipMode;
    rule: ClipRule | null;
    /** 默认方案（多个提取器的集成体）；ai 模式生效 */
    scheme: ClipScheme | null;
    /** 方案引用的提取器全集（按 id 解析成员） */
    extractors: ClipExtractor[];
}

/** 最近解析结果内存条目（气泡窗口消费） */
export interface SmartClipEntry {
    /** clipboard 表行 id（与剪贴板列表选中态对齐） */
    id: number;
    content: string;
    segments: Segment[];
    ts: number;
    /** 解析时使用的配置版本（mode/rule/template 快照版本号）：
     *  规则或模板变更后版本号递增，据此判定缓存结果已过期需重解析 */
    configVersion?: number;
}

/** dbService 广播的复制事件 detail（仅文本，事件名 smart-clip:copy） */
export interface CopyEventDetail {
    id: number;
    content: string;
    ts: number;
}

export type { ClipRule, ClipScheme, ClipExtractor };
