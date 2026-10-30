/**
 * X27 群架的本地演出层：事件 → 时间线、命中坐标、可注入的执行接口。
 *
 * 设计见 `docs/x27-brawl-design.md` §4.2 / §4.4。和 1v1 的关系：
 *   - `Step` / `AttackShow` 的口径照 `battle-show.ts`，只把 `who` 从 `0 | 1` 改成编号、
 *     `hp` 从二元组改成按编号排列的数组，并补上 `target`；
 *   - 飞行物、动作、受击素材仍按 `ATTACK_SHOW` / `MOVE_SHOW` 查表，不复制 1v1 的大段私有实现；
 *   - 坐标复用 `fx-window.ts` 的 `bodyPoint`：出手方身体中心 → 目标身体中心，不再假设「左打右」。
 *
 * 本文件不碰 Electron，也不开窗口。执行顺序由 `brawlCues` / `applyBrawlCues` 明确给出，
 * 真实的窗口执行器（B2）只实现 `BrawlSides`。
 */
import {
  ATTACK_SHOW,
  MOVE_SHOW,
  OPEN_MS,
  SLOT_MS,
  BEAT_MS,
  LINE_MS,
  REACT_MS,
  REACT_WINDOW_MS,
  RELEASE,
  actionRate,
  animLength,
  rateFor,
  releaseOffset,
  windupOf,
  type AttackShow,
  type Shot,
} from './battle-show';
import { bodyPoint, type Stage } from './fx-window';
import type { BrawlAction, BrawlEvent } from './brawl';

/** 群架默认走切磋节奏；收场动画的窗口与 1v1 一致 */
const CLOSE_MS = 3_000;
/** 两格之间的喘气（同 1v1 的 GAP_MS） */
const GAP_MS = 150;
/** 受击反应素材 */
const HIT_ANIM = '受击-正面';
const BUBBLE_ANIM = '招式-泡泡护体';
const DODGE_ANIM = '战斗-闪避';
const PLAY_DEAD_ANIM = '招式-假死遁';
const FALL_ANIM = '战斗-倒地';
const OPEN_ANIM = '战斗-起手';
const WIN_ANIM = '战斗-胜利';

/** 各轨迹的飞行时间（同 battle-show；`bolt` 在这一层暂时用不到，留个兜底） */
const FLIGHT_MS: Record<Shot['track'], number> = {
  line: 380,
  thrust: 160,
  arc: 620,
  ground: 520,
  float: 900,
  slam: 700,
  bolt: 320,
  boomerang: 340,
  surge: 200,
};

/** 群架时间线上的一步（语义对齐 1v1 的 `Step`） */
export interface BrawlStep {
  /** 距离开打的毫秒数 */
  at: number;
  /** 这一步由哪只演（编号） */
  who: number;
  /** 这一手的目标（出手 / 命中时给） */
  target?: number;
  anim?: string;
  from?: 'pool';
  rate?: number;
  line?: string;
  /** 飞行物；坐标由执行器用 `brawlShotPoints` 现算（舞台会跟着本机宠物动） */
  shot?: Shot;
  /** 冲刺（降龙十八掌）：冲到目标身前 / 退回原位，位移由执行器挪窗口 */
  dash?: { dir: 'out' | 'back'; ms: number };
  /** 这一步之后的全场气血快照（按编号排列） */
  hp: number[];
  /** 收场那几步（结果动画、结果台词） */
  closing?: boolean;
}

function nameOf(names: readonly string[], id: number | undefined): string {
  if (id === undefined) return '有人';
  return names[id] ?? `#${id}`;
}

/** 这一手的演出条目：招式表（move）查 `MOVE_SHOW`，其余照 `ATTACK_SHOW`，没配的按空手 */
function showOf(action: BrawlAction): AttackShow {
  if (action.kind === 'move') {
    const show = MOVE_SHOW[action.move];
    if (show.action) return { action: show.action, ...(show.fly ? { fly: show.fly } : {}) };
    return ATTACK_SHOW.unarmed;
  }
  const key = action.kind === 'weapon' ? action.weapon : action.kind === 'skill' ? action.skill : 'unarmed';
  return ATTACK_SHOW[key] ?? ATTACK_SHOW.unarmed;
}

function shotOf(fly: NonNullable<AttackShow['fly']>, anim: string): Shot {
  return {
    kind: fly.kind,
    track: fly.track,
    flightMs: FLIGHT_MS[fly.track],
    count: fly.count ?? 1,
    gapMs: fly.gapMs ?? 0,
    hitFx: fly.hitFx,
    hand: [...(RELEASE[anim]?.hand ?? [0, 0])] as [number, number],
    ...(fly.reverse ? { reverse: true as const } : {}),
  };
}

/** 简单模板台词：先保证结构和可测性，正式措辞留给 B5 的解说表 */
function lineForBrawl(event: BrawlEvent, names: readonly string[]): string | undefined {
  switch (event.kind) {
    case 'hit':
    case 'combo':
      return `${nameOf(names, event.target)} 挨了 ${nameOf(names, event.actor)} 一下`;
    case 'dodge':
      return `${nameOf(names, event.target)} 闪开了`;
    case 'miss':
      return `${nameOf(names, event.actor)} 打偏了`;
    case 'mirror':
      return `${nameOf(names, event.target)} 的魂影挡了一下`;
    case 'decoy':
      return `${nameOf(names, event.target)} 的水母替身碎了一地`;
    case 'guard':
      return `${nameOf(names, event.target)} 挡下了`;
    case 'reverse':
      return `${nameOf(names, event.actor)} 把力道弹了回去`;
    case 'counter':
      return `${nameOf(names, event.actor)} 反手一记`;
    case 'beast':
      return `${nameOf(names, event.actor)} 的灵兽扑了上去`;
    case 'field':
      return `${nameOf(names, event.actor)} 的领域咬了一口`;
    case 'knock':
      return `${nameOf(names, event.actor)} 的鬼敲门应验了`;
    case 'ancient':
      return `${nameOf(names, event.actor)} 的古人出手了`;
    case 'devour':
      return `${nameOf(names, event.actor)} 吞了一口`;
    case 'skill':
      if (event.heal !== undefined) return `${nameOf(names, event.actor)} 缓过一口气`;
      if (event.damage !== undefined && event.target !== undefined) return `${nameOf(names, event.target)} 中招了`;
      return undefined;
    case 'ko':
    case 'forfeit':
      return `${nameOf(names, event.target)} 出局`;
    case 'end':
      return event.winner === null ? '同归于尽' : `${nameOf(names, event.winner)} 站到最后`;
    default:
      return undefined;
  }
}

/**
 * 群架事件 → 时间线。
 *
 * 同一时刻多人出手已由引擎串行化，这里按事件顺序连播。每个 `decide` 起一格：
 * 动作按 `actionRate` 压进 `SLOT_MS`，飞行物在 `releaseOffset` 后放出，命中 / 闪避 / 淘汰
 * 都排在那一发的命中时刻，并明确落到 `who` 与 `target`；`end` 排收场动画（胜者 + 所有倒地者）。
 */
export function brawlTimeline(events: readonly BrawlEvent[], names: readonly string[]): BrawlStep[] {
  const count = events.reduce((n, event) => Math.max(n, event.hp.length), names.length);
  const steps: BrawlStep[] = [];
  const start = events.find((event) => event.kind === 'start');
  const base = (start ? start.hp : new Array<number>(count).fill(0)).slice();
  const busy = new Array<number>(count).fill(0);

  let cursor = OPEN_MS;
  let beat = 0;
  let slot: { next: number; fly: NonNullable<AttackShow['fly']> } | null = null;

  const pushAnim = (step: BrawlStep & { anim: string; rate: number }): void => {
    steps.push(step);
    busy[step.who] = Math.max(busy[step.who] ?? 0, step.at + animLength(step.anim, step.rate));
  };

  /** 对准命中时刻起播受击 / 闪避 / 倒地（起播 = 命中 − 前摇，口径同 1v1） */
  const pushReaction = (impact: number, who: number, anim: string, hp: number[], line?: string): void => {
    const at = Math.max(0, impact - windupOf(anim));
    pushAnim({
      at,
      who,
      target: who,
      anim,
      rate: rateFor(anim, REACT_WINDOW_MS),
      ...(line === undefined ? {} : { line }),
      hp,
    });
  };

  const closeSlot = (): void => {
    if (beat > 0) {
      const idle = Math.max(...busy.map((end) => end + GAP_MS), 0);
      cursor = Math.max(cursor + Math.max(SLOT_MS, beat * BEAT_MS), idle);
    }
    beat = 0;
    slot = null;
  };

  // 开场：每只各一段起手式（start 事件本身不再另排一步）
  for (let id = 0; id < count; id += 1) {
    pushAnim({ at: 0, who: id, anim: OPEN_ANIM, rate: rateFor(OPEN_ANIM, OPEN_MS), hp: base.slice() });
  }

  for (const event of events) {
    if (event.kind === 'start') continue;

    if (event.kind === 'decide') {
      closeSlot();
      if (event.autoRelease) {
        // 鲸派气功的自动释放：这一手不播聚气动作，释放由后面的 skill 事件自己排
        beat = 1;
        continue;
      }
      const show = showOf(event.action);
      const target = event.action.target;
      pushAnim({
        at: cursor,
        who: event.actor,
        target,
        anim: show.action,
        rate: actionRate(show.action),
        hp: event.hp.slice(),
      });
      beat = 1;
      const release = cursor + releaseOffset(show.action);
      // 冲刺（X16 降龙十八掌）：出掌前冲过去、命中后退回原位；位移由执行器挪窗口
      if (show.dash) {
        steps.push({
          at: Math.max(cursor, release - show.dash.outMs),
          who: event.actor,
          target,
          dash: { dir: 'out', ms: show.dash.outMs },
          hp: event.hp.slice(),
        });
      }
      if (show.fly) {
        const shot = shotOf(show.fly, show.action);
        steps.push({ at: release, who: event.actor, target, shot, hp: event.hp.slice() });
        const impact = release + shot.flightMs + (show.fly.reverse ? (shot.count - 1) * shot.gapMs : 0);
        slot = { next: impact, fly: show.fly };
        if (show.dash) {
          steps.push({
            at: impact,
            who: event.actor,
            target,
            dash: { dir: 'back', ms: show.dash.backMs },
            hp: event.hp.slice(),
          });
        }
      } else if (show.dash) {
        steps.push({
          at: cursor + SLOT_MS,
          who: event.actor,
          target,
          dash: { dir: 'back', ms: show.dash.backMs },
          hp: event.hp.slice(),
        });
      }
      continue;
    }

    if (event.kind === 'end') {
      closeSlot();
      const winner = event.winner;
      for (let id = 0; id < count; id += 1) {
        const win = winner === id;
        const anim = win ? WIN_ANIM : FALL_ANIM;
        pushAnim({
          at: cursor,
          who: id,
          ...(win ? { target: id } : {}),
          anim,
          rate: rateFor(anim, CLOSE_MS),
          hp: event.hp.slice(),
          closing: true,
        });
      }
      const line = lineForBrawl(event, names);
      if (line) {
        const lineStep = steps.find((step) => step.closing && step.who === (winner ?? 0));
        if (lineStep) lineStep.line = line;
      }
      continue;
    }

    // 其余事件：有出手格就排在那一发的命中时刻，没有就单起一拍
    const inSlot = slot !== null;
    const at = slot ? slot.next : cursor;
    if (slot) {
      slot.next += BEAT_MS;
      beat += 1;
    }
    const target = 'target' in event && typeof event.target === 'number' ? event.target : undefined;
    const line = lineForBrawl(event, names);

    switch (event.kind) {
      case 'hit':
      case 'combo': {
        const who = target ?? event.actor;
        const anim = event.blocked ? BUBBLE_ANIM : (slot?.fly.react ?? HIT_ANIM);
        pushReaction(inSlot ? at : at + REACT_MS, who, anim, event.hp.slice(), line);
        break;
      }
      case 'dodge': {
        const who = target ?? event.actor;
        pushReaction(inSlot ? at : at + REACT_MS, who, DODGE_ANIM, event.hp.slice(), line);
        break;
      }
      case 'miss':
        // 打偏：出手方那一发飞过去，目标不反应
        steps.push({
          at,
          who: event.actor,
          ...(target === undefined ? {} : { target }),
          ...(line ? { line } : {}),
          hp: event.hp.slice(),
        });
        break;
      case 'mirror':
      case 'decoy':
      case 'guard': {
        const who = target ?? event.actor;
        pushReaction(at, who, DODGE_ANIM, event.hp.slice(), line);
        break;
      }
      case 'reverse':
      case 'counter':
      case 'beast':
      case 'field':
      case 'knock':
      case 'ancient':
      case 'devour': {
        const who = target ?? event.actor;
        pushReaction(at, who, HIT_ANIM, event.hp.slice(), line);
        break;
      }
      case 'play-dead':
        pushReaction(at, event.target, PLAY_DEAD_ANIM, event.hp.slice(), line);
        break;
      case 'ko':
      case 'forfeit':
        pushAnim({
          at,
          who: event.target,
          target: event.target,
          anim: FALL_ANIM,
          rate: rateFor(FALL_ANIM, CLOSE_MS),
          ...(line ? { line } : {}),
          hp: event.hp.slice(),
        });
        break;
      case 'skip': {
        const anim =
          event.cause === 'freeze'
            ? '受击-冻僵'
            : event.cause === 'sleep'
              ? '受击-犯困'
              : event.cause === 'dream'
                ? '受击-入梦'
                : event.cause === 'float'
                  ? '受击-飘起'
                  : HIT_ANIM;
        pushAnim({
          at,
          who: event.actor,
          anim,
          rate: rateFor(anim, REACT_WINDOW_MS),
          ...(line ? { line } : {}),
          hp: event.hp.slice(),
        });
        break;
      }
      case 'skill': {
        const act = ATTACK_SHOW[event.skill] ?? ATTACK_SHOW.unarmed;
        if (event.damage !== undefined) {
          const who = target ?? event.actor;
          const anim = slot?.fly.react ?? HIT_ANIM;
          pushReaction(at, who, anim, event.hp.slice(), line);
        } else {
          // 自增益 / 回血 / 无伤害但带目标的招：动作演在出手方身上
          pushAnim({
            at,
            who: event.actor,
            target: target ?? event.actor,
            anim: act.action,
            rate: actionRate(act.action),
            ...(line ? { line } : {}),
            hp: event.hp.slice(),
          });
        }
        break;
      }
    }

    if (!inSlot) {
      const last = steps[steps.length - 1];
      const end = last?.anim ? last.at + animLength(last.anim, last.rate ?? 1) : at;
      cursor = Math.max(cursor + BEAT_MS, end + GAP_MS);
    }
  }

  return steps;
}

/** 命中坐标：出手方身体中心 → 目标身体中心（屏幕坐标）；舞台不在时返回 null */
export function brawlShotPoints(
  stages: readonly (Stage | null)[],
  actor: number,
  target: number,
): { from: [number, number]; to: [number, number] } | null {
  const fromStage = stages[actor];
  const toStage = stages[target];
  if (!fromStage || !toStage) return null;
  return { from: bodyPoint(fromStage), to: bodyPoint(toStage) };
}

/** 一边的手：播一段素材、说一句台词 */
export interface BrawlSide {
  play(anim: string, rate: number, from?: 'pool'): void;
  say(line: string, durationMs: number): void;
}

/**
 * 可注入的执行接口（不直接碰 Electron）：
 *   - `side(id)` 取第 id 只的窗口 / 宠物页；
 *   - `arena(hp)` 刷新 N 条血条；
 *   - `shoot(shot, from, to)` 从出手方身体中心打到目标身体中心；
 *   - `dash` 可选（冲刺类招），坐标同样是两只的身体中心。
 */
export interface BrawlSides {
  side(id: number): BrawlSide | null;
  arena(hp: number[]): void;
  shoot(shot: Shot, from: [number, number], to: [number, number]): void;
  dash?(from: [number, number], to: [number, number], dir: 'out' | 'back', ms: number): void;
}

/** 一步拆成按固定顺序执行的调用 */
export type BrawlCue =
  | { kind: 'play'; id: number; anim: string; rate: number; from?: 'pool' }
  | { kind: 'say'; id: number; line: string; ms: number }
  | { kind: 'arena'; hp: number[] }
  | { kind: 'shoot'; shot: Shot; from: [number, number]; to: [number, number] }
  | { kind: 'dash'; from: [number, number]; to: [number, number]; dir: 'out' | 'back'; ms: number };

/**
 * 一步的调用顺序：动画 → 血条 → 飞行物 → 冲刺 → 台词。
 * 飞行物 / 冲刺的坐标在这一刻从舞台表现算（本机宠物被拖动时整环已经跟着动过）。
 */
export function brawlCues(step: BrawlStep, stages: readonly (Stage | null)[]): BrawlCue[] {
  const cues: BrawlCue[] = [];
  if (step.anim) {
    cues.push({
      kind: 'play',
      id: step.who,
      anim: step.anim,
      rate: step.rate ?? 1,
      ...(step.from ? { from: step.from } : {}),
    });
  }
  cues.push({ kind: 'arena', hp: step.hp });
  if (step.shot && step.target !== undefined) {
    const points = brawlShotPoints(stages, step.who, step.target);
    if (points) cues.push({ kind: 'shoot', shot: step.shot, from: points.from, to: points.to });
  }
  if (step.dash && step.target !== undefined) {
    const points = brawlShotPoints(stages, step.who, step.target);
    if (points) cues.push({ kind: 'dash', from: points.from, to: points.to, dir: step.dash.dir, ms: step.dash.ms });
  }
  if (step.line) cues.push({ kind: 'say', id: step.who, line: step.line, ms: LINE_MS });
  return cues;
}

/** 把一串 cue 按顺序交给执行接口；真实窗口执行器只需实现 `BrawlSides` */
export function applyBrawlCues(sides: BrawlSides, cues: readonly BrawlCue[]): void {
  for (const cue of cues) {
    switch (cue.kind) {
      case 'play':
        sides.side(cue.id)?.play(cue.anim, cue.rate, cue.from);
        break;
      case 'say':
        sides.side(cue.id)?.say(cue.line, cue.ms);
        break;
      case 'arena':
        sides.arena(cue.hp);
        break;
      case 'shoot':
        sides.shoot(cue.shot, cue.from, cue.to);
        break;
      case 'dash':
        sides.dash?.(cue.from, cue.to, cue.dir, cue.ms);
        break;
    }
  }
}
