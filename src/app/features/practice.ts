import { SKILLS, WEAPONS } from '../battle';
import { FX_ASSETS } from '../battle-show';
import { Cultivation, stageLabel } from '../cultivation';
import type { CultivationEvent } from '../cultivation';
import { foeStage, homeStage, openFxWindow } from '../fx-window';
import type { FxWindow, Stage } from '../fx-window';
import type { Rect } from '../visit-windows';
import { MENU_CULTIVATION_GROUP, lazyFns } from './context';
import type { FeatureContext, SayOptions } from './context';
import { errorText } from './util';

/** 修炼：开关、修炼事件冒泡、修炼素材播放、演出特效层、修炼菜单项 */
export interface Practice {
  cultivationOn(): Cultivation | null;
  onCultivation(now: number, events: CultivationEvent[], options?: SayOptions): void;
  playExtra(name: string, options?: { facing?: 'left' | 'right'; rate?: number }): Promise<void>;
  playPooled(name: string, rate: number): Promise<void>;
  openShowFx(foeBounds: () => Rect | null, foeOnLeft: () => boolean, foeShadow?: boolean): FxWindow;
  cultivationActions(): Map<string, () => unknown>;
}

export function createPractice(ctx: FeatureContext): Practice {
  const {
    ensureAdventure,
    forfeitBattle,
    petRequest,
    refreshMenu,
    runAdventure,
    runTrial,
    say,
    sayLine,
    speak,
    skipTrial,
    tribulationActions,
  } = lazyFns(ctx);
  const { deps, log, electron, diary, homePet } = ctx;
  /** 开关开着才有修炼；第一次用到时建档（开关关着不建 cultivation.json） */
  function cultivationOn(): Cultivation | null {
    if (!deps.appConfig().cultivation.enabled) return null;
    if (!ctx.state.cultivation)
      ctx.state.cultivation = new Cultivation(deps.cultivationPath, (m) => log(`修炼：${m}`), deps.cultivationRng);
    return ctx.state.cultivation;
  }

  /**
   * 修炼事件：冒泡（排进现有的说话队列）+ 记日记。
   * @param options 冒空气泡的选项：X3 演完一场时的奖励冒泡要传 `{ anim: false }`——
   *   收场的胜利 / 倒地动画还在播，带 anim 的气泡会把它顶掉（X2 真机踩过的坑）
   */
  function onCultivation(now: number, events: CultivationEvent[], options: SayOptions = {}): void {
    const view = ctx.state.cultivation?.view();
    // 正在演一场：冒泡一律 anim: false——升级、炼丹这些气泡撞上演出，会把正在播的动画顶掉（X2 真机的坑）
    if (ctx.state.battle || ctx.state.liveBattle || ctx.state.actionPanel) options = { ...options, anim: false };
    for (const event of events) {
      if (event.kind === 'stage-up') {
        void sayLine(`修为精进，到${stageLabel(event.stage)}啦～`, options);
        diary.note(now, 'cultivate', `修为精进，到了${stageLabel(event.stage)}`);
      } else if (event.kind === 'full') {
        void speak('修为刚修满一个大境界（圆满），可以渡劫了。跟主人说一声。', '可以渡劫了～', options);
        diary.note(now, 'cultivate', '修为圆满，可以渡劫了');
      } else if (event.kind === 'breakthrough') {
        // 突破的 `修炼-突破` 动画与那句感言都在渡劫的演出里（battle-show 的收场 + runTribulation 的结果感言），
        // 这里只记日记——再播一遍、再说一句就是重复（§X4 每次渡劫只 +1 次模型调用）
        diary.note(now, 'cultivate', `渡劫成功，突破到${view?.label ?? '下一个大境界'}`);
      } else if (event.kind === 'offer') {
        // 二选一挂出来了（菜单两项，10 分钟）：模板句，不调模型（§X4 每次渡劫只 +1 次）
        void sayLine(`有两个新招式可以领悟：${SKILLS[event.a].name}和${SKILLS[event.b].name}，右键「修炼」里挑一个～`, {
          ...options,
          anim: false,
        });
      } else if (event.kind === 'choose') {
        void sayLine(`我领悟了${SKILLS[event.skill].name}～`, options);
        diary.note(now, 'cultivate', `领悟了${SKILLS[event.skill].name}`);
      } else if (event.kind === 'tribulation-fail') {
        void sayLine(event.lost > 0 ? `没扛住，修为退了 ${event.lost}` : '没扛住天雷，修为一点没退', options);
        diary.note(now, 'cultivate', `渡劫没扛住，修为退了 ${event.lost}`);
      } else if (event.kind === 'rest') {
        void sayLine(`调息回来，修为 +${event.gain}`, options);
        diary.note(now, 'cultivate', `调息，修为 +${event.gain}`);
      } else if (event.kind === 'pill') {
        void sayLine('炼成一颗破境丹～', options);
        diary.note(now, 'cultivate', '炼成一颗破境丹');
      } else if (event.kind === 'xp') {
        // 一场的进账（心魔试炼 / 切磋）：只在真的进了账时才发（圆满、当天不算收益的切磋、连点没恢复的心魔都没有这条）
        void sayLine(`这一场修为 +${event.amount}`, options);
      } else if (event.kind === 'trial-tired') {
        // 心魔收益随间隔恢复：离上一场不到 10 分钟只给一部分（连点就一点没有），说一声免得以为白打了
        void sayLine(`心魔还没缓过来，这一场收益打了折；再过 ${event.minutes} 分钟打才是满额～`, options);
      } else if (event.kind === 'title') {
        // 秘境结局给的称号（Y1 只入账；真正的演出在 Y3 的历练小窗）
        void sayLine(`得了称号「${event.title}」～`, options);
        diary.note(now, 'cultivate', `得了称号「${event.title}」`);
      } else {
        // 打赢心魔掉了一件还没有的法宝
        void sayLine(`得到法宝：${WEAPONS[event.weapon].name}～`, options);
        diary.note(now, 'cultivate', `得到法宝：${WEAPONS[event.weapon].name}`);
      }
    }
  }

  /**
   * 播一段修炼 / 战斗的新素材（修炼-打坐、战斗-起手、法宝-水枪 等）。这些素材不注册进动画池
   * （用户的 main-config.jsonc 会整段替换 animations），一律走 /anim 的 url 形态；
   * 素材缺了只是那一下没动画，播之前不查文件在不在。
   * 注意：之后任何带 anim 的气泡（/broadcast 默认联动说话动画）都会把它顶掉——
   * 要边播边说话就用 anim: false 的气泡（X3 的对战演出都得这样）。
   * @param facing 对战要面朝对手（素材统一画成朝左，宠物朝右站时整段镜像）
   * @param rate 倍速（0.5–3）：让一段 4–6 秒的素材正好占满时间线上的一步（battle-show 算好传进来）
   */
  function playExtra(name: string, options: { facing?: 'left' | 'right'; rate?: number } = {}): Promise<void> {
    return petRequest('POST', '/anim', {
      url: `${deps.petBase}/thumb/main/${encodeURIComponent(name)}.webm`,
      ...(options.facing ? { facing: options.facing } : {}),
      ...(options.rate === undefined ? {} : { rate: options.rate }),
    })
      .then((result) => {
        if (result.ok !== true) log(`播放动画失败（${name}）：${JSON.stringify(result)}`);
      })
      .catch((error: unknown) => log(`播放动画失败（${name}）：${errorText(error)}`));
  }

  /**
   * 播一段**动画池里的现有素材**（`/anim` 的名字形态；§X4 渡劫失败播「工作状态-垂头叹气冒汗」）。
   * 池里的名字由用户的 main-config.jsonc 整段替换（animations.events.workStatus 那一档），
   * 名字不在池里宿主回 unknown-animation——只是那一下没动画，气泡和气血条照旧（§2.3 的素材缺失口径）。
   */
  function playPooled(name: string, rate: number): Promise<void> {
    return petRequest('POST', '/anim', { name, rate })
      .then((result) => {
        if (result.ok !== true) log(`播放池内动画失败（${name}）：${JSON.stringify(result)}`);
      })
      .catch((error: unknown) => log(`播放池内动画失败（${name}）：${errorText(error)}`));
  }

  /**
   * 开这一场的**特效窗口**（X7）：盖住两只宠物，把飞行物从出手方手里画到对方身上。
   * 两只的舞台：自家宠物从 `homePet.box()` 推、对手从它窗口的 bounds 推（都在 fx-window.ts 的纯函数里）；
   * 朝向跟着「对手在哪一边」——自家宠物面朝对手、对手面朝自家宠物，`hand` 才落在挥出的那只手上。
   * 摆不了（还没收到宠物位置）时那边打一行 warn、回一个空操作的窗口：时间线、台词、气血条照常走。
   */
  function openShowFx(foeBounds: () => Rect | null, foeOnLeft: () => boolean, foeShadow = false): FxWindow {
    return openFxWindow(
      electron,
      `${new URL(deps.petBase).origin}/app/fx`,
      { base: `${deps.petBase}/pic/fx/`, names: FX_ASSETS },
      (): [Stage | null, Stage | null] => {
        const box = homePet.box();
        if (!box) return [null, null];
        // 两只面对面：自家宠物面朝对手（口径同 runTrial / runHostSparShow 的 playExtra facing），
        // 对手窗口面朝自家宠物（`GuestWindow` 的 face 也是这一套）
        const selfFacing: 'left' | 'right' = foeOnLeft() ? 'left' : 'right';
        const foeRect = foeBounds();
        const foe = foeRect ? foeStage(foeRect, selfFacing === 'left' ? 'right' : 'left') : null;
        return [homeStage(box, selfFacing), foe];
      },
      () => {
        const box = homePet.box();
        const point = box
          ? { x: box.left + box.size / 2, y: box.top + box.size / 2 }
          : electron.screen.getCursorScreenPoint();
        return electron.screen.getDisplayNearestPoint(point).workArea;
      },
      (message) => log(`修炼：${message}`),
      { foeShadow },
    );
  }

  /**
   * 修炼的右键项（开关开着才有）：信息项带境界和百分比（变了才重新注册）；
   * 圆满时是「渡劫」（有丹再多一项「服丹后渡劫」，§X4 替换掉 X1 的「突破」）；
   * 渡劫成功后挂 10 分钟两项「领悟：X」；演一场时换成「快进」。
   */
  function cultivationActions(): Map<string, () => unknown> {
    const actions = new Map<string, () => unknown>();
    const practice = cultivationOn();
    if (!practice) return actions;
    const view = practice.view();
    actions.set(`${MENU_CULTIVATION_GROUP}/${view.label} · ${view.percent}%`, () => {
      const now = practice.view();
      void say(
        `我在${now.label}（${now.percent}%），气血 ${now.stats.hp}、灵力 ${now.stats.power}、` +
          `身法 ${now.stats.agility}、遁速 ${now.stats.speed}，有 ${now.weapons.length} 件法宝～`,
      );
    });
    // 历练（Y3）：开着修炼才有；存档里有没走完的一趟时带层数；这一趟在走时多一项自动走开关（Y4）
    if (ensureAdventure()) {
      const run = practice.adventureRun();
      actions.set(`${MENU_CULTIVATION_GROUP}/历练${run ? `（第 ${run.layer} 层）` : ''}`, () => void runAdventure());
      if (ctx.state.adventure && ctx.state.adventure.active && ctx.state.adventure.running) {
        actions.set(`${MENU_CULTIVATION_GROUP}/自动走：${ctx.state.adventure.autoWalk ? '开' : '关'}`, () => {
          ctx.state.adventure?.toggleAutoWalk();
          void refreshMenu();
        });
      }
    }
    if (view.full) tribulationActions(practice, actions);
    // 二选一：两项「领悟：X」（点了才消失；10 分钟没人挑就由 cultivation 在 tick 里随机定一个）
    if (view.offer) {
      for (const skill of [view.offer.a, view.offer.b]) {
        actions.set(`${MENU_CULTIVATION_GROUP}/领悟：${SKILLS[skill].name}`, () => {
          onCultivation(Date.now(), practice.choose(Date.now(), skill));
          void refreshMenu();
        });
      }
    }
    // 心魔试炼：没在打、没出门、家里没客人、也没有挂着的隔空挑战时才有；打的时候换成「快进」
    if (ctx.state.battle || ctx.state.liveBattle) {
      actions.set(`${MENU_CULTIVATION_GROUP}/快进`, skipTrial);
      // 认输（X26）：只有心魔 / 切磋开打时注册了收尾回调才有；二次确认在单独一块小面板里问
      if (ctx.state.forfeitNow) actions.set(`${MENU_CULTIVATION_GROUP}/认输`, () => void forfeitBattle());
    } else if (
      ctx.state.trip === null &&
      ctx.state.hosting === null &&
      ctx.state.duelWait === null &&
      ctx.state.duelAccepted === null &&
      ctx.state.adventure?.blocking !== true
    )
      actions.set(`${MENU_CULTIVATION_GROUP}/心魔试炼`, () => void runTrial());
    return actions;
  }
  return { cultivationOn, onCultivation, playExtra, playPooled, openShowFx, cultivationActions };
}
