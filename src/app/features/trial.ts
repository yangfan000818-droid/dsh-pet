import { openActionPanel } from '../action-panel-window';
import type { ActionPanelWindow } from '../action-panel-window';
import { arenaScoreboard, openArenaWindow } from '../arena-window';
import { askAiTurn, legalChoices, startLiveBattle } from '../battle-live';
import { createDashRig, screenUnion } from '../battle-dash';
import { BattleShow, SHOW_ANIMS, timeline } from '../battle-show';
import type { Shot } from '../battle-show';
import { fight, shadowOf, tribulate } from '../battle';
import type { Action, BattleEvent, BattleView } from '../battle';
import { Cultivation } from '../cultivation';
import { openGuestWindow } from '../visit-windows';
import { cleanText, LINE_MAX } from '../visit';
import { MENU_CULTIVATION_GROUP, CLOSE_HOLD_MS, lazyFns } from './context';
import { chooseManualAction } from './manual-action';
import { errorText } from './util';
import type { FeatureContext, TrialWindows } from './context';

/** 心魔试炼、渡劫 */
export interface Trial {
  runTrial(): Promise<void>;
  closeTrial(afterMs: number): void;
  skipTrial(): void;
  forfeitBattle(): Promise<void>;
  runTribulation(wantPill: boolean): Promise<void>;
  closeTribulationFx(afterMs: number): void;
  tribulationActions(practice: Cultivation, actions: Map<string, () => unknown>): void;
}

export function createTrial(ctx: FeatureContext): Trial {
  const {
    compose,
    cultivationOn,
    holdPet,
    onCultivation,
    openShowFx,
    petName,
    petRequest,
    playExtra,
    playPooled,
    refreshMenu,
    releasePet,
    say,
  } = lazyFns(ctx);
  const { deps, electron, diary, homePet } = ctx;
  /**
   * 开一场心魔试炼：心魔窗口 + 擂台 + 出招面板 → 选方式（自动 / AI 出招 / 手动）→ 演 → 算奖励、记日记、收摊、说赛后感言。
   * 演法（§X3）：每句台词走 /broadcast 的 anim: false、时长和一步相当，下一句自然顶替上一句；
   * 台词不进说话队列（它们按时间线走），但碎碎念与自动看屏幕在这期间让路。
   * 逐手出招（X17）：自动仍是一整场算好、整场时间线；AI / 手动由 `battle-live.ts` 一段一段接时间线。
   * 收摊不等模型（§X14）：菜单、窗口、记账都在 compose 之前，赛后感言回来只负责说。
   */
  async function runTrial(): Promise<void> {
    const practice = cultivationOn();
    if (
      !practice ||
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.trip ||
      ctx.state.hosting ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted
    )
      return;
    // 上一场演完还没收完的那组立刻关：新一场不能和它叠着，也不能让它稍后收摊时关错窗口（§X14）
    for (const old of [...ctx.state.trialWindowGroups]) closeTrialWindows(old, 0);
    let windows: TrialWindows | null = null;
    const you = practice.fighter(petName());
    const foe = shadowOf(you);
    const seed = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const origin = new URL(deps.petBase).origin;
    const guest = openGuestWindow(
      electron,
      `${origin}/app/guest`,
      foe.name,
      homePet.box,
      () => undefined, // 心魔不响应戳一下的反应
      // 对战等大、贴身：攻击特效的飞行距离才对得上素材里的命中时刻（串门维持小一号的表意）
      { tint: 'shadow', scale: 1, tight: true },
    );
    const arena = openArenaWindow(electron, `${origin}/app/arena`, homePet.box, () => windows?.guest.bounds() ?? null, {
      initiallyVisible: false,
    });
    // 心魔要播的动画先取到窗口里（X7：换源不等网络，出手才和飞行物对得上）
    guest.preload(SHOW_ANIMS);
    // 特效层（X7）：飞行物从出手方手里飞到对方身上，命中那一刻对方才开始反应
    // 心魔放出来的飞行物和命中特效也用它的暗紫配色（手里那件暗色道具出手时颜色才接得上，不突然变鲜艳）
    const fx = openShowFx(
      () => windows?.guest.bounds() ?? null,
      () => guest.side === 'left',
      true,
    );
    // 出招面板（X17）：挂在擂台下面，先选这一场怎么出招；自动 / AI / 手动
    const panel = openActionPanel(
      electron,
      `${origin}/app/panel`,
      () => windows?.arena.bounds() ?? null,
      homePet.box,
      () => windows?.guest.bounds() ?? null,
    );
    windows = { guest, arena, fx, panel };
    ctx.state.trialWindowGroups.add(windows);
    // 冲刺（X16）：降龙十八掌冲过去推掌，心魔窗口钉住按帧挪
    const dash = createDashRig({
      box: homePet.box,
      union: () => screenUnion(electron.screen),
      foe: guest,
      pinStage: (on) => {
        arena.pin(on);
        fx.pin(on);
      },
      moveSelf: (x, y, durationMs) => {
        void petRequest('POST', '/position', { x, y, mode: 'line', duration: durationMs });
      },
    });
    ctx.state.actionPanel = panel;
    panel.place(arena.bounds());
    const scoreboard = arenaScoreboard({
      self: { label: `${you.name} · ${practice.view().label}`, maxHp: you.hp },
      foe: { label: foe.name, maxHp: foe.hp },
    });
    // 自家宠物面朝对手：素材统一画成朝左，心魔站左边就原样播、站右边就镜像
    const showSides = {
      self: {
        play: (anim: string, rate: number) =>
          void playExtra(anim, { facing: guest.side === 'left' ? 'left' : 'right', rate }),
        // 演出台词：anim 一律 false（带 anim 的气泡会顶掉正在播的动画），时长跟着时间线的一步
        say: (line: string, durationMs: number) => void say(line, { anim: false, durationMs }),
      },
      foe: {
        play: (anim: string, rate: number) => guest.play(anim, rate),
        say: (line: string, durationMs: number) => guest.say(line, durationMs),
      },
      arena: (hp: [number, number]) => {
        arena.place(homePet.box(), guest.bounds());
        // 左右跟着两只的实际位置：心魔站在自家宠物左边时它那条在左
        arena.update(scoreboard(hp, guest.side === 'left'));
        // 特效层与出招面板跟着两只挪（放一发时也会自己挪一次）
        fx.place();
        panel.place(arena.bounds());
      },
      shoot: (shot: Shot, who: 0 | 1) => fx.fire(shot, who),
      dash: (who: 0 | 1, dir: 'out' | 'back', ms: number) => dash.run(who, dir, ms),
      dashEnd: (force?: boolean) => dash.end(force),
    };
    const mode = await panel.chooseMode(ctx.ai.isReady(), deps.modeTimeoutMs ?? 10_000);
    if (!mode) {
      if (ctx.state.actionPanel === panel) ctx.state.actionPanel = null;
      closeTrialWindows(windows, 0);
      return;
    }
    // 选完出招方式才亮血条；准备阶段只保留宠物与出招面板
    arena.setVisible(true);
    let events: BattleEvent[];
    /** 自动局在整场时间线上认输：演出立刻停，结果按负场记（X26） */
    let forfeited = false;
    if (mode === 'auto') {
      // 全自动：和以前完全一样——整场算好、整场时间线
      panel.close();
      if (ctx.state.actionPanel === panel) ctx.state.actionPanel = null;
      events = fight(you, foe, seed);
      const steps = timeline(events, [you.name, foe.name], Math.random, [you.skills, foe.skills]);
      ctx.state.battle = new BattleShow(steps, showSides);
      const show = ctx.state.battle;
      ctx.state.forfeitNow = () => {
        forfeited = true;
        show.dispose();
      };
      void refreshMenu();
      // 先占住宠物再开演：两段动画之间别插播随机活动（等锁的这一下可能被退出打断，所以留住这一场）
      await holdPet(steps);
      await show.run();
      ctx.state.forfeitNow = null;
      ctx.state.battle = null;
    } else {
      // 逐手：AI 出招 / 手动出招（X17）
      // 逐手局一创建就开演第一手：先占住宠物，别让 /lock 的往返和第一段动画抢先后（同 spar）
      await holdPet([], 20 * 60_000);
      if (ctx.state.disposed) {
        releasePet(0);
        closeTrialWindows(windows, 0);
        return;
      }
      const live = startLiveBattle({
        a: you,
        b: foe,
        seed,
        mode,
        show: showSides,
        lineRng: Math.random,
        decide: async (
          view: BattleView,
          _index: number,
          signal: AbortSignal,
        ): Promise<{ action: Action; line?: string } | null> => {
          if (mode === 'manual') {
            return chooseManualAction({
              panel,
              choices: legalChoices(view),
              timeoutMs: deps.actionTimeoutMs ?? 20_000,
              onTimeout: () => ctx.log('逐手出招：手动没点，按后备挑法'),
              forfeit: () => ctx.state.forfeitNow?.(),
            });
          }
          const reply = await askAiTurn({
            ai: ctx.ai,
            system: ctx.fns.personaPrompt(),
            view,
            names: [you.name, foe.name],
            timeoutMs: deps.aiTurnTimeoutMs ?? 15_000,
            signal,
            log: ctx.log,
          });
          if (!reply) return null;
          const choice = legalChoices(view)[reply.pick - 1];
          if (!choice) return null;
          return { action: choice.action, ...(reply.line ? { line: reply.line } : {}) };
        },
        think: () => void say('想一想…', { anim: false }),
        log: ctx.log,
      });
      ctx.state.liveBattle = live;
      const forfeitHook = (): void => live.forfeit();
      ctx.state.forfeitNow = forfeitHook;
      void refreshMenu();
      const finished = await live.done;
      if (ctx.state.liveBattle === live) ctx.state.liveBattle = null;
      if (ctx.state.forfeitNow === forfeitHook) ctx.state.forfeitNow = null;
      if (!finished || ctx.state.disposed) {
        releasePet(ctx.state.disposed ? 0 : CLOSE_HOLD_MS);
        return;
      }
      events = finished;
    }
    releasePet(ctx.state.disposed ? 0 : CLOSE_HOLD_MS);
    // 中途退出了（dispose）：别再把这场算进存档
    if (ctx.state.disposed) return;
    const end = events[events.length - 1];
    const won = !forfeited && end.kind === 'end' && end.winner === 0;
    const suffix = mode === 'ai' ? '（AI 出招）' : mode === 'manual' ? '（手动）' : '';
    // 奖励（修为进账、掉法宝、战绩都在 trialDone 里；冒泡与日记在 onCultivation）
    onCultivation(Date.now(), practice.trialDone(Date.now(), won), { anim: false });
    diary.note(
      Date.now(),
      'cultivate',
      `${won ? '心魔试炼打赢了' : '心魔试炼没打赢'}${suffix}${forfeited ? '，认输了' : ''}`,
    );
    // 演完马上收摊（§X14）：菜单换回来、这一场的窗口按 CLOSE_HOLD_MS 收，都不等赛后感言
    void refreshMenu();
    closeTrialWindows(windows, CLOSE_HOLD_MS);
    // 赛后感言：走 compose（只带人设，§2.2 的口径），生成不了用模板；anim: false 别顶掉收场动画。
    // 回来时已经开了下一场（battle 不是 null）就不说了，免得插进下一场的台词里
    const instruction =
      `你刚跟自己的心魔打了一架（${you.name} 对 ${foe.name}），${won ? '你赢了' : '你输了'}。` +
      '跟主人说一句赛后感言。' +
      (won ? '别提修为和法宝的数字。' : '输了不丢人，放平心态，下次再来。');
    const text = cleanText(
      await compose(instruction, won ? '心魔被打跑了，呼～' : '心魔太强了，我输了，下次再来～'),
      LINE_MAX,
    );
    if (ctx.state.battle === null && ctx.state.liveBattle === null) void say(text, { anim: false });
  }

  /** 关掉某一组心魔试炼的窗口：0 = 立刻，`CLOSE_HOLD_MS` = 演完停一会儿；同一组只关一次 */
  function closeTrialWindows(windows: TrialWindows, afterMs: number): void {
    const close = (): void => {
      if (!ctx.state.trialWindowGroups.delete(windows)) return;
      if (ctx.state.actionPanel === windows.panel) ctx.state.actionPanel = null;
      windows.panel.close();
      windows.guest.close(0);
      windows.arena.close(0);
      windows.fx.close(0);
    };
    if (afterMs <= 0) close();
    else setTimeout(close, afterMs);
  }

  /** 关掉所有还没收完的心魔窗口、擂台与特效层（有人来敲门、退出时立刻关；新开一场时先清上一组） */
  function closeTrial(afterMs: number): void {
    for (const windows of [...ctx.state.trialWindowGroups]) closeTrialWindows(windows, afterMs);
  }

  /** 快进：停掉剩下的步骤，直接看结果（菜单「修炼/快进」，有人敲门时也用它收场；渡劫同样用它） */
  function skipTrial(): void {
    if (ctx.state.liveBattle) {
      // 逐手：剩下的手全按后备挑法、立刻算完；等着的 AI / 手动选择作废，面板先收起来
      ctx.state.actionPanel?.close();
      ctx.state.actionPanel = null;
      ctx.state.liveBattle.skip();
      return;
    }
    ctx.state.battle?.skip();
  }

  /**
   * 菜单「认输」（X26）：二次确认，默认继续打；确认后由这一场注册的 `forfeitNow` 停演、按负场收。
   * 自动局手上没有出招面板，这时另开一块只放这两个按钮——不能借正在等的那块面板，
   * 面板一次只挂一问，借了就会把手上这一手按「没选」结算掉。
   */
  async function forfeitBattle(): Promise<void> {
    const forfeit = ctx.state.forfeitNow;
    if (!forfeit) return;
    let panel: ActionPanelWindow;
    let own = false;
    try {
      panel = openActionPanel(
        electron,
        `${new URL(deps.petBase).origin}/app/panel`,
        () => null,
        () => homePet.box(),
      );
    } catch (error) {
      ctx.log(`认输：确认面板没开出来：${errorText(error)}`);
      return;
    }
    // 自动 / AI 局手上没有面板：这块就是眼下的面板，本机接口和 curl 也能点它
    if (!ctx.state.actionPanel) {
      ctx.state.actionPanel = panel;
      own = true;
    }
    try {
      const pick = await panel.choosePrompt(
        '确定认输？这一场按输记',
        ['继续打', '认输'],
        deps.actionTimeoutMs ?? 20_000,
      );
      // 确认期间这一场可能已经演完（菜单还挂着旧引用）：那就不再动手
      if (pick === 2 && ctx.state.forfeitNow === forfeit) forfeit();
    } finally {
      if (own && ctx.state.actionPanel === panel) ctx.state.actionPanel = null;
      panel.close();
    }
  }

  // ---------- 渡劫（X4） ----------

  /**
   * 开一场渡劫：扛天雷 → 成功进下一个大境界并挂出二选一，失败扣修为（不掉境界，不设冷却）。
   * 演出复用 X3 的执行器，**没有对手窗口**（`foe: null`，也不开擂台：只有一只宠物一道一道挨雷，
   * 气泡报「第 i/N 道天雷 -25」）；吃丹先播 `修炼-服丹`，每道雷 `修炼-挨雷`，
   * 成功播 `修炼-突破`、失败播池里的 `工作状态-垂头叹气冒汗`。
   * @param wantPill 主人点的是「服丹后渡劫」：气血上限 ×1.2，这一颗丹在 tribulationDone 里扣掉
   */
  async function runTribulation(wantPill: boolean): Promise<void> {
    const practice = cultivationOn();
    if (
      !practice ||
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.trip ||
      ctx.state.hosting ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted
    )
      return;
    const plan = practice.tribulationPlan(Date.now());
    if (!plan) {
      void say('还没修到圆满，先不急～');
      return;
    }
    if (wantPill && !plan.canPill) {
      void say('手里没有破境丹，炼成了再吃～');
      return;
    }
    const you = practice.tribulationFighter(petName(), wantPill);
    const events = tribulate(you, plan.strikes, plan.stage, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    // 台词报「第 i/N 道」的 N 用 plan 的雷数：没扛住时引擎提前收尾，事件里只有前几道雷
    const steps = timeline(events, [you.name, '天雷'], Math.random, [you.skills, []], {
      tribulation: { pill: wantPill, strikes: plan.strikes },
    });
    // 特效层（X7 第二步）：每道雷的乌云与闪电画在渡劫者头顶（没有对手；朝向按素材原样朝左）
    const fx = openShowFx(
      () => null,
      () => true,
    );
    ctx.state.tribulationFx = fx;
    ctx.state.battle = new BattleShow(steps, {
      self: {
        // 渡劫没有对手，不指定朝向（素材朝左原样播即可，天雷在头顶）
        play: (anim, rate, from) => void (from === 'pool' ? playPooled(anim, rate) : playExtra(anim, { rate })),
        say: (line, durationMs) => void say(line, { anim: false, durationMs }),
      },
      foe: null,
      // 渡劫不开擂台：没有对手，两条血没得画
      arena: () => fx.place(),
      shoot: (shot: Shot, who: 0 | 1) => fx.fire(shot, who),
    });
    void refreshMenu();
    const end = events[events.length - 1];
    const survived = end.kind === 'end' && end.winner === 0;
    const show = ctx.state.battle;
    await holdPet(steps);
    await show.run();
    ctx.state.battle = null;
    releasePet(ctx.state.disposed ? 0 : CLOSE_HOLD_MS);
    closeTribulationFx(CLOSE_HOLD_MS);
    // 中途退出了（dispose）：这场不算，境界与修为都不动
    if (ctx.state.disposed) return;
    // 结果进存档（属性加成、扣修为、丹数、二选一都在这一步）；冒泡与日记在 onCultivation
    onCultivation(Date.now(), practice.tribulationDone(Date.now(), survived, wantPill), { anim: false });
    // 结果感言走 compose（只带人设，口径同 X3 的赛后感言），生成不了用模板；anim: false 别顶掉收场动画
    const instruction =
      `你刚渡了一次劫（${plan.strikes} 道天雷，${wantPill ? '吃了破境丹' : '没吃丹'}），` +
      `${survived ? `成功突破到${plan.nextLabel}` : '没扛住，被天雷劈回原形'}。跟主人说一句感言。` +
      (survived ? '别提境界和招式。' : '渡劫失败不掉境界，歇一歇还能再渡，别灰心。');
    const text = cleanText(
      await compose(instruction, survived ? '渡劫成功啦，呼～' : '天雷太猛了，我没扛住……再来一次！'),
      LINE_MAX,
    );
    void say(text, { anim: false });
    void refreshMenu();
  }

  /** 关掉渡劫的特效层（演完 `CLOSE_HOLD_MS` 后收尾；退出时立刻关） */
  function closeTribulationFx(afterMs: number): void {
    const closing = ctx.state.tribulationFx;
    if (!closing) return;
    ctx.state.tribulationFx = null;
    closing.close(afterMs);
  }

  /**
   * 渡劫的右键项（圆满时替换 X1 的「突破」）：直接渡；有丹时多一项「服丹后渡劫」
   * （气血上限 ×1.2，一次最多吃 1 颗）。没在打、没出门、家里没客人时才有，和「心魔试炼」同一口径。
   */
  function tribulationActions(practice: Cultivation, actions: Map<string, () => unknown>): void {
    // 历练小窗开着时不能开心魔试炼和渡劫：先关了小窗再说；收起来的小窗只在宠物还在秘境里时算数（Y4）
    if (
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.trip !== null ||
      ctx.state.hosting !== null ||
      ctx.state.duelWait !== null ||
      ctx.state.duelAccepted !== null ||
      ctx.state.adventure?.blocking === true
    )
      return;
    const plan = practice.tribulationPlan(Date.now());
    if (!plan) return;
    actions.set(`${MENU_CULTIVATION_GROUP}/渡劫`, () => void runTribulation(false));
    if (plan.canPill) actions.set(`${MENU_CULTIVATION_GROUP}/服丹后渡劫`, () => void runTribulation(true));
  }
  return {
    runTrial,
    closeTrial,
    skipTrial,
    forfeitBattle,
    runTribulation,
    closeTribulationFx,
    tribulationActions,
  };
}
