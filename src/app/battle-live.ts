/**
 * 逐手出招（修炼路线 X17）：把「重放到缺决策处」的引擎接成一段一段的演出，并提供 AI 出招的
 * 提示词、JSON 解析与限时请求。心魔试炼只在这里做接线（features/trial.ts），历练 / 切磋以后照用。
 *
 * 引擎每次只算到下一个决策点（`fightUntilDecision`），外层把这一手补进自家的动作串、从头再算一遍；
 * 演出用 `LiveTimeline` 只取新多出来的那一段，所以已经播过的动画、台词、飞行物都不会重排。
 */
import {
  MOVES,
  SKILLS,
  WEAPONS,
  fallbackAction,
  fightUntilDecision,
  legalActions,
  type Action,
  type BattleEvent,
  type BattleView,
  type Fighter,
  type MoveId,
  type SkillId,
  type WeaponId,
} from './battle';
import { BattleShow, LiveTimeline, swapSides, type ShowSides, type Step, type TimelineOptions } from './battle-show';
import type { StandaloneAiService } from '../standalone/ai-provider';
import { cleanText } from './visit';
import type { SparTurnReply } from './visit';

/** 一手：动作 + AI 可选的一句台词（20 字以内） */
export interface TurnDecision {
  action: Action;
  line?: string;
}

export type ActionTone = 'damage' | 'control' | 'sustain';

/** 主动招式的面板分类；没列出的动作按伤害处理 */
export const SKILL_TONE: Partial<Record<SkillId, ActionTone>> = {
  bloom: 'sustain',
  'lion-roar': 'control',
  'blue-whale': 'damage',
  'whale-song': 'control',
  ink: 'control',
  'whale-gulp': 'sustain',
  'myriad-self': 'sustain',
  'dream-chant': 'control',
  'finger-sword': 'damage',
  'dragon-palm': 'damage',
  'farewell-wind': 'control',
};

/** 编号清单里的一项（面板按钮与 AI 的 `pick` 共用一份） */
export interface LegalChoice {
  /** 从 1 数（AI 的 JSON 与 curl 的 pick 同一口径） */
  pick: number;
  action: Action;
  label: string;
  note?: string;
  /** 给 AI 看的一句效果 */
  effect: string;
  tone: ActionTone;
}

function weaponEffect(id: WeaponId): string {
  const w = WEAPONS[id];
  const bits = [`伤害 ${w.min}–${w.max}`];
  if (w.hits > 1) bits.push(`${w.hits} 段`);
  if (w.mustHit) bits.push('必中');
  if (w.ranged) bits.push('远程');
  if (w.skipChance > 0) bits.push(w.skipCause === 'freeze' ? '可能冻住' : '可能打晕');
  if (w.slow) bits.push('可能迟缓');
  if (w.twinChance > 0) bits.push('可能一发两颗');
  if (w.heavy) bits.push('重，下一手会慢');
  return bits.join('，');
}

function moveEffect(id: MoveId): string {
  const m = MOVES[id];
  const bits = [`伤害 ${m.min}–${m.max}`];
  if (m.hits > 1) bits.push(`${m.hits} 段`);
  if (m.packHits) bits.push('按狗数多段');
  if (m.mustHit) bits.push('必中');
  if (m.ranged) bits.push('远程');
  if (m.skipChance > 0) bits.push(m.skipCause === 'freeze' ? '可能冻住' : '可能打晕');
  if (m.heavy) bits.push('重，下一手会慢');
  return bits.join('，');
}

/** 主动招式的一句效果（AI 提示词用；图鉴里没有伤害数字） */
const SKILL_EFFECT: Record<SkillId, string> = {
  'play-dead': '致命一击时保命一次，但要躺一拍',
  dove: '提高闪避',
  bubble: '挨打时挡下两次并减伤',
  'sixth-sense': '挨打后可能反劈一刀',
  'shadow-fists': '连击时追打一串拳影',
  critical: '提高会心',
  'spirit-beast': '前几次出手后追加一击',
  bloom: '回 18% 气血并马上再出一手',
  'lion-roar': '伤害并可能震晕对方一拍',
  'blue-whale': '大伤害',
  'whale-song': '伤害并可能让对方睡过下一拍',
  ink: '让对方接下来三次出手可能打空',
  'whale-gulp': '伤害并回复一半',
  'myriad-self': '召出三重魂影替自己挨打',
  'dream-chant': '必中伤害并可能把对方牵进梦里一拍',
  'finger-sword': '必中且穿护体',
  'dragon-palm': '必中伤害，下一手法宝或空手带后劲',
  'farewell-wind': '必中伤害并可能让对方飘过下一拍',
  'jelly-clone': '挨打时可能用水母替身挡下',
};

/** 一项动作在面板 / AI 提示词里的名字 */
export function actionLabel(action: Action): string {
  if (action.kind === 'weapon') return WEAPONS[action.weapon].name;
  if (action.kind === 'move') return MOVES[action.move].name;
  if (action.kind === 'skill') return SKILLS[action.skill].name;
  return '空手';
}

/** 一项动作的效果说明 */
export function actionEffect(action: Action): string {
  if (action.kind === 'weapon') return weaponEffect(action.weapon);
  if (action.kind === 'move') return moveEffect(action.move);
  if (action.kind === 'skill') return SKILL_EFFECT[action.skill];
  return '伤害 3–6';
}

/** 手动面板按主要效果分成伤害、控制、回复与保命三组 */
export function toneOf(action: Action): ActionTone {
  if (action.kind === 'weapon') {
    const weapon = WEAPONS[action.weapon];
    return weapon.skipChance > 0 || weapon.slow ? 'control' : 'damage';
  }
  if (action.kind === 'move') return MOVES[action.move].skipChance > 0 ? 'control' : 'damage';
  if (action.kind === 'skill') return SKILL_TONE[action.skill] ?? 'damage';
  return 'damage';
}

/**
 * 这一手的选择清单：顺序与 `legalActions` 一致，编号从 1 数。
 * 有次数限制的招式在 `note` 里标还剩几次（面板照这个显示）。
 */
export function legalChoices(view: BattleView): LegalChoice[] {
  const used = view.you.moveUses ?? [];
  return legalActions(view).map((action, index) => {
    let note: string | undefined;
    if (action.kind === 'move') {
      const cap = MOVES[action.move].uses;
      if (cap !== undefined) note = `剩 ${Math.max(0, cap - used.filter((id) => id === action.move).length)} 次`;
    }
    return {
      pick: index + 1,
      action,
      label: actionLabel(action),
      ...(note ? { note } : {}),
      effect: actionEffect(action),
      tone: toneOf(action),
    };
  });
}

function namesOf(view: BattleView, names: [string, string]): { me: string; foe: string } {
  return { me: names[view.self], foe: names[view.self === 0 ? 1 : 0] };
}

function listSkills(skills: SkillId[]): string {
  return skills.length > 0 ? skills.map((id) => `${SKILLS[id].name}（${SKILL_EFFECT[id]}）`).join('、') : '无';
}

function listMoves(moves: MoveId[] | undefined): string {
  return moves && moves.length > 0 ? moves.map((id) => `${MOVES[id].name}（${moveEffect(id)}）`).join('、') : '无';
}

/**
 * AI 出招的正文：双方气血（含上限）、自己的法宝和招式（名字 + 一句效果）、对方的、这场已经用掉的、
 * `legalActions` 的编号清单，以及只回 JSON 的要求。
 */
export function turnPrompt(view: BattleView, names: [string, string]): string {
  const { me, foe } = namesOf(view, names);
  const usedSkills = view.you.used.map((id) => SKILLS[id].name);
  const usedMoves = view.you.moveUses ?? [];
  const usedMoveText = [...new Set(usedMoves)].map(
    (id) => `${MOVES[id].name}×${usedMoves.filter((x) => x === id).length}`,
  );
  const used = [...usedSkills, ...usedMoveText];
  return [
    `你是${me}，在和${foe}对战。`,
    `你的气血 ${view.hp[view.self]}/${view.maxHp[view.self]}；对方气血 ${view.hp[view.self === 0 ? 1 : 0]}/${view.maxHp[view.self === 0 ? 1 : 0]}。`,
    `你的法宝：${view.you.weapons.length > 0 ? view.you.weapons.map((id) => `${WEAPONS[id].name}（${weaponEffect(id)}）`).join('、') : '无'}。`,
    `你的招式：${listSkills(view.you.skills)}${view.you.moves && view.you.moves.length > 0 ? `；${listMoves(view.you.moves)}` : ''}。`,
    `对方的法宝：${view.foe.weapons.length > 0 ? view.foe.weapons.map((id) => WEAPONS[id].name).join('、') : '无'}。`,
    `对方的招式：${listSkills(view.foe.skills)}。`,
    `这一场你已经用掉：${used.length > 0 ? used.join('、') : '无'}。`,
    '这一手可以选：',
    ...legalChoices(view).map(
      (choice) => `${choice.pick}. ${choice.label}（${choice.effect}${choice.note ? `，${choice.note}` : ''}）`,
    ),
    `只回一个 JSON 对象，不要代码块、不要多余的话：{"pick": 编号, "line": "可选，20 字以内"}。`,
  ].join('\n');
}

/**
 * 解析 AI 的回答：跳过 `{...}` 之外的话（代码块、解释），`pick` 必须在 `1..count`，
 * `line` 过 `cleanText` 截到 20 字。解析不了 / 编号不合法回 null（外层按后备挑法出）。
 */
export function parseTurnReply(reply: string, count: number): { pick: number; line?: string } | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const pick = (parsed as Record<string, unknown>).pick;
  if (typeof pick !== 'number' || !Number.isInteger(pick) || pick < 1 || pick > count) return null;
  const line = cleanText((parsed as Record<string, unknown>).line, 20);
  return { pick, ...(line ? { line } : {}) };
}

export interface AskTurnOptions {
  ai: StandaloneAiService;
  /** 宠物人设 */
  system: string;
  view: BattleView;
  names: [string, string];
  /** 15 秒 */
  timeoutMs: number;
  /** 收摊 / 快进时作废这一手 */
  signal: AbortSignal;
  log: (message: string) => void;
}

/**
 * 问 AI 这一手（X17）：一次模型请求，15 秒超时；解析失败、超时、没配好都回 null，
 * 外层按后备挑法出、整场不中断。走 `streamBattle`（另一份每分钟 30 次的额度），不排说话队列。
 */
export async function askAiTurn(options: AskTurnOptions): Promise<{ pick: number; line?: string } | null> {
  const choices = legalChoices(options.view);
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
    cancelReject?.(new Error('cancelled'));
    cancelReject = null;
  };
  let cancelReject: ((error: Error) => void) | null = null;
  if (options.signal.aborted) return null;
  options.signal.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const selection = options.ai.currentSelection();
    const reading = (async (): Promise<string> => {
      let text = '';
      for await (const part of options.ai.streamBattle({
        provider: selection.provider,
        model: selection.model,
        system: options.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: turnPrompt(options.view, options.names) }] }],
        signal: controller.signal,
      }))
        text += part.text;
      return text;
    })();
    const failed = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new Error('timeout'));
        },
        Math.max(1, options.timeoutMs),
      );
    });
    const cancelled = new Promise<never>((_resolve, reject) => (cancelReject = reject));
    if (options.signal.aborted) {
      controller.abort();
      return null;
    }
    const text = await Promise.race([reading, failed, cancelled]);
    const reply = parseTurnReply(text, choices.length);
    if (!reply) options.log('逐手出招：AI 出招失败（回答里没有合法的 pick），按后备挑法');
    return reply;
  } catch (error) {
    options.log(`逐手出招：AI 出招失败（${error instanceof Error ? error.message : String(error)}），按后备挑法`);
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
    cancelReject = null;
    options.signal.removeEventListener('abort', cancel);
    controller.abort();
  }
}

export interface LiveBattleOptions {
  a: Fighter;
  b: Fighter;
  seed: string;
  /** `'auto'` 不走这个函数（全自动仍由 `fight` + 整场时间线演） */
  mode: 'ai' | 'manual';
  show: ShowSides;
  /** 解说台词的随机数（注入才测得准） */
  lineRng: () => number;
  /** 时间线的额外选项（心魔不用） */
  timeline?: TimelineOptions;
  /** 定这一手：AI 超时 / 手动没点由实现回 null，外层按后备挑法出 */
  decide: (view: BattleView, index: number, signal: AbortSignal) => Promise<TurnDecision | null>;
  /** 已经记下的自家出手（中断续打 / 春秋蝉倒回）：先照这串重放，用完再问 */
  initialActions?: readonly Action[];
  /** 每定下一手（含后备）就回调：调用方立刻写进存档 */
  onDecision?: (action: Action, index: number) => void;
  /** 演完一段还没定（AI 还在想）：让宠物头上显示「想一想…」 */
  think: () => void;
  log: (message: string) => void;
}

/** 一场逐手对战：`done` 在演完 / 快进 / 收摊时结算（收摊回 null） */
export interface LiveBattle {
  done: Promise<BattleEvent[] | null>;
  /** 快进：剩下的手全按后备挑法、立刻算完，演到最后 */
  skip(): void;
  /** 收摊 / 退出：停掉等待与演出，`done` 回 null */
  dispose(): void;
}

/**
 * 开一场逐手对战（X17 的心魔）：边演边问下一手，一段一段把时间线接起来。
 * 全自动的场次不走这里（`fight` + 整场 `timeline` 一字不改）。
 */
export function startLiveBattle(options: LiveBattleOptions): LiveBattle {
  const decisions: Action[] = [...(options.initialActions ?? [])];
  const decideLines = new Map<number, string>();
  const live = new LiveTimeline(
    [options.a.name, options.b.name],
    options.lineRng,
    [options.a.skills, options.b.skills],
    { ...options.timeline, decideLines },
  );
  const abort = new AbortController();
  let current: BattleShow | null = null;
  let fastForward = false;
  let disposed = false;
  let resolveDone: (events: BattleEvent[] | null) => void = () => undefined;
  const done = new Promise<BattleEvent[] | null>((resolve) => (resolveDone = resolve));
  let settled = false;
  const finish = (events: BattleEvent[] | null): void => {
    if (settled) return;
    settled = true;
    current = null;
    resolveDone(events);
  };

  /** 播一段：步骤的绝对时刻从上一段结尾接着排，所以平移到 0 起播 */
  const play = async (steps: Step[]): Promise<void> => {
    if (steps.length === 0) return;
    const start = steps[0].at;
    const show = new BattleShow(
      steps.map((step) => ({ ...step, at: step.at - start })),
      options.show,
    );
    current = show;
    await show.run();
    if (current === show) current = null;
  };

  /** 快进时把这一步的步骤换成收场几步直接播（同 `BattleShow.skip()` 的口径） */
  const skipToEnd = async (): Promise<void> => {
    current?.dispose();
    const finalShow = new BattleShow(live.steps(), options.show);
    finalShow.skip();
    await finalShow.run();
  };

  void (async () => {
    let result = fightUntilDecision(options.a, options.b, options.seed, [decisions, 'auto']);
    try {
      while (true) {
        if (disposed) return finish(null);
        if (fastForward) {
          // 剩下的手全按后备挑法算完，再跳到收场
          while (result.need) {
            const index = decisions.length;
            const action = fallbackAction(result.need.view, options.seed, index);
            decisions.push(action);
            options.onDecision?.(action, index);
            result = fightUntilDecision(options.a, options.b, options.seed, [decisions, 'auto']);
          }
          live.push(result.events);
          await skipToEnd();
          return finish(result.events);
        }
        if (!result.need) {
          const tail = live.push(result.events);
          await play(tail);
          if (fastForward && !disposed) await skipToEnd();
          return finish(disposed ? null : result.events);
        }
        const index = decisions.length;
        const need = result.need;
        let decided = false;
        const decision = options
          .decide(need.view, index, abort.signal)
          .then((value) => {
            decided = true;
            return value;
          })
          .catch((error: unknown) => {
            decided = true;
            options.log(
              `逐手出招：定这一手失败（${error instanceof Error ? error.message : String(error)}），按后备挑法`,
            );
            return null;
          });
        const segment = play(live.push(result.events));
        await segment;
        if (disposed) return finish(null);
        if (fastForward) continue;
        if (!decided) options.think();
        let picked: TurnDecision | null = null;
        try {
          picked = await decision;
        } catch {
          picked = null;
        }
        if (disposed) return finish(null);
        if (fastForward) continue;
        // 外部把等待作废（面板关了 / 收到一半的 AI 请求）：这一手改按后备挑法出
        const action = picked?.action ?? fallbackAction(need.view, options.seed, index);
        decisions.push(action);
        options.onDecision?.(action, index);
        if (picked?.line) decideLines.set(result.events.length, picked.line);
        result = fightUntilDecision(options.a, options.b, options.seed, [decisions, 'auto']);
      }
    } catch (error) {
      options.log(`逐手出招：这一场中断了（${error instanceof Error ? error.message : String(error)}）`);
      finish(null);
    }
  })();

  return {
    done,
    skip() {
      if (fastForward || disposed || settled) return;
      fastForward = true;
      abort.abort();
      current?.dispose();
    },
    dispose() {
      if (disposed || settled) return;
      disposed = true;
      fastForward = true;
      abort.abort();
      current?.dispose();
      finish(null);
    },
  };
}

// ---------- 逐手对传（X19：串门切磋 / 隔空切磋） ----------

/** 逐手局一手的应答（协议层的 SparTurnReply 与此同形；battle-live 不认识网络） */
export type LiveTurnReply =
  { ok: true; action?: Action } | { ok: false; reason: 'illegal' | 'late' | 'busy' | 'not-visiting' };

/** 逐手对传两边共用的一份：本地是引擎几号、本地这一手怎么定、怎么把一段一段演出来 */
export interface LiveVersusOptions {
  a: Fighter;
  b: Fighter;
  seed: string;
  /** 本地是引擎 0 号还是 1 号（1 号要 swapSides 成本地视角） */
  local: 0 | 1;
  show: ShowSides;
  /** 解说台词的随机数（两边同一种子） */
  lineRng: () => number;
  timeline?: TimelineOptions;
  /** 串门切磋的逐手局两边都传 true（X16）；隔空切磋、心魔、秘境都不传 */
  farewell?: boolean;
  /** 切磋节奏（X23）：只给切磋 / 隔空传，两边必须一致；不传按 1 */
  damageScale?: number;
  /** 单次伤害封顶（X23）：只给切磋 / 隔空传，两边必须一致；不传不封顶 */
  maxHitShare?: number;
  /** 本地这一手：返回 null（超时 / 没选 / 收摊）就按后备挑法出 */
  decide: (view: BattleView, index: number, signal: AbortSignal) => Promise<TurnDecision | null>;
  /** 演完一段、本地这一手还没定：宠物头上「想一想…」 */
  think: () => void;
  log: (message: string) => void;
  /**
   * 开演闸门：占住宠物这类准备动作（`/lock` 要一个来回）。给上就先等它再演第一段，
   * 免得第一段动画抢在锁前面；局本身照样立刻注册，对端递进来的第一手不会丢。
   */
  ready?: Promise<unknown>;
}

/** 发起方 / 客人那一侧：发 HTTP 的总是这一边 */
export interface LiveClientOptions extends LiveVersusOptions {
  /** 等对面一手 / 自己这一手送达的时限（35 秒没收到就当掉线） */
  waitMs: number;
  sendTurn: (body: { index: number; action?: Action }, signal: AbortSignal) => Promise<SparTurnReply>;
}

/** 应战方 / 主人家那一侧：请求由协议层经 `turn()` 递进来 */
export interface LiveServerOptions extends LiveVersusOptions {
  /** 等对面下一手的时限（35 秒没来就当掉线） */
  waitMs: number;
}

/** 一场逐手对传：`done` 在演完 / 掉线 / 收摊时结算（掉线、收摊回 null） */
export interface LiveVersus {
  done: Promise<BattleEvent[] | null>;
  /** 快进：本地剩下的手全按后备挑法、不再等 AI / 手动；仍按协议把出手传完 */
  skip(): void;
  /** 收摊 / 退出：停掉等待与演出，`done` 回 null */
  dispose(): void;
  /** 服务端专用：协议层收到一手时调（客户端调用回 not-visiting） */
  turn(index: number, action?: Action): Promise<LiveTurnReply>;
}

/** 两个动作是不是同一个（动作只有 kind + 编号） */
function sameAction(a: Action, b: Action): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'weapon' && b.kind === 'weapon') return a.weapon === b.weapon;
  if (a.kind === 'skill' && b.kind === 'skill') return a.skill === b.skill;
  if (a.kind === 'move' && b.kind === 'move') return a.move === b.move;
  return a.kind === 'unarmed';
}

/** 这一手在不在 `legalActions` 里 */
function isLegal(view: BattleView, action: Action): boolean {
  return legalActions(view).some((item) => sameAction(item, action));
}

/** 一次入站请求（服务端）：序号、对面的出手（轮到它时才有）、应答 */
interface LiveInbound {
  index: number;
  action?: Action;
  reply: (result: LiveTurnReply) => void;
}

/**
 * 逐手对传的发起方 / 客人那一侧（X19）：轮到自家时带上这一手发出去，轮到对面时挂着等它回。
 * 对面 35 秒没回、连接断了、回的招不合法，都按掉线，`done` 回 null。
 */
export function startLiveClient(options: LiveClientOptions): LiveVersus {
  const actions: [Action[], Action[]] = [[], []];
  const decideLines = new Map<number, string>();
  const live = new LiveTimeline(
    [options.a.name, options.b.name],
    options.lineRng,
    [options.a.skills, options.b.skills],
    { ...options.timeline, decideLines },
  );
  const decideAbort = new AbortController();
  const networkAbort = new AbortController();
  let current: BattleShow | null = null;
  let fastForward = false;
  let disposed = false;
  let settled = false;
  let resolveDone: (events: BattleEvent[] | null) => void = () => undefined;
  const done = new Promise<BattleEvent[] | null>((resolve) => (resolveDone = resolve));

  const finish = (events: BattleEvent[] | null): void => {
    if (settled) return;
    settled = true;
    current = null;
    resolveDone(events);
  };

  /** 演一段：步骤的绝对时刻从上一段结尾接着排，所以平移到 0 起播；本地是 1 号时换边 */
  const play = async (steps: Step[]): Promise<void> => {
    if (steps.length === 0 || fastForward || disposed) return;
    if (options.ready) await options.ready;
    const local = options.local === 1 ? swapSides(steps) : steps;
    const start = local[0].at;
    const show = new BattleShow(
      local.map((one) => ({ ...one, at: one.at - start })),
      options.show,
    );
    current = show;
    await show.run();
    if (current === show) current = null;
  };

  /** 本地这一手：定不了 / 不合法都按后备挑法（序号用这一手在整场里的位置） */
  const localAction = async (view: BattleView, index: number): Promise<{ action: Action; line?: string }> => {
    let decision: TurnDecision | null = null;
    try {
      decision = await options.decide(view, index, decideAbort.signal);
    } catch (error) {
      options.log(`逐手对传：定这一手失败（${error instanceof Error ? error.message : String(error)}），按后备挑法`);
    }
    const action =
      decision?.action && isLegal(view, decision.action) ? decision.action : fallbackAction(view, options.seed, index);
    return { action, ...(decision?.line ? { line: decision.line } : {}) };
  };

  /** 等对面一手 / 送出自家的这一手：超过 waitMs 或收摊都抛错，外层按掉线 */
  const waitTurn = (body: { index: number; action?: Action }, what: string): Promise<SparTurnReply> => {
    if (networkAbort.signal.aborted) return Promise.reject(new Error('cancelled'));
    return new Promise<SparTurnReply>((resolve, reject) => {
      let done = false;
      const finish = (error: Error | null, reply?: SparTurnReply): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        networkAbort.signal.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve(reply ?? { ok: false, reason: 'not-visiting' });
      };
      const timer = setTimeout(() => finish(new Error(`${what}超时`)), Math.max(1, options.waitMs));
      const cancel = (): void => finish(new Error('cancelled'));
      networkAbort.signal.addEventListener('abort', cancel, { once: true });
      options.sendTurn(body, networkAbort.signal).then(
        (reply) => finish(null, reply),
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
  };

  void (async () => {
    try {
      let result = fightUntilDecision(options.a, options.b, options.seed, [actions[0], actions[1]], {
        farewell: options.farewell,
        damageScale: options.damageScale,
        maxHitShare: options.maxHitShare,
      });
      while (true) {
        if (disposed) return finish(null);
        if (!result.need) {
          await play(live.push(result.events));
          return finish(disposed ? null : result.events);
        }
        const need = result.need;
        const index = actions[0].length + actions[1].length;
        const local = need.side === options.local;
        let decided = false;
        const decision = (async (): Promise<{ action: Action; line?: string } | null> => {
          if (local) {
            const picked = await localAction(need.view, index);
            decided = true;
            return picked;
          }
          const reply = await waitTurn({ index }, '等对面出手');
          if (!reply.ok) throw new Error(reply.reason);
          if (!reply.action) throw new Error('对面没有给这一手');
          if (!isLegal(need.view, reply.action)) throw new Error('对面这一手不合法');
          decided = true;
          return { action: reply.action };
        })();
        // 一边问下一手一边把上一段演完（§X17 边演边想）
        await play(live.push(result.events));
        if (disposed) return finish(null);
        if (!decided && !fastForward) options.think();
        let picked: { action: Action; line?: string } | null;
        try {
          picked = await decision;
        } catch (error) {
          options.log(`逐手对传：这一手断了（${error instanceof Error ? error.message : String(error)}），按掉线`);
          return finish(null);
        }
        if (disposed) return finish(null);
        if (!picked) return finish(null);
        if (picked.line) decideLines.set(result.events.length, picked.line);
        // 自家这一手也发给对面（对面要过 legalActions，收下这一场才往下走）
        if (local) {
          const reply = await waitTurn({ index, action: picked.action }, '送这一手').catch((error: unknown) => {
            options.log(`逐手对传：这一手没送到（${error instanceof Error ? error.message : String(error)}），按掉线`);
            return null;
          });
          if (disposed) return finish(null);
          if (!reply || !reply.ok) return finish(null);
        }
        actions[need.side].push(picked.action);
        result = fightUntilDecision(options.a, options.b, options.seed, [actions[0], actions[1]], {
          farewell: options.farewell,
          damageScale: options.damageScale,
          maxHitShare: options.maxHitShare,
        });
      }
    } catch (error) {
      options.log(`逐手对传：这一场中断了（${error instanceof Error ? error.message : String(error)}）`);
      finish(null);
    }
  })();

  return {
    done,
    skip() {
      if (fastForward || disposed || settled) return;
      fastForward = true;
      decideAbort.abort();
      current?.dispose();
    },
    dispose() {
      if (disposed || settled) return;
      disposed = true;
      fastForward = true;
      decideAbort.abort();
      networkAbort.abort();
      current?.dispose();
      finish(null);
    },
    turn: () => Promise.resolve({ ok: false, reason: 'not-visiting' as const }),
  };
}

/**
 * 逐手对传的应战方 / 主人家那一侧（X19）：请求由协议层经 `turn()` 递进来。
 * 轮到对面时只收它那一手（先过 legalActions）；轮到自家时定了再随应答回过去。
 * 对面 35 秒没来下一手、序号对不上、出手不合法，都按掉线，`done` 回 null。
 */
export function startLiveServer(options: LiveServerOptions): LiveVersus {
  const actions: [Action[], Action[]] = [[], []];
  const decideLines = new Map<number, string>();
  const live = new LiveTimeline(
    [options.a.name, options.b.name],
    options.lineRng,
    [options.a.skills, options.b.skills],
    { ...options.timeline, decideLines },
  );
  const abort = new AbortController();
  const inbound: LiveInbound[] = [];
  let wake: (() => void) | null = null;
  let current: BattleShow | null = null;
  let fastForward = false;
  let disposed = false;
  let settled = false;
  let resolveDone: (events: BattleEvent[] | null) => void = () => undefined;
  const done = new Promise<BattleEvent[] | null>((resolve) => (resolveDone = resolve));

  const finish = (events: BattleEvent[] | null): void => {
    if (settled) return;
    settled = true;
    current = null;
    resolveDone(events);
  };

  const play = async (steps: Step[]): Promise<void> => {
    if (steps.length === 0 || fastForward || disposed) return;
    if (options.ready) await options.ready;
    const local = options.local === 1 ? swapSides(steps) : steps;
    const start = local[0].at;
    const show = new BattleShow(
      local.map((one) => ({ ...one, at: one.at - start })),
      options.show,
    );
    current = show;
    await show.run();
    if (current === show) current = null;
  };

  const localAction = async (view: BattleView, index: number): Promise<{ action: Action; line?: string }> => {
    let decision: TurnDecision | null = null;
    try {
      decision = await options.decide(view, index, abort.signal);
    } catch (error) {
      options.log(`逐手对传：定这一手失败（${error instanceof Error ? error.message : String(error)}），按后备挑法`);
    }
    const action =
      decision?.action && isLegal(view, decision.action) ? decision.action : fallbackAction(view, options.seed, index);
    return { action, ...(decision?.line ? { line: decision.line } : {}) };
  };

  /** 等下一手；超时回 null（按掉线） */
  const nextInbound = (): Promise<LiveInbound | null> => {
    const ready = inbound.shift();
    if (ready) return Promise.resolve(ready);
    if (disposed || settled) return Promise.resolve(null);
    return new Promise<LiveInbound | null>((resolve) => {
      let done = false;
      const settle = (value: LiveInbound | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (wake === kick) wake = null;
        resolve(value);
      };
      const timer = setTimeout(() => settle(null), Math.max(1, options.waitMs));
      const kick = (): void => settle(inbound.shift() ?? null);
      wake = kick;
    });
  };

  void (async () => {
    try {
      let result = fightUntilDecision(options.a, options.b, options.seed, [actions[0], actions[1]], {
        farewell: options.farewell,
        damageScale: options.damageScale,
        maxHitShare: options.maxHitShare,
      });
      while (true) {
        if (disposed) return finish(null);
        if (!result.need) {
          await play(live.push(result.events));
          return finish(disposed ? null : result.events);
        }
        const need = result.need;
        const index = actions[0].length + actions[1].length;
        const playing = play(live.push(result.events));
        const request = await nextInbound();
        if (disposed) return finish(null);
        if (!request) {
          options.log('逐手对传：等对面出手超时，按掉线');
          return finish(null);
        }
        if (request.index !== index) {
          request.reply({ ok: false, reason: 'late' });
          options.log(`逐手对传：对面这一手的序号 ${request.index} 对不上 ${index}，按掉线`);
          return finish(null);
        }
        if (need.side === options.local) {
          if (request.action) {
            request.reply({ ok: false, reason: 'illegal' });
            options.log('逐手对传：还没轮到对面，它却带了一手，按掉线');
            return finish(null);
          }
          // 一边演上一段一边想这一手（§X17 边演边想）
          let decided = false;
          const deciding = localAction(need.view, index).then((value) => {
            decided = true;
            return value;
          });
          await playing;
          if (!decided && !fastForward) options.think();
          const picked = await deciding;
          if (disposed) {
            request.reply({ ok: false, reason: 'not-visiting' });
            return finish(null);
          }
          if (picked.line) decideLines.set(result.events.length, picked.line);
          actions[need.side].push(picked.action);
          request.reply({ ok: true, action: picked.action });
        } else {
          if (!request.action || !isLegal(need.view, request.action)) {
            request.reply({ ok: false, reason: 'illegal' });
            options.log('逐手对传：对面这一手不合法，按掉线');
            return finish(null);
          }
          actions[need.side].push(request.action);
          request.reply({ ok: true });
          await playing;
        }
        result = fightUntilDecision(options.a, options.b, options.seed, [actions[0], actions[1]], {
          farewell: options.farewell,
          damageScale: options.damageScale,
          maxHitShare: options.maxHitShare,
        });
      }
    } catch (error) {
      options.log(`逐手对传：这一场中断了（${error instanceof Error ? error.message : String(error)}）`);
      finish(null);
    }
  })();

  return {
    done,
    skip() {
      if (fastForward || disposed || settled) return;
      fastForward = true;
      abort.abort();
      current?.dispose();
    },
    dispose() {
      if (disposed || settled) return;
      disposed = true;
      fastForward = true;
      abort.abort();
      current?.dispose();
      wake?.();
      for (const request of inbound.splice(0)) request.reply({ ok: false, reason: 'not-visiting' });
      finish(null);
    },
    turn(index, action) {
      if (disposed || settled) return Promise.resolve({ ok: false, reason: 'not-visiting' as const });
      return new Promise<LiveTurnReply>((resolve) => {
        inbound.push({ index, action, reply: resolve });
        wake?.();
      });
    },
  };
}
