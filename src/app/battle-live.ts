/**
 * 逐手出招（修炼路线 X17）：把「重放到缺决策处」的引擎接成一段一段的演出，并提供 AI 出招的
 * 提示词、JSON 解析与限时请求。心魔试炼只在这里做接线（features/trial.ts），历练 / 切磋以后照用。
 *
 * 引擎每次只算到下一个决策点（`fightUntilDecision`），外层把这一手补进自家的动作串、从头再算一遍；
 * 演出用 `LiveTimeline` 只取新多出来的那一段，所以已经播过的动画、台词、飞行物都不会重排。
 */
import {
  MOVES,
  ROUND_SURE_WEAPON_HP_SHARE,
  SKILLS,
  WEAPONS,
  fallbackAction,
  fightUntilDecision,
  legalActions,
  rngFrom,
  type Action,
  type BattleEvent,
  type BattleView,
  type Fighter,
  type FightOptions,
  type MoveId,
  type SkillId,
  type WeaponId,
} from './battle';
import { BattleShow, LiveTimeline, swapSides, type ShowSides, type Step, type TimelineOptions } from './battle-show';
import type { StandaloneAiService } from '../standalone/ai-provider';
import { cleanText, sparEndTurnReply } from './visit';
import type { SparEndReceipt, SparForfeitReply, SparTurnReply } from './visit';

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

function weaponEffect(id: WeaponId, rounds = false): string {
  const w = WEAPONS[id];
  const bits = [`伤害 ${w.min}–${w.max}`];
  if (w.hits > 1) bits.push(`${w.hits} 段`);
  if (w.mustHit) bits.push('必中');
  if (rounds && w.returnSure) bits.push('回旋段必中');
  if (rounds && (w.mustHit || w.returnSure))
    bits.push(`必中段吃 ${Math.round(ROUND_SURE_WEAPON_HP_SHARE * 100)}% 破势`);
  if (rounds && id === 'firework') bits.push('不连击');
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
  'myriad-palm': '必中伤害，并让对方下一次出手用不了法宝',
  'reverse-seal': '接下来挨到的一次伤害按七成弹回对方',
  ancients: '下一次出手时古人先补一击',
  'eat-hardship': '吃掉对方的泡泡或魂影回血，都没有就咬一口',
  'ghost-eye': '看破对方的分身与魂影，墨汁糊眼无效',
  'ghost-hand': '必中伤害，并让对方下一次出手用不了主动招式',
  'headless-shadow': '必中伤害，打死的救不回来（假死遁无效）',
  'ghost-knock': '对方下一次真正出手前先挨一记敲门声',
  'ghost-painting': '封住对方随机一门被动，本场失效；没有被动就改成伤害',
  'ghost-blood': '必中伤害，对方被动招式越多打得越重',
  'jelly-clone': '挨打时可能用水母替身挡下',
  'tide-cannon': '聚气一拍，下一次出手自动放出必中水浪；聚气期间挨打减三成',
  'abyss-field': '三次攻击内自己必中，并让对方每次出手前先挨暗流',
  'shadow-step': '挨普通攻击全闪，自己下一次攻击必中',
};

/**
 * 切磋（X26）的口径：普通主动技恢复闪避判定，只有 §3.1 的招牌招写必中。
 * 没列出的主动技（凭空生花 / 万我 / 逆流护身印 / 深渊领域 / 瞬影 / 聚气起手）是自增益，不判命中。
 */
const SPAR_SKILL_EFFECT: Partial<Record<SkillId, string>> = {
  'lion-roar': '伤害并可能震晕对方一拍（可闪避）',
  'blue-whale': '必中大伤害',
  'whale-song': '伤害并可能让对方睡过下一拍（可闪避）',
  ink: '让对方接下来三次出手可能打空（可闪避）',
  'whale-gulp': '伤害并回复一半（可闪避）',
  'dream-chant': '伤害并可能把对方牵进梦里一拍（可闪避）',
  'dragon-palm': '伤害，下一手法宝或空手带后劲（可闪避）',
  'farewell-wind': '伤害并可能让对方飘过下一拍（可闪避）',
  'myriad-palm': '伤害，并让对方下一次出手用不了法宝（可闪避）',
  ancients: '下一次出手时古人先补一记必中',
  'eat-hardship': '吃掉对方的泡泡或魂影回血，都没有就咬一口（可闪避）',
  'ghost-hand': '伤害，并让对方下一次出手用不了主动招式（可闪避）',
  'ghost-knock': '对方下一次真正出手前先挨一记必中敲门声',
  'ghost-painting': '封住对方随机一门被动，本场失效（可闪避；没有被动就改成伤害）',
  'ghost-blood': '伤害，对方被动招式越多打得越重（可闪避）',
};

/** 一项动作在面板 / AI 提示词里的名字 */
export function actionLabel(action: Action): string {
  if (action.kind === 'weapon') return WEAPONS[action.weapon].name;
  if (action.kind === 'move') return MOVES[action.move].name;
  if (action.kind === 'skill') return SKILLS[action.skill].name;
  return '空手';
}

/** 一项动作的效果说明；`spar` 是切磋口径（X26），非切磋照旧 */
export function actionEffect(action: Action, spar = false): string {
  if (action.kind === 'weapon') return weaponEffect(action.weapon);
  if (action.kind === 'move') return moveEffect(action.move);
  if (action.kind === 'skill')
    return spar ? (SPAR_SKILL_EFFECT[action.skill] ?? SKILL_EFFECT[action.skill]) : SKILL_EFFECT[action.skill];
  return '伤害 3–6';
}

const ROUND_EFFECT: Partial<Record<SkillId, string>> = {
  bloom: '回复18%气血，占用本轮动作',
  'lion-roar': '伤害并可能让对方跳过下一轮（可闪避）',
  'whale-song': '伤害并可能让对方跳过下一轮（可闪避）',
  'dream-chant': '伤害并可能让对方跳过下一轮（可闪避）',
  'farewell-wind': '伤害并可能让对方跳过下一轮，不会直接送走（可闪避）',
  'myriad-palm': '伤害，命中后封住对方下一轮法宝（可闪避）',
  'ghost-hand': '伤害，命中后封住对方下一轮主动技（可闪避）',
  'ghost-painting': '从下轮起封住对方一门被动（可闪避；没有被动就改成伤害）',
  'abyss-field': '本轮起3轮攻击必中，后2轮对方行动前受暗流伤害',
  'tide-cannon': '本轮聚气减伤，下次能出手时自动释放必中水浪',
};

function roundActionEffect(action: Action): string {
  if (action.kind === 'skill') return ROUND_EFFECT[action.skill] ?? actionEffect(action, true);
  if (action.kind === 'weapon') {
    const weapon = WEAPONS[action.weapon];
    if (weapon.slow) return '普通伤害；同步轮内迟缓不增加行动次数';
    if (weapon.heavy) return '重击；同步轮每方仍各行动一次';
    return weaponEffect(action.weapon, true);
  }
  return actionEffect(action, true);
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
  const skillUsesLeft = view.you.skillUsesLeft;
  const spar = skillUsesLeft !== undefined;
  return legalActions(view).map((action, index) => {
    let note: string | undefined;
    if (action.kind === 'move') {
      const cap = MOVES[action.move].uses;
      if (cap !== undefined) note = `剩 ${Math.max(0, cap - used.filter((id) => id === action.move).length)} 次`;
    } else if (action.kind === 'skill' && skillUsesLeft !== undefined) {
      note = `剩 ${skillUsesLeft} 次`;
    }
    return {
      pick: index + 1,
      action,
      label: actionLabel(action),
      ...(note ? { note } : {}),
      effect: view.round !== undefined ? roundActionEffect(action) : actionEffect(action, spar),
      tone: toneOf(action),
    };
  });
}

function namesOf(view: BattleView, names: [string, string]): { me: string; foe: string } {
  return { me: names[view.self], foe: names[view.self === 0 ? 1 : 0] };
}

function listSkills(skills: SkillId[], effect: (action: Action) => string): string {
  return skills.length > 0
    ? skills.map((id) => `${SKILLS[id].name}（${effect({ kind: 'skill', skill: id })}）`).join('、')
    : '无';
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
  const spar = view.you.skillUsesLeft !== undefined;
  const rounds = view.round !== undefined;
  const effect = rounds ? roundActionEffect : (action: Action) => actionEffect(action, spar);
  const usedSkills = view.you.used.map((id) => SKILLS[id].name);
  const usedMoves = view.you.moveUses ?? [];
  const usedMoveText = [...new Set(usedMoves)].map(
    (id) => `${MOVES[id].name}×${usedMoves.filter((x) => x === id).length}`,
  );
  const used = [...usedSkills, ...usedMoveText];
  return [
    `你是${me}，在和${foe}对战。`,
    `你的气血 ${view.hp[view.self]}/${view.maxHp[view.self]}；对方气血 ${view.hp[view.self === 0 ? 1 : 0]}/${view.maxHp[view.self === 0 ? 1 : 0]}。`,
    `你的法宝：${view.you.weapons.length > 0 ? view.you.weapons.map((id) => `${WEAPONS[id].name}（${effect({ kind: 'weapon', weapon: id })}）`).join('、') : '无'}。`,
    `你的招式：${listSkills(view.you.skills, effect)}${view.you.moves && view.you.moves.length > 0 ? `；${listMoves(view.you.moves)}` : ''}。`,
    `对方的法宝：${view.foe.weapons.length > 0 ? view.foe.weapons.map((id) => WEAPONS[id].name).join('、') : '无'}。`,
    `对方的招式：${listSkills(view.foe.skills, effect)}。`,
    `这一场你已经用掉：${used.length > 0 ? used.join('、') : '无'}。`,
    ...(view.round !== undefined
      ? [
          `第${view.round + 1}轮：双方先锁动作再完整结算，本轮控制或封招不会取消已锁动作；双亡为平局。`,
          `你的公开状态：${JSON.stringify(view.you.status)}；对方公开状态：${JSON.stringify(view.foe.status)}。`,
        ]
      : []),
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

/** 认输（X26）：在双方都已确认的事件后面补一个 forfeit 收场；已经结束就原样返回 */
function forfeitEvents(events: BattleEvent[], loser: 0 | 1): BattleEvent[] {
  const last = events[events.length - 1];
  if (last?.kind === 'end') return events;
  const hp: [number, number] = last && 'hp' in last ? last.hp : [0, 0];
  return [...events, { actor: loser, kind: 'end', winner: loser === 0 ? 1 : 0, reason: 'forfeit', hp }];
}

/** 一场逐手对战：`done` 在演完 / 快进 / 收摊时结算（收摊回 null） */
export interface LiveBattle {
  done: Promise<BattleEvent[] | null>;
  /** 快进：剩下的手全按后备挑法、立刻算完，演到最后 */
  skip(): void;
  /** 认输（X26）：停掉等待与演出，`done` 回带 forfeit 收场的正常事件（本方负） */
  forfeit(): void;
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
  let latestEvents: BattleEvent[] = [];
  let fastForward = false;
  let disposed = false;
  let forfeited = false;
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
    latestEvents = result.events;
    try {
      while (true) {
        if (disposed) return finish(null);
        if (forfeited) return;
        if (fastForward) {
          // 剩下的手全按后备挑法算完，再跳到收场
          while (result.need) {
            const index = decisions.length;
            const action = fallbackAction(result.need.view, options.seed, index);
            decisions.push(action);
            options.onDecision?.(action, index);
            result = fightUntilDecision(options.a, options.b, options.seed, [decisions, 'auto']);
            latestEvents = result.events;
          }
          live.push(result.events);
          await skipToEnd();
          return finish(result.events);
        }
        if (!result.need) {
          const tail = live.push(result.events);
          await play(tail);
          if (forfeited) return;
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
        if (forfeited) return;
        if (fastForward) continue;
        if (!decided) options.think();
        let picked: TurnDecision | null = null;
        try {
          picked = await decision;
        } catch {
          picked = null;
        }
        if (disposed) return finish(null);
        if (forfeited) return;
        if (fastForward) continue;
        // 外部把等待作废（面板关了 / 收到一半的 AI 请求）：这一手改按后备挑法出
        const action = picked?.action ?? fallbackAction(need.view, options.seed, index);
        decisions.push(action);
        options.onDecision?.(action, index);
        if (picked?.line) decideLines.set(result.events.length, picked.line);
        result = fightUntilDecision(options.a, options.b, options.seed, [decisions, 'auto']);
        latestEvents = result.events;
      }
    } catch (error) {
      if (forfeited) return;
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
    forfeit() {
      if (disposed || settled || forfeited) return;
      forfeited = true;
      abort.abort();
      current?.dispose();
      // 心魔 / 切磋的本地逐手局里，本地永远是引擎 0 号，认输即 1 号获胜
      finish(forfeitEvents(latestEvents, 0));
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

/** 逐手局一手的应答；同步轮的认输额外标明是哪一边认输。 */
export type LiveTurnReply =
  Extract<SparTurnReply, { ok: true }> | { ok: false; reason: 'illegal' | 'late' | 'busy' | 'not-visiting' };

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
  /**
   * 独立切磋的引擎口径：`'rounds'` = 同轮双方先锁动作再一起结算（引擎给双侧视野、每轮双方各一手）。
   * 不传保留旧的单边出招（心魔 / 旧测试）；两边必须一致。
   */
  sparMode?: 'opening' | 'rounds';
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
  sendTurn: (
    body: { index: number; action?: Action; forfeit?: boolean },
    signal: AbortSignal,
  ) => Promise<SparTurnReply>;
}

/** 应战方 / 主人家那一侧：请求由协议层经 `turn()` 递进来 */
export interface LiveServerOptions extends LiveVersusOptions {
  /** 等对面下一手的时限（35 秒没来就当掉线） */
  waitMs: number;
  /** 同步轮已确定的结局；协议层在会话收掉后仍能回最后一轮。 */
  onEnd?: (receipt: SparEndReceipt) => void;
}

/** 一场逐手对传：`done` 在演完 / 掉线 / 收摊时结算（掉线、收摊回 null） */
export interface LiveVersus {
  done: Promise<BattleEvent[] | null>;
  /** 快进：本地剩下的手全按后备挑法、不再等 AI / 手动；仍按协议把出手传完 */
  skip(): void;
  /**
   * 认输（X26）：本方负。客户端 / 服务端都要等对面确认（或本地就是权威）后才结算；
   * 对面没收到 / 没确认仍回 null（掉线语义），不伪装成认输成功。
   */
  forfeit(): void;
  /** 收摊 / 退出：停掉等待与演出，`done` 回 null */
  dispose(): void;
  /** 服务端专用：协议层收到一手 / 一次认输时调（客户端调用回 not-visiting） */
  turn(index: number, action?: Action, forfeit?: boolean): Promise<LiveTurnReply>;
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

/**
 * 同步轮里引擎已经替这一侧定了动作（受控跳过 / 聚气自动释放 / 假死躺一拍）：
 * 玩家和 AI 都不用再选，直接空手占位，手动面板也不弹。
 */
function roundsPlaceholder(view: BattleView): boolean {
  const status = view.you.status;
  return status !== undefined && ((status.charge ?? 0) > 0 || status.skip);
}

/** 引擎参数：逐手局沿用原来的三个开关，新切磋再带上 sparMode */
function fightOptionsOf(options: LiveVersusOptions): FightOptions {
  return {
    ...(options.farewell !== undefined ? { farewell: options.farewell } : {}),
    ...(options.damageScale !== undefined ? { damageScale: options.damageScale } : {}),
    ...(options.maxHitShare !== undefined ? { maxHitShare: options.maxHitShare } : {}),
    ...(options.sparMode !== undefined ? { sparMode: options.sparMode } : {}),
  };
}

/** 把本地这一手的台词挂到它自己的 `decide` 事件上（同步轮里对手可能先结算） */
function setDecideLine(
  decideLines: Map<number, string>,
  events: BattleEvent[],
  from: number,
  side: 0 | 1,
  line: string | undefined,
): void {
  if (!line) return;
  for (let i = from; i < events.length; i++) {
    const event = events[i]!;
    if (event.kind === 'decide' && event.actor === side) {
      decideLines.set(i, line);
      return;
    }
  }
}

/**
 * 独立切磋（rounds）的默认自动策略：确定性、只看公开状态、每场主动技预算 3。
 * 只给同步轮当后备与「自动」模式用；PvE 的 `autoController` 不动。
 *
 * 和旧 autoController 的差别：旧策略按单边出手顺序写，「对方四成血就无头收头」在同步轮里既可能
 * 撞上假死 / 反伤，也不看瞬影和领域；这里先按状态做防守，再在预算内挑主动技，最后才挑法宝。
 */
export function roundsAutoAction(view: BattleView, seed: string, index: number): Action {
  const rng = rngFrom(`${seed}:rounds-auto:${index}`);
  const legal = legalActions(view);
  const has = (action: Action): boolean => legal.some((item) => sameAction(item, action));
  const skill = (id: SkillId): Action => ({ kind: 'skill', skill: id });
  const pickFirst = (candidates: Action[]): Action | null => {
    for (const candidate of candidates) if (has(candidate)) return candidate;
    return null;
  };
  const my = view.you.status;
  const foe = view.foe.status;
  const myHp = view.hp[view.self];
  const myMax = view.maxHp[view.self];
  const foeHp = view.hp[view.self === 0 ? 1 : 0];
  const foeMax = view.maxHp[view.self === 0 ? 1 : 0];
  const budget = view.you.skillUsesLeft ?? 0;
  const canSkill = budget > 0;
  const skills = (id: SkillId): Action | null => {
    const action = skill(id);
    return canSkill && has(action) ? action : null;
  };
  const pickSkill = (ids: SkillId[]): Action | null => pickFirst(ids.map(skill));
  // 引擎已经按状态定好的一手：受控跳过 / 聚气自动释放 / 假死，别再浪费主动技
  if (roundsPlaceholder(view)) return pickFirst([{ kind: 'unarmed' }]) ?? legal[0] ?? { kind: 'unarmed' };

  const foeSkills = new Set(view.foe.skills);
  const foeReversal = foe?.reversal ?? 0;
  const foeBubbles = foe?.bubbles ?? view.foe.bubbles ?? 0;
  const foeMirror = foe?.mirror ?? view.foe.mirror ?? 0;
  const foeBlink = foe?.blink ?? false;
  const foeField = foe?.field ?? 0;
  const foeControlled = foe?.controlled ?? false;
  const foePlayDead = foeSkills.has('play-dead');
  const foeGhostEye = foeSkills.has('ghost-eye');
  const foePassives = view.foe.skills.filter((id) => SKILLS[id].kind === '被动').length;

  // 防守：残血先回一口；对方领域 / 暗流压着时先保命或抢在挨打前铺防
  if (myHp * 100 < myMax * 55 && canSkill) {
    const heal = pickSkill(['bloom', 'whale-gulp', 'eat-hardship']);
    if (heal) return heal;
    if (myHp * 100 < myMax * 35) {
      const guard = pickSkill(['shadow-step', 'reverse-seal', 'myriad-self', 'abyss-field']);
      if (guard && !(guard.kind === 'skill' && guard.skill === 'myriad-self' && foeGhostEye)) return guard;
    }
  }
  // 反伤：先用空手 / 弱招把护身印蹭掉，别把大招喂回去
  if (foeReversal > 0) {
    if (foeBubbles + foeMirror > 0) {
      const eat = skills('eat-hardship');
      if (eat) return eat;
    }
    const cheap = pickSkill(['tide-cannon', 'shadow-step', 'abyss-field']);
    if (cheap) return cheap;
    return pickFirst([{ kind: 'unarmed' }]) ?? legal[0] ?? { kind: 'unarmed' };
  }
  // 瞬影：普通攻击全闪，能用主动技就用（技能不判闪避）
  if (foeBlink) {
    const hit = pickSkill(['blue-whale', 'finger-sword', 'headless-shadow', 'ghost-blood', 'ghost-hand', 'lion-roar']);
    if (hit) return hit;
  }
  // 对方铺了领域：每次出手前先吃暗流，尽快在预算内用爆发或控制
  if (foeField > 0) {
    const burst = pickSkill([
      'blue-whale',
      'ghost-blood',
      'headless-shadow',
      'finger-sword',
      'lion-roar',
      'whale-song',
    ]);
    if (burst) return burst;
  }
  // 鬼眼看穿魂影：别在它面前铺万我
  if (!foeGhostEye) {
    const mirror = pickSkill(['myriad-self']);
    if (mirror && myHp * 100 > myMax * 45) return mirror;
  }
  // 吃苦吃亏：对方有泡泡 / 魂影时先吃掉（同时回血）
  if (foeBubbles + foeMirror > 0) {
    const eat = skills('eat-hardship');
    if (eat) return eat;
  }
  // 无头鬼影只收真正的残血；对方带假死遁时放宽到四成，但仍然不是「四成就无脑收头」
  if (canSkill && foeHp * 100 <= foeMax * (foePlayDead ? 40 : 28)) {
    const finish = skills('headless-shadow');
    if (finish) return finish;
  }
  // 鬼血 / 鬼画按被动数量，鬼敲门只在对方还满着时挂
  if (foePassives >= 4) {
    const blood = skills('ghost-blood');
    if (blood) return blood;
  }
  if (foePassives >= 3) {
    const paint = skills('ghost-painting');
    if (paint) return paint;
  }
  if (foeHp * 100 > foeMax * 70) {
    const knock = skills('ghost-knock');
    if (knock && !foe?.knock) return knock;
  }
  // 万我大手印：对方法宝多时先封法宝（已经封着就别重复）
  if (view.foe.weapons.length > 2 && foe?.sealed !== 'weapon') {
    const palm = skills('myriad-palm');
    if (palm) return palm;
  }
  // 领域 / 聚气 / 瞬影：没触发条件不白放；领域铺开对闪避 / 魂影局最值
  if (canSkill) {
    const field = skills('abyss-field');
    if (field) return field;
  }
  if (foeHp * 100 > foeMax * 60) {
    const charge = skills('tide-cannon');
    if (charge) return charge;
  }
  // 控制只压还没被控过的一拍（引擎口径：刚被控过的不再吃控）
  if (!foeControlled) {
    const control = pickSkill(['lion-roar', 'whale-song', 'dream-chant', 'farewell-wind']);
    if (control) return control;
  }
  // 伤害招式：五指拳心剑破泡泡，鲸吞带回血，降龙有后劲
  if (foeBubbles > 0) {
    const pierce = pickSkill(['finger-sword']);
    if (pierce) return pierce;
  }
  const damage = pickSkill(['blue-whale', 'whale-gulp', 'ghost-blood', 'dragon-palm']);
  if (damage) return damage;
  // 预算没用完也不硬花：普通攻击里挑期望伤害最高的一件，带状态时优先多段 / 必中
  const weapons = legal.filter((action): action is Extract<Action, { kind: 'weapon' }> => action.kind === 'weapon');
  if (weapons.length > 0) {
    const score = (action: Extract<Action, { kind: 'weapon' }>): number => {
      const weapon = WEAPONS[action.weapon];
      let value = ((weapon.min + weapon.max) / 2) * weapon.hits;
      if (weapon.mustHit) value += 1.5;
      if (my?.blind && my.blind > 0) value -= weapon.hits > 1 ? 0 : 0.5;
      return value;
    };
    let best = weapons[0]!;
    for (const weapon of weapons) if (score(weapon) > score(best)) best = weapon;
    // 同分时用确定性的随机数打散，避免每场都从同一件起手
    const top = weapons.filter((weapon) => score(weapon) === score(best));
    return top[Math.floor(rng() * top.length)] ?? best;
  }
  return pickFirst([{ kind: 'unarmed' }]) ?? legal[0] ?? { kind: 'unarmed' };
}

/** 一次入站请求（服务端）：序号、对面的出手（轮到它时才有）、是否认输、应答 */
interface LiveInbound {
  index: number;
  action?: Action;
  forfeit?: true;
  reply: (result: LiveTurnReply) => void;
}

/**
 * 逐手对传的发起方 / 客人那一侧（X19）：轮到自家时带上这一手发出去，轮到对面时挂着等它回。
 * 对面 35 秒没回、连接断了、回的招不合法，都按掉线，`done` 回 null。
 */
export function startLiveClient(options: LiveClientOptions): LiveVersus {
  if (options.sparMode === 'rounds') return startRoundsClient(options);
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
  let latestEvents: BattleEvent[] = [];
  let currentIndex = 0;
  let fastForward = false;
  let disposed = false;
  let settled = false;
  let forfeited = false;
  let forfeitSent = false;
  let forfeitConfirmed = false;
  // 用对象存 resolver：TS 的跨闭包 CFA 会把裸 let 变量在 await 后窄成 never
  const forfeitConfirm: { resolve: (() => void) | null } = { resolve: null };
  const forfeitConfirmedWait = new Promise<void>((resolve) => {
    forfeitConfirm.resolve = resolve;
  });
  let forfeitKicks: (() => void)[] = [];
  const kickForfeit = (): void => {
    const kicks = forfeitKicks;
    forfeitKicks = [];
    for (const kick of kicks) kick();
  };
  const waitForfeitKick = (): Promise<void> => new Promise((resolve) => forfeitKicks.push(resolve));
  let resolveDone: (events: BattleEvent[] | null) => void = () => undefined;
  const done = new Promise<BattleEvent[] | null>((resolve) => (resolveDone = resolve));

  const finish = (events: BattleEvent[] | null): void => {
    if (settled) return;
    settled = true;
    if (events === null) {
      decideAbort.abort();
      networkAbort.abort();
      current?.dispose();
    }
    current = null;
    forfeitConfirm.resolve?.();
    forfeitConfirm.resolve = null;
    resolveDone(events);
  };

  /** 本地认输：本方负；对面认输：对方负（本地胜） */
  const settleForfeit = (loser: 0 | 1): void => {
    finish(forfeitEvents(latestEvents, loser));
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
  const waitTurn = (
    body: { index: number; action?: Action; forfeit?: boolean },
    what: string,
  ): Promise<SparTurnReply> => {
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

  const opponent: 0 | 1 = options.local === 0 ? 1 : 0;

  void (async () => {
    const compute = (): ReturnType<typeof fightUntilDecision> =>
      fightUntilDecision(options.a, options.b, options.seed, [actions[0], actions[1]], {
        farewell: options.farewell,
        damageScale: options.damageScale,
        maxHitShare: options.maxHitShare,
      });
    try {
      let result = compute();
      latestEvents = result.events;
      while (true) {
        if (disposed) return finish(null);
        if (forfeited) {
          await forfeitConfirmedWait;
          if (settled) return;
          if (forfeitConfirmed) return settleForfeit(options.local);
          return finish(null);
        }
        if (!result.need) {
          await play(live.push(result.events));
          if (forfeited) continue;
          return finish(disposed ? null : result.events);
        }
        const need = result.need;
        const index = actions[0].length + actions[1].length;
        currentIndex = index;
        const local = need.side === options.local;
        let decided = false;
        const decision = (async (): Promise<{ action?: Action; line?: string; peerForfeit?: true }> => {
          if (local) {
            const picked = await localAction(need.view, index);
            decided = true;
            return picked;
          }
          const reply = await waitTurn({ index }, '等对面出手');
          if (reply.ok && reply.forfeit) {
            decided = true;
            return { peerForfeit: true };
          }
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
        let picked: { action?: Action; line?: string; peerForfeit?: true } | null;
        try {
          if (local) {
            if (forfeited) {
              // 本地已经认输：这一手不再发出去，等对面确认
              void decision.catch(() => undefined);
              picked = null;
            } else {
              const raced = await Promise.race([
                decision.then((value) => ({ picked: value })),
                waitForfeitKick().then(() => ({ forfeited: true as const })),
              ]);
              if ('forfeited' in raced) {
                void decision.catch(() => undefined);
                picked = null;
              } else picked = raced.picked;
            }
          } else {
            // 等对面时不能丢下已经在路上的应答：对面可能已把这手算进去了
            picked = await decision;
          }
        } catch (error) {
          if (forfeited) {
            await forfeitConfirmedWait;
            if (settled) return;
            if (forfeitConfirmed) return settleForfeit(options.local);
            return finish(null);
          }
          options.log(`逐手对传：这一手断了（${error instanceof Error ? error.message : String(error)}），按掉线`);
          return finish(null);
        }
        if (disposed) return finish(null);
        if (picked?.peerForfeit) {
          // 对面认输；如果本地也在认输，按本地认输记负
          return settleForfeit(forfeited ? options.local : opponent);
        }
        if (forfeited) {
          // 对面这一手如果已经确认发出，先纳入本地事件，保证两边 forfeit 收场的气血一致
          if (!local && picked?.action) {
            actions[need.side].push(picked.action);
            result = compute();
            latestEvents = result.events;
          }
          await forfeitConfirmedWait;
          if (settled) return;
          if (forfeitConfirmed) return settleForfeit(options.local);
          return finish(null);
        }
        if (!picked?.action) return finish(null);
        if (picked.line) decideLines.set(result.events.length, picked.line);
        // 自家这一手也发给对面（对面要过 legalActions，收下这一场才往下走）
        if (local) {
          const reply = await waitTurn({ index, action: picked.action }, '送这一手').catch((error: unknown) => {
            options.log(`逐手对传：这一手没送到（${error instanceof Error ? error.message : String(error)}），按掉线`);
            return null;
          });
          if (disposed) return finish(null);
          if (forfeited) {
            // 对面收下了这一手才会先记它；本地补上这一手再按认输结算
            if (reply?.ok && !reply.forfeit) {
              actions[need.side].push(picked.action);
              result = compute();
              latestEvents = result.events;
            }
            await forfeitConfirmedWait;
            if (settled) return;
            if (forfeitConfirmed) return settleForfeit(options.local);
            return finish(null);
          }
          if (!reply) return finish(null);
          if (reply.ok && reply.forfeit) return settleForfeit(opponent);
          if (!reply.ok) return finish(null);
        }
        actions[need.side].push(picked.action);
        result = compute();
        latestEvents = result.events;
      }
    } catch (error) {
      if (forfeited) return;
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
    forfeit() {
      if (disposed || settled || forfeited) return;
      forfeited = true;
      decideAbort.abort();
      current?.dispose();
      kickForfeit();
      if (forfeitSent) return;
      forfeitSent = true;
      const index = currentIndex;
      // 认输也要对方在协议上确认：对面回 ok + forfeit 才算数，网络失败仍按掉线
      void waitTurn({ index, forfeit: true }, '认输').then(
        (reply) => {
          if (settled) return;
          if (reply.ok && reply.forfeit) {
            forfeitConfirmed = true;
            forfeitConfirm.resolve?.();
            forfeitConfirm.resolve = null;
            return;
          }
          options.log(`逐手对传：认输没确认（${reply.ok ? '对面没有回认输' : reply.reason}），按掉线`);
          finish(null);
        },
        (error: unknown) => {
          if (settled) return;
          options.log(`逐手对传：认输没送到（${error instanceof Error ? error.message : String(error)}），按掉线`);
          forfeitConfirm.resolve?.();
          forfeitConfirm.resolve = null;
          finish(null);
        },
      );
    },
    dispose() {
      if (disposed || settled) return;
      disposed = true;
      fastForward = true;
      decideAbort.abort();
      networkAbort.abort();
      current?.dispose();
      kickForfeit();
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
  if (options.sparMode === 'rounds') return startRoundsServer(options);
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
  let latestEvents: BattleEvent[] = [];
  let pendingRequest: LiveInbound | null = null;
  let fastForward = false;
  let disposed = false;
  let settled = false;
  let settledByForfeit = false;
  let forfeitKicks: (() => void)[] = [];
  let resolveDone: (events: BattleEvent[] | null) => void = () => undefined;
  const done = new Promise<BattleEvent[] | null>((resolve) => (resolveDone = resolve));

  const kickForfeit = (): void => {
    const kicks = forfeitKicks;
    forfeitKicks = [];
    for (const kick of kicks) kick();
  };
  const waitForfeitKick = (): Promise<void> => new Promise((resolve) => forfeitKicks.push(resolve));

  const finish = (events: BattleEvent[] | null): void => {
    if (settled) return;
    settled = true;
    current = null;
    resolveDone(events);
  };

  const opponent: 0 | 1 = options.local === 0 ? 1 : 0;

  /** 认输的结局：回复所有还挂着的请求，再按已经确认的事件收场 */
  const settleForfeit = (loser: 0 | 1): void => {
    if (settled) return;
    settledByForfeit = true;
    current?.dispose();
    const pending = pendingRequest;
    pendingRequest = null;
    pending?.reply({ ok: true, forfeit: true });
    for (const request of inbound.splice(0)) request.reply({ ok: true, forfeit: true });
    finish(forfeitEvents(latestEvents, loser));
  };

  /** 从队列里取出对方的认输请求；序号对得上（或刚好是上一手）就收，否则回 late */
  const settleQueuedForfeit = (index: number): boolean => {
    for (;;) {
      const at = inbound.findIndex((request) => request.forfeit === true);
      if (at < 0) return false;
      const request = inbound.splice(at, 1)[0]!;
      if (request.index === index || request.index === index - 1) {
        request.reply({ ok: true, forfeit: true });
        settleForfeit(opponent);
        return true;
      }
      request.reply({ ok: false, reason: 'late' });
    }
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

  /** 等下一手；超时回 null（按掉线）。`delivered` 留住已经取出的那一手，供竞速输掉时补处理 */
  let delivered: LiveInbound | null = null;
  const takeInbound = (): LiveInbound | null => {
    delivered = inbound.shift() ?? null;
    return delivered;
  };
  const takeDelivered = (): LiveInbound | null => {
    const value = delivered;
    delivered = null;
    return value;
  };
  const nextInbound = (): Promise<LiveInbound | null> => {
    const ready = takeInbound();
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
      const kick = (): void => settle(takeInbound());
      wake = kick;
    });
  };

  void (async () => {
    const compute = (): ReturnType<typeof fightUntilDecision> =>
      fightUntilDecision(options.a, options.b, options.seed, [actions[0], actions[1]], {
        farewell: options.farewell,
        damageScale: options.damageScale,
        maxHitShare: options.maxHitShare,
      });
    try {
      let result = compute();
      latestEvents = result.events;
      while (true) {
        if (disposed) return finish(null);
        if (settled) return;
        if (!result.need) {
          await play(live.push(result.events));
          if (settled) return;
          if (disposed) return finish(null);
          return finish(result.events);
        }
        const need = result.need;
        const index = actions[0].length + actions[1].length;
        const playing = play(live.push(result.events));
        const forfeitWait = waitForfeitKick();
        const arrival = await Promise.race([
          nextInbound().then((request) => ({ request })),
          forfeitWait.then(() => ({ kicked: true as const })),
        ]);
        if (disposed) return finish(null);
        if (settled) return;
        let request: LiveInbound | null;
        if ('kicked' in arrival) {
          // 可能是对方认输把这一手顶掉；也可能是本地认输（上面已结算）
          request = takeDelivered();
          if (settleQueuedForfeit(index)) {
            request?.reply({ ok: true, forfeit: true });
            return;
          }
          if (!request) {
            await playing;
            continue;
          }
        } else {
          request = arrival.request;
          delivered = null;
        }
        if (!request) {
          options.log('逐手对传：等对面出手超时，按掉线');
          return finish(null);
        }
        if (request.forfeit) {
          if (request.index === index || request.index === index - 1) {
            request.reply({ ok: true, forfeit: true });
            settleForfeit(opponent);
            return;
          }
          request.reply({ ok: false, reason: 'late' });
          await playing;
          continue;
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
          pendingRequest = request;
          // 一边演上一段一边想这一手（§X17 边演边想）
          let decided = false;
          const deciding = localAction(need.view, index).then((value) => {
            decided = true;
            return value;
          });
          await playing;
          if (disposed) {
            pendingRequest = null;
            request.reply({ ok: false, reason: 'not-visiting' });
            return finish(null);
          }
          if (settled) return;
          if (!decided && !fastForward) options.think();
          const outcome = await Promise.race([
            deciding.then((value) => ({ picked: value })),
            forfeitWait.then(() => ({ forfeit: true as const })),
          ]);
          if (settled) return;
          if ('forfeit' in outcome) {
            // 对方的认输请求到了；队列里没有就只是排队顺序，继续等本地这一手
            if (settleQueuedForfeit(index)) return;
            const picked = await deciding;
            if (disposed) {
              pendingRequest = null;
              request.reply({ ok: false, reason: 'not-visiting' });
              return finish(null);
            }
            if (settled) return;
            if (picked.line) decideLines.set(result.events.length, picked.line);
            actions[need.side].push(picked.action);
            pendingRequest = null;
            request.reply({ ok: true, action: picked.action });
          } else {
            const picked = outcome.picked;
            if (picked.line) decideLines.set(result.events.length, picked.line);
            actions[need.side].push(picked.action);
            pendingRequest = null;
            request.reply({ ok: true, action: picked.action });
          }
        } else {
          if (!request.action || !isLegal(need.view, request.action)) {
            request.reply({ ok: false, reason: 'illegal' });
            options.log('逐手对传：对面这一手不合法，按掉线');
            return finish(null);
          }
          actions[need.side].push(request.action);
          request.reply({ ok: true });
          await Promise.race([playing, forfeitWait]);
          if (disposed) return finish(null);
          if (settled) return;
          if (settleQueuedForfeit(index)) return;
        }
        result = compute();
        latestEvents = result.events;
      }
    } catch (error) {
      if (settled) return;
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
    forfeit() {
      if (disposed || settled) return;
      abort.abort();
      kickForfeit();
      settleForfeit(options.local);
    },
    dispose() {
      if (disposed || settled) return;
      disposed = true;
      fastForward = true;
      abort.abort();
      current?.dispose();
      kickForfeit();
      wake?.();
      for (const request of inbound.splice(0)) request.reply({ ok: false, reason: 'not-visiting' });
      finish(null);
    },
    turn(index, action, forfeit) {
      if (disposed) return Promise.resolve({ ok: false, reason: 'not-visiting' as const });
      if (settled)
        return Promise.resolve(
          settledByForfeit ? ({ ok: true, forfeit: true } as const) : ({ ok: false, reason: 'not-visiting' } as const),
        );
      return new Promise<LiveTurnReply>((resolve) => {
        inbound.push({ index, action, ...(forfeit === true ? { forfeit: true as const } : {}), reply: resolve });
        wake?.();
        if (forfeit === true) kickForfeit();
      });
    },
  };
}

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  let cancel: () => void = () => undefined;
  const stop = new Promise<undefined>((resolve) => {
    cancel = () => resolve(undefined);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([stop, work]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function roundPlayback(options: LiveVersusOptions) {
  const decideLines = new Map<number, string>();
  const live = new LiveTimeline(
    [options.a.name, options.b.name],
    options.lineRng,
    [options.a.skills, options.b.skills],
    {
      ...options.timeline,
      decideLines,
    },
  );
  const interrupted = new AbortController();
  let ready = options.ready === undefined;
  const readiness = options.ready?.then(
    () => {
      ready = true;
    },
    (error: unknown) => {
      ready = true;
      if (!interrupted.signal.aborted) options.log(`切磋：开演准备失败（${String(error)}），不等准备继续演`);
    },
  );
  let fast = false;
  let stopped = false;
  let current: { show: BattleShow; closing: boolean } | null = null;
  const showFor = (steps: Step[]): BattleShow => {
    const local = options.local === 1 ? swapSides(steps) : steps;
    const start = local[0].at;
    return new BattleShow(
      local.map((step) => ({ ...step, at: step.at - start })),
      options.show,
    );
  };
  return {
    decideLines,
    async play(events: BattleEvent[]): Promise<void> {
      const steps = live.push(events);
      if (stopped || steps.length === 0) return;
      if (!fast && !ready && readiness) await untilAborted(readiness, interrupted.signal);
      if (stopped) return;
      const closing = steps.some((step) => step.closing);
      if (fast) {
        if (ready && closing) showFor(steps).skip();
        return;
      }
      const show = showFor(steps);
      current = { show, closing };
      await show.run();
      if (current?.show === show) current = null;
    },
    skip() {
      fast = true;
      interrupted.abort();
      if (current?.closing) current.show.skip();
      else current?.show.dispose();
    },
    stop() {
      stopped = true;
      interrupted.abort();
      current?.show.dispose();
    },
  };
}

async function decideRound(
  options: LiveVersusOptions,
  view: BattleView,
  index: number,
  signal: AbortSignal,
): Promise<TurnDecision> {
  if (roundsPlaceholder(view)) return { action: { kind: 'unarmed' } };
  if (!signal.aborted) {
    try {
      const decision = await untilAborted(options.decide(view, index, signal), signal);
      if (!signal.aborted && decision && isLegal(view, decision.action)) return decision;
    } catch (error) {
      if (!signal.aborted)
        options.log(`切磋：定这一手失败（${error instanceof Error ? error.message : String(error)}），按后备挑法`);
    }
  }
  return { action: roundsAutoAction(view, options.seed, index) };
}

async function roundDeadline<T>(work: Promise<T>, waitMs: number, signal: AbortSignal): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(1, waitMs));
  });
  try {
    return await untilAborted(Promise.race([work, deadline]), signal);
  } finally {
    clearTimeout(timer);
  }
}

/** 同步轮发起方：只按本轮开场视野锁招，对面也锁好以后才能收到它的动作。 */
function startRoundsClient(options: LiveClientOptions): LiveVersus {
  const actions: [Action[], Action[]] = [[], []];
  const playback = roundPlayback(options);
  const decideAbort = new AbortController();
  const networkAbort = new AbortController();
  const surrenderConfirmed = new AbortController();
  const opponent = (options.local ^ 1) as 0 | 1;
  const surrender: { reply?: Promise<SparTurnReply | undefined> } = {};
  let latestEvents: BattleEvent[] = [];
  let settled = false;
  let resolveDone: (events: BattleEvent[] | null) => void = () => undefined;
  const done = new Promise<BattleEvent[] | null>((resolve) => (resolveDone = resolve));

  const finish = (events: BattleEvent[] | null): void => {
    if (settled) return;
    settled = true;
    decideAbort.abort();
    networkAbort.abort();
    playback.stop();
    resolveDone(events);
  };

  const exchange = async (body: Parameters<LiveClientOptions['sendTurn']>[0]): Promise<SparTurnReply | undefined> => {
    const controller = new AbortController();
    const signals = [networkAbort.signal, controller.signal];
    if (!body.forfeit) signals.push(surrenderConfirmed.signal);
    const signal = AbortSignal.any(signals);
    try {
      return await roundDeadline(options.sendTurn(body, signal), options.waitMs, signal);
    } catch (error) {
      if (!signal.aborted) options.log(`切磋：请求没送到（${error instanceof Error ? error.message : String(error)}）`);
    } finally {
      controller.abort();
    }
  };

  void (async () => {
    try {
      const compute = () => fightUntilDecision(options.a, options.b, options.seed, actions, fightOptionsOf(options));
      let result = compute();
      const addRound = (picked: TurnDecision, peer: Action | undefined): boolean => {
        const view = result.need?.views?.[opponent];
        if (!peer || !view || !isLegal(view, peer)) return false;
        const before = result.events.length;
        actions[options.local].push(picked.action);
        actions[opponent].push(peer);
        result = compute();
        setDecideLine(playback.decideLines, result.events, before, options.local, picked.line);
        return true;
      };
      const conclude = async (reply: SparForfeitReply, pending?: TurnDecision): Promise<void> => {
        const round = actions[0].length;
        // 认输应答先到时，用回执补齐双方已经锁定的上一轮。
        if (reply.round !== round && (reply.round !== round + 1 || !pending || !addRound(pending, reply.action))) {
          throw new Error('认输回执的轮号或动作不对');
        }
        const events = forfeitEvents(result.events, reply.loser);
        decideAbort.abort();
        playback.skip();
        await playback.play(events);
        finish(events);
      };
      let pending: TurnDecision | undefined;
      while (!settled) {
        latestEvents = result.events;
        if (!result.need) {
          await playback.play(result.events);
          return finish(result.events);
        }
        if (surrender.reply) {
          const reply = await surrender.reply;
          if (settled) return;
          if (reply?.ok && reply.forfeit && reply.round !== undefined) return await conclude(reply, pending);
          // 最后一轮比认输先锁完：应战方重发该轮动作，仍按引擎的自然结局收场。
          if (reply?.ok && !reply.forfeit && pending && addRound(pending, reply.action) && !result.need) continue;
          options.log('切磋：认输没确认，按掉线');
          return finish(null);
        }
        const views = result.need.views;
        if (!views) throw new Error('缺少本轮的双侧视野');
        const round = actions[0].length;
        let decided = false;
        const choosing = decideRound(options, views[options.local], round, decideAbort.signal).then((picked) => {
          decided = true;
          return picked;
        });
        await playback.play(result.events);
        if (settled) return;
        if (!decided && !decideAbort.signal.aborted) options.think();
        const picked = await choosing;
        if (settled) return;
        if (surrender.reply) continue;

        pending = picked;
        const reply = await exchange({ index: round, action: picked.action });
        if (settled) return;
        if (reply?.ok && reply.forfeit && reply.round !== undefined) return await conclude(reply, picked);
        if (!reply?.ok || reply.forfeit || !addRound(picked, reply.action)) {
          if (surrender.reply) continue;
          options.log(`切磋：没收到对方合法的出手（${reply && !reply.ok ? reply.reason : '超时或动作不符'}），按掉线`);
          return finish(null);
        }
        pending = undefined;
      }
    } catch (error) {
      options.log(`切磋：这一场中断了（${error instanceof Error ? error.message : String(error)}）`);
      finish(null);
    }
  })();

  return {
    done,
    skip() {
      if (settled) return;
      decideAbort.abort();
      playback.skip();
    },
    forfeit() {
      if (settled || surrender.reply || latestEvents[latestEvents.length - 1]?.kind === 'end') return;
      surrender.reply = exchange({ index: actions[0].length, forfeit: true }).then((reply) => {
        if (reply?.ok && (reply.forfeit ? reply.round !== undefined : reply.action !== undefined)) {
          surrenderConfirmed.abort();
        }
        return reply;
      });
      decideAbort.abort();
      playback.skip();
    },
    dispose: () => finish(null),
    turn: () => Promise.resolve({ ok: false, reason: 'not-visiting' }),
  };
}

/** 同步轮应战方：先按开场视野开始选招；两边都锁定后才回复对方。 */
function startRoundsServer(options: LiveServerOptions): LiveVersus {
  const actions: [Action[], Action[]] = [[], []];
  const playback = roundPlayback(options);
  const decideAbort = new AbortController();
  const stop = new AbortController();
  const opponent = (options.local ^ 1) as 0 | 1;
  type Request = { action: Action; reply: (reply: LiveTurnReply) => void };
  const inbox: { request?: Request; wake?: (request: Request | undefined) => void } = {};
  const compute = () => fightUntilDecision(options.a, options.b, options.seed, actions, fightOptionsOf(options));
  let result = compute();
  let settled = false;
  let receipt: SparEndReceipt | undefined;
  let resolveDone: (events: BattleEvent[] | null) => void = () => undefined;
  const done = new Promise<BattleEvent[] | null>((resolve) => (resolveDone = resolve));

  const finish = (events: BattleEvent[] | null): void => {
    if (settled) return;
    settled = true;
    decideAbort.abort();
    stop.abort();
    playback.stop();
    inbox.request?.reply({ ok: false, reason: 'not-visiting' });
    inbox.wake?.(undefined);
    inbox.request = undefined;
    inbox.wake = undefined;
    resolveDone(events);
  };

  const fail = (error: unknown): void => {
    if (settled || receipt?.forfeit) return;
    options.log(`切磋：这一场中断了（${error instanceof Error ? error.message : String(error)}）`);
    finish(receipt ? result.events : null);
  };

  const recordEnd = (end: SparEndReceipt): void => {
    receipt = end;
    options.onEnd?.(end);
  };

  const concede = (loser: 0 | 1): LiveTurnReply => {
    if (receipt?.forfeit) return receipt;
    if (settled || !result.need) return { ok: false, reason: 'late' };
    const round = actions[0].length;
    const action = actions[options.local][round - 1];
    const end: SparForfeitReply = { ok: true, forfeit: true, loser, round, ...(action ? { action } : {}) };
    recordEnd(end);
    inbox.request?.reply(end);
    inbox.request = undefined;
    decideAbort.abort();
    stop.abort();
    const events = forfeitEvents(result.events, loser);
    playback.skip();
    void playback.play(events).then(
      () => finish(events),
      () => finish(events),
    );
    return end;
  };

  void (async () => {
    try {
      while (!settled && !receipt?.forfeit) {
        if (!result.need) {
          await playback.play(result.events);
          return finish(result.events);
        }
        const views = result.need.views;
        if (!views) throw new Error('缺少本轮的双侧视野');
        const round = actions[0].length;
        let decided = false;
        const choosing = decideRound(options, views[options.local], round, decideAbort.signal).then((picked) => {
          decided = true;
          return picked;
        });
        const playing = playback
          .play(result.events)
          .then(() => {
            if (!settled && !receipt && !decided && !decideAbort.signal.aborted) options.think();
          })
          .catch(fail);
        const request =
          inbox.request ??
          new Promise<Request | undefined>((resolve) => {
            inbox.wake = resolve;
          });
        const locked = await roundDeadline(Promise.all([request, choosing]), options.waitMs, stop.signal);
        inbox.wake = undefined;
        if (settled || receipt) return;
        if (!locked?.[0]) {
          options.log('切磋：等待双方锁招超时，按掉线');
          return finish(null);
        }
        const [move, picked] = locked;
        const before = result.events.length;
        actions[options.local].push(picked.action);
        actions[opponent].push(move.action);
        result = compute();
        setDecideLine(playback.decideLines, result.events, before, options.local, picked.line);
        if (!result.need) recordEnd({ ok: true, round: round + 1, action: picked.action });
        inbox.request = undefined;
        move.reply({ ok: true, action: picked.action });
        await playing;
      }
    } catch (error) {
      fail(error);
    }
  })();

  return {
    done,
    skip() {
      if (settled) return;
      decideAbort.abort();
      playback.skip();
    },
    forfeit: () => {
      concede(options.local);
    },
    dispose: () => finish(null),
    async turn(index, action, forfeit) {
      if (receipt) return sparEndTurnReply(receipt, index);
      if (settled) return { ok: false, reason: 'not-visiting' };
      const round = actions[0].length;
      if (forfeit && (index === round || index === round - 1)) return concede(opponent);
      if (!forfeit && index < round) {
        const peer = actions[opponent][index];
        if (peer && action && sameAction(peer, action)) return { ok: true, action: actions[options.local][index] };
      }
      if (index !== round) return { ok: false, reason: 'late' };
      const view = result.need?.views?.[opponent];
      if (!view || inbox.request) return { ok: false, reason: 'late' };
      if (!action || !isLegal(view, action)) {
        finish(null);
        return { ok: false, reason: 'illegal' };
      }
      return new Promise<LiveTurnReply>((reply) => {
        inbox.request = { action, reply };
        inbox.wake?.(inbox.request);
      });
    },
  };
}
