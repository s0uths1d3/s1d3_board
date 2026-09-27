import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DeleteConfirm from '../DeleteConfirm.vue';

/**
 * 删除确认框生命周期测试（批量删除复用的内联组件）：
 * - visible=true → Teleport 到 body 渲染 + capture 阶段键盘监听（Enter 确认 / Esc 取消）
 * - visible=false → 卸载渲染 + 移除监听（按键不再产生事件）
 * - 焦点切换：方向键/Tab 在确认/取消之间轮转，Enter 触发当前聚焦按钮
 */

type MountOpts = { visible?: boolean; message?: string; anchor?: DOMRect | null };

/** 当前挂载实例（afterEach 统一卸载，防止键盘监听跨用例泄漏抢占事件） */
let activeWrapper: ReturnType<typeof mount> | null = null;

function mountConfirm({ visible = true, message = '确定删除？', anchor = null }: MountOpts = {}) {
    activeWrapper = mount(DeleteConfirm, {
        props: { visible, message, anchor },
        attachTo: document.body,
    });
    return activeWrapper;
}

const panel = () => document.querySelector('[data-delete-confirm]');

function pressKey(key: string) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

afterEach(() => {
    activeWrapper?.unmount();
    activeWrapper = null;
    document.body.innerHTML = '';
});

describe('DeleteConfirm 渲染与定位', () => {
    it('visible=true：Teleport 到 body 渲染，显示传入文案', async () => {
        const w = mountConfirm();
        await flushPromises();
        expect(panel()).not.toBeNull();
        expect(panel()?.textContent).toContain('确定删除？');
        w.unmount();
    });

    it('visible=false：不渲染任何节点', () => {
        mountConfirm({ visible: false });
        expect(panel()).toBeNull();
    });

    it('无锚点（anchor=null）：视口居中定位', async () => {
        const w = mountConfirm({ anchor: null });
        await flushPromises();
        const el = panel() as HTMLElement;
        const vw = window.innerWidth;
        const expectedLeft = Math.max(8, (vw - 400) / 2);
        expect(el.style.left).toBe(`${expectedLeft}px`);
        w.unmount();
    });
});

describe('DeleteConfirm 键盘生命周期', () => {
    it('Enter 触发 confirm，Esc 触发 cancel', async () => {
        const w = mountConfirm();
        await flushPromises();
        pressKey('Enter');
        pressKey('Escape');
        expect(w.emitted('confirm')).toHaveLength(1);
        expect(w.emitted('cancel')).toHaveLength(1);
        w.unmount();
    });

    it('打开时确认按钮自动聚焦', async () => {
        mountConfirm();
        await flushPromises();
        const [cancelBtn, okBtn] = panel()!.querySelectorAll('button');
        expect(document.activeElement).toBe(okBtn);
        expect(document.activeElement).not.toBe(cancelBtn);
    });

    it('方向键在确认/取消间切换焦点：聚焦取消后 Enter 触发 cancel', async () => {
        const w = mountConfirm();
        await flushPromises();
        const [cancelBtn] = panel()!.querySelectorAll('button');
        pressKey('ArrowLeft');
        expect(document.activeElement).toBe(cancelBtn);
        pressKey('Enter');
        expect(w.emitted('cancel')).toHaveLength(1);
        expect(w.emitted('confirm')).toBeUndefined();
        w.unmount();
    });

    it('visible=true→false 后键盘监听移除：按键不再产生事件', async () => {
        const w = mountConfirm();
        await flushPromises();
        await w.setProps({ visible: false });
        await flushPromises();
        expect(panel()).toBeNull();
        pressKey('Enter');
        pressKey('Escape');
        expect(w.emitted('confirm')).toBeUndefined();
        expect(w.emitted('cancel')).toBeUndefined();
        w.unmount();
    });

    it('Delete/Backspace 被拦截：不产生 confirm/cancel（防误删）', async () => {
        const w = mountConfirm();
        await flushPromises();
        pressKey('Delete');
        pressKey('Backspace');
        expect(w.emitted('confirm')).toBeUndefined();
        expect(w.emitted('cancel')).toBeUndefined();
        w.unmount();
    });

    it('点击取消/确认按钮：触发对应事件', async () => {
        const w = mountConfirm();
        await flushPromises();
        const [cancelBtn, okBtn] = panel()!.querySelectorAll('button');
        (okBtn as HTMLButtonElement).click();
        (cancelBtn as HTMLButtonElement).click();
        expect(w.emitted('confirm')).toHaveLength(1);
        expect(w.emitted('cancel')).toHaveLength(1);
        w.unmount();
    });
});
