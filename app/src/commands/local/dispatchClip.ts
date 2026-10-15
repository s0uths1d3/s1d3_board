import { v4 as uuidv4 } from 'uuid';
import clipboardService from '~/src/db/dbService';
import { DEFAULT_NOTE_COLORS } from '~/composables/useNoteColors';
import type { Todo, TodoLink } from '~/src/entities';

/**
 * 剪贴板 → 其他模块的共享分发管道（模块交互的地基）：
 * 右键菜单、拖拽到 Tab、灵动岛快捷动作、环盘分段落地动作等触发姿势
 * 全部收敛到这里，避免每处各自实现一遍「解析 → insertTodo/insertNote」。
 * Tab 内容区为 v-if 渲染：写入 DB 后切到目标 Tab 即重新挂载加载，无需额外刷新事件。
 */

/** 来源剪贴板内容在待办 links 中的标记（title 固定值）：完成待办时据此回写剪贴板使用计数 */
export const CLIP_SOURCE_LINK_TITLE = 'clipboard';

/** 清单行前缀（- [ ] / - [x] / - / * / •）：转待办时剥离前缀，勾选态映射为完成态 */
const TODO_LINE_RE = /^\s*(?:[-*•]\s*\[( |x|X)\]\s*|[-*•]\s+)(.+)$/;

/**
 * 多行文本 → 待办行解析：
 * - 逐非空行一条待办；命中清单前缀的行剥离前缀，`- [x]` 直接记为已完成；
 * - 单行且无前缀：整行一条（「复制一句话当任务」的常见用法不做多余加工）。
 */
export function parseTodoLines(content: string): { title: string; completed: 0 | 1 }[] {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  // length === 0 已先行返回，首行必存在
  if (lines.length === 1 && !TODO_LINE_RE.test(lines[0]!)) {
    return [{ title: lines[0]!, completed: 0 }];
  }
  return lines
    .map((line) => {
      const m = line.match(TODO_LINE_RE);
      if (!m) return { title: line, completed: 0 as const };
      // 正则命中时捕获组 2（行内容）必然存在
      return { title: m[2]!.trim(), completed: (m[1]?.toLowerCase() === 'x' ? 1 : 0) as 0 | 1 };
    })
    .filter((t) => t.title.length > 0);
}

/**
 * 剪贴板内容 → 待办：多行清单逐条创建（单行建一条），默认最低优先级；
 * sourceClip 提供时记入 links（title=clipboard 标记），完成待办时据此回写剪贴板使用计数。
 * 返回创建条数（0 = 内容无可解析行）。
 */
export async function clipToTodos(content: string, sourceClip?: TodoLink): Promise<number> {
  const items = parseTodoLines(content);
  const nowMs = String(Date.now());
  for (const it of items) {
    const todo: Todo = {
      id: uuidv4(),
      title: it.title,
      description: '',
      completed: it.completed,
      priorityLevel: 0,
      category: '',
      remindMode: 'smart',
      tags: [],
      links: sourceClip ? [sourceClip] : [],
      created_at: nowMs,
      updated_at: nowMs,
    };
    await clipboardService.insertTodo(todo);
  }
  return items.length;
}

/** 剪贴板内容 → 便签：默认黄色（配色第一项），文本原样落卡（多行保留换行） */
export async function clipToNote(content: string): Promise<void> {
  const nowMs = String(Date.now());
  await clipboardService.insertNote({
    id: uuidv4(),
    content,
    // 内置配色常量首项必存在
    color: DEFAULT_NOTE_COLORS[0]!.color,
    created_at: nowMs,
    updated_at: nowMs,
  });
}
