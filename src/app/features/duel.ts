import { openActionPanel } from '../action-panel-window';
import type { Action, BattleEvent } from '../battle';
import { fairSparPair } from '../battle';
import type { TurnMode } from '../action-panel-window';
import { stageLabel } from '../cultivation';
import { orderNeighbors, shouldAutoAdmit } from '../neighbors';
import {
  cardFighter,
  cleanText,
  LINE_MAX,
  randomSparNonce,
  sendDuel,
  sendDuelReveal,
  sendDuelTurn,
  sparCardOf,
  sparCommit,
  sparFight,
  sparLineRng,
  SPAR_LIVE_MODE,
} from '../visit';
import type {
  DuelAnswer,
  DuelFailure,
  DuelReply,
  DuelRevealReply,
  Neighbor,
  SparCard,
  SparTurnReply,
  Visitor,
} from '../visit';
import { MENU_CULTIVATION_GROUP, lazyFns } from './context';
import type { DuelAccepted, DuelChallenge, DuelWait, FeatureContext } from './context';
import { pickTurnMode, SPAR_REMARK_CAP_MS } from './spar';
import { errorText } from './util';

/** 「修炼/切磋/…」最多列几个邻居（X15；熟人在前，照邻居列表的排序） */
const DUEL_NEIGHBORS_MAX = 3;

/** 隔空切磋（X15）：挑战方与应战方两侧的协议、菜单与演出 */
export interface Duel {
  cancelDuels(): void;
  hostDuel(visitor: Visitor, card: SparCard, commit: string, live?: boolean): Promise<DuelAnswer>;
  answerDuel(accept: boolean, pickedMode?: TurnMode): Promise<void>;
  hostDuelReveal(visitor: Visitor, nonce: string, line: string): void;
  duelTurn(visitor: Visitor, index: number, action?: Action, forfeit?: boolean): Promise<SparTurnReply>;
  hostDuelConceded(visitor: Visitor, why: 'mismatch' | 'late'): void;
  duelChallengeActions(): Map<string, () => unknown>;
}

export function createDuel(ctx: FeatureContext): Duel {
  const { compose, cultivationOn, nickname, onCultivation, petName, refreshMenu, runSparShow, say } = lazyFns(ctx);
  const { deps, log, tracker, diary, neighbors, sparWaitMs } = ctx;
  /** 应战面板已经由别处（右键应战 / 超时 / 收摊）接管：面板 Promise 收尾时别再重复结算 */
  let promptSuperseded = false;
  /** 收掉还挂着的隔空挑战（退出 / 收摊）：等主人答复的那次回 timeout，已应战的那场不再记账 */
  function cancelDuels(): void {
    if (ctx.state.duelPrompt) {
      promptSuperseded = true;
      const panel = ctx.state.duelPrompt;
      ctx.state.duelPrompt = null;
      panel.close();
    }
    const waiting = ctx.state.duelWait;
    if (waiting) {
      ctx.state.duelWait = null;
      if (waiting.timer !== null) clearTimeout(waiting.timer);
      waiting.resolve({ ok: false, reason: 'timeout' });
    }
    ctx.state.duelAccepted = null;
    ctx.state.duel = null;
    // 逐手局（X19）留着认 /v1/duel/turn 令牌的协议会话也一起收掉
    ctx.state.visitHost?.finishDuel();
  }

  /**
   * 主人答复 / 超时 / 自动应战都走这里：清掉等待状态，答应时把这边自己的名帖与随机数交回去。
   * 逐手局把这边选的方式一起记下（全自动局没得选，按自动）。
   */
  function settleDuel(state: DuelWait, answer: DuelAnswer, mode: TurnMode = 'auto'): void {
    if (ctx.state.duelWait !== state) return;
    if (ctx.state.duelPrompt) {
      promptSuperseded = true;
      ctx.state.duelPrompt.close();
      ctx.state.duelPrompt = null;
    }
    ctx.state.duelWait = null;
    if (state.timer !== null) clearTimeout(state.timer);
    if (answer.ok)
      ctx.state.duelAccepted = {
        visitor: state.visitor,
        card: state.card,
        hostNonce: state.hostNonce,
        ...(state.live ? { live: true, mode } : {}),
      };
    state.resolve(answer);
    void refreshMenu();
  }

  /**
   * 应战方这一侧收到 /v1/duel（X15）：off / busy 在这里答；能接就冒一句、挂出「应战 / 不应战」，
   * 熟人在「直接请进」打开且主人在电脑前时直接应战，不挂菜单（逐手局照样弹面板选方式）。
   */
  function hostDuel(visitor: Visitor, card: SparCard, commit: string, live = false): Promise<DuelAnswer> {
    const practice = cultivationOn();
    if (!practice) return Promise.resolve({ ok: false, reason: 'off' });
    if (
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.spar ||
      ctx.state.hosting !== null ||
      ctx.state.trip !== null ||
      ctx.state.duel ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted ||
      ctx.state.adventure?.blocking === true
    )
      return Promise.resolve({ ok: false, reason: 'busy' });
    return new Promise<DuelAnswer>((resolve) => {
      const state: DuelWait = { visitor, card, commit, hostNonce: randomSparNonce(), live, resolve, timer: null };
      state.timer = setTimeout(() => settleDuel(state, { ok: false, reason: 'timeout' }), sparWaitMs);
      ctx.state.duelWait = state;
      if (shouldAutoAdmit(neighbors, visitor, deps.appConfig().visit.autoAdmitFriends, tracker.snapshot()?.present)) {
        void say(`熟人 ${visitor.owner} 家的 ${visitor.pet} 来隔空切磋，直接应战～`);
        // 逐手局照样在出招面板里选自家方式（10 秒不点按自动）；旧对端发来的全自动局直接答应
        if (live) void answerDuel(true);
        else
          settleDuel(state, {
            ok: true,
            card: sparCardOf(practice.fighter(petName()), practice.view().stage),
            nonce: state.hostNonce,
          });
        return;
      }
      void say(`${visitor.owner} 家的 ${visitor.pet} 想跟我切磋～`);
      void refreshMenu();
      void askDuel(state);
    });
  }

  /**
   * 有人来挑战：直接弹应战面板，不再让主人先右键找「应战」。
   * 逐手局把出招方式一起选（自动 / AI / 手动 / 不应战），全自动局只问应战 / 不应战；
   * 菜单里的两项仍保留，右键点应战时会把这块面板收掉。
   */
  async function askDuel(state: DuelWait): Promise<void> {
    if (ctx.state.duelWait !== state) return;
    let panel;
    try {
      panel = openActionPanel(
        ctx.electron,
        `${new URL(deps.petBase).origin}/app/panel`,
        () => null,
        () => ctx.homePet.box(),
      );
    } catch (error) {
      // 面板开不出来就退回右键菜单：这一场还挂在 duelWait 上，主人仍能应战
      log(`串门：隔空切磋的应战面板没开出来：${errorText(error)}`);
      return;
    }
    ctx.state.duelPrompt = panel;
    promptSuperseded = false;
    // 逐手局要接着选出招方式，面板只等模式选择的时限；全自动局就是等主人应战，和旧菜单一样等满答复时限
    const timeout = Math.max(
      1,
      state.live ? Math.min(ctx.deps.modeTimeoutMs ?? 10_000, sparWaitMs - 100) : sparWaitMs - 100,
    );
    try {
      if (state.live) {
        const picked = await panel.chooseMode(ctx.ai.isReady(), timeout, {
          title: `${state.visitor.owner} 家的 ${state.visitor.pet} 想跟你切磋：怎么出招？`,
          declineLabel: '不应战',
        });
        if (promptSuperseded || ctx.state.duelWait !== state) return;
        await answerDuel(picked !== null, picked ?? undefined);
      } else {
        const pick = await panel.choosePrompt(
          `${state.visitor.owner} 家的 ${state.visitor.pet} 想跟你切磋，要应战吗？`,
          ['应战', '不应战'],
          timeout,
        );
        if (promptSuperseded || ctx.state.duelWait !== state) return;
        await answerDuel(pick === 1);
      }
    } finally {
      if (ctx.state.duelPrompt === panel) ctx.state.duelPrompt = null;
      panel.close();
    }
  }

  /** 主人点了「应战 / 不应战」；逐手局在答应以后选自家方式（10 秒不点按自动） */
  async function answerDuel(accept: boolean, pickedMode?: TurnMode): Promise<void> {
    const state = ctx.state.duelWait;
    if (!state) return;
    // 右键应战 / 收摊时把自动弹出的应战面板收掉；面板自己的 Promise 收尾时不再重复结算
    if (ctx.state.duelPrompt) {
      promptSuperseded = true;
      const panel = ctx.state.duelPrompt;
      ctx.state.duelPrompt = null;
      panel.close();
    }
    // 逐手局正在选出招方式：再点一次「应战」不要把这场的面板顶掉
    if (accept && state.live && ctx.state.actionPanel) return;
    if (!accept) {
      settleDuel(state, { ok: false, reason: 'declined' });
      void say(`好，那就不跟 ${state.visitor.pet} 切磋啦～`);
      return;
    }
    const practice = cultivationOn();
    if (!practice) {
      settleDuel(state, { ok: false, reason: 'off' });
      return;
    }
    let mode: TurnMode = pickedMode ?? 'auto';
    if (state.live && pickedMode === undefined) {
      const picked = await pickTurnMode(ctx);
      if (ctx.state.duelWait !== state) return;
      if (!picked) {
        settleDuel(state, { ok: false, reason: 'busy' });
        return;
      }
      mode = picked;
    }
    settleDuel(
      state,
      {
        ok: true,
        card: sparCardOf(practice.fighter(petName()), practice.view().stage),
        nonce: state.hostNonce,
      },
      mode,
    );
    void say(`来，跟 ${state.visitor.pet} 过两招～`);
  }

  /** 应战方这一侧收到 /v1/duel/reveal：承诺已核过，记账、开演（挑战方同时也在记它的） */
  function hostDuelReveal(visitor: Visitor, nonce: string, line: string): void {
    const state = ctx.state.duelAccepted;
    if (!state || state.visitor.id !== visitor.id || state.visitor.address !== visitor.address) return;
    ctx.state.duelAccepted = null;
    void runDuelHost(state, nonce, line);
  }

  /** 挑战方没亮随机数（对不上 / 超时）：按它认输记一场，不开打 */
  function hostDuelConceded(visitor: Visitor, why: 'mismatch' | 'late'): void {
    const state = ctx.state.duelAccepted;
    if (!state || state.visitor.id !== visitor.id) return;
    ctx.state.duelAccepted = null;
    const practice = cultivationOn();
    const id = visitor.id;
    if (!practice || !id) return;
    onCultivation(Date.now(), practice.sparDone(Date.now(), id, true), { anim: false });
    neighbors.dueled(id, { owner: visitor.owner, pet: visitor.pet }, true, Date.now());
    diary.note(
      Date.now(),
      'cultivate',
      `和 ${visitor.owner} 家的 ${visitor.pet} 隔空切磋，赢了（它${
        why === 'late' ? '没按时亮随机数' : '随机数没对上'
      }，算它认输）`,
    );
    void say(`${visitor.pet} ${why === 'late' ? '没按时亮随机数' : '随机数没对上'}，这场算它认输啦～`, {
      anim: false,
    });
    void refreshMenu();
  }

  /**
   * 应战方这一侧的隔空切磋演出：全自动局两边各自用同一对随机数算同一场，开打前记账；
   * 逐手局（X19）一手一手对传，打完才记账，掉线两边都不记。
   */
  async function runDuelHost(state: DuelAccepted, guestNonce: string, guestLine: string): Promise<void> {
    const practice = cultivationOn();
    const visitorId = state.visitor.id;
    if (!practice || !visitorId) {
      if (state.live) ctx.state.visitHost?.finishDuel();
      return;
    }
    // 切磋不比修为（X20）：名帖照旧收真实属性，开打和演出都用拉平后的这一对
    const [you, foe] = fairSparPair(practice.fighter(petName()), cardFighter(state.visitor.pet, state.card));
    const baseShow = {
      zero: you,
      one: foe,
      zeroStage: practice.view().label,
      oneStage: stageLabel(state.card.stage),
      lineRng: sparLineRng(guestNonce, state.hostNonce),
      local: 0 as const,
      foeLabel: `${state.visitor.owner} 家的 ${state.visitor.pet}`,
      // 自家宠物在家：不碰 AWAY_OPACITY / fadeHome，台词直接走 say(..., { anim: false })
      selfSay: (line: string, durationMs: number) => void say(line, { anim: false, durationMs }),
      think: () => void say('想一想…', { anim: false }),
      foeLine: guestLine,
      cancelled: () => ctx.state.disposed,
    };
    let won: boolean;
    if (state.live) {
      let events: BattleEvent[] | null;
      try {
        events = await runSparShow({
          ...baseShow,
          events: [],
          live: { role: 'server', mode: state.mode ?? 'auto', seed: `${guestNonce}:${state.hostNonce}` },
        });
      } finally {
        // 演出中途抛错也得收：留着的会话会让之后的隔空挑战一直回 busy
        ctx.state.visitHost?.finishDuel();
      }
      if (ctx.state.disposed) return;
      if (!events) {
        void say('切磋断了', { anim: false });
        void refreshMenu();
        return;
      }
      const end = events[events.length - 1];
      won = end.kind === 'end' && end.winner === 0;
      // 打完才记账（§X19）
      onCultivation(Date.now(), practice.sparDone(Date.now(), visitorId, won), { anim: false });
      neighbors.dueled(visitorId, { owner: state.visitor.owner, pet: state.visitor.pet }, won, Date.now());
      diary.note(
        Date.now(),
        'cultivate',
        `和 ${state.visitor.owner} 家的 ${state.visitor.pet} 隔空切磋，${won ? '赢了' : '输了'}`,
      );
    } else {
      const events = sparFight(you, foe, guestNonce, state.hostNonce);
      const end = events[events.length - 1];
      won = end.kind === 'end' && end.winner === 0;
      // 记账（同 X5，在开打这一步记；演出只是回放）
      onCultivation(Date.now(), practice.sparDone(Date.now(), visitorId, won), { anim: false });
      neighbors.dueled(visitorId, { owner: state.visitor.owner, pet: state.visitor.pet }, won, Date.now());
      diary.note(
        Date.now(),
        'cultivate',
        `和 ${state.visitor.owner} 家的 ${state.visitor.pet} 隔空切磋，${won ? '赢了' : '输了'}`,
      );
      await runSparShow({ ...baseShow, events });
      if (ctx.state.disposed) return;
    }
    void refreshMenu();
    const instruction =
      `你刚和隔空来切磋的${state.visitor.pet}（${state.visitor.owner} 家的）打了一场，${won ? '你赢了' : '你输了'}。` +
      '跟主人说一句赛后感言。' +
      (won ? '别提修为和法宝的数字。' : '切磋点到为止，输了不丢人，下次再战。');
    const text = cleanText(
      await compose(instruction, won ? '隔空切磋赢啦，承让承让～' : '隔空切磋输了，下次再战！'),
      LINE_MAX,
    );
    if (ctx.state.battle === null && ctx.state.liveBattle === null) void say(text, { anim: false });
  }

  /**
   * 挑战方发起隔空切磋（菜单「修炼/切磋/X 家的 Y」）：发名帖与承诺 → 对方应战后亮随机数 →
   * 一手一手对传、在自家屏幕上演全套 → 打完才记账、说赛后感言。
   */
  async function startDuel(id: string): Promise<void> {
    const practice = cultivationOn();
    const neighbor = ctx.state.neighborhood?.get(id);
    if (!practice || !neighbor) {
      await say('它好像已经不在附近了～');
      return;
    }
    if (
      ctx.state.duel ||
      ctx.state.spar ||
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.trip ||
      ctx.state.hosting ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted ||
      ctx.state.adventure?.blocking === true
    )
      return;
    // 发起方先在出招面板里选自家的方式（X19）；一律走逐手局，应战方也在它自己的面板里选
    const mode = await pickTurnMode(ctx);
    if (!mode || ctx.state.disposed) return;
    const state: DuelChallenge = { neighbor, stage: 'asking', since: Date.now(), nonce: randomSparNonce() };
    ctx.state.duel = state;
    void refreshMenu();
    await say(`去找 ${neighbor.pet} 切磋，等它应战～`);
    let reply: DuelReply;
    try {
      reply = await sendDuel(
        { address: neighbor.address, port: neighbor.port },
        neighbor.id,
        { owner: nickname(), pet: petName() },
        ctx.state.visitIdentity,
        {
          mode: SPAR_LIVE_MODE,
          card: sparCardOf(practice.fighter(petName()), practice.view().stage),
          commit: sparCommit(state.nonce),
        },
      );
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause;
      log(
        `串门：隔空切磋的请求没送到 ${neighbor.owner} 家：${errorText(error)}${cause ? `（${errorText(cause)}）` : ''}`,
      );
      if (ctx.state.duel === state) ctx.state.duel = null;
      await say(duelFailText(neighbor.owner, 'unreachable'));
      void refreshMenu();
      return;
    }
    if (ctx.state.duel !== state || ctx.state.disposed) return;
    if (!reply.ok) {
      ctx.state.duel = null;
      await say(duelFailText(neighbor.owner, reply.reason));
      void refreshMenu();
      return;
    }
    // 切磋不比修为（X20）：名帖照旧收真实属性，开打和演出都用拉平后的这一对
    const [foe, you] = fairSparPair(cardFighter(neighbor.pet, reply.card), practice.fighter(petName()));
    // 引擎里应战方是 0 号、挑战方是 1 号：两边各自算同一场
    const baseShow = {
      zero: foe,
      one: you,
      zeroStage: stageLabel(reply.card.stage),
      oneStage: practice.view().label,
      lineRng: sparLineRng(state.nonce, reply.nonce),
      local: 1 as const,
      foeLabel: `${neighbor.owner} 家的 ${neighbor.pet}`,
      // 自家宠物在家：不碰 AWAY_OPACITY / fadeHome，台词直接走 say(..., { anim: false })
      selfSay: (line: string, durationMs: number) => void say(line, { anim: false, durationMs }),
      think: () => void say('想一想…', { anim: false }),
      cancelled: () => ctx.state.duel !== state,
    };
    // 逐手局：先亮随机数（赛后感言打完再编），再一手一手对传；打完才记账
    let revealed: DuelRevealReply;
    try {
      revealed = await sendDuelReveal(
        { address: neighbor.address, port: neighbor.port },
        { token: reply.token, nonce: state.nonce, line: '' },
      );
    } catch (error) {
      log(`串门：隔空切磋的随机数没亮出去：${errorText(error)}`);
      if (ctx.state.duel !== state) return;
      ctx.state.duel = null;
      onCultivation(Date.now(), practice.sparDone(Date.now(), neighbor.id, false), { anim: false });
      neighbors.dueled(neighbor.id, { owner: neighbor.owner, pet: neighbor.pet }, false, Date.now());
      diary.note(Date.now(), 'cultivate', `和 ${neighbor.owner} 家的 ${neighbor.pet} 隔空切磋，输了（没按时亮随机数）`);
      await say('亮随机数迟了，算我认输', { anim: false });
      void refreshMenu();
      return;
    }
    if (ctx.state.duel !== state || ctx.state.disposed) return;
    if (!revealed.ok) {
      ctx.state.duel = null;
      if (revealed.reason === 'mismatch' || revealed.reason === 'late') {
        onCultivation(Date.now(), practice.sparDone(Date.now(), neighbor.id, false), { anim: false });
        neighbors.dueled(neighbor.id, { owner: neighbor.owner, pet: neighbor.pet }, false, Date.now());
        diary.note(
          Date.now(),
          'cultivate',
          `和 ${neighbor.owner} 家的 ${neighbor.pet} 隔空切磋，输了（${
            revealed.reason === 'late' ? '没按时亮随机数' : '随机数没对上'
          }）`,
        );
      }
      await say(duelFailText(neighbor.owner, revealed.reason), { anim: false });
      void refreshMenu();
      return;
    }
    state.stage = 'showing';
    const events = await runSparShow({
      ...baseShow,
      events: [],
      live: {
        role: 'client',
        mode,
        seed: `${state.nonce}:${reply.nonce}`,
        sendTurn: (body, signal) =>
          sendDuelTurn({ address: neighbor.address, port: neighbor.port }, { token: reply.token, ...body }, signal),
      },
    });
    if (ctx.state.duel !== state || ctx.state.disposed) return;
    ctx.state.duel = null;
    if (!events) {
      void say('切磋断了', { anim: false });
      void refreshMenu();
      return;
    }
    const end = events[events.length - 1];
    const won = end.kind === 'end' && end.winner === 1;
    // 打完才记账（§X19）
    onCultivation(Date.now(), practice.sparDone(Date.now(), neighbor.id, won), { anim: false });
    neighbors.dueled(neighbor.id, { owner: neighbor.owner, pet: neighbor.pet }, won, Date.now());
    diary.note(Date.now(), 'cultivate', `和 ${neighbor.owner} 家的 ${neighbor.pet} 隔空切磋，${won ? '赢了' : '输了'}`);
    void say(won ? '这场隔空切磋我赢啦！' : '这场隔空切磋输了，下次再战～', { anim: false });
    void say(await duelRemark(neighbor, won), { anim: false });
    void refreshMenu();
  }

  /** 逐手局应战方这一侧收到的一手（X19）：协议层已核过令牌 / 来源地址，递进正在跑的那一场 */
  async function duelTurn(
    _visitor: Visitor,
    index: number,
    action?: Action,
    forfeit?: boolean,
  ): Promise<SparTurnReply> {
    const turn = ctx.state.liveTurn;
    if (!turn) return { ok: false, reason: 'not-visiting' };
    return turn(index, action, forfeit);
  }

  /** 挑战方的赛后感言：按人设编一句（只带人设，§2.2 的口径），编太久退回模板（模型卡住别拖着收场） */
  async function duelRemark(neighbor: Neighbor, won: boolean): Promise<string> {
    const instruction =
      `你正在跟${neighbor.owner}家的宠物${neighbor.pet}隔空切磋，${won ? '你赢了' : '你输了'}。说一句赛后感言。` +
      (won ? '别提修为和法宝的数字。' : '切磋点到为止，输了不丢人。');
    const fallback = won ? '隔空切磋赢啦，承让承让～' : '隔空切磋输了，下次再战！';
    const composed = compose(instruction, fallback);
    const capped = new Promise<string>((done) => setTimeout(() => done(fallback), SPAR_REMARK_CAP_MS));
    return Promise.race([composed, capped]);
  }

  /**
   * 挑战方的隔空切磋项（X15）：只列在线、带 id 的邻居，熟人在前（照邻居列表现有的排序），最多 3 个。
   * 放在 wantedLabels 的最后：菜单项挤不下时先截掉它们，串门的邻居项照旧。
   */
  function duelChallengeActions(): Map<string, () => unknown> {
    const actions = new Map<string, () => unknown>();
    const practice = cultivationOn();
    if (
      !practice ||
      ctx.state.battle ||
      ctx.state.liveBattle ||
      ctx.state.actionPanel ||
      ctx.state.spar ||
      ctx.state.duel ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted ||
      ctx.state.trip ||
      ctx.state.hosting ||
      ctx.state.knockingOn ||
      ctx.state.visitHost?.knocking() ||
      ctx.state.adventure?.blocking === true
    )
      return actions;
    if (!deps.appConfig().visit.enabled || !deps.appConfig().visit.visiting) return actions;
    const ordered = orderNeighbors(ctx.state.neighborhood?.list() ?? [], neighbors, ctx.state.lastGuest, Date.now());
    const nearby = (ordered.revisit ? [ordered.revisit, ...ordered.list] : ordered.list)
      .filter((neighbor) => neighbor.id)
      .slice(0, DUEL_NEIGHBORS_MAX);
    for (const neighbor of nearby) {
      let label = `${MENU_CULTIVATION_GROUP}/切磋/${neighbor.owner} 家的 ${neighbor.pet}`;
      for (let n = 2; actions.has(label); n += 1)
        label = `${MENU_CULTIVATION_GROUP}/切磋/${neighbor.owner} 家的 ${neighbor.pet}（${n}）`;
      actions.set(label, () => void startDuel(neighbor.id));
    }
    return actions;
  }

  /** 隔空切磋没打成的原因，说给自家主人听（old-host / declined / timeout 是 X15 点名的几种） */
  function duelFailText(
    owner: string,
    reason: DuelFailure | 'mismatch' | 'late' | 'not-visiting' | 'unreachable',
  ): string {
    switch (reason) {
      case 'old-host':
        return '对方的桌宠还不会隔空切磋';
      case 'off':
        return '对方没开修炼，切不了';
      case 'busy':
        return `${owner} 家正忙着，等会儿再切～`;
      case 'version':
        return '两边版本不一样，切磋不了';
      case 'unsupported-mode':
        return '对方的桌宠还不会逐手切磋';
      case 'bad-card':
        return '对方没看懂我的名帖';
      case 'bad-sig':
        return `${owner} 家没应战，下次再约～`;
      case 'bad-request':
        return '没打成';
      case 'declined':
      case 'timeout':
        return `${owner} 家没应战，下次再约～`;
      case 'too-soon':
        return `刚找过 ${owner} 家，等会儿再切～`;
      case 'mismatch':
        return '随机数没对上，算我认输';
      case 'late':
        return '亮随机数迟了，算我认输';
      case 'not-visiting':
        return '对方不认这场了';
      case 'unreachable':
        return `连不上 ${owner} 家，看看系统设置里有没有允许 dsh-pet 访问本地网络～`;
    }
  }

  return {
    cancelDuels,
    hostDuel,
    answerDuel,
    hostDuelReveal,
    duelTurn,
    hostDuelConceded,
    duelChallengeActions,
  };
}
