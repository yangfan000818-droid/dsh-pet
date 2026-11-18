import { openActionPanel } from '../action-panel-window';
import type { ActionPanelWindow, TurnMode, TurnModePrompt } from '../action-panel-window';
import { arenaScoreboard, openArenaWindow } from '../arena-window';
import { askAiTurn, legalChoices, startLiveClient, startLiveServer } from '../battle-live';
import { createDashRig, screenUnion } from '../battle-dash';
import type { DashFoe } from '../battle-dash';
import type { TurnDecision } from '../battle-live';
import type { Action, BattleEvent, BattleView } from '../battle';
import { BattleShow, LINE_MS, SHOW_ANIMS, swapSides, timeline } from '../battle-show';
import type { Shot } from '../battle-show';
import { SPAR_LABEL, SPAR_OPTIONS, sparFighter } from '../spar-rules';
import { AWAY_OPACITY, fadeHome, openGuestWindow } from '../visit-windows';
import type { Rect } from '../visit-windows';
import {
  cleanText,
  LINE_MAX,
  randomSparNonce,
  sendReveal,
  sendSpar,
  sendSparTurn,
  sparCardOf,
  sparCommit,
  sparFight,
  sparLineRng,
  SPAR_LIVE_MODE,
  SPAR_MODE,
  TURN_WAIT_MS,
} from '../visit';
import type { SparCard, SparFailure, SparReply, SparRevealReply, SparTurnReply, Visitor } from '../visit';
import { CLOSE_HOLD_MS, lazyFns } from './context';
import { chooseManualAction } from './manual-action';
import type { FeatureContext, SparShow, SparState, SparWindows, Trip } from './context';
import { outcomeWord, settleSpar, sparDiaryText, sparOutcome, sparResultLine } from './spar-result';
import type { SparOutcome } from './spar-result';
import { errorText } from './util';

/** 切磋等客人应战 / 亮随机数的时限（§X5：对不上或 30 秒没来，按客人认输记） */
export const SPAR_WAIT_MS = 30_000;
/** 客人的赛后感言最多编这么久（跟着 reveal 带过去；模型磨蹭就退回模板，别把 reveal 拖过时限） */
export const SPAR_REMARK_CAP_MS = 10_000;

/**
 * 开打前选出招方式（X19，照 X17 的出招面板）：自动 / AI 出招 / 手动，10 秒不点按自动。
 * 面板挂在擂台下面；这会儿擂台还没开（`arena` 回 null），先放工作区上方居中，开演后跟着擂台挪。
 * 关掉（收摊 / 退出）回 null，调用方按「没选」收场。
 */
export async function pickTurnMode(
  ctx: FeatureContext,
  arena: () => Rect | null = () => null,
  foe: () => Rect | null = () => null,
  prompt: TurnModePrompt = {},
): Promise<TurnMode | null> {
  if (ctx.state.actionPanel) return null;
  const panel = openActionPanel(
    ctx.electron,
    `${new URL(ctx.deps.petBase).origin}/app/panel`,
    arena,
    () => ctx.homePet.box(),
    foe,
  );
  ctx.state.actionPanel = panel;
  const initial = arena();
  if (initial) panel.place(initial);
  try {
    return await panel.chooseMode(ctx.ai.isReady(), ctx.deps.modeTimeoutMs ?? 10_000, prompt);
  } finally {
    panel.close();
    if (ctx.state.actionPanel === panel) ctx.state.actionPanel = null;
  }
}

/** 「同步轮」手动面板补的一行状态：只看双方公开状态里最影响这手选择的几项 */
function sparStatusHint(view: BattleView): string {
  const parts: string[] = [];
  const you = view.you.status;
  const foe = view.foe.status;
  if (you?.sealed) parts.push(you.sealed === 'weapon' ? '法宝被封' : '招式被封');
  if (you?.controlled) parts.push('被控');
  if (you && you.charge > 0) parts.push(`蓄力 ${you.charge}`);
  if (you && you.bubbles > 0) parts.push(`护体 ${you.bubbles}`);
  if (you && you.mirror > 0) parts.push(`魂影 ${you.mirror}`);
  if (foe?.sealed) parts.push(foe.sealed === 'weapon' ? '对方法宝被封' : '对方招式被封');
  if (foe?.controlled) parts.push('对方被控');
  if (foe && foe.bubbles > 0) parts.push(`对方护体 ${foe.bubbles}`);
  if (foe && foe.mirror > 0) parts.push(`对方魂影 ${foe.mirror}`);
  return parts.slice(0, 2).join(' · ');
}

/** 逐手局手动面板标题：同步轮是双方同时锁定，顺带把主动技次数和公开状态说清楚 */
function sparManualTitle(view: BattleView): string {
  const base = view.round === undefined ? '轮到你了，出一手' : `第 ${view.round + 1} 轮 · 双方各锁一手`;
  const extras: string[] = [];
  if (view.you.skillUsesLeft !== undefined) extras.push(`主动技剩 ${view.you.skillUsesLeft} 次`);
  const status = sparStatusHint(view);
  if (status) extras.push(status);
  return extras.length > 0 ? `${base} · ${extras.join(' · ')}` : base;
}

/** 切磋（X5）、隔空切磋（X15）和共用演出 runSparShow */
export interface Spar {
  cancelSpar(): void;
  inviteSpar(): void;
  hostSpar(visitor: Visitor, card: SparCard, commit: string, live?: boolean): Promise<SparReply>;
  hostReveal(visitor: Visitor, nonce: string, line: string): Promise<SparRevealReply>;
  sparTurn(visitor: Visitor, index: number, action?: Action, forfeit?: boolean): Promise<SparTurnReply>;
  startGuestSpar(invite?: { live: boolean }): Promise<void>;
  runSparShow(show: SparShow): Promise<BattleEvent[] | null>;
}

export function createSpar(ctx: FeatureContext): Spar {
  const {
    cancelDuels,
    comeHome,
    compose,
    holdPet,
    openShowFx,
    petName,
    petRequest,
    playExtra,
    refreshMenu,
    relay,
    releasePet,
    say,
    showRelay,
  } = lazyFns(ctx);
  const { deps, log, electron, homePet, sparWaitMs } = ctx;
  /** 收摊一场切磋（客人走了 / 回家了 / 退出）：定时器停掉、演出停掉、窗口全部立刻关 */
  function cancelSpar(): void {
    const current = ctx.state.spar;
    ctx.state.spar = null;
    if (current) {
      if (current.timer !== null) clearTimeout(current.timer);
      // dispose 只是让 run() 立刻 resolve；battle 不清零的话菜单永远挂着「快进」、
      // 后续心魔 / 渡劫 / 切磋全被 `if (battle)` 挡住（真机踩过：一场演完全锁死）
      ctx.state.battle?.dispose();
      ctx.state.battle = null;
    }
    // 逐手局（X19）在 liveBattle 里跑；出招面板也一起收（等着的 AI / 手动选择作废）
    ctx.state.liveBattle?.dispose();
    ctx.state.liveBattle = null;
    ctx.state.forfeitNow = null;
    ctx.state.liveTurn = null;
    ctx.state.actionPanel?.close();
    ctx.state.actionPanel = null;
    // 演完到 `CLOSE_HOLD_MS` 收摊之间回家 / 被请回也要立刻关（那会儿 spar 已经是 null，靠窗口组收尾）
    for (const windows of [...ctx.state.sparWindows]) closeSparWindows(windows, 0);
    // 隔空切磋也收掉：等主人答复的回 timeout，已应战的那场不再记账（窗口在上面那轮里关）
    cancelDuels();
  }

  /**
   * 关掉某一场切磋的窗口：0 = 立刻（回家 / 被请回 / 退出），`CLOSE_HOLD_MS` = 演完留一会儿再收。
   * 只按传进来的这一组关——上一场的收摊不会把下一场的窗口误关掉，也不会把上一场丢下没人关。
   */
  function closeSparWindows(windows: SparWindows, afterMs: number): void {
    if (!ctx.state.sparWindows.has(windows)) return;
    const close = (): void => {
      if (!ctx.state.sparWindows.delete(windows)) return;
      if (windows.panel && ctx.state.actionPanel === windows.panel) ctx.state.actionPanel = null;
      windows.panel?.close();
      windows.foe?.close(0);
      windows.arena.close(0);
      windows.fx.close(0);
    };
    if (afterMs <= 0) close();
    else setTimeout(close, afterMs);
  }

  /**
   * 冲刺（X16）：降龙十八掌带 `dash`。对手窗口在冲刺期间钉住、按帧挪；擂台和特效层按开场站位摆。
   * 自家宠物走 `/position` 的 `line`（演出锁由 petRequest 带上）。
   */
  function dashRig(foe: DashFoe, arena: { pin(on: boolean): void }, fx: { pin(on: boolean): void }) {
    return createDashRig({
      box: homePet.box,
      union: () => screenUnion(electron.screen),
      foe,
      pinStage: (on) => {
        arena.pin(on);
        fx.pin(on);
      },
      moveSelf: (x, y, durationMs) => {
        void petRequest('POST', '/position', { x, y, mode: 'line', duration: durationMs });
      },
    });
  }

  /** 主人家主动请回客人时，如果还在演，等收场再离开。 */
  async function finishGuestShow(current: Trip): Promise<void> {
    if (ctx.state.trip === current && !ctx.state.disposed && current.pendingHome === 'sent-home') {
      await comeHome('sent-home');
    }
  }

  /**
   * 一场对战的演出（X12 客人这一侧、X15 隔空切磋两边共用）：开对手窗口 → 擂台 → 特效层 →
   * BattleShow → 收摊，窗口记进 sparWindows，cancelSpar 能立刻全关。
   * 差别用参数传：本地是引擎 0 号还是 1 号（1 号要 swapSides）、自家宠物的台词走哪条、
   * 做客时的亮度、对手随 reveal 带来的赛后感言。
   * X19 逐手局给了 `show.live`：不走整场时间线，按每一手对传一段一段演；返回打出来的事件
   * （掉线 / 收摊回 null，调用方按这个决定记不记账）。
   */
  async function runSparShow(show: SparShow): Promise<BattleEvent[] | null> {
    const localFighter = show.local === 0 ? show.zero : show.one;
    const foeFighter = show.local === 0 ? show.one : show.zero;
    const localStage = show.local === 0 ? show.zeroStage : show.oneStage;
    const foeStage = show.local === 0 ? show.oneStage : show.zeroStage;
    // 对手窗口：本机 /app/guest，默认粉色——两边都是自家原色、对方粉色，和对面屏幕对称。
    // 主人家这一侧复用串门时已经开着的客人窗口（`foeWindow`），不另开、也不归这一场关
    const ownFoe = show.foeWindow === undefined;
    const foe =
      show.foeWindow ??
      openGuestWindow(
        electron,
        `${new URL(deps.petBase).origin}/app/guest`,
        show.foeLabel,
        homePet.box,
        () => undefined,
        { scale: 1, tight: true },
      );
    // 对手要播的动画先取到窗口里（X7：换源不等网络，出手才和飞行物对得上）
    foe.preload(SHOW_ANIMS);
    const arena = openArenaWindow(
      electron,
      `${new URL(deps.petBase).origin}/app/arena`,
      homePet.box,
      () => foe.bounds(),
      { initiallyVisible: false },
    );
    // 特效层：对手就是这一场的对手窗口（默认粉色，不用心魔配色）
    const fx = openShowFx(
      () => foe.bounds(),
      () => foe.side === 'left',
    );
    const windows: SparWindows = { foe: ownFoe ? foe : null, arena, fx, panel: null };
    ctx.state.sparWindows.add(windows);
    const dash = dashRig(foe, arena, fx);
    const scoreboard = arenaScoreboard({
      self: { label: `${localFighter.name} · ${localStage}`, maxHp: localFighter.hp },
      foe: { label: `${foeFighter.name} · ${foeStage}`, maxHp: foeFighter.hp },
    });
    const sides = {
      self: {
        // 自家宠物面朝对手（素材统一画成朝左，对手站右边时整段镜像）
        play: (anim: string, rate: number) =>
          void playExtra(anim, { facing: foe.side === 'left' ? 'left' : 'right', rate }),
        say: show.selfSay,
      },
      foe: {
        play: (anim: string, rate: number) => foe.play(anim, rate),
        say: (line: string, durationMs: number) => foe.say(line, durationMs),
      },
      arena: (hp: [number, number]) => {
        arena.place(homePet.box(), foe.bounds());
        // 左右跟着两只的实际位置：对手站在自家宠物左边时它那条在左
        arena.update(scoreboard(hp, foe.side === 'left'));
        fx.place();
        if (windows.panel) windows.panel.place(arena.bounds());
      },
      shoot: (shot: Shot, who: 0 | 1) => fx.fire(shot, who),
      dash: (who: 0 | 1, dir: 'out' | 'back', ms: number) => dash.run(who, dir, ms),
      dashEnd: (force?: boolean) => dash.end(force),
    };
    /**
     * 逐手局手动出招的面板：到自家第一手才开（开早了会先亮一块空面板），
     * 挂在擂台下面，等主人点（AI / 自动局没有面板，§X17）。
     */
    let manualPanel: ActionPanelWindow | null = null;
    const ensureManualPanel = (): ActionPanelWindow => {
      if (manualPanel) return manualPanel;
      const panel = openActionPanel(
        electron,
        `${new URL(deps.petBase).origin}/app/panel`,
        () => arena.bounds(),
        homePet.box,
        () => foe.bounds(),
      );
      manualPanel = panel;
      windows.panel = panel;
      ctx.state.actionPanel = panel;
      panel.place(arena.bounds());
      return panel;
    };
    /** 逐手局本地这一手：auto 交回 null（外层按后备挑法），ai 问模型，manual 等面板 */
    const decideLive = async (view: BattleView, _index: number, signal: AbortSignal): Promise<TurnDecision | null> => {
      const mode = show.live?.mode ?? 'auto';
      if (mode === 'auto') return null;
      if (mode === 'ai') {
        const reply = await askAiTurn({
          ai: ctx.ai,
          system: ctx.fns.personaPrompt(),
          view,
          names: [show.zero.name, show.one.name],
          timeoutMs: deps.aiTurnTimeoutMs ?? 15_000,
          signal,
          log: ctx.log,
        });
        if (!reply) return null;
        const choice = legalChoices(view)[reply.pick - 1];
        return choice ? { action: choice.action, ...(reply.line ? { line: reply.line } : {}) } : null;
      }
      if (ctx.state.disposed || signal.aborted) return null;
      const panel = ensureManualPanel();
      return chooseManualAction({
        panel,
        choices: legalChoices(view),
        timeoutMs: deps.actionTimeoutMs ?? 20_000,
        title: sparManualTitle(view),
        onTimeout: () => ctx.log('逐手对传：手动没点，按后备挑法'),
        forfeit: () => ctx.state.forfeitNow?.(),
      });
    };
    let events: BattleEvent[] | null;
    if (show.live) {
      // 逐手对传（X19）：每一手一段一段演；发起方发 HTTP，应战方等协议层递进来
      const sendTurn = show.live.sendTurn;
      if (show.live.role === 'client' && !sendTurn) throw new Error('逐手局缺 sendTurn');
      // 逐手局一创建就开演第一手，而占锁要等一个来回：先把锁的请求发出去，第一段演出等锁到手再开。
      // 不能把整局往后挪——应战方要先把 live 局注册上，对端第一手才递得进来（X19 回归测试踩过）
      const held = holdPet([], 20 * 60_000);
      const live =
        show.live.role === 'client'
          ? startLiveClient({
              a: show.zero,
              b: show.one,
              seed: show.live.seed,
              local: show.local,
              show: sides,
              lineRng: show.lineRng,
              ...SPAR_OPTIONS,
              decide: decideLive,
              think: () => show.think?.(),
              log: ctx.log,
              waitMs: deps.turnWaitMs ?? TURN_WAIT_MS,
              sendTurn: sendTurn!,
              ready: held,
            })
          : startLiveServer({
              a: show.zero,
              b: show.one,
              seed: show.live.seed,
              local: show.local,
              show: sides,
              lineRng: show.lineRng,
              ...SPAR_OPTIONS,
              decide: decideLive,
              think: () => show.think?.(),
              log: ctx.log,
              waitMs: deps.turnWaitMs ?? TURN_WAIT_MS,
              ready: held,
              onEnd: show.live.onEnd,
            });
      ctx.state.liveBattle = live;
      // 认输（X26）：菜单与手动面板都走这一条；双方由 live 层把 forfeit 结局对齐
      const forfeitHook = (): void => live.forfeit();
      ctx.state.forfeitNow = forfeitHook;
      const turn = live.turn;
      if (show.live.role === 'server') ctx.state.liveTurn = turn;
      arena.setVisible(true);
      show.beforeShow?.();
      void refreshMenu();
      // 正常演出等 ready；快进或取消不必等网络上的占用锁，锁稍后到账也会释放。
      events = await live.done;
      if (ctx.state.liveBattle === live) ctx.state.liveBattle = null;
      if (ctx.state.forfeitNow === forfeitHook) ctx.state.forfeitNow = null;
      if (show.live.role === 'server' && ctx.state.liveTurn === turn) ctx.state.liveTurn = null;
      if (windows.panel) {
        if (ctx.state.actionPanel === windows.panel) ctx.state.actionPanel = null;
        windows.panel.close();
        windows.panel = null;
      }
      releasePet(events && !ctx.state.disposed ? CLOSE_HOLD_MS : 0, held);
    } else {
      // 全自动：整场时间线一字不改（X5 / X12）
      // 两边先照引擎顺序排（0 号 = 被挑战方），本地是 1 号时再换边成本地视角
      const ordered = timeline(show.events, [show.zero.name, show.one.name], show.lineRng, [
        show.zero.skills,
        show.one.skills,
      ]);
      const steps = show.local === 1 ? swapSides(ordered) : ordered;
      ctx.state.battle = new BattleShow(steps, sides);
      arena.setVisible(true);
      show.beforeShow?.();
      void refreshMenu();
      const current = ctx.state.battle;
      await holdPet(steps);
      await current.run();
      // 不清零的话「快进」常驻菜单、下一场被 guard 挡住（真机踩过）；已经换了下一场就别误清
      if (ctx.state.battle === current) ctx.state.battle = null;
      releasePet(ctx.state.disposed ? 0 : CLOSE_HOLD_MS);
      events = show.events;
    }
    const cancelled = ctx.state.disposed || show.cancelled?.() === true;
    if (cancelled) {
      closeSparWindows(windows, 0);
      return null;
    }
    if (events) {
      if (show.foeLine) foe.say(show.foeLine, LINE_MS);
      void refreshMenu();
    }
    closeSparWindows(windows, CLOSE_HOLD_MS);
    show.afterShow?.();
    return events;
  }

  /** 主人家发起切磋（菜单「切磋/和客人切磋」）：先选自家的出招方式（X19），再把逐手局的 spar-invite 捎给客人 */
  function inviteSpar(): void {
    const current = ctx.state.hosting;
    if (
      !current?.visitor.id ||
      ctx.state.spar ||
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted
    )
      return;
    void (async () => {
      const mode = await pickTurnMode(
        ctx,
        () => null,
        () => current.window.bounds(),
      );
      if (ctx.state.hosting !== current || ctx.state.disposed) return;
      if (!mode) return;
      // 一律邀逐手局：客人也在它自己的面板里选方式
      if (!ctx.state.visitHost?.tell({ type: 'spar-invite', mode: SPAR_LIVE_MODE })) return;
      const state: SparState = { role: 'host', stage: 'invited', since: Date.now(), timer: null, live: true, mode };
      state.timer = setTimeout(() => {
        if (ctx.state.spar !== state || state.stage !== 'invited') return;
        ctx.state.spar = null;
        log(`串门：${current.visitor.pet} 没接切磋的招`);
        void say(`${current.visitor.pet} 好像没接招～`);
        void refreshMenu();
      }, sparWaitMs);
      ctx.state.spar = state;
      void say(`${current.visitor.pet}，来跟我过两招～`);
      void refreshMenu();
    })();
  }

  /** 主人家这一侧收到 /v1/spar（客人应约或主动）：busy / no-id 在这里答，答应了回名帖与随机数 */
  async function hostSpar(visitor: Visitor, _card: SparCard, commit: string, live = false): Promise<SparReply> {
    // 在打才算忙；等客人应战（invited）的那份不算——客人现在就是来应战的
    if (
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.duel ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted ||
      (ctx.state.spar && !(ctx.state.spar.role === 'host' && ctx.state.spar.stage === 'invited'))
    )
      return { ok: false, reason: 'busy' };
    // 没验证过身份的客人没有稳定的 id：邻居簿没得记，不接
    if (!visitor.id) return { ok: false, reason: 'no-id' };
    const invited = ctx.state.spar;
    // 这边邀的是逐手局、旧客人只会发自动：不要悄悄降成全自动，按「还不会逐手」拒掉
    if (invited?.live && !live) {
      if (invited.timer !== null) clearTimeout(invited.timer);
      ctx.state.spar = null;
      void say(`${visitor.pet} 好像还不会逐手切磋～`, { anim: false });
      void refreshMenu();
      return { ok: false, reason: 'unsupported-mode' };
    }
    let mode: TurnMode = 'auto';
    if (live) {
      // 自己发起时在邀约前就选好了；客人发起时这会儿在自己的出招面板里选（10 秒不点按自动）
      if (invited?.live && invited.mode) mode = invited.mode;
      else {
        // 客人来切磋：直接弹「自动 / AI / 手动 / 不应战」，主人不用先右键再找应战项
        const picked = await pickTurnMode(
          ctx,
          () => null,
          () => null,
          {
            title: `${visitor.owner} 家的 ${visitor.pet} 想跟你切磋：怎么出招？`,
            declineLabel: '不应战',
          },
        );
        if (!picked) return { ok: false, reason: 'declined' };
        // 选方式的 10 秒里客人可能已经走了：别再挂一场没人亮的切磋
        if (!ctx.state.hosting || ctx.state.hosting.visitor !== visitor) return { ok: false, reason: 'not-visiting' };
        mode = picked;
      }
    }
    const hostNonce = randomSparNonce();
    const state: SparState = {
      role: 'host',
      stage: 'card',
      since: Date.now(),
      timer: null,
      commit,
      hostNonce,
    };
    if (live) {
      state.live = true;
      state.mode = mode;
    }
    // 客人应了邀约（或自己先开的口）：把等邀约的那份状态连定时器一起收掉
    if (invited && invited.timer !== null) clearTimeout(invited.timer);
    state.timer = setTimeout(() => {
      if (ctx.state.spar !== state || state.stage !== 'card') return;
      guestConceded(visitor, '超时没亮随机数');
    }, sparWaitMs);
    ctx.state.spar = state;
    log(`串门：${visitor.pet} 应战切磋（${live ? `逐手：${mode}` : '自动'}）`);
    return { ok: true, card: sparCardOf(sparFighter(petName()), 0), nonce: hostNonce };
  }

  /** 客人没亮随机数（对不上 / 超时，§X5）：按客人认输记，这场不开打 */
  function guestConceded(visitor: Visitor, why: string): void {
    const state = ctx.state.spar;
    if (state?.timer) clearTimeout(state.timer);
    ctx.state.spar = null;
    settleSpar(ctx, {
      kind: 'spar',
      neighborId: visitor.id,
      names: { owner: visitor.owner, pet: visitor.pet },
      outcome: 'win',
      diary: `和 ${visitor.owner} 家的 ${visitor.pet} 切磋，它${why}，算它认输`,
    });
    void say(`${visitor.pet} ${why}，这场算它认输啦～`, { anim: false });
    void refreshMenu();
  }

  /** 主人家这一侧收到 /v1/spar/reveal（客人亮随机数）：核承诺，对不上或超时都按客人认输，核过了开打 */
  async function hostReveal(visitor: Visitor, nonce: string, line: string): Promise<SparRevealReply> {
    const state = ctx.state.spar;
    if (!state || state.role !== 'host' || state.stage !== 'card') return { ok: false, reason: 'late' };
    if (Date.now() - state.since > sparWaitMs) {
      guestConceded(visitor, '超时没亮随机数');
      return { ok: false, reason: 'late' };
    }
    if (sparCommit(nonce) !== state.commit) {
      guestConceded(visitor, '随机数对不上');
      return { ok: false, reason: 'mismatch' };
    }
    if (state.timer !== null) clearTimeout(state.timer);
    state.stage = 'showing';
    void runHostSparShow(visitor, state, nonce, line);
    return { ok: true };
  }

  /** 逐手局应战方这一侧收到的一手（X19）：只有这一场正在逐手、客人也对得上才递进去 */
  async function sparTurn(visitor: Visitor, index: number, action?: Action, forfeit?: boolean): Promise<SparTurnReply> {
    const state = ctx.state.spar;
    const current = ctx.state.hosting;
    if (!state?.live || state.role !== 'host' || state.stage !== 'showing' || current?.visitor !== visitor)
      return { ok: false, reason: 'not-visiting' };
    const turn = ctx.state.liveTurn;
    if (!turn) return { ok: false, reason: 'late' };
    return turn(index, action, forfeit);
  }

  /** 主人家复用串门的客人窗口。整场算好的局开演前记账，同步轮等双方打完再记。 */
  async function runHostSparShow(
    visitor: Visitor,
    state: SparState,
    guestNonce: string,
    guestLine: string,
  ): Promise<void> {
    const current = ctx.state.hosting;
    const { id: visitorId, owner, pet } = visitor;
    const { hostNonce } = state;
    if (current?.visitor !== visitor || !visitorId || !hostNonce) return;
    const zero = sparFighter(petName());
    const one = sparFighter(pet);
    const cancelled = () => ctx.state.spar !== state || ctx.state.disposed;
    const settle = (events: BattleEvent[]): SparOutcome => {
      const outcome = sparOutcome(events[events.length - 1], 0);
      settleSpar(ctx, {
        kind: 'spar',
        neighborId: visitorId,
        names: { owner, pet },
        outcome,
        diary: sparDiaryText(owner, pet, outcome),
      });
      return outcome;
    };
    const preset = state.live ? null : sparFight(zero, one, guestNonce, hostNonce);
    let outcome = preset ? settle(preset) : undefined;
    let events: BattleEvent[] | null;
    try {
      events = await runSparShow({
        zero,
        one,
        zeroStage: SPAR_LABEL,
        oneStage: SPAR_LABEL,
        events: preset ?? [],
        lineRng: sparLineRng(guestNonce, hostNonce),
        local: 0,
        foeLabel: `${owner} 家的 ${pet}`,
        foeWindow: current.window,
        selfSay: (line, durationMs) => void say(line, { anim: false, durationMs }),
        think: () => void say('想一想…', { anim: false }),
        live: state.live
          ? {
              role: 'server',
              mode: state.mode ?? 'auto',
              seed: `${guestNonce}:${hostNonce}`,
              onEnd: (receipt) => ctx.state.visitHost?.rememberSparEnd(visitor, hostNonce, receipt),
            }
          : undefined,
        foeLine: guestLine,
        cancelled,
      });
    } catch (error) {
      log(`串门：切磋演出没能完成：${errorText(error)}`);
      events = null;
    }
    const interrupted = cancelled();
    if (ctx.state.spar === state) ctx.state.spar = null;
    if (interrupted) return;
    void refreshMenu();
    if (!events) {
      void say('切磋断了', { anim: false });
      return;
    }
    outcome ??= settle(events);
    const instruction =
      `你刚和来串门的${pet}（${owner} 家的）切磋了一场，${outcomeWord(outcome)}。跟主人说一句赛后感言。` +
      (outcome === 'draw'
        ? '双方点到为止，平局也很精彩。'
        : outcome === 'win'
          ? '别提修为和法宝的数字。'
          : '切磋点到为止，输了不丢人，下次再战。');
    const fallback =
      outcome === 'draw'
        ? '切磋打平啦，旗鼓相当～'
        : outcome === 'win'
          ? '切磋赢啦，承让承让～'
          : '切磋输了，下次再战！';
    const text = cleanText(await compose(instruction, fallback), LINE_MAX);
    if (!ctx.state.disposed && !ctx.state.battle && !ctx.state.liveBattle) void say(text, { anim: false });
  }

  /**
   * 客人这一侧的切磋（菜单「切磋/找主人家的宠物切磋」；收到 spar-invite 也走这里，§X5 的自动应战）：
   * 发名帖与承诺 → 拿到主人家的随机数后这一场就定了 → 编好自己的赛后感言跟着 reveal 带过去 →
   * 记账、在自家屏幕上把这一场演全套（对手是主人家的宠物窗口；`say` 会先把宠物叫回家，台词全走转播）。
   * X19 逐手局：发起时先选出招方式（自动 / AI / 手动），一律走逐手局；逐手局在打完时才记账，掉线不记。
   */
  async function startGuestSpar(invite?: { live: boolean }): Promise<void> {
    const current = ctx.state.trip;
    if (
      !current ||
      ctx.state.spar ||
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.duel ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted
    )
      return;
    // 发起方（菜单点的）先选方式；主人家邀的逐手局由客人选自家方式（自动也是逐手对传的一种）。
    // 自己发起的一律走逐手局，主人家也能选它的；只有旧主人家邀的全自动局才整场算好
    let mode: TurnMode = 'auto';
    if (!invite || invite.live) {
      // 主人家邀战也直接弹确认：多一个「不应战」，超时按不应战收
      const picked = await pickTurnMode(
        ctx,
        () => null,
        () => null,
        invite
          ? {
              title: `${current.host.owner} 家的 ${current.host.pet} 邀你切磋：怎么出招？`,
              declineLabel: '不应战',
            }
          : {},
      );
      if (!picked) {
        if (invite) relay('（切磋）这次不打了');
        return;
      }
      if (ctx.state.trip !== current || ctx.state.disposed) return;
      mode = picked;
    }
    const live = invite ? invite.live : true;
    const state: SparState = { role: 'guest', stage: 'asking', since: Date.now(), timer: null };
    if (live) {
      state.live = true;
      state.mode = mode;
    }
    ctx.state.spar = state;
    relay('（切磋）跟它过两招～');
    void refreshMenu();
    const ownNonce = randomSparNonce();
    let reply: SparReply;
    try {
      reply = await sendSpar(current.host, {
        token: current.token,
        mode: live ? SPAR_LIVE_MODE : SPAR_MODE,
        card: sparCardOf(sparFighter(petName()), 0),
        commit: sparCommit(ownNonce),
      });
    } catch (error) {
      log(`串门：切磋的请求没送到：${errorText(error)}`);
      if (ctx.state.spar === state) ctx.state.spar = null;
      relay('（切磋）没送到，改天再切');
      return;
    }
    if (ctx.state.trip !== current || ctx.state.spar !== state) return;
    if (!reply.ok) {
      guestSparFailed(state, reply.reason, live);
      return;
    }
    // 切磋和修炼解绑：两边都用同一套固定配装，名帖里的成长数值不再参与
    const hostFighter = sparFighter(current.host.pet);
    const you = sparFighter(petName());
    const beforeShow = (): void => {
      // 做客时自家宠物是半透明的（AWAY_OPACITY）：开演亮回原色；演出期间转播不改亮度，
      // 等窗口一起收摊（CLOSE_HOLD_MS）后才退回半透明
      if (ctx.state.relayTimer !== null) {
        clearTimeout(ctx.state.relayTimer);
        ctx.state.relayTimer = null;
      }
      fadeHome(electron, 1);
    };
    const afterShow = (): void => {
      // 窗口收摊时退回做客的半透明；转播的气泡还挂着就交给它到点再退（又开了一场就不动）
      setTimeout(() => {
        if (
          ctx.state.trip === current &&
          ctx.state.battle === null &&
          ctx.state.liveBattle === null &&
          ctx.state.relayTimer === null
        )
          fadeHome(electron, AWAY_OPACITY);
      }, CLOSE_HOLD_MS);
    };
    const baseShow = {
      zero: hostFighter,
      one: you,
      zeroStage: SPAR_LABEL,
      oneStage: SPAR_LABEL,
      lineRng: sparLineRng(ownNonce, reply.nonce),
      local: 1 as const,
      foeLabel: `${current.host.owner} 家的 ${current.host.pet}`,
      selfSay: (line: string, durationMs: number) => showRelay(line, durationMs),
      beforeShow,
      afterShow,
      cancelled: () => ctx.state.trip !== current || ctx.state.spar !== state,
    };
    const preset = live ? undefined : sparFight(hostFighter, you, ownNonce, reply.nonce);
    let outcome = preset ? sparOutcome(preset[preset.length - 1], 1) : undefined;
    // 整场算好的局把感言随 reveal 捎过去；同步轮打完再编。
    const remark = outcome ? await sparRemark(current, outcome) : '';
    if (baseShow.cancelled() || ctx.state.disposed) return;
    let revealed: SparRevealReply;
    try {
      revealed = await sendReveal(current.host, {
        token: current.token,
        ...(live ? { match: reply.nonce } : {}),
        nonce: ownNonce,
        line: remark,
      });
    } catch (error) {
      log(`串门：随机数没亮出去：${errorText(error)}`);
      if (baseShow.cancelled() || ctx.state.disposed) return;
      ctx.state.spar = null;
      relay('（切磋）切磋断了');
      void refreshMenu();
      return;
    }
    if (baseShow.cancelled() || ctx.state.disposed) return;
    if (!revealed.ok) {
      guestSparFailed(state, revealed.reason, live);
      return;
    }
    const settle = (result: SparOutcome): void => {
      const { owner, pet, id } = current.host;
      settleSpar(ctx, {
        kind: 'spar',
        neighborId: id,
        names: { owner, pet },
        outcome: result,
        recordNeighbor: current.verified,
        diary: sparDiaryText(owner, pet, result),
      });
    };
    if (outcome) settle(outcome);
    state.stage = 'showing';
    let events: BattleEvent[] | null;
    try {
      events = await runSparShow({
        ...baseShow,
        events: preset ?? [],
        think: () => showRelay('想一想…', LINE_MS),
        live: live
          ? {
              role: 'client',
              mode,
              seed: `${ownNonce}:${reply.nonce}`,
              sendTurn: (body, signal) =>
                sendSparTurn(current.host, { token: current.token, match: reply.nonce, ...body }, signal),
            }
          : undefined,
      });
    } catch (error) {
      log(`串门：切磋演出没能完成：${errorText(error)}`);
      events = null;
    }
    const cancelled = baseShow.cancelled() || ctx.state.disposed;
    if (ctx.state.spar === state) ctx.state.spar = null;
    if (cancelled) return;
    void refreshMenu();
    if (!events) {
      relay('（切磋）切磋断了');
      await finishGuestShow(current);
      return;
    }
    if (!outcome) {
      outcome = sparOutcome(events[events.length - 1], 1);
      settle(outcome);
    }
    relay(sparResultLine(outcome));
    const text = live ? await sparRemark(current, outcome) : remark;
    if (ctx.state.trip === current && !ctx.state.spar && !ctx.state.disposed) relay(text);
    await finishGuestShow(current);
  }

  // ---------- 隔空切磋（X15） ----------
  /** 客人的赛后感言：按人设编一句（只带人设，§2.2 的口径），编太久退回模板（模型卡住别拖垮 reveal） */
  async function sparRemark(current: Trip, outcome: SparOutcome): Promise<string> {
    const { owner, pet } = current.host;
    const instruction =
      `你正在${owner}家做客，刚和它家的宠物${pet}切磋了一场，${outcomeWord(outcome)}。说一句赛后感言。` +
      (outcome === 'draw'
        ? '双方点到为止，平局也很精彩。'
        : outcome === 'win'
          ? '别提修为和法宝的数字。'
          : '切磋点到为止，输了不丢人。');
    const fallback =
      outcome === 'draw'
        ? '切磋打平啦，旗鼓相当～'
        : outcome === 'win'
          ? '切磋赢啦，承让承让～'
          : '切磋输了，下次再战！';
    const composed = compose(instruction, fallback);
    const capped = new Promise<string>((done) => setTimeout(() => done(fallback), SPAR_REMARK_CAP_MS));
    return Promise.race([composed, capped]);
  }

  /**
   * 客人这边没打成：对面关着 / 正忙 / 版本不同……说清楚原因就好，谁都没记账；
   * 认输类的（随机数对不上、没按时亮出去）对面已经按它赢记了账，这边同样按输记，两边才对得上。
   */
  function guestSparFailed(state: SparState, reason: SparFailure | 'mismatch' | 'late', live = false): void {
    if (ctx.state.spar === state) ctx.state.spar = null;
    const current = ctx.state.trip;
    relay(`（切磋）${sparFailText(reason, live)}`);
    if (current && (reason === 'mismatch' || reason === 'late')) {
      settleSpar(ctx, {
        kind: 'spar',
        neighborId: current.host.id,
        names: { owner: current.host.owner, pet: current.host.pet },
        outcome: 'loss',
        recordNeighbor: current.verified,
        bond: false,
        diary: `和 ${current.host.owner} 家的 ${current.host.pet} 切磋，${
          reason === 'late' ? '没按时亮随机数' : '随机数没对上'
        }，认输了`,
      });
    }
    void refreshMenu();
  }

  /** 切磋没打成的原因，说给自家主人听（§X5 点名的两种说法在这里：还不会切磋、版本不一样） */
  function sparFailText(reason: SparFailure | 'mismatch' | 'late', live = false): string {
    switch (reason) {
      case 'old-host':
        return '对方的桌宠还不会切磋';
      case 'off':
        return '对方这次不能切磋';
      case 'busy':
        return '对方正在切磋，等会儿吧';
      case 'declined':
        return '对方这次不应战';
      case 'version':
        return '两边版本不一样，切磋不了';
      case 'unsupported-mode':
        return live ? '对方的桌宠还不会逐手切磋' : '对方不支持这种打法';
      case 'bad-card':
        return '对方没看懂我的名帖';
      case 'no-id':
        return '对方没认出我，切不了';
      case 'bad-request':
        return '没打成';
      case 'mismatch':
        return '随机数没对上，算我认输';
      case 'late':
        return '亮随机数迟了，算我认输';
      default:
        return '已经回家了';
    }
  }

  return {
    cancelSpar,
    runSparShow,
    inviteSpar,
    hostSpar,
    hostReveal,
    sparTurn,
    startGuestSpar,
  };
}
