import type { Command } from '../Command';
import { bus } from '../../core/events';

/**
 * Ctrl+P：全局搜索命令面板（剪贴板/待办/便签聚合搜索）。
 * 通过派发 global-search:toggle 事件，由主窗口的 GlobalSearch 组件响应开/关；
 * 主窗口未挂载该组件（理论不会发生）时事件无人响应，静默忽略。
 */
export class GlobalSearchCommand implements Command {
    async execute(event?: { state: string }): Promise<void> {
        if (event?.state !== 'Pressed') return;
        bus.emit('global-search:toggle');
    }
}
