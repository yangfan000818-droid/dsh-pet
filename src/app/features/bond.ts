/**
 * 羁绊接线：好感度、小剧场小窗、跟班窗口，以及和聊天 / 战斗 / 串门的挂钩。
 *
 * 纯逻辑在 `src/app/bond.ts`；这里只管窗口、菜单、说话和存盘时机。
 * 好感来源：
 *   - 对话成功（host 的 onChat 回调）；
 *   - 小窗里的「摸摸头」「喂零食」；
 *   - 打赢一场（trial.ts / spar.ts / duel.ts 调 bondReward('battle')）；
 *   - 串门回家（visiting.ts 调 bondReward('visit')）。
 * 分工约定：对话里只把关系阶段喂给提示词，不主动剧透 pending 的心事（bond.chatContext）。
 */
import { BOND_SCENES, Bond } from '../bond';
import type { BondAction, BondView } from '../bond-window';
import { openBondWindow } from '../bond-window';
import type { BondWindow } from '../bond-window';
import type { CompanionWindow } from '../companion-window';
import { openCompanionWindow } from '../companion-window';
import { COMPANION_NAME_MAX } from '../bond';
import { lazyFns } from './context';
import type { FeatureContext } from './context';

export interface BondFeature {
  /** 菜单项文案：有待演的小剧场时变成「羁绊 · 有话想说」 */
  bondMenuLabel(): string;
  /** 打开羁绊小窗（已经在开就提到前面） */
  openBond(): Promise<void>;
  /** 对话专用上下文：关系阶段 + 跟班 */
  bondContext(): string;
  /** 一次成功对话（host 回调；只有主宠物算） */
  onChat(petId: string, text: string): void;
  /** 其它来源：打赢一场 / 串门回来 */
  bondReward(kind: 'battle' | 'visit'): void;
  /** 退出：关窗、停跟班 */
  disposeBond(): void;
}

export function createBond(ctx: FeatureContext): BondFeature {
  const { deps, log, electron, pouch, diary, homePet } = ctx;
  const { petId, say, refreshMenu } = lazyFns(ctx);
  const origin = new URL(deps.petBase).origin;
  const bond = new Bond(deps.bondPath, Date.now(), (message) => log(`羁绊：${message}`));
  /** 小窗一次只开一个；opening 防连点 */
  let panel: BondWindow | null = null;
  let opening = false;
  /** 小窗里显示一次的提示（「它蹭了蹭你的手」这类），下一次 render 后清掉 */
  let flash = '';
  let companion: CompanionWindow | null = null;

  /** 打击 / 历练 / 串门 / 退出时跟班躲起来 */
  function busy(): boolean {
    const state = ctx.state;
    return (
      state.disposed ||
      state.battle !== null ||
      state.liveBattle !== null ||
      // adventure 对象建过就一直留着；只有小窗真的开着 / 这一趟还在走才算忙
      state.adventure?.blocking === true ||
      state.showLock !== null ||
      state.trialWindowGroups.size > 0 ||
      state.sparWindows.size > 0 ||
      state.hosting !== null ||
      state.trip !== null
    );
  }

  function asset(name: string): string {
    return `${origin}/dsh-pet-7340/pic/bond/${encodeURIComponent(name)}`;
  }

  /** 跟班窗口：开着就不重复开；关掉时一并清掉 */
  function ensureCompanion(): void {
    if (companion || !bond.companionEnabled()) return;
    companion = openCompanionWindow(electron, `${origin}/app/companion`, asset('跟班.png'), homePet.box, busy);
  }

  function closeCompanion(): void {
    companion?.close();
    companion = null;
  }

  function statusView(): BondView {
    const status = bond.status(Date.now());
    const scene = bond.stageImage();
    const lines: string[] = [];
    if (flash) lines.push(flash);
    lines.push(status.stageLine);
    if (status.pending) lines.push('它好像有话想跟你说，但一直没找到合适的时机。');
    else if (status.stage === 0) lines.push('多陪它聊聊天、摸摸它，关系会慢慢变近。');
    else lines.push(`跟班「${status.companion.name}」${status.companion.enabled ? '正在你脚边飘着。' : '在家休息。'}`);
    const snacks = pouch.kinds();
    const buttons = [
      ...(status.pending ? [{ id: 'story', label: '听它说…', primary: true }] : []),
      { id: 'touch', label: '摸摸头 +2' },
      {
        id: 'feed',
        label: snacks.length > 0 ? `喂${status.companion.name} +3` : '喂零食（袋子空）',
        disabled: snacks.length === 0,
      },
      { id: 'companion', label: status.companion.enabled ? '让小跟班回家' : '带小跟班出来' },
      { id: 'rename', label: '改个名字' },
      { id: 'close', label: '关上' },
    ];
    flash = '';
    return {
      kind: 'status',
      title: `羁绊 · ${status.stageName}`,
      subtitle:
        status.nextAt === null
          ? `好感度 ${status.points} · 一起第 ${status.days} 天`
          : `好感度 ${status.points} / ${status.nextAt} · 一起第 ${status.days} 天`,
      progress: status.percent,
      ...(scene ? { image: asset(scene.image) } : {}),
      lines,
      input: { value: status.companion.name, placeholder: '给跟班起个名字', maxLength: COMPANION_NAME_MAX },
      buttons,
    };
  }

  function sceneView(sceneId: string): BondView {
    const scene = BOND_SCENES[sceneId as keyof typeof BOND_SCENES];
    const status = bond.status(Date.now());
    flash = '';
    return {
      kind: 'scene',
      title: scene.title,
      subtitle: `羁绊 · ${status.stageName}`,
      progress: status.percent,
      image: asset(scene.image),
      lines: scene.intro,
      buttons: [
        ...scene.choices.map((choice, index) => ({
          id: `choose:${choice.id}`,
          label: choice.label,
          ...(index === 0 ? { primary: true } : {}),
        })),
        { id: 'postpone', label: '下次再说' },
      ],
    };
  }

  function resultView(sceneId: string, choiceId: string): BondView {
    const scene = BOND_SCENES[sceneId as keyof typeof BOND_SCENES];
    const choice = scene.choices.find((item) => item.id === choiceId);
    const status = bond.status(Date.now());
    const lines = choice ? [...choice.reply] : [];
    if (choice?.bonus) lines.push(`（羁绊 +${choice.bonus}）`);
    if (status.pending && status.pending !== sceneId) lines.push('它好像还有话想说。');
    flash = '';
    return {
      kind: 'result',
      title: scene.title,
      subtitle: `羁绊 · ${status.stageName}`,
      progress: status.percent,
      image: asset(scene.image),
      lines,
      buttons: [{ id: 'result', label: '继续', primary: true }],
    };
  }

  /**
   * 小窗里的一次操作。返回下一份视图；返回 null = 用户关窗，收摊。
   * 所有状态变更都走 Bond（它自己落盘），这里不直接改存档字段。
   */
  async function handle(action: BondAction): Promise<BondView | null> {
    const now = Date.now();
    if (action.action === 'close') return null;
    if (action.action === 'story') {
      const pending = bond.status(now).pending;
      if (!pending) {
        flash = '它现在没什么想说的。';
        return statusView();
      }
      return sceneView(pending);
    }
    if (action.action === 'postpone') {
      flash = '它把到嘴边的话咽了回去。';
      return statusView();
    }
    if (action.action === 'result') return statusView();
    if (action.action.startsWith('choose:')) {
      const pending = bond.status(now).pending;
      if (!pending) return statusView();
      const choiceId = action.action.slice('choose:'.length);
      const result = bond.choose(pending, choiceId);
      if (!result) {
        flash = '这句话没接上，再试一次吧。';
        return statusView();
      }
      void refreshMenu();
      companion?.setMood('happy');
      companion?.say('唔哇…');
      return resultView(pending, choiceId);
    }
    if (action.action === 'touch') {
      const gain = bond.add('touch', now);
      if (gain.added > 0) {
        flash = `它眯起眼睛，往你手心里蹭了蹭。（羁绊 +${gain.added}）`;
        companion?.setMood('happy');
        void say('嘿嘿……');
      } else {
        flash = '它刚刚才蹭过你，等会儿再来吧。';
      }
      if (gain.scene) {
        void refreshMenu();
        void say('有件事想跟你说…忙完点一下「羁绊」好不好？');
      }
      return statusView();
    }
    if (action.action === 'feed') {
      const snack = pouch.kinds()[0];
      if (!snack) {
        flash = '零食袋空啦。';
        return statusView();
      }
      // 先加好感；被每日上限挡住时不吃掉零食（别白白浪费一份）
      const gain = bond.feedCompanion(now);
      if (gain.added === 0) {
        flash = '它刚吃过，先放着吧。';
        return statusView();
      }
      pouch.take(snack.label);
      diary.note(now, 'snack', `喂了跟班「${bond.companionName()}」一份${snack.label}`);
      flash = `${bond.companionName()}吃掉了${snack.label}，尾巴摇得飞快。（羁绊 +${gain.added}）`;
      companion?.setMood('happy');
      companion?.say('咕噜咕噜～');
      if (gain.scene) {
        void refreshMenu();
        void say('有件事想跟你说…忙完点一下「羁绊」好不好？');
      }
      return statusView();
    }
    if (action.action === 'companion') {
      const enabled = !bond.companionEnabled();
      bond.setCompanionEnabled(enabled);
      if (enabled) {
        ensureCompanion();
        companion?.setMood('happy');
        flash = `${bond.companionName()}飘出来了。`;
      } else {
        closeCompanion();
        flash = `${bond.companionName()}回家休息了。`;
      }
      return statusView();
    }
    if (action.action === 'rename') {
      if (bond.renameCompanion(action.value ?? '')) {
        flash = `以后就叫它「${bond.companionName()}」啦。`;
        companion?.say('我叫' + bond.companionName() + '！');
      } else {
        flash = `名字没变（最多 ${COMPANION_NAME_MAX} 个字）。`;
      }
      return statusView();
    }
    return statusView();
  }

  async function openBond(): Promise<void> {
    if (panel) {
      panel.focus();
      return;
    }
    if (opening) return;
    opening = true;
    const win = openBondWindow(electron, `${origin}/app/bond`, homePet.box);
    panel = win;
    try {
      let view = statusView();
      for (;;) {
        win.render(view);
        const action = await win.wait();
        const next = await handle(action);
        if (!next) break;
        view = next;
      }
    } catch {
      // 用户把窗口关了：没有要报的错，直接收摊
    } finally {
      opening = false;
      panel = null;
      win.close();
    }
  }

  function reward(kind: 'battle' | 'visit'): void {
    const gain = bond.add(kind, Date.now());
    if (gain.added === 0) return;
    companion?.setMood('happy');
    if (gain.scene) {
      void refreshMenu();
      void say('有件事想跟你说…忙完点一下「羁绊」好不好？');
    }
  }

  // 启动时就按存档决定跟班要不要出来
  ensureCompanion();

  return {
    bondMenuLabel: () => (bond.status(Date.now()).pending ? '羁绊 · 有话想说' : '羁绊'),
    openBond,
    bondContext: () => bond.chatContext(Date.now()),
    onChat: (id) => {
      // 只有主宠物的对话算：多开宠物时，和别的宠物聊天不该涨这段关系
      if (id !== petId()) return;
      const gain = bond.add('chat', Date.now());
      if (gain.added === 0) return;
      if (gain.scene) {
        void refreshMenu();
        void say('有件事想跟你说…忙完点一下「羁绊」好不好？');
      }
    },
    bondReward: reward,
    disposeBond() {
      panel?.close();
      panel = null;
      closeCompanion();
    },
  };
}
