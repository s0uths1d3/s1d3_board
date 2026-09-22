import { describe, expect, it, vi } from 'vitest';
import { ModuleRegistry } from '../registry';
import type { AppModule } from '../registry';
import { createEventBus } from '../events';
import { createModuleContext } from '../context';
import type { ModuleContext } from '../context';
import type { DatabaseConnection } from '../db/connection';

/** 构造轻量测试上下文（db/config 为 no-op 桩，registry 生命周期不触碰其方法） */
function makeCtx(): ModuleContext {
    const dbStub = {
        peek: () => undefined,
        ready: async () => ({ select: async () => [], execute: async () => ({ rowsAffected: 0 }) }),
        executeWithRetry: async () => ({ rowsAffected: 0 }),
    } as unknown as DatabaseConnection;
    return createModuleContext({
        events: createEventBus(),
        db: dbStub,
        config: { get: async () => null, set: async () => {} },
    });
}

/** 记录生命周期调用的模块工厂 */
function spyModule(id: string, opts: {
    deps?: string[];
    init?: AppModule['init'];
    start?: AppModule['start'];
    stop?: AppModule['stop'];
    dispose?: AppModule['dispose'];
} = {}): AppModule {
    return {
        id,
        dependencies: opts.deps,
        init: opts.init ?? vi.fn(),
        start: opts.start,
        stop: opts.stop,
        dispose: opts.dispose,
    };
}

describe('ModuleRegistry 注册与发现', () => {
    it('register/get/has/ids 基本语义', () => {
        const reg = new ModuleRegistry();
        const a = spyModule('a');
        reg.register(a);
        expect(reg.has('a')).toBe(true);
        expect(reg.has('b')).toBe(false);
        expect(reg.get('a')).toBe(a);
        expect(reg.get('b')).toBeUndefined();
        expect(reg.ids()).toEqual(['a']);
    });

    it('重复 id 注册抛错', () => {
        const reg = new ModuleRegistry();
        reg.register(spyModule('a'));
        expect(() => reg.register(spyModule('a'))).toThrow('重复注册');
    });
});

describe('ModuleRegistry 依赖解析', () => {
    it('按依赖拓扑序返回（同层保持注册顺序）', () => {
        const reg = new ModuleRegistry();
        reg.register(spyModule('c', { deps: ['b'] }));
        reg.register(spyModule('a'));
        reg.register(spyModule('b', { deps: ['a'] }));
        expect(reg.resolutionOrder()).toEqual(['a', 'b', 'c']);
    });

    it('缺依赖抛错', () => {
        const reg = new ModuleRegistry();
        reg.register(spyModule('a', { deps: ['ghost'] }));
        expect(() => reg.resolutionOrder()).toThrow('未注册的依赖');
    });

    it('依赖环抛错', () => {
        const reg = new ModuleRegistry();
        reg.register(spyModule('a', { deps: ['b'] }));
        reg.register(spyModule('b', { deps: ['a'] }));
        expect(() => reg.resolutionOrder()).toThrow('环或不可解析');
    });
});

describe('ModuleRegistry boot 生命周期', () => {
    it('init/start 按拓扑序执行（注册顺序乱序声明依赖）', async () => {
        const reg = new ModuleRegistry();
        const calls: string[] = [];
        const mk = (id: string, deps?: string[]): AppModule => ({
            id,
            dependencies: deps,
            init: vi.fn(() => { calls.push(`init:${id}`); }),
            start: vi.fn(() => { calls.push(`start:${id}`); }),
        });
        reg.register(mk('c', ['b']));
        reg.register(mk('b', ['a']));
        reg.register(mk('a'));
        await reg.boot(makeCtx());
        expect(calls).toEqual(['init:a', 'init:b', 'init:c', 'start:a', 'start:b', 'start:c']);
    });

    it('无 start 的模块跳过 start 阶段不报错', async () => {
        const reg = new ModuleRegistry();
        reg.register(spyModule('plain'));
        await expect(reg.boot(makeCtx())).resolves.toBeUndefined();
    });

    it('boot 幂等：重复调用忽略', async () => {
        const reg = new ModuleRegistry();
        const m = spyModule('a');
        reg.register(m);
        await reg.boot(makeCtx());
        await reg.boot(makeCtx());
        expect(m.init).toHaveBeenCalledTimes(1);
    });
});

describe('ModuleRegistry 故障隔离', () => {
    it('单模块 init 抛错不影响其余模块（失败模块不 start）', async () => {
        const reg = new ModuleRegistry();
        const bad = spyModule('bad', { init: vi.fn(() => { throw new Error('boom'); }) });
        const good = spyModule('good', { start: vi.fn() });
        reg.register(bad);
        reg.register(good);
        await expect(reg.boot(makeCtx())).resolves.toBeUndefined();
        expect(bad.init).toHaveBeenCalledTimes(1);
        expect(good.init).toHaveBeenCalledTimes(1);
        expect(good.start).toHaveBeenCalledTimes(1);
    });

    it('依赖失败的下游模块被跳过', async () => {
        const reg = new ModuleRegistry();
        const bad = spyModule('bad', { init: vi.fn(() => { throw new Error('boom'); }) });
        const downstream = spyModule('down', { deps: ['bad'] });
        const downstream2 = spyModule('down2', { deps: ['down'] });
        const independent = spyModule('independent', { start: vi.fn() });
        reg.register(bad);
        reg.register(downstream);
        reg.register(downstream2);
        reg.register(independent);
        await reg.boot(makeCtx());
        expect(downstream.init).not.toHaveBeenCalled();
        expect(downstream2.init).not.toHaveBeenCalled();
        expect(independent.init).toHaveBeenCalledTimes(1);
        expect(independent.start).toHaveBeenCalledTimes(1);
    });

    it('start 抛错被隔离，其他模块照常 start', async () => {
        const reg = new ModuleRegistry();
        reg.register(spyModule('bad', { start: vi.fn(() => { throw new Error('boom'); }) }));
        const good = spyModule('good', { start: vi.fn() });
        reg.register(good);
        await expect(reg.boot(makeCtx())).resolves.toBeUndefined();
        expect(good.start).toHaveBeenCalledTimes(1);
    });
});

describe('ModuleRegistry shutdown 收尾', () => {
    it('stop/dispose 按反拓扑序执行', async () => {
        const reg = new ModuleRegistry();
        const calls: string[] = [];
        const mk = (id: string, deps?: string[]): AppModule => ({
            id,
            dependencies: deps,
            init: vi.fn(),
            start: vi.fn(() => { calls.push(`start:${id}`); }),
            stop: vi.fn(() => { calls.push(`stop:${id}`); }),
            dispose: vi.fn(() => { calls.push(`dispose:${id}`); }),
        });
        reg.register(mk('a'));
        reg.register(mk('b', ['a']));
        reg.register(mk('c', ['b']));
        await reg.boot(makeCtx());
        calls.length = 0;
        await reg.shutdown();
        expect(calls).toEqual(['stop:c', 'stop:b', 'stop:a', 'dispose:c', 'dispose:b', 'dispose:a']);
    });

    it('单个 stop 抛错不阻断其余模块收尾', async () => {
        const reg = new ModuleRegistry();
        const badStop = spyModule('badStop', {
            start: vi.fn(),
            stop: vi.fn(() => { throw new Error('boom'); }),
            dispose: vi.fn(),
        });
        const good = spyModule('good', { start: vi.fn(), stop: vi.fn(), dispose: vi.fn() });
        reg.register(badStop);
        reg.register(good);
        await reg.boot(makeCtx());
        await expect(reg.shutdown()).resolves.toBeUndefined();
        expect(good.stop).toHaveBeenCalledTimes(1);
        expect(good.dispose).toHaveBeenCalledTimes(1);
        // stop 失败的模块仍会被 dispose（释放可能持有的资源）
        expect(badStop.dispose).toHaveBeenCalledTimes(1);
    });

    it('未 boot 时 shutdown 为 no-op', async () => {
        const reg = new ModuleRegistry();
        const m = spyModule('a', { stop: vi.fn(), dispose: vi.fn() });
        reg.register(m);
        await reg.shutdown();
        expect(m.stop).not.toHaveBeenCalled();
        expect(m.dispose).not.toHaveBeenCalled();
    });

    it('shutdown 幂等且完成后可再次 boot（init 重新执行）', async () => {
        const reg = new ModuleRegistry();
        const m = spyModule('a', { start: vi.fn(), stop: vi.fn(), dispose: vi.fn() });
        reg.register(m);
        await reg.boot(makeCtx());
        await reg.shutdown();
        await reg.shutdown();
        expect(m.stop).toHaveBeenCalledTimes(1);
        expect(m.dispose).toHaveBeenCalledTimes(1);
        await reg.boot(makeCtx());
        expect(m.init).toHaveBeenCalledTimes(2);
    });

    it('init 失败的模块 shutdown 时不被 dispose', async () => {
        const reg = new ModuleRegistry();
        const bad = spyModule('bad', { init: vi.fn(() => { throw new Error('boom'); }), dispose: vi.fn() });
        reg.register(bad);
        await reg.boot(makeCtx());
        await reg.shutdown();
        expect(bad.dispose).not.toHaveBeenCalled();
    });
});
