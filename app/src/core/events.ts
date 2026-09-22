/**
 * 类型化事件总线（core 层抽象）：模块与 UI 只依赖本模块的 EventBus 接口，不感知派发机制。
 *
 * 职责边界：
 * - 仅承载**同窗口内**的应用进程事件（原 window.dispatchEvent + CustomEvent 的派发点）；
 * - **跨窗口通信走 Tauri emit/listen（@tauri-apps/api），与本总线无关**——两套通道语义不同，
 *   不可混用（island:show、tooltip:* 等跨窗口事件不在本总线内）。
 *
 * 与原生 CustomEvent 派发的语义对齐（行为不变性）：
 * - 同步派发：emit 在调用栈内逐个调用监听器，无队列/微任务；
 * - 注册顺序：同事件多个监听器按注册先后依次调用；
 * - 引用去重：同一函数重复注册只生效一次（与 window.addEventListener 一致）；
 * - 错误透传：监听器抛错不被总线吞掉，与 window.dispatchEvent 一致地同步冒泡给派发方；
 * - 派发中先删除的监听器不再被调用；派发中新增的监听器会被本轮调用
 *   （与 DOM「本轮不调用」存在微小差异，现有代码无此依赖场景）。
 */

/** island:copy 载荷：复制行为反馈灵动岛（图片携带岛显示缩略图与二维码识别结果） */
export interface IslandCopyDetail {
    content: string;
    type: 'text' | 'image';
    thumb?: string | null;
    qrText?: string | null;
}

/** smart-clip:copy 载荷：新文本入库广播（仅文本参与智能剪贴板解析管道） */
export interface SmartClipCopyDetail {
    id: number;
    content: string;
    ts: number;
}

/** focus-search 载荷：派发时的激活标签页 */
export interface FocusSearchDetail {
    tab: string;
}

/** 应用内事件映射：事件名 → 载荷类型（void = 无载荷）。事件名与既有 CustomEvent 完全一致 */
export interface AppEventMap {
    'clipboard:changed': void;
    'island:copy': IslandCopyDetail;
    'smart-clip:copy': SmartClipCopyDetail;
    'window-shown': void;
    'resolved-scheme-changed': void;
    'save-note': void;
    'create-note': void;
    'todo:edit-request': void;
    'todo:delete-request': void;
    'delete-request': void;
    'focus-search': FocusSearchDetail;
}

export type AppEventName = keyof AppEventMap;
export type EventHandler<K extends AppEventName> = (detail: AppEventMap[K]) => void;
export type Unsubscribe = () => void;

/** 事件总线抽象：模块只依赖此接口（依赖抽象而非实现） */
export interface EventBus {
    /** 注册监听器；返回退订函数（等价于对同参调用 off） */
    on<K extends AppEventName>(event: K, handler: EventHandler<K>): Unsubscribe;
    /** 按引用注销监听器（未注册过的引用为 no-op，与 removeEventListener 一致） */
    off<K extends AppEventName>(event: K, handler: EventHandler<K>): void;
    /** 同步派发事件：无载荷事件不传 detail，载荷事件必须传（类型层面约束） */
    emit<K extends AppEventName>(event: K, ...detail: AppEventMap[K] extends void ? [] : [AppEventMap[K]]): void;
}

export function createEventBus(): EventBus {
    // 内部统一以 (detail: unknown) => void 存放：EventHandler 的参数型变与泛型 K 无法在
    // 实现内部关联，注册/派发处经 unknown 桥接（类型安全由对外签名保证）
    const registry = new Map<string, Set<(detail: unknown) => void>>();

    return {
        on(event, handler) {
            let set = registry.get(event);
            if (!set) {
                set = new Set();
                registry.set(event, set);
            }
            const h = handler as (detail: unknown) => void;
            set.add(h);
            return () => { set.delete(h); };
        },
        off(event, handler) {
            registry.get(event)?.delete(handler as (detail: unknown) => void);
        },
        // 方法实现签名放宽为 unknown[]（方法参数双变，仍满足接口的条件元组签名）
        emit(event: AppEventName, ...detail: unknown[]): void {
            const set = registry.get(event);
            if (!set) return;
            for (const handler of set) {
                handler(detail[0]);
            }
        },
    };
}

/** 应用级单例总线 */
export const bus: EventBus = createEventBus();
