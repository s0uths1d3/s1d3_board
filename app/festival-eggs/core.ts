/**
 * 节日判定核心（纯函数、零依赖，可独立单测）：
 * 公历 + 农历两张日期表 → currentFestival()；测试日期钩子 festivalNow()。
 * 消费方在每次展示时重新取值即可跨零点/跨节日自然切换，无需轮询。
 *
 * 农历节日（春节/元宵/七夕/端午/中秋）采用**专用公历映射表**而非完整农历换算：只为农历节日
 * 维护每年一个日期，数据量小且无换算错误风险；未收录年份自然不触发（每年初按万年历续表即可）。
 * 除夕（岁末最后一夜）不单列年份表——恒为春节公历日期的前一天（无论当年腊月廿九还是三十），
 * 直接从春节映射派生，续表只维护春节一行。
 *
 * ── 新增一个节日的完整步骤（全部在本目录内，业务代码零改动）──
 *  1. 日期表：公历节日加 FESTIVAL_DAYS 条目；农历节日加 LUNAR_FESTIVAL_SOLAR 当年映射
 *  2. 文案：lang/*.toml 的 [festival] 表加 tip_<id>（徽章 v-tip）等键
 *  3. 皮肤：styles/festival.css 加 [data-festival='<id>'] 变量组 + 装饰样式
 *  4. 岛装饰（可选）：island/FestivalIslandDecor.vue 对应槽位加分支
 *  5. 弹岛行为（可选）：island/useIslandFestivalEgg.ts 的 ISLAND_QUIRKS 登记一行
 *  6. 主窗口点缀（可选）：points.ts 的 POINT_CLASSES / QUOTE_BANNERS 登记一行
 */

/** 节日标识（与 styles/festival.css 变量组 [data-festival='...'] 一一对应） */
export type FestivalId = 'newyear' | 'fools' | 'programmer' | 'halloween' | 'christmas' | 'qixi' | 'midautumn' | 'chuxi' | 'chunjie' | 'yuanxiao' | 'duanwu';

/** 公历节日表：[月, 日] 命中（圣诞节覆盖平安夜两天） */
const FESTIVAL_DAYS: Record<FestivalId, [number, number][]> = {
  newyear: [[1, 1]],
  fools: [[4, 1]],
  programmer: [[10, 24]],
  halloween: [[10, 31]],
  christmas: [[12, 24], [12, 25]],
  qixi: [],
  midautumn: [],
  chuxi: [],
  chunjie: [],
  yuanxiao: [],
  duanwu: [],
};

/** 农历节日 → 公历日期映射（MMDD；2020-2025 为确定值，其后按万年历推算——如有偏差以当年万年历为准修正） */
const LUNAR_FESTIVAL_SOLAR: Partial<Record<FestivalId, Record<number, string>>> = {
  chunjie: {
    // 农历正月初一
    2026: '0217', 2027: '0206', 2028: '0126', 2029: '0213', 2030: '0203',
  },
  yuanxiao: {
    // 农历正月十五（春节当日 + 14 天）
    2026: '0303', 2027: '0220', 2028: '0209', 2029: '0227', 2030: '0217',
  },
  duanwu: {
    // 农历五月初五
    2026: '0619', 2027: '0609', 2028: '0528', 2029: '0616', 2030: '0605',
  },
  qixi: {
    2020: '0825', 2021: '0814', 2022: '0804', 2023: '0822', 2024: '0810',
    2025: '0829', 2026: '0819', 2027: '0808', 2028: '0826', 2029: '0816', 2030: '0805',
  },
  midautumn: {
    2020: '1001', 2021: '0921', 2022: '0910', 2023: '0929', 2024: '0917',
    2025: '1006', 2026: '0925', 2027: '0915', 2028: '1003', 2029: '0922', 2030: '0912',
  },
};

/** 除夕 = 春节公历日期的前一天（Date 自动进位天然处理跨月；岁末廿九/三十皆覆盖），
 *  从春节映射派生使续表只维护春节一行、两节永不脱钩（春节未收录 → 除夕同样不触发） */
const CHUXI_SOLAR: Record<number, string> = {};
for (const [year, mmdd] of Object.entries(LUNAR_FESTIVAL_SOLAR.chunjie ?? {})) {
  const prev = new Date(Number(year), Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(2, 4)) - 1);
  CHUXI_SOLAR[Number(year)] = `${String(prev.getMonth() + 1).padStart(2, '0')}${String(prev.getDate()).padStart(2, '0')}`;
}
LUNAR_FESTIVAL_SOLAR.chuxi = CHUXI_SOLAR;

/** 代码级禁用（无 UI 开关）：命中的节日一律视为无节日；恢复 = 从集合移除即可
 *  （日期表/文案/皮肤/装饰全部保留不删，禁用只拦截判定出口） */
const DISABLED_FESTIVALS: ReadonlySet<FestivalId> = new Set<FestivalId>(['programmer']);

/** 日期解析（不叠加禁用过滤）：公历表 → 农历表 */
function resolveFestival(now: Date): FestivalId | null {
  const m = now.getMonth() + 1;
  const d = now.getDate();
  for (const id of Object.keys(FESTIVAL_DAYS) as FestivalId[]) {
    if (FESTIVAL_DAYS[id]!.some(([fm, fd]) => fm === m && fd === d)) return id;
  }
  // 农历节日：MMDD 字符串比对（表未收录年份不触发）
  const mmdd = `${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
  for (const [id, table] of Object.entries(LUNAR_FESTIVAL_SOLAR)) {
    if (table?.[now.getFullYear()] === mmdd) return id as FestivalId;
  }
  return null;
}

/** 今天命中哪个节日；未命中或被代码级禁用返回 null（now 可注入便于测试） */
export function currentFestival(now: Date = new Date()): FestivalId | null {
  const hit = resolveFestival(now);
  return hit && !DISABLED_FESTIVALS.has(hit) ? hit : null;
}

/**
 * 测试钩子：`npm run tauri dev --time YYMMDD` 经 scripts/tauri.mjs 注入 VITE_TEST_DATE，
 * 返回模拟的"今天"（固定 12 点整避开零点边界）；未注入（正常启动/生产构建）返回真实当前时间。
 */
export function festivalNow(): Date {
  const raw = import.meta.env.VITE_TEST_DATE as string | undefined;
  if (!raw || !/^\d{6}$/.test(raw)) return new Date();
  return new Date(2000 + Number(raw.slice(0, 2)), Number(raw.slice(2, 4)) - 1, Number(raw.slice(4, 6)), 12, 0, 0);
}
