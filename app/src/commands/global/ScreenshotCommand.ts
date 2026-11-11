import type { Command } from '../Command';
import { openSnip, type SnipEntry } from '../../snip/snipManager';
import { ensureSnipSettingsLoaded, isSnipEnabled, useSnipDelaySec } from '../../snip/snipSettings';
import { notifyIsland } from '~/composables/useCopyIsland';
import { useI18n } from '~/composables/useI18n';

/**
 * 全局唤起截图（任何应用中生效）。
 * 总开关关闭时不建窗，弹岛提示设置入口；会话进行中的重复触发由 snipManager 忽略。
 * 延时截图（snip_delay_sec > 0）：岛提示倒计时后自动进入框选。
 *
 * entry 由快捷键配置决定（多入口）：
 *   region = 自由框选；fullscreen = 光标所在整屏；
 *   window = 光标下的窗口；last = 上次确认的选区。
 */
export class ScreenshotCommand implements Command {
  constructor(private readonly entry: SnipEntry = 'region') {}

  async execute(event?: { state: string }): Promise<void> {
    if (event?.state !== 'Pressed') return;
    const { t } = useI18n();
    if (!(await isSnipEnabled())) {
      notifyIsland({ kind: 'info', text: t('snip.disabled_notice') });
      return;
    }
    await ensureSnipSettingsLoaded();
    const delay = useSnipDelaySec().value;
    if (delay > 0) {
      notifyIsland({ kind: 'info', text: t('snip.delay_notice', { n: delay }) });
      setTimeout(() => { void openSnip(this.entry); }, delay * 1000);
      return;
    }
    await openSnip(this.entry);
  }
}
