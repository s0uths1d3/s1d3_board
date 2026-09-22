import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../events';
import type { AppEventMap } from '../events';

describe('createEventBus', () => {
    it('emit 同步派发载荷给监听器', () => {
        const bus = createEventBus();
        const received: AppEventMap['focus-search'][] = [];
        bus.on('focus-search', (d) => received.push(d));
        bus.emit('focus-search', { tab: 'todo' });
        expect(received).toEqual([{ tab: 'todo' }]);
    });

    it('无载荷事件直接派发', () => {
        const bus = createEventBus();
        const spy = vi.fn();
        bus.on('clipboard:changed', spy);
        bus.emit('clipboard:changed');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('同事件多监听器按注册顺序同步调用', () => {
        const bus = createEventBus();
        const order: string[] = [];
        bus.on('window-shown', () => order.push('a'));
        bus.on('window-shown', () => order.push('b'));
        bus.emit('window-shown');
        expect(order).toEqual(['a', 'b']);
    });

    it('同一函数重复注册只生效一次（与 window.addEventListener 对齐）', () => {
        const bus = createEventBus();
        const spy = vi.fn();
        bus.on('create-note', spy);
        bus.on('create-note', spy);
        bus.emit('create-note');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('off 按引用注销，注销后不再收到派发', () => {
        const bus = createEventBus();
        const spy = vi.fn();
        bus.on('delete-request', spy);
        bus.off('delete-request', spy);
        bus.emit('delete-request');
        expect(spy).not.toHaveBeenCalled();
    });

    it('注销未注册过的引用为 no-op 不抛错', () => {
        const bus = createEventBus();
        expect(() => bus.off('save-note', vi.fn())).not.toThrow();
    });

    it('on 返回的退订函数等价 off', () => {
        const bus = createEventBus();
        const spy = vi.fn();
        const off = bus.on('save-note', spy);
        off();
        bus.emit('save-note');
        expect(spy).not.toHaveBeenCalled();
    });

    it('emit 无监听器时为 no-op 不抛错', () => {
        const bus = createEventBus();
        expect(() => bus.emit('todo:edit-request')).not.toThrow();
        expect(() => bus.emit('island:copy', { content: 'x', type: 'text' })).not.toThrow();
    });

    it('监听器抛错同步冒泡给派发方且后续监听器不再执行（与 window.dispatchEvent 一致）', () => {
        const bus = createEventBus();
        const after = vi.fn();
        bus.on('smart-clip:copy', () => { throw new Error('boom'); });
        bus.on('smart-clip:copy', after);
        expect(() => bus.emit('smart-clip:copy', { id: 1, content: 'c', ts: 0 })).toThrow('boom');
        expect(after).not.toHaveBeenCalled();
    });

    it('同监听器注册到不同事件互不影响', () => {
        const bus = createEventBus();
        const spy = vi.fn();
        bus.on('clipboard:changed', spy);
        bus.emit('resolved-scheme-changed');
        expect(spy).not.toHaveBeenCalled();
        bus.emit('clipboard:changed');
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
