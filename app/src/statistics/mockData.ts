import Database from "@tauri-apps/plugin-sql";

/**
 * 演示数据生成器（Mock Data）
 *
 * 目的：统计模块有显示门槛（§7.9：活跃 ≥ 7 天 且 粘贴 ≥ 1000 次），
 * 全新环境下统计 Tab 不可见。本模块生成一段"重度使用者"的历史统计数据，
 * 用于直接展示统计页的全部能力（指标卡片 / 标签 / 大标签 / 趣味数据 / 趋势图）。
 *
 * 特性：
 * - 幂等：`daily_stat` 已有数据时跳过，绝不覆盖真实统计；
 * - 确定性：使用固定种子伪随机，每次生成结果一致；
 * - 独立：只写 `daily_stat` 与 `clipboard`（复制之王趣味项），不碰待办/便签。
 */

/** 生成天数：约半年，足以展示"月/年"范围与标签的 15 天门槛 */
const MOCK_DAYS = 180;

/** 确定性伪随机数生成器（mulberry32） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在 [min, max] 区间取整数 */
function rint(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 待写入的每日统计行 */
interface MockDay {
  date: string;
  row: Record<string, number>;
}

export function buildMockDays(): MockDay[] {
  const rand = mulberry32(20260826);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days: MockDay[] = [];

  for (let i = MOCK_DAYS - 1; i >= 0; i--) {
    const date = new Date(today.getTime() - i * 86400000);
    const clipText = rint(rand, 160, 200);
    const clipImage = rint(rand, 5, 15);
    const clipUse = rint(rand, 190, 230);
    const todoAdded = rint(rand, 3, 6);
    const todoCompleted = Math.min(todoAdded, rint(rand, 2, 5));
    const todoDeleted = rint(rand, 0, 2);
    const noteAdded = rint(rand, 1, 4);
    const noteDeleted = rint(rand, 0, 2);
    const favToggle = rint(rand, 1, 5);
    const usageSeconds = rint(rand, 3600, 14400);
    const shortcutCount = rint(rand, 170, 230);
    const tabClip = rint(rand, 10, 20);
    const tabTodo = rint(rand, 4, 10);
    const tabNote = rint(rand, 3, 8);
    const tabPinned = rint(rand, 2, 6);
    const tabSetting = rint(rand, 0, 3);
    const tabStatistics = rint(rand, 1, 3);

    // 时段分布（每次 record 都会给某时段 +1，故总和 = 当日操作总数）
    const ops = clipText + clipImage + clipUse
      + todoAdded + todoCompleted + todoDeleted
      + noteAdded + noteDeleted + favToggle
      + shortcutCount + tabClip + tabTodo + tabNote + tabPinned + tabSetting + tabStatistics;
    const dawn = Math.round(ops * 0.08);
    const day = Math.round(ops * 0.53);
    const evening = Math.round(ops * 0.27);
    const night = Math.max(0, ops - dawn - day - evening);

    days.push({
      date: fmtDate(date),
      row: {
        clip_text: clipText,
        clip_image: clipImage,
        clip_use: clipUse,
        clip_chars: rint(rand, 2000, 5000),
        todo_added: todoAdded,
        todo_completed: todoCompleted,
        todo_deleted: todoDeleted,
        todo_chars: rint(rand, 200, 1200),
        note_added: noteAdded,
        note_deleted: noteDeleted,
        favorite_toggle: favToggle,
        usage_seconds: usageSeconds,
        shortcut_count: shortcutCount,
        tab_clip: tabClip,
        tab_todo: tabTodo,
        tab_note: tabNote,
        tab_pinned: tabPinned,
        tab_setting: tabSetting,
        tab_statistics: tabStatistics,
        active_dawn: dawn,
        active_day: day,
        active_evening: evening,
        active_night: night,
      },
    });
  }
  return days;
}

/** 演示用的剪贴板文本（用于"复制之王"趣味项与剪贴板列表展示） */
const MOCK_CLIP_TEXTS: string[] = [
  'https://vuejs.org/guide/quick-start.html',
  'https://github.com/tauri-apps/tauri',
  'npm install @tauri-apps/api @tauri-apps/plugin-sql',
  'function debounce(fn, delay) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); }; }',
  'const { data } = await clipboardService.fetchClipboardData(filter)',
  'git commit -m "feat: 统计模块上线"',
  'SELECT * FROM daily_stat WHERE stat_date BETWEEN $1 AND $2',
  'Rust 语言安全高效，适合系统级开发',
  '译文：S1d3 Board 是一块轻量、优雅的剪贴板管理看板',
  'docker run -d -p 8080:80 --name web nginx:alpine',
  'curl -X POST https://api.example.com/upload -F "file=@report.pdf"',
  'body { font-family: system-ui, -apple-system, sans-serif; }',
  'INSERT INTO clipboard (content, type) VALUES ($1, $2)',
  'Ctrl+Shift+P 打开命令面板',
  'useEffect(() => { fetchData() }, [activeTab])',
  'TaRUI v2 插件体系：sql / global-shortcut / clipboard',
  '需求文档：统计模块设计文档 v0.19',
  'productivity: 高效能人士的七个习惯',
  'type TabKey = "clip" | "todo" | "note" | "pinned" | "setting" | "statistics"',
  '⚠ 注意：请先备份再升级数据库',
];

/**
 * 生成演示数据。
 * @param force 是否强制重建：true 时清空 daily_stat 后重新生成（用于手动添加测试数据验证统计功能）；
 *              默认 false 保持幂等——已有真实统计数据则跳过，绝不覆盖。
 * @returns true = 已生成；false = 跳过（非强制且已有数据）
 */
export async function seedMockStats(force = false): Promise<boolean> {
  const db = await Database.load('sqlite:s1d3_board.db');

  // 幂等：已有真实统计数据则跳过（force 时强制重建）
  if (!force) {
    const rows: any[] = await db.select('SELECT COUNT(*) AS cnt FROM daily_stat');
    if ((rows?.[0]?.cnt ?? 0) > 0) return false;
  } else {
    // 强制模式：清空统计表重建，确保演示数据完整可复现
    await db.execute('DELETE FROM daily_stat');
  }

  const days = buildMockDays();

  // 1) daily_stat 逐日写入
  for (const { date, row } of days) {
    const cols = Object.keys(row);
    const vals = cols.map(c => row[c] ?? 0);
    await db.execute(
      `INSERT INTO daily_stat (stat_date, ${cols.join(', ')})
       VALUES ($1, ${vals.map((_, i) => `$${i + 2}`).join(', ')})`,
      [date, ...vals]
    );
  }

  // 2) clipboard 演示记录（复制之王）：INSERT OR IGNORE 避免与真实内容冲突
  const now = Date.now();
  const rand = mulberry32(20260827);
  for (let i = 0; i < MOCK_CLIP_TEXTS.length; i++) {
    const content = MOCK_CLIP_TEXTS[i]!;
    const createdAt = now - (i + 5) * 3600_000;
    // 第 1 条设为最高使用次数（复制之王）
    const count = i === 0 ? 888 : rint(rand, 1, 30);
    await db.execute(
      `INSERT OR IGNORE INTO clipboard (content, category, type, count, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [content, 'T', 'text', count, '演示数据', createdAt, createdAt]
    );
  }

  console.log(`[mock] 已生成演示统计：${days.length} 天 / ${MOCK_CLIP_TEXTS.length} 条剪贴板记录`);
  return true;
}

/** 判断当前是否处于"无任何统计数据"状态（供解锁逻辑决定是否生成演示数据） */
export async function isStatsEmpty(): Promise<boolean> {
  try {
    const db = await Database.load('sqlite:s1d3_board.db');
    const rows: any[] = await db.select('SELECT COUNT(*) AS cnt FROM daily_stat');
    return (rows?.[0]?.cnt ?? 0) === 0;
  } catch {
    return true;
  }
}
