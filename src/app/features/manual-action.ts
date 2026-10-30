import type { ActionPanelWindow, PanelAction } from '../action-panel-window';
import type { LegalChoice, TurnDecision } from '../battle-live';

/**
 * 手动出一手，或在同一块面板里确认认输。取消确认会重新亮出招卡片，不消耗这一手；
 * 确认后由调用方结束当前对局，这里不再给一个会被当成正常出手的后备动作。
 */
export async function chooseManualAction(options: {
  panel: ActionPanelWindow;
  choices: LegalChoice[];
  timeoutMs: number;
  title?: string;
  onTimeout?: () => void;
  forfeit: () => void;
}): Promise<TurnDecision | null> {
  const { panel, choices, timeoutMs, title, onTimeout, forfeit } = options;
  const actions: PanelAction[] = [
    ...choices.map((choice) => ({
      label: choice.label,
      ...(choice.note ? { note: choice.note } : {}),
      effect: choice.effect,
      tone: choice.tone,
    })),
    { label: '认输', effect: '结束这一场，按本方负场结算', tone: 'control' },
  ];
  while (true) {
    const pick = await panel.chooseAction(actions, timeoutMs, { title });
    if (pick === null) {
      onTimeout?.();
      return null;
    }
    const choice = choices[pick];
    if (choice) return { action: choice.action };
    if (pick !== choices.length) return null;
    const confirmed = await panel.choosePrompt('确定认输？', ['继续打', '认输'], timeoutMs);
    if (confirmed === 2) {
      forfeit();
      return null;
    }
    if (confirmed === null) return null;
  }
}
