import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentFestival, festivalNow } from '../core';
import { refreshFestivalRaw, useFestivalEgg } from '../state';
import { useFestivalEggSwitch } from '../switch';
import { useFestivalEggClass, useFestivalQuoteBanner } from '../points';
import { useI18n } from '~/composables/useI18n';

/**
 * 节日彩蛋模块测试：
 * - core：日期表判定 + --time 注入钩子（纯函数）
 * - state/switch：总开关门控 + 跨天重算（refreshFestivalRaw，岛弹岛路径同款机制；
 *   零点 ticker 在 VITEST 环境不启动，属环境守卫不做定时器断言）
 * - points：主窗口点缀注册表（类名/引言键）
 * - ISLAND_QUIRKS：中秋凌晨台词（vi.resetModules 取新模块实例，控制"窗口生命周期一次"标记）
 */

// switch.ts → useBooleanSetting → dbService：KV 读写 mock 为"未设置过"（保持默认开）
vi.mock('~/src/db/dbService', () => ({
    default: {
        getKeyValue: vi.fn(async () => ''),
        setKeyValue: vi.fn(async () => {}),
    },
}));

/** 固定日期构造（月份 0-based）：避免依赖运行当天，跨零点/跨节日判定可稳定回归 */
const at = (month: number, day: number) => new Date(2026, month - 1, day, 12, 0, 0);

describe('currentFestival', () => {
    it('命中各公历节日', () => {
        expect(currentFestival(at(1, 1))).toBe('newyear');
        expect(currentFestival(at(4, 1))).toBe('fools');
        expect(currentFestival(at(10, 31))).toBe('halloween');
    });

    it('代码级禁用：programmer 命中日期也返回 null（恢复 = 从 DISABLED_FESTIVALS 移除）', () => {
        expect(currentFestival(at(10, 24))).toBeNull();
    });

    it('圣诞节覆盖平安夜与圣诞两天', () => {
        expect(currentFestival(at(12, 24))).toBe('christmas');
        expect(currentFestival(at(12, 25))).toBe('christmas');
    });

    it('未命中返回 null（普通日期）', () => {
        expect(currentFestival(at(10, 16))).toBeNull();
        expect(currentFestival(at(2, 14))).toBeNull();
        expect(currentFestival(at(12, 26))).toBeNull();
    });

    it('相邻日不误判（节日仅当天生效）', () => {
        expect(currentFestival(at(4, 2))).toBeNull();
        expect(currentFestival(at(3, 31))).toBeNull();
        expect(currentFestival(at(10, 25))).toBeNull();
    });

    it('农历映射命中：七夕/中秋（映射表收录年份）', () => {
        expect(currentFestival(at(8, 19))).toBe('qixi');      // 2026-08-19 七夕
        expect(currentFestival(at(9, 25))).toBe('midautumn'); // 2026-09-25 中秋
    });

    it('农历映射命中：春节/元宵/端午（映射表收录年份）', () => {
        expect(currentFestival(at(2, 17))).toBe('chunjie'); // 2026-02-17 春节
        expect(currentFestival(at(3, 3))).toBe('yuanxiao'); // 2026-03-03 元宵
        expect(currentFestival(at(6, 19))).toBe('duanwu');  // 2026-06-19 端午
        expect(currentFestival(new Date(2028, 0, 26, 12, 0, 0))).toBe('chunjie'); // 2028 春节落在 1 月
    });

    it('除夕由春节映射派生（春节前一天；跨月/未收录年份）', () => {
        expect(currentFestival(at(2, 16))).toBe('chuxi'); // 2026-02-16 = 春节前一天
        expect(currentFestival(new Date(2030, 1, 2, 12, 0, 0))).toBe('chuxi'); // 2030-02-02（春节 02-03 派生）
        expect(currentFestival(new Date(2031, 0, 22, 12, 0, 0))).toBeNull(); // 2031 春节未收录 → 除夕同样不触发
    });

    it('农历映射表未收录年份不触发', () => {
        // 表只收录到 2030：2031 年同期不再命中
        expect(currentFestival(new Date(2031, 7, 19, 12, 0, 0))).toBeNull();
        expect(currentFestival(new Date(2031, 8, 25, 12, 0, 0))).toBeNull();
    });

    it('festivalNow 解析 --time 注入的 YYMMDD 测试日期', () => {
        vi.stubEnv('VITE_TEST_DATE', '260401');
        expect(currentFestival(festivalNow())).toBe('fools');
        vi.stubEnv('VITE_TEST_DATE', '261224');
        expect(currentFestival(festivalNow())).toBe('christmas');
        vi.unstubAllEnvs();
    });

    it('festivalNow 未注入/非法值回退真实当前时间', () => {
        vi.stubEnv('VITE_TEST_DATE', 'bad');
        const d = festivalNow();
        expect(d.getFullYear()).toBeGreaterThanOrEqual(2026);
        vi.unstubAllEnvs();
        expect(festivalNow()).toBeInstanceOf(Date);
    });
});

describe('总开关门控（useFestivalEgg）', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        refreshFestivalRaw(); // 还原为真实日期，避免污染其他用例的模块级单例
    });

    it('关闭时 festival 恒 null，重开恢复', () => {
        vi.stubEnv('VITE_TEST_DATE', '260925'); // 中秋
        refreshFestivalRaw();
        const sw = useFestivalEggSwitch();
        const { festival } = useFestivalEgg();
        expect(festival.value).toBe('midautumn');
        sw.enabled.value = false;
        expect(festival.value).toBeNull();
        sw.enabled.value = true;
        expect(festival.value).toBe('midautumn');
    });

    it('跨天即时重算：refreshFestivalRaw 随注入日期切换（岛弹岛前调用，主窗口靠零点 ticker 同语义）', () => {
        const { festival } = useFestivalEgg();
        vi.stubEnv('VITE_TEST_DATE', '261224');
        refreshFestivalRaw();
        expect(festival.value).toBe('christmas');
        vi.stubEnv('VITE_TEST_DATE', '261225');
        refreshFestivalRaw();
        expect(festival.value).toBe('christmas');
        vi.stubEnv('VITE_TEST_DATE', '261226'); // 节日次日
        refreshFestivalRaw();
        expect(festival.value).toBeNull();
    });
});

describe('主窗口点缀注册表（points）', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        refreshFestivalRaw();
    });

    it('fav-badge 点缀位：七夕挂喜鹊蓝、春节挂鎏金，其余节日/关闭输出空串', () => {
        const cls = useFestivalEggClass('fav-badge');
        vi.stubEnv('VITE_TEST_DATE', '261016'); // 非节日
        refreshFestivalRaw();
        expect(cls.value).toBe('');
        vi.stubEnv('VITE_TEST_DATE', '260819'); // 七夕
        refreshFestivalRaw();
        expect(cls.value).toBe('fav-badge-qixi');
        vi.stubEnv('VITE_TEST_DATE', '260217'); // 春节
        refreshFestivalRaw();
        expect(cls.value).toBe('fav-badge-chunjie');
        useFestivalEggSwitch().enabled.value = false; // 总开关关闭
        expect(cls.value).toBe('');
        useFestivalEggSwitch().enabled.value = true;
    });

    it('引言横幅：七夕/除夕/春节/元宵/端午返回台词键，未登记节日为 null', () => {
        const banner = useFestivalQuoteBanner();
        vi.stubEnv('VITE_TEST_DATE', '260819');
        refreshFestivalRaw();
        expect(banner.value?.quoteKey).toBe('festival.qixi_quote');
        vi.stubEnv('VITE_TEST_DATE', '260216');
        refreshFestivalRaw();
        expect(banner.value?.quoteKey).toBe('festival.chuxi_quote');
        vi.stubEnv('VITE_TEST_DATE', '260217');
        refreshFestivalRaw();
        expect(banner.value?.quoteKey).toBe('festival.chunjie_quote');
        vi.stubEnv('VITE_TEST_DATE', '260303');
        refreshFestivalRaw();
        expect(banner.value?.quoteKey).toBe('festival.yuanxiao_quote');
        vi.stubEnv('VITE_TEST_DATE', '260619');
        refreshFestivalRaw();
        expect(banner.value?.quoteKey).toBe('festival.duanwu_quote');
        vi.stubEnv('VITE_TEST_DATE', '261224'); // 圣诞未登记横幅
        refreshFestivalRaw();
        expect(banner.value).toBeNull();
    });
});

describe('弹岛行为（ISLAND_QUIRKS）', () => {
    // 每个用例取全新模块实例："窗口生命周期一次"标记（midautumnQuoteShown / chunjieGreetingShown）随模块重置。
    // 注意 reset 必须发生在首次动态 import 之前——否则 hook 会复用 file-top 的原始
    // state 单例（rawFestival 为真实日期），afterEach reset 只对后续用例生效
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    async function freshMods() {
        vi.resetModules();
        const switchMod = await import('../switch');
        const eggMod = await import('../island/useIslandFestivalEgg');
        return { sw: switchMod.useFestivalEggSwitch(), egg: eggMod.useIslandFestivalEgg() };
    }

    it('中秋凌晨首弹改播台词，再次弹岛不改写（窗口生命周期一次）', async () => {
        vi.useFakeTimers({ now: new Date(2026, 8, 25, 3, 30, 0) }); // 中秋凌晨 03:30（真实时钟语义）
        vi.stubEnv('VITE_TEST_DATE', '260925');
        const { egg } = await freshMods();
        expect(egg.festival.value).toBe('midautumn');
        const first = await egg.beforeShow({ kind: 'copy', text: 'hello' });
        expect(first.kind).toBe('info');
        expect(first.text).toBe(useI18n().t('festival.midautumn_quote'));
        const second = await egg.beforeShow({ kind: 'copy', text: 'hello' });
        expect(second.kind).toBe('copy');
        expect(second.text).toBe('hello');
    });

    it('中秋白天弹岛不改写载荷', async () => {
        vi.useFakeTimers({ now: new Date(2026, 8, 25, 14, 0, 0) });
        vi.stubEnv('VITE_TEST_DATE', '260925');
        const { egg } = await freshMods();
        const payload = await egg.beforeShow({ kind: 'copy', text: 'hello' });
        expect(payload.kind).toBe('copy');
        expect(payload.text).toBe('hello');
    });

    it('春节凌晨首弹改播贺词，再次弹岛不改写（窗口生命周期一次）', async () => {
        vi.useFakeTimers({ now: new Date(2026, 1, 17, 3, 30, 0) }); // 春节凌晨 03:30（真实时钟语义）
        vi.stubEnv('VITE_TEST_DATE', '260217');
        const { egg } = await freshMods();
        expect(egg.festival.value).toBe('chunjie');
        const first = await egg.beforeShow({ kind: 'copy', text: 'hello' });
        expect(first.kind).toBe('info');
        expect(first.text).toBe(useI18n().t('festival.chunjie_greeting'));
        const second = await egg.beforeShow({ kind: 'copy', text: 'hello' });
        expect(second.kind).toBe('copy');
        expect(second.text).toBe('hello');
    });

    it('春节白天弹岛不改写载荷', async () => {
        vi.useFakeTimers({ now: new Date(2026, 1, 17, 14, 0, 0) });
        vi.stubEnv('VITE_TEST_DATE', '260217');
        const { egg } = await freshMods();
        const payload = await egg.beforeShow({ kind: 'paste', text: 'world' });
        expect(payload.kind).toBe('paste');
        expect(payload.text).toBe('world');
    });

    it('除夕凌晨首弹改播贺词，再次弹岛不改写（窗口生命周期一次）', async () => {
        vi.useFakeTimers({ now: new Date(2026, 1, 16, 3, 30, 0) }); // 除夕凌晨 03:30（真实时钟语义）
        vi.stubEnv('VITE_TEST_DATE', '260216');
        const { egg } = await freshMods();
        expect(egg.festival.value).toBe('chuxi');
        const first = await egg.beforeShow({ kind: 'copy', text: 'hello' });
        expect(first.kind).toBe('info');
        expect(first.text).toBe(useI18n().t('festival.chuxi_greeting'));
        const second = await egg.beforeShow({ kind: 'copy', text: 'hello' });
        expect(second.kind).toBe('copy');
        expect(second.text).toBe('hello');
    });

    it('总开关关闭：凌晨也不改写（festival 恒 null，行为钩子整体跳过）', async () => {
        vi.useFakeTimers({ now: new Date(2026, 8, 25, 3, 30, 0) });
        vi.stubEnv('VITE_TEST_DATE', '260925');
        const { sw, egg } = await freshMods();
        sw.enabled.value = false;
        expect(egg.festival.value).toBeNull();
        const payload = await egg.beforeShow({ kind: 'copy', text: 'hello' });
        expect(payload.kind).toBe('copy');
    });

    it('非登记节日（七夕）凌晨弹岛原样透传', async () => {
        vi.useFakeTimers({ now: new Date(2026, 7, 19, 3, 30, 0) });
        vi.stubEnv('VITE_TEST_DATE', '260819');
        const { egg } = await freshMods();
        const payload = await egg.beforeShow({ kind: 'paste', text: 'world' });
        expect(payload.kind).toBe('paste');
        expect(payload.text).toBe('world');
    });
});
