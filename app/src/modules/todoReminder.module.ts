import type { AppModule } from '../core/registry';
import reminderService from '../todo/reminderService';

/**
 * 待办智能提醒模块：调度服务挂主窗口（切 Tab 不丢定时器；内部幂等，
 * TodoList 侧会兜底再调）。读取待办提醒设置，依赖 settings 域先行装配。
 */
export const todoReminderModule: AppModule = {
    id: 'todo-reminder',
    dependencies: ['settings'],
    start() {
        void reminderService.start();
    },
};
