import type { ModuleContext } from './context';
import { createConsoleLogger } from './context';

/**
 * 模块注册表（注册表式插件化的中央管理点，阶段 1b）：
 * 统一的模块注册、发现与生命周期管理——模块间不直接 import 依赖对方实现，
 * 而是注册到注册表、经依赖声明表达协作关系，由注册表按拓扑序驱动生命周期。
 *
 * 生命周期两阶段（boot）+ 收尾（shutdown）：
 * - init：按依赖拓扑序执行（获取依赖、注册事件监听等一次性装配）；
 * - start：init 全部尝试后按同一拓扑序执行（启动定时器/监听器，可选）；
 * - shutdown：stop 与 dispose 按**反**拓扑序执行（先停后启的、先启后依赖的）。
 *
 * 故障隔离：单模块 init/start 抛错只记日志不中断其余模块；
 * 依赖失败的模块被跳过（其上游能力不可用）。装配错误（缺依赖/依赖环/重复 id）
 * 不属于运行故障，显式抛错尽早暴露。
 *
 * 边界控制：模块只经 ModuleContext（events/db/config/logger 抽象）获取能力，
 * 对其他模块的可见需求一律通过依赖声明 + 事件总线，而非直接引用。
 */

/** 应用模块接口：注册表式插件化的统一生命周期契约 */
export interface AppModule {
    /** 全局唯一 id（注册表内去重；dependencies 用它引用其他模块） */
    id: string;
    /** 依赖的模块 id 列表：init/start 按 topo 序执行，stop/dispose 反序 */
    dependencies?: string[];
    /** 一次性装配：获取能力句柄、注册事件监听（可选：无装配需求的模块可省略） */
    init?(ctx: ModuleContext): Promise<void> | void;
    /** 启动运行期资源（定时器/监听器/轮询）；可选，仅 init 成功的模块会被调用 */
    start?(ctx: ModuleContext): Promise<void> | void;
    /** 停止运行期资源；可选，仅 start 成功的模块会被调用（start 失败模块可能持有半成品资源，不安全 stop） */
    stop?(ctx: ModuleContext): Promise<void> | void;
    /** 释放资源；可选，init 成功的模块在 shutdown 时反序调用 */
    dispose?(ctx: ModuleContext): Promise<void> | void;
}

type ModuleStatus =
    | 'registered'   // 已注册未引导
    | 'initialized'  // init 成功（无 start 或 start 未执行）
    | 'started'      // start 成功（运行中）
    | 'failed'       // init/start 抛错（被隔离）
    | 'skipped';     // 依赖失败被跳过

interface ModuleEntry {
    module: AppModule;
    status: ModuleStatus;
}

export class ModuleRegistry {
    private entries = new Map<string, ModuleEntry>();
    private logger = createConsoleLogger('registry');
    private ctx: ModuleContext | undefined;
    private booted = false;

    /** 注册模块；id 重复抛错（装配期契约错误） */
    register(module: AppModule): void {
        if (this.entries.has(module.id)) {
            throw new Error(`[registry] 模块 id 重复注册: ${module.id}`);
        }
        this.entries.set(module.id, { module, status: 'registered' });
    }

    /** 模块发现：按 id 取模块（未注册返回 undefined） */
    get(id: string): AppModule | undefined {
        return this.entries.get(id)?.module;
    }

    has(id: string): boolean {
        return this.entries.has(id);
    }

    /** 已注册模块 id（按注册顺序） */
    ids(): string[] {
        return [...this.entries.keys()];
    }

    /**
     * 依赖拓扑序（确定性：同层按注册顺序）。
     * 缺依赖 / 依赖环在此显式抛错（装配错误不隔离，尽早失败）。
     */
    resolutionOrder(): string[] {
        const ids = this.ids();
        const depsOf = new Map<string, string[]>();
        for (const id of ids) {
            depsOf.set(id, this.entries.get(id)!.module.dependencies ?? []);
        }
        for (const [id, deps] of depsOf) {
            for (const d of deps) {
                if (!depsOf.has(d)) {
                    throw new Error(`[registry] 模块 ${id} 声明了未注册的依赖: ${d}`);
                }
            }
        }
        const emitted = new Set<string>();
        const order: string[] = [];
        let progress = true;
        while (order.length < ids.length && progress) {
            progress = false;
            for (const id of ids) {
                if (emitted.has(id)) continue;
                if (depsOf.get(id)!.every((d) => emitted.has(d))) {
                    emitted.add(id);
                    order.push(id);
                    progress = true;
                }
            }
        }
        if (order.length < ids.length) {
            const stuck = ids.filter((id) => !emitted.has(id));
            throw new Error(`[registry] 模块依赖存在环或不可解析: ${stuck.join(', ')}`);
        }
        return order;
    }

    /** 引导：init → start 两阶段按拓扑序执行。幂等：booted 后重复调用忽略并告警 */
    async boot(ctx: ModuleContext): Promise<void> {
        if (this.booted) {
            this.logger.warn('boot 已执行过，忽略重复调用');
            return;
        }
        this.ctx = ctx;
        const order = this.resolutionOrder();

        // 阶段一 init（故障隔离：单模块失败不中断其余；依赖失败则下游跳过）
        for (const id of order) {
            const entry = this.entries.get(id)!;
            const deps = entry.module.dependencies ?? [];
            const depDown = deps.some((d) => {
                const s = this.entries.get(d)?.status;
                return s === 'failed' || s === 'skipped';
            });
            if (depDown) {
                entry.status = 'skipped';
                this.logger.warn(`模块 ${id} 因依赖失败被跳过`);
                continue;
            }
            try {
                await entry.module.init?.(ctx);
                entry.status = 'initialized';
            } catch (e) {
                entry.status = 'failed';
                this.logger.error(`模块 ${id} init 失败（已隔离，不影响其他模块）:`, e);
            }
        }

        // 阶段二 start（按拓扑序；仅 init 成功的模块）
        for (const id of order) {
            const entry = this.entries.get(id)!;
            if (entry.status !== 'initialized' || !entry.module.start) continue;
            try {
                await entry.module.start(ctx);
                entry.status = 'started';
            } catch (e) {
                entry.status = 'failed';
                this.logger.error(`模块 ${id} start 失败（已隔离，不影响其他模块）:`, e);
            }
        }

        this.booted = true;
    }

    /**
     * 收尾：stop → dispose 两阶段按反拓扑序执行。
     * - stop 仅作用于 start 成功的模块；单个 stop 失败不阻断其余模块收尾；
     * - dispose 作用于 init 成功（或曾启动）的模块；
     * - 幂等：未 boot 时 no-op；完成后状态复位，允许再次 boot（测试/HMR 场景）。
     */
    async shutdown(): Promise<void> {
        if (!this.booted || !this.ctx) return;
        const ctx = this.ctx;
        const reverse = [...this.resolutionOrder()].reverse();

        for (const id of reverse) {
            const entry = this.entries.get(id)!;
            if (entry.status !== 'started' || !entry.module.stop) continue;
            try {
                await entry.module.stop(ctx);
            } catch (e) {
                this.logger.error(`模块 ${id} stop 失败（继续收尾其余模块）:`, e);
            } finally {
                entry.status = 'initialized';
            }
        }

        for (const id of reverse) {
            const entry = this.entries.get(id)!;
            if (entry.status === 'initialized' && entry.module.dispose) {
                try {
                    await entry.module.dispose(ctx);
                } catch (e) {
                    this.logger.error(`模块 ${id} dispose 失败:`, e);
                }
            }
            entry.status = 'registered';
        }

        this.booted = false;
        this.ctx = undefined;
    }
}
