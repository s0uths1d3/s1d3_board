import type { Command } from '../Command';
import { openSnip } from '../../snip/snipManager';
import { ensureSnipSettingsLoaded, isSnipEnabled, useSnipDelaySec } from '../../snip/snipSettings';
import { notifyIsland } from '~/composables/useCopyIsland';
import { useI18n } from '~/composables/useI18n';

/**
 * Ctrl+Alt+A：全局唤起截图（任何应用中生效）。
 * 总开关关闭时不建窗，弹岛提示设置入口；会话进行中的重复触发由 snipManager 忽略。
 * 延时截图（snip_delay_sec > 0）：岛提示倒计时后自动进入框选。
 */
export class ScreenshotCommand implements Command {
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
      setTimeout(() => { void openSnip(); }, delay * 1000);
      return;
    }
    await openSnip();
  }
}
