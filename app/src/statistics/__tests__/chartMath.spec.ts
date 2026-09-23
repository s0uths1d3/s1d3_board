import { describe, expect, it } from 'vitest';
import {
    OPS_FIELDS, totalOps, buildHeatmapCells, weekdayAverages, alignGhost, dateRangeToMs,
    type SeriesRow,
} from '../chartMath';
import type { StatsSummary } from '../../statistics/statsService';

/** 快捷构造聚合结果 */
function stats(partial: Partial<Record<string, number>>): StatsSummary {
    return { ...partial } as StatsSummary;
}

function rows(list: [string, number][]): SeriesRow[] {
    return list.map(([stat_date, value]) => ({ stat_date, value }));
}

// ---------------------------------------------------------------------------
// OPS_FIELDS / totalOps：口径
// ---------------------------------------------------------------------------
describe('totalOps', () => {
    it('汇总 OPS_FIELDS 全部字段', () => {
        expect(OPS_FIELDS).toHaveLength(16);
        expect(totalOps(stats({ clip_text: 3, clip_image: 2, tab_clip: 5, shortcut_count: 1 }))).toBe(11);
    });

    it('缺省字段按 0 计；不含时段与 tab_app_usage', () => {
        expect(totalOps(stats({}))).toBe(0);
        expect(OPS_FIELDS).not.toContain('tab_app_usage');
        expect(OPS_FIELDS).not.toContain('active_night');
    });
});

// ---------------------------------------------------------------------------
// buildHeatmapCells：热力图分格
// ---------------------------------------------------------------------------
describe('buildHeatmapCells', () => {
    const label = (m: number) => `${m + 1}月`;

    it('共 371 格（53 整列×7）、末格为 endDate 所在周周日', () => {
        const g = buildHeatmapCells([], '2026-09-23', label);
        expect(g.cells).toHaveLength(371);
        expect(g.cells[g.cells.length - 1]!.date).toBe('2026-09-27'); // 2026-09-27 是周日
        expect(g.cells[g.cells.length - 1]!.weekIdx).toBe(52);
        expect(g.cells[g.cells.length - 1]!.dayIdx).toBe(6);
        // 占位格（endDate 之后）值恒为 0
        expect(g.cells[g.cells.length - 1]!.value).toBe(0);
    });

    it('首列对齐周一（dayIdx 0 = 周一）', () => {
        const g = buildHeatmapCells([], '2026-09-23', label);
        // 2026-09-23 是周三（dayIdx 2）
        const end23 = g.cells.find(c => c.date === '2026-09-23')!;
        expect(end23.dayIdx).toBe(2);
        for (const c of g.cells) {
            if (c.dayIdx === 0) {
                const d = new Date(`${c.date}T00:00:00`);
                expect((d.getDay() + 6) % 7).toBe(0);
            }
        }
    });

    it('缺失日补 0；命中日取序列值', () => {
        const g = buildHeatmapCells(rows([['2026-09-23', 7]]), '2026-09-23', label);
        const hit = g.cells.find(c => c.date === '2026-09-23')!;
        expect(hit.value).toBe(7);
        const miss = g.cells.find(c => c.date === '2026-09-22')!;
        expect(miss.value).toBe(0);
    });

    it('level 五档边界（>0 / ≥25% / ≥50% / ≥75% of max）', () => {
        // max = 100：1 → 1 档；25 → 2；50 → 3；75 → 4；99 → 4；100 → 4
        const g = buildHeatmapCells(
            rows([['2026-09-14', 1], ['2026-09-15', 25], ['2026-09-16', 50], ['2026-09-17', 75], ['2026-09-18', 99], ['2026-09-19', 100]]),
            '2026-09-23', label,
        );
        const by = (d: string) => g.cells.find(c => c.date === d)!.level;
        expect(by('2026-09-14')).toBe(1);
        expect(by('2026-09-15')).toBe(2);
        expect(by('2026-09-16')).toBe(3);
        expect(by('2026-09-17')).toBe(4);
        expect(by('2026-09-18')).toBe(4);
        expect(by('2026-09-19')).toBe(4);
        expect(by('2026-09-20')).toBe(0);
    });

    it('月份标注落在每月 1 号所在列且同列去重', () => {
        const g = buildHeatmapCells([], '2026-09-23', label);
        const seen = new Set(g.months.map(m => m.idx));
        expect(seen.size).toBe(g.months.length);
        // 网格覆盖 2025-10 ~ 2026-09，共 12 个月份标注
        expect(g.months).toHaveLength(12);
        // 2026-09-01 的标注列必须与该日期所在列一致
        const sep1 = g.cells.find(c => c.date === '2026-09-01')!;
        expect(g.months.some(m => m.label === '9月' && m.idx === sep1.weekIdx)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// weekdayAverages：星期节奏
// ---------------------------------------------------------------------------
describe('weekdayAverages', () => {
    it('按周一~周日归桶并求均值', () => {
        // 2026-09-21 周一、09-22 周二、09-27 周日
        const avg = weekdayAverages(rows([['2026-09-21', 10], ['2026-09-28', 20], ['2026-09-22', 4], ['2026-09-27', 9]]));
        expect(avg[0]).toBe(15); // 周一 (10+20)/2
        expect(avg[1]).toBe(4);  // 周二
        expect(avg[6]).toBe(9);  // 周日
        expect(avg.slice(2, 6).every(v => v === 0)).toBe(true);
    });

    it('无记录日期行跳过、非法日期忽略', () => {
        const avg = weekdayAverages(rows([['2026-09-21', 6], ['not-a-date', 99]]));
        expect(avg[0]).toBe(6);
        expect(avg.reduce((s, v) => s + v, 0)).toBe(6);
    });
});

// ---------------------------------------------------------------------------
// alignGhost：环比对齐
// ---------------------------------------------------------------------------
describe('alignGhost', () => {
    it('逐日等长区间按索引对齐', () => {
        const g = alignGhost(
            rows([['2026-09-01', 1], ['2026-09-02', 2]]),
            rows([['2026-08-01', 9], ['2026-08-02', 8]]),
        );
        expect(g).toEqual([
            { stat_date: '2026-09-01', value: 9 },
            { stat_date: '2026-09-02', value: 8 },
        ]);
    });

    it('长度不齐截断最短（降采样月数差 1）', () => {
        const g = alignGhost(rows([['2026-07', 1], ['2026-08', 2], ['2026-09', 3]]), rows([['2026-04', 7], ['2026-05', 8]]));
        expect(g).toHaveLength(2);
        expect(g[1]).toEqual({ stat_date: '2026-08', value: 8 });
    });

    it('空序列返回空', () => {
        expect(alignGhost([], rows([['2026-08-01', 1]]))).toEqual([]);
        expect(alignGhost(rows([['2026-08-01', 1]]), [])).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// dateRangeToMs：毫秒边界
// ---------------------------------------------------------------------------
describe('dateRangeToMs', () => {
    it('start 为当日 00:00 本地毫秒，end 为次日 00:00（开区间）', () => {
        const { startMs, endMs } = dateRangeToMs('2026-09-23', '2026-09-23');
        expect(startMs).toBe(new Date(2026, 8, 23).getTime());
        expect(endMs - startMs).toBe(86400000);
    });

    it('跨日区间 end 含末日全天', () => {
        const { startMs, endMs } = dateRangeToMs('2026-09-01', '2026-09-30');
        expect(endMs - startMs).toBe(30 * 86400000);
    });
});
