/**
 * X27 群架联机协议层（B3）：星型中继、出手广播、掉线退场、认输与房主移交。
 *
 * 纯状态机，不碰 HTTP / Electron / 全局计时器：
 * - 收发只走注入的 `send(msg)`，测试用内存总线把 3–5 个实例连起来；
 * - 计时走注入的 `BrawlClock`，测试用假时钟推进，不真等 35 秒；
 * - 结算、修为、收益不在这层：`end` 只带胜负与名次，由各家本地记账。
 *
 * 设计见 `docs/x27-brawl-design.md` §3（联机协议）与 §3.4（掉线与房主移交）。
 * 房主编号固定为 0；加入者按加入顺序拿 1..N-1。每一手由轮到的人发给房主，
 * 房主校验通过后转发给其余人。种子由所有名帖的 nonce 按编号顺序算出，不经过房主转手。
 */

import {
  ACTIVE_SKILLS,
  MOVES,
  MOVE_IDS,
  SKILL_IDS,
  SPAR_ACTIVE_LIMIT,
  WEAPON_IDS,
  type Action,
  type Fighter,
  type MoveId,
  type SkillId,
  type WeaponId,
} from './battle';
import { BRAWL_MAX, BRAWL_MIN, BRAWL_VERSION, brawlNeedsTarget } from './brawl';
import { seedOf } from './dungeon';

/** 一手最多等这么久（沿用 X19 的 waitMs） */
export const BRAWL_NET_TIMEOUT_MS = 35_000;

const NONCE_RE = /^[0-9a-f]{64}$/;

/** 一手：序号、换代号、出手编号、目标编号、动作 */
export interface BrawlMove {
  index: number;
  epoch: number;
  actor: number;
  target: number;
  action: Action;
}

/** 名帖：协议只传战斗档案与 nonce；编号由房主按加入顺序发 */
export interface BrawlPeer {
  id: number;
  card: Fighter;
  nonce: string;
}

export type BrawlRejectReason =
  'version' | 'full' | 'closed' | 'id' | 'nonce' | 'epoch' | 'index' | 'turn' | 'actor' | 'target' | 'action';

export type BrawlExitReason = 'timeout' | 'forfeit';

export interface BrawlExit {
  id: number;
  reason: BrawlExitReason;
}

export interface BrawlResult {
  winner: number | null;
  ranking: number[];
}

export type BrawlPhase = 'lobby' | 'running' | 'ended';

/**
 * 线上的报文。`from` / `to` 是信封（内存总线按 `to` 投递），
 * 每一手的字段与 `BrawlMove` 完全一致。
 */
export type BrawlNetMsg =
  | { kind: 'join'; from: number; to: number; version: number; card: Fighter; nonce: string }
  | { kind: 'welcome'; from: number; to: number; id: number }
  | { kind: 'start'; from: number; to: number; version: number; players: BrawlPeer[] }
  | ({ kind: 'move'; from: number; to: number } & BrawlMove)
  | {
      kind: 'reject';
      from: number;
      to: number;
      index: number;
      actor: number;
      reason: BrawlRejectReason;
    }
  | { kind: 'forfeit'; from: number; to: number; actor: number; epoch: number }
  | { kind: 'exit'; from: number; to: number; actor: number; reason: BrawlExitReason; epoch: number }
  | { kind: 'hostChange'; from: number; to: number; epoch: number; host: number }
  | {
      kind: 'end';
      from: number;
      to: number;
      epoch: number;
      winner: number | null;
      ranking: number[];
    };

export interface BrawlNetState {
  self: number;
  host: number;
  epoch: number;
  phase: BrawlPhase;
  seed: string | null;
  players: BrawlPeer[];
  alive: number[];
  index: number;
  exits: BrawlExit[];
  result: BrawlResult | null;
}

/** 可注入的计时器：测试用假时钟推进，生产用全局 setTimeout */
export interface BrawlClock {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 房主校验动作是否合法（法宝 / 招式 / 次数 / 封印……由接线方按本地重算判） */
export type BrawlActionValidator = (move: BrawlMove, peer: BrawlPeer, state: BrawlNetState) => BrawlRejectReason | null;

/** 轮次解析：接入引擎时按本地重算给出第 `index` 手该谁出；不接就用按编号轮转 */
export type BrawlTurnResolver = (index: number, alive: readonly number[]) => number | null;

export interface BrawlNetOptions {
  /** 本机编号；客人加入前可以用一个临时编号，`welcome` 会以房主发的为准 */
  self: number;
  card: Fighter;
  nonce: string;
  /** 唯一的网络出口：不直接起 HTTP */
  send: (msg: BrawlNetMsg) => void;
  version?: number;
  timeoutMs?: number;
  maxPlayers?: number;
  clock?: BrawlClock;
  /** 不接引擎时默认按存活编号轮转 */
  turnOf?: BrawlTurnResolver;
  /** 不提供时用内置校验（动作编号认识、法宝/功法属于本人、主动技只一次、招式次数） */
  validateAction?: BrawlActionValidator;
  onDeliver?: (move: BrawlMove) => void;
  onReject?: (reason: BrawlRejectReason, msg: BrawlNetMsg) => void;
  onExit?: (id: number, reason: BrawlExitReason) => void;
  onHostChange?: (host: number, epoch: number) => void;
  onStart?: (state: BrawlNetState) => void;
  onEnd?: (result: BrawlResult) => void;
  /** 轮到自己却迟迟没提交：接线方可以在这里补一手后备动作 */
  onTurnTimeout?: (actor: number) => void;
}

export interface BrawlNet {
  readonly self: number;
  readonly host: number;
  readonly epoch: number;
  state(): BrawlNetState;
  /** 客人向房主报名（房主不用调） */
  join(): void;
  /** 房主开打：人数 2–5，广播名帖与 nonce，各家本地算种子 */
  start(): void;
  /** 轮到本机时提交这一手；不是自己的轮次或动作不合法会抛错 */
  submitMove(target: number, action: Action): BrawlMove;
  /** 认输：客人先报房主，房主确认后转发；房主自己认输会直接移交 */
  forfeit(): void;
  /** 总线投递入口（房主 / 客人收到的报文都从这里进） */
  receive(msg: BrawlNetMsg): void;
  dispose(): void;
}

const defaultClock: BrawlClock = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function cloneFighter(f: Fighter): Fighter {
  return {
    ...f,
    weapons: [...f.weapons],
    skills: [...f.skills],
    ...(f.moves ? { moves: [...f.moves] } : {}),
    ...(f.mods ? { mods: { ...f.mods } } : {}),
    ...(f.guard ? { guard: { ...f.guard } } : {}),
  };
}

function clonePeer(p: BrawlPeer): BrawlPeer {
  return { id: p.id, card: cloneFighter(p.card), nonce: p.nonce };
}

function cloneAction(action: Action): Action {
  return { ...action };
}

/** 结构校验：只认图鉴里认识的编号；不认识返回 null（房主按 action 拒收） */
function normalizeAction(raw: Action): Action | null {
  if (!raw || typeof raw !== 'object') return null;
  switch (raw.kind) {
    case 'unarmed':
      return { kind: 'unarmed' };
    case 'weapon': {
      const weapon = (raw as { weapon?: unknown }).weapon;
      return typeof weapon === 'string' && (WEAPON_IDS as readonly string[]).includes(weapon)
        ? { kind: 'weapon', weapon: weapon as WeaponId }
        : null;
    }
    case 'skill': {
      const skill = (raw as { skill?: unknown }).skill;
      return typeof skill === 'string' && (SKILL_IDS as readonly string[]).includes(skill)
        ? { kind: 'skill', skill: skill as SkillId }
        : null;
    }
    case 'move': {
      const move = (raw as { move?: unknown }).move;
      return typeof move === 'string' && (MOVE_IDS as readonly string[]).includes(move)
        ? { kind: 'move', move: move as MoveId }
        : null;
    }
    default:
      return null;
  }
}

class BrawlNetImpl implements BrawlNet {
  private readonly opts: BrawlNetOptions;
  private readonly version: number;
  private readonly timeoutMs: number;
  private readonly maxPlayers: number;
  private readonly clock: BrawlClock;

  private myId: number;
  private hostId = 0;
  private epochNo = 0;
  private phase: BrawlPhase = 'lobby';
  private players: BrawlPeer[] = [];
  private aliveIds: number[] = [];
  private nextIndex = 0;
  private exitList: BrawlExit[] = [];
  private result: BrawlResult | null = null;
  private seedValue: string | null = null;

  /** 默认轮转的下一个候选位置（players 按编号排好后的下标） */
  private turnPtr = 0;
  private usedSkills = new Map<number, Set<SkillId>>();
  private skillUses = new Map<number, number>();
  private moveUses = new Map<number, Map<MoveId, number>>();

  private timer: unknown = null;
  private strikes = 0;
  private awaitingRelay = false;
  private endedNotified = false;
  private disposed = false;

  constructor(options: BrawlNetOptions) {
    this.opts = options;
    this.myId = options.self;
    this.version = options.version ?? BRAWL_VERSION;
    this.timeoutMs = options.timeoutMs ?? BRAWL_NET_TIMEOUT_MS;
    this.maxPlayers = Math.min(BRAWL_MAX, Math.max(BRAWL_MIN, options.maxPlayers ?? BRAWL_MAX));
    this.clock = options.clock ?? defaultClock;
    if (this.myId === 0) {
      this.players = [{ id: 0, card: cloneFighter(options.card), nonce: options.nonce }];
    }
  }

  get self(): number {
    return this.myId;
  }

  get host(): number {
    return this.hostId;
  }

  get epoch(): number {
    return this.epochNo;
  }

  state(): BrawlNetState {
    return {
      self: this.myId,
      host: this.hostId,
      epoch: this.epochNo,
      phase: this.phase,
      seed: this.seedValue,
      players: this.players.map(clonePeer),
      alive: [...this.aliveIds],
      index: this.nextIndex,
      exits: this.exitList.map((e) => ({ ...e })),
      result: this.result ? { ...this.result, ranking: [...this.result.ranking] } : null,
    };
  }

  // -------------------------------------------------------------------------
  // 组局
  // -------------------------------------------------------------------------

  join(): void {
    if (this.phase !== 'lobby') throw new Error('已经开打了，不能再报名');
    if (this.myId === 0) throw new Error('房主不用报名');
    this.send({
      kind: 'join',
      from: this.myId,
      to: 0,
      version: this.version,
      card: cloneFighter(this.opts.card),
      nonce: this.opts.nonce,
    });
  }

  start(): void {
    if (this.myId !== 0 || this.hostId !== 0) throw new Error('只有房主能开打');
    if (this.phase !== 'lobby') throw new Error('已经开打了');
    if (this.players.length < BRAWL_MIN || this.players.length > this.maxPlayers) {
      throw new Error(`群架人数必须在 ${BRAWL_MIN}–${this.maxPlayers} 之间`);
    }
    this.begin(this.players, 0);
    for (const p of this.players) {
      if (p.id === this.myId) continue;
      this.send({
        kind: 'start',
        from: this.myId,
        to: p.id,
        version: this.version,
        players: this.players.map(clonePeer),
      });
    }
  }

  private begin(players: BrawlPeer[], host: number): void {
    this.players = [...players].sort((a, b) => a.id - b.id).map(clonePeer);
    this.hostId = host;
    this.epochNo = 0;
    this.phase = 'running';
    this.aliveIds = this.players.map((p) => p.id);
    this.nextIndex = 0;
    this.turnPtr = 0;
    this.exitList = [];
    this.result = null;
    // 种子由各家拿到的全部 nonce 按编号顺序自己算，不信房主转手的种子
    this.seedValue = seedOf(this.players.map((p) => p.nonce));
    this.usedSkills = new Map();
    this.skillUses = new Map();
    this.moveUses = new Map();
    this.strikes = 0;
    this.awaitingRelay = false;
    this.endedNotified = false;
    this.opts.onStart?.(this.state());
    this.arm();
  }

  private onJoin(msg: Extract<BrawlNetMsg, { kind: 'join' }>): void {
    if (this.myId !== this.hostId) return;
    if (this.phase !== 'lobby') {
      this.sendReject(msg.from, -1, msg.from, 'closed');
      return;
    }
    if (msg.version !== this.version) {
      this.sendReject(msg.from, -1, msg.from, 'version');
      return;
    }
    if (!NONCE_RE.test(msg.nonce)) {
      this.sendReject(msg.from, -1, msg.from, 'nonce');
      return;
    }
    if (this.players.length >= this.maxPlayers) {
      this.sendReject(msg.from, -1, msg.from, 'full');
      return;
    }
    // 编号按加入顺序发：1、2、3……；客人的临时编号必须正好是下一个
    if (msg.from !== this.players.length) {
      this.sendReject(msg.from, -1, msg.from, 'id');
      return;
    }
    this.players.push({ id: msg.from, card: cloneFighter(msg.card), nonce: msg.nonce });
    this.send({ kind: 'welcome', from: this.hostId, to: msg.from, id: msg.from });
  }

  private onWelcome(msg: Extract<BrawlNetMsg, { kind: 'welcome' }>): void {
    if (this.phase !== 'lobby') return;
    this.myId = msg.id;
    this.hostId = msg.from;
  }

  private onStart(msg: Extract<BrawlNetMsg, { kind: 'start' }>): void {
    if (this.phase !== 'lobby') return;
    if (msg.from !== this.hostId) return;
    if (msg.version !== this.version) return;
    if (msg.players.length < BRAWL_MIN || msg.players.length > BRAWL_MAX) return;
    if (!msg.players.some((p) => p.id === this.myId)) return;
    this.begin(msg.players, msg.from);
  }

  // -------------------------------------------------------------------------
  // 出手
  // -------------------------------------------------------------------------

  submitMove(target: number, action: Action): BrawlMove {
    if (this.phase !== 'running') throw new Error('群架还没开始');
    const expected = this.expectedActor();
    if (expected !== this.myId) throw new Error('还没轮到自己');
    const normalized = normalizeAction(action);
    if (!normalized) throw new Error('动作不合法：action');
    const move: BrawlMove = {
      index: this.nextIndex,
      epoch: this.epochNo,
      actor: this.myId,
      target,
      action: normalized,
    };
    if (this.myId === this.hostId) {
      const reason = this.validateMove(move);
      if (reason) throw new Error(`动作不合法：${reason}`);
      this.acceptMove(move);
      return move;
    }
    // 客人不在本地判动作（房主说了算），只保证轮次；先发给房主，等广播回来再推进
    this.awaitingRelay = true;
    this.strikes = 0;
    this.send({ kind: 'move', from: this.myId, to: this.hostId, ...move });
    this.arm();
    return move;
  }

  private onMove(msg: Extract<BrawlNetMsg, { kind: 'move' }>): void {
    if (this.phase !== 'running') return;
    if (this.myId === this.hostId) {
      this.hostReceiveMove(msg);
    } else {
      this.guestReceiveMove(msg);
    }
  }

  private hostReceiveMove(msg: Extract<BrawlNetMsg, { kind: 'move' }>): void {
    if (msg.from !== msg.actor) {
      this.sendReject(msg.from, msg.index, msg.actor, 'actor');
      return;
    }
    // 旧 epoch / 重复 / 乱序：一律丢弃，不能推进状态，也不回包
    if (msg.epoch !== this.epochNo) return;
    if (msg.index !== this.nextIndex) return;
    if (!this.aliveIds.includes(msg.actor)) {
      this.sendReject(msg.from, msg.index, msg.actor, 'actor');
      return;
    }
    if (msg.actor !== this.expectedActor()) {
      this.sendReject(msg.from, msg.index, msg.actor, 'turn');
      return;
    }
    const reason = this.validateMove(msg);
    if (reason) {
      this.sendReject(msg.from, msg.index, msg.actor, reason);
      return;
    }
    this.acceptMove(msg);
  }

  private guestReceiveMove(msg: Extract<BrawlNetMsg, { kind: 'move' }>): void {
    if (msg.from !== this.hostId) return;
    if (msg.epoch !== this.epochNo) return;
    if (msg.index !== this.nextIndex) return;
    if (msg.actor !== this.expectedActor()) return;
    this.strikes = 0;
    this.awaitingRelay = false;
    this.nextIndex += 1;
    this.advanceTurn(msg.actor);
    this.opts.onDeliver?.({
      index: msg.index,
      epoch: msg.epoch,
      actor: msg.actor,
      target: msg.target,
      action: cloneAction(msg.action),
    });
    this.arm();
  }

  private acceptMove(move: BrawlMove): void {
    this.recordUse(move);
    this.nextIndex += 1;
    this.advanceTurn(move.actor);
    this.strikes = 0;
    this.awaitingRelay = false;
    const delivered: BrawlMove = {
      index: move.index,
      epoch: move.epoch,
      actor: move.actor,
      target: move.target,
      action: cloneAction(move.action),
    };
    this.opts.onDeliver?.(delivered);
    for (const p of this.players) {
      if (p.id === this.myId) continue;
      this.send({ kind: 'move', from: this.myId, to: p.id, ...delivered, action: cloneAction(delivered.action) });
    }
    this.arm();
  }

  private validateMove(move: BrawlMove): BrawlRejectReason | null {
    const peer = this.players.find((p) => p.id === move.actor);
    if (!peer) return 'actor';
    // 目标：需要目标的招必须是活着且不是自己的编号；自增益招只要求是场上的人
    if (brawlNeedsTarget(move.action)) {
      if (move.target === move.actor || !this.aliveIds.includes(move.target)) return 'target';
    } else if (!this.players.some((p) => p.id === move.target)) {
      return 'target';
    }
    if (this.opts.validateAction) {
      return this.opts.validateAction({ ...move, action: cloneAction(move.action) }, clonePeer(peer), this.state());
    }
    const used = this.usedSkills.get(peer.id) ?? new Set<SkillId>();
    const uses = this.skillUses.get(peer.id) ?? 0;
    const moveCount = this.moveUses.get(peer.id) ?? new Map<MoveId, number>();
    switch (move.action.kind) {
      case 'unarmed':
        return null;
      case 'weapon':
        return peer.card.weapons.includes(move.action.weapon) ? null : 'action';
      case 'skill':
        if (!peer.card.skills.includes(move.action.skill)) return 'action';
        if (!ACTIVE_SKILLS.includes(move.action.skill)) return 'action';
        if (used.has(move.action.skill)) return 'action';
        if (uses >= SPAR_ACTIVE_LIMIT) return 'action';
        return null;
      case 'move': {
        if (!peer.card.moves?.includes(move.action.move)) return 'action';
        const cap = MOVES[move.action.move].uses;
        if (cap !== undefined && (moveCount.get(move.action.move) ?? 0) >= cap) return 'action';
        return null;
      }
    }
  }

  private recordUse(move: BrawlMove): void {
    if (move.action.kind === 'skill') {
      let used = this.usedSkills.get(move.actor);
      if (!used) {
        used = new Set();
        this.usedSkills.set(move.actor, used);
      }
      used.add(move.action.skill);
      this.skillUses.set(move.actor, (this.skillUses.get(move.actor) ?? 0) + 1);
    } else if (move.action.kind === 'move') {
      let uses = this.moveUses.get(move.actor);
      if (!uses) {
        uses = new Map();
        this.moveUses.set(move.actor, uses);
      }
      uses.set(move.action.move, (uses.get(move.action.move) ?? 0) + 1);
    }
  }

  // -------------------------------------------------------------------------
  // 认输 / 掉线 / 房主移交
  // -------------------------------------------------------------------------

  forfeit(): void {
    if (this.phase !== 'running') return;
    if (this.myId === this.hostId) {
      this.hostForfeit();
      return;
    }
    this.send({ kind: 'forfeit', from: this.myId, to: this.hostId, actor: this.myId, epoch: this.epochNo });
  }

  private onForfeit(msg: Extract<BrawlNetMsg, { kind: 'forfeit' }>): void {
    if (this.myId !== this.hostId || this.phase !== 'running') return;
    if (msg.epoch !== this.epochNo) return;
    if (msg.actor !== msg.from || msg.actor === this.myId) return;
    if (!this.aliveIds.includes(msg.actor)) return;
    this.applyExit(msg.actor, 'forfeit');
    this.broadcastExit(msg.actor, 'forfeit', this.myId);
    this.arm();
    this.maybeEnd();
  }

  /** 房主自己认输：先换代，再把退场公告发出去 */
  private hostForfeit(): void {
    const lost = this.myId;
    this.applyExit(lost, 'forfeit');
    const survivors = [...this.aliveIds].sort((a, b) => a - b);
    if (survivors.length === 0) {
      this.finish();
      return;
    }
    const newHost = survivors[0];
    this.epochNo += 1;
    this.hostId = newHost;
    this.broadcastHostChange(newHost, newHost);
    this.broadcastExit(lost, 'forfeit', newHost);
    this.arm();
    this.maybeEnd();
  }

  /** 房主这一手迟迟没来（客人侧）：判定房主掉线，编号最小的存活者接任 */
  private hostLost(): void {
    if (this.phase !== 'running' || this.disposed) return;
    if (this.myId === this.hostId) return;
    const lost = this.hostId;
    this.applyExit(lost, 'timeout');
    const survivors = [...this.aliveIds].sort((a, b) => a - b);
    if (survivors.length === 0) {
      this.finish();
      return;
    }
    const newHost = survivors[0];
    this.epochNo += 1;
    this.hostId = newHost;
    this.strikes = 0;
    this.awaitingRelay = false;
    this.opts.onHostChange?.(newHost, this.epochNo);
    if (this.myId === newHost) {
      // 先公告换代，再公告旧房主退场：接收方要先拿到新 epoch 才认这两条
      this.broadcastHostChange(newHost, newHost);
      this.broadcastExit(lost, 'timeout', newHost);
    }
    this.arm();
    this.maybeEnd();
  }

  private hostTurnTimeout(actor: number): void {
    if (this.phase !== 'running' || this.myId !== this.hostId) return;
    if (this.expectedActor() !== actor || actor === this.myId) return;
    this.applyExit(actor, 'timeout');
    this.broadcastExit(actor, 'timeout', this.myId);
    this.arm();
    this.maybeEnd();
  }

  private guestWatchdog(): void {
    if (this.phase !== 'running' || this.disposed) return;
    const actor = this.expectedActor();
    if (actor === null) return;
    if (this.awaitingRelay) {
      // 自己的出手送出去没回音：再等一拍；还没有就当房主失联（转发超时）
      this.strikes += 1;
      if (this.strikes >= 2) {
        this.hostLost();
        return;
      }
      this.arm();
      return;
    }
    if (actor === this.myId) {
      // 先把补一手的口子交给接线方。自己没交出不怪房主：房主到点会广播本机退场
      this.opts.onTurnTimeout?.(this.myId);
      this.arm();
      return;
    }
    if (actor === this.hostId) {
      this.hostLost();
      return;
    }
    // 别的客人这一手没来：房主该在 timeout 内广播退场，再等一拍确认不是房主失联
    this.strikes += 1;
    if (this.strikes >= 2) {
      this.hostLost();
      return;
    }
    this.arm();
  }

  private onExit(msg: Extract<BrawlNetMsg, { kind: 'exit' }>): void {
    if (this.phase !== 'running') return;
    if (msg.epoch !== this.epochNo) return;
    const wasHost = msg.actor === this.hostId;
    this.applyExit(msg.actor, msg.reason);
    this.strikes = 0;
    this.awaitingRelay = false;
    if (wasHost) {
      this.hostLost();
      return;
    }
    this.arm();
    this.maybeEnd();
  }

  private onHostChange(msg: Extract<BrawlNetMsg, { kind: 'hostChange' }>): void {
    if (this.phase !== 'running') return;
    if (msg.from !== msg.host) return;
    if (!this.players.some((p) => p.id === msg.host)) return;
    if (msg.epoch < this.epochNo) return;
    if (msg.epoch === this.epochNo) {
      if (msg.host !== this.hostId) return;
      this.strikes = 0;
      this.awaitingRelay = false;
      this.arm();
      return;
    }
    this.epochNo = msg.epoch;
    this.hostId = msg.host;
    this.strikes = 0;
    this.awaitingRelay = false;
    this.opts.onHostChange?.(msg.host, msg.epoch);
    this.arm();
  }

  private applyExit(id: number, reason: BrawlExitReason): boolean {
    if (!this.aliveIds.includes(id)) return false;
    this.aliveIds = this.aliveIds.filter((x) => x !== id);
    this.exitList.push({ id, reason });
    this.opts.onExit?.(id, reason);
    return true;
  }

  private broadcastExit(actor: number, reason: BrawlExitReason, from: number): void {
    for (const p of this.players) {
      if (p.id === this.myId) continue;
      this.send({ kind: 'exit', from, to: p.id, actor, reason, epoch: this.epochNo });
    }
  }

  private broadcastHostChange(host: number, from: number): void {
    for (const p of this.players) {
      if (p.id === this.myId) continue;
      if (!this.aliveIds.includes(p.id)) continue;
      this.send({ kind: 'hostChange', from, to: p.id, epoch: this.epochNo, host });
    }
  }

  // -------------------------------------------------------------------------
  // 收场
  // -------------------------------------------------------------------------

  private maybeEnd(): void {
    if (this.phase !== 'running') return;
    if (this.aliveIds.length > 1) return;
    this.finish();
  }

  private finish(): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.clearTimer();
    const ranking = [...this.aliveIds].sort((a, b) => a - b);
    for (let i = this.exitList.length - 1; i >= 0; i--) ranking.push(this.exitList[i].id);
    const winner = this.aliveIds.length === 1 ? this.aliveIds[0] : null;
    this.result = { winner, ranking };
    if (!this.endedNotified) {
      this.endedNotified = true;
      this.opts.onEnd?.({ winner, ranking: [...ranking] });
    }
    if (this.myId === this.hostId) {
      for (const p of this.players) {
        if (p.id === this.myId) continue;
        this.send({ kind: 'end', from: this.myId, to: p.id, epoch: this.epochNo, winner, ranking });
      }
    }
  }

  private onEnd(msg: Extract<BrawlNetMsg, { kind: 'end' }>): void {
    if (this.phase !== 'running') return;
    if (msg.epoch !== this.epochNo) return;
    this.phase = 'ended';
    this.clearTimer();
    this.result = { winner: msg.winner, ranking: [...msg.ranking] };
    if (!this.endedNotified) {
      this.endedNotified = true;
      this.opts.onEnd?.({ winner: msg.winner, ranking: [...msg.ranking] });
    }
  }

  // -------------------------------------------------------------------------
  // 计时 / 轮次
  // -------------------------------------------------------------------------

  private arm(): void {
    this.clearTimer();
    if (this.disposed || this.phase !== 'running') return;
    // 退场的人只收广播、不再盯轮次
    if (!this.aliveIds.includes(this.myId)) return;
    const actor = this.expectedActor();
    if (actor === null) return;
    if (this.myId === this.hostId) {
      // 房主自己这一手由上层提交，不用自己给自己判超时
      if (actor === this.myId) return;
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.hostTurnTimeout(actor);
      }, this.timeoutMs);
    } else {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        this.guestWatchdog();
      }, this.timeoutMs);
    }
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private expectedActor(): number | null {
    if (this.aliveIds.length === 0) return null;
    if (this.opts.turnOf) {
      const id = this.opts.turnOf(this.nextIndex, [...this.aliveIds]);
      return id !== null && this.aliveIds.includes(id) ? id : null;
    }
    const ids = this.players.map((p) => p.id).sort((a, b) => a - b);
    if (ids.length === 0) return null;
    const start = ((this.turnPtr % ids.length) + ids.length) % ids.length;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[(start + k) % ids.length];
      if (this.aliveIds.includes(id)) return id;
    }
    return null;
  }

  private advanceTurn(actor: number): void {
    const ids = this.players.map((p) => p.id).sort((a, b) => a - b);
    if (ids.length === 0) return;
    const pos = ids.indexOf(actor);
    if (pos >= 0) this.turnPtr = (pos + 1) % ids.length;
  }

  // -------------------------------------------------------------------------
  // 投递
  // -------------------------------------------------------------------------

  receive(msg: BrawlNetMsg): void {
    if (this.disposed) return;
    if (msg.to !== this.myId) return;
    switch (msg.kind) {
      case 'join':
        this.onJoin(msg);
        break;
      case 'welcome':
        this.onWelcome(msg);
        break;
      case 'start':
        this.onStart(msg);
        break;
      case 'move':
        this.onMove(msg);
        break;
      case 'reject':
        this.awaitingRelay = false;
        this.opts.onReject?.(msg.reason, msg);
        break;
      case 'forfeit':
        this.onForfeit(msg);
        break;
      case 'exit':
        this.onExit(msg);
        break;
      case 'hostChange':
        this.onHostChange(msg);
        break;
      case 'end':
        this.onEnd(msg);
        break;
    }
  }

  private send(msg: BrawlNetMsg): void {
    if (this.disposed) return;
    this.opts.send(msg);
  }

  private sendReject(to: number, index: number, actor: number, reason: BrawlRejectReason): void {
    this.send({ kind: 'reject', from: this.myId, to, index, actor, reason });
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }
}

export function createBrawlNet(options: BrawlNetOptions): BrawlNet {
  return new BrawlNetImpl(options);
}
