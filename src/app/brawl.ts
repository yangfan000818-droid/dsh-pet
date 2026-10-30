/**
 * X27 群架内核（各自为战）：2–5 只同场混战，每次出手自己挑一个目标。
 *
 * 设计见 `docs/x27-brawl-design.md`。这里只做纯逻辑与事件，不碰网络、不碰窗口。
 * 规则口径与 `battle.ts` 的 1v1 逐条对齐：法宝 / 招式 / 护体 / 魂影 / 蓄力 / 领域 / 控制都走同一套
 * 常量与纯函数（`applyDamage` / `specOf` / `dodgeRate` …），区别只有「对方」变成了「这一手选中的目标」。
 * 1v1 的 `fight()` 一行不改；两边漂没漂用 `brawl.test.ts` 的 2 人对照测试兜底。
 */

import {
  ACTIVE_SKILLS,
  ANCIENT_BASE,
  BASE_CRIT,
  BLIND_MISS_FROM,
  BLOOD_BASE,
  BLOOD_PER_PASSIVE,
  BLOOD_POWER,
  BLUE_WHALE_SPAR_SHARE,
  CHANT_HP_SHARE,
  CONTROL_BASE,
  CONTROL_MAX,
  CONTROL_MIN,
  CONTROL_POWER_STEP,
  CRIT_SKILL_CHANCE,
  DECOY_FROM,
  DRAGON_PALM_BASE,
  DRAGON_PALM_HP_SHARE,
  DRAGON_SURGE_BASE,
  DRAGON_SURGE_POWER,
  EAT_BITE_BASE,
  EAT_HEAL,
  EAT_MIRROR_HEAL,
  FAREWELL_BASE,
  FAREWELL_HP_SHARE,
  FIST_HP_SHARE,
  FIELD_TICK,
  FIELD_TURNS,
  GULP_HP_SHARE,
  HAND_BASE,
  HAND_HP_SHARE,
  HEAVY_FACTOR,
  HP_BONUS,
  INK_TURNS,
  KNOCK_BASE,
  KNOCK_HP_SHARE,
  LION_BASE,
  LION_HP_SHARE,
  MAX_ACTIONS,
  MAX_COMBOS,
  MOVES,
  MYRIAD_MIRRORS,
  PAINT_BASE,
  PAINT_POWER,
  PALM_BASE,
  PALM_HP_SHARE,
  POWER_FACTOR,
  REVERSAL_SHARE,
  REVERSAL_TIMES,
  SHADOW_BASE,
  SHADOW_HP_SHARE,
  SIXTH_SENSE_CHANCE,
  SKILLS,
  SLOW_FACTOR,
  SPAR_DAMAGE_SCALE,
  SPAR_DODGE_SKILLS,
  SPAR_MAX_HIT_SHARE,
  SPAR_SURE_SKILLS,
  TIDE_BASE,
  TIDE_HP_SHARE,
  WHALE_SONG_BASE,
  WHALE_SONG_HP_SHARE,
  WEAPONS,
  applyDamage,
  autoController,
  desperateFactor,
  dodgeRate,
  hasSkill,
  intervalOf,
  makeSide,
  pick,
  randBetween,
  rngFrom,
  specOf,
  startingHp,
  type Action,
  type BattleView,
  type Fighter,
  type MoveId,
  type Side,
  type SkipCause,
  type SkillId,
  type WeaponId,
} from './battle';

/** 群架版本：协议与存档对不上就进不了同一场 */
export const BRAWL_VERSION = 1;

/** 一场群架的人数上下限 */
export const BRAWL_MIN = 2;
export const BRAWL_MAX = 5;

export interface BrawlFighter extends Fighter {
  /** 本场编号 0..N-1；0 号是房主 / 发起方 */
  id: number;
}

/** 带目标的一手。自增益招的 target 填自己即可，引擎不读它。 */
export type BrawlAction = Action & { target: number };

/**
 * 出手时引擎交给出招者的视野：活着的所有人都在 `foes` 里，没有「唯一对手」这回事。
 * `you` 的形状照 `BattleView.you`，AI 策略直接复用。
 */
export interface BrawlView {
  self: number;
  /** 按编号排列的全场气血 / 上限 / 存活 */
  hp: number[];
  maxHp: number[];
  alive: boolean[];
  you: {
    weapons: WeaponId[];
    skills: SkillId[];
    used: SkillId[];
    sealed?: 'weapon' | 'skill';
    moves?: MoveId[];
    moveUses?: MoveId[];
    skillUsesLeft?: number;
  };
  /** 其他还活着的人（不含自己） */
  foes: Array<{
    id: number;
    hp: number;
    maxHp: number;
    weapons: WeaponId[];
    skills: SkillId[];
    moves?: MoveId[];
    bubbles?: number;
    mirror?: number;
  }>;
}

export interface BrawlController {
  decide(view: BrawlView): BrawlAction;
}

export type BrawlEvent =
  | { actor: number; kind: 'start'; hp: number[] }
  | { actor: number; kind: 'decide'; action: BrawlAction; autoRelease?: true; hp: number[] }
  | {
      actor: number;
      kind: 'hit' | 'combo';
      target: number;
      weapon?: WeaponId;
      move?: MoveId;
      damage: number;
      crit: boolean;
      blocked: boolean;
      slowed?: true;
      twin?: true;
      surge?: true;
      hp: number[];
    }
  | { actor: number; kind: 'dodge' | 'miss' | 'mirror' | 'decoy'; target: number; hp: number[] }
  | { actor: number; kind: 'guard'; target: number; by: string; hp: number[] }
  | { actor: number; kind: 'play-dead'; target: number; hp: number[] }
  | { actor: number; kind: 'reverse'; target: number; damage: number; hp: number[] }
  | { actor: number; kind: 'counter'; target: number; damage: number; blocked: boolean; hp: number[] }
  | { actor: number; kind: 'beast'; target: number; damage: number; blocked: boolean; hp: number[] }
  | {
      actor: number;
      kind: 'skill';
      target?: number;
      skill: SkillId;
      damage?: number;
      heal?: number;
      resisted?: true;
      release?: true;
      charging?: true;
      pierce?: true;
      sealed?: 'weapon' | 'skill';
      paint?: SkillId;
      behead?: true;
      hp: number[];
    }
  | { actor: number; kind: 'field'; target: number; damage: number; hp: number[] }
  | { actor: number; kind: 'knock'; target: number; damage: number; hp: number[] }
  | { actor: number; kind: 'ancient'; target: number; damage: number; hp: number[] }
  | {
      actor: number;
      kind: 'devour';
      target: number;
      what: 'bubble' | 'mirror' | 'bite';
      heal?: number;
      damage?: number;
      hp: number[];
    }
  | { actor: number; kind: 'skip'; cause: SkipCause; hp: number[] }
  | { actor: number; kind: 'ko'; target: number; hp: number[] }
  | { actor: number; kind: 'forfeit'; target: number; hp: number[] }
  | {
      actor: number;
      kind: 'end';
      winner: number | null;
      reason: 'ko' | 'timeout';
      ranking: number[];
      hp: number[];
    };

/** 群架里的一只：在 1v1 的 `Side` 上补编号与「这一手的目标」相关状态 */
interface BrawlSide extends Side {
  id: number;
  /** 聚气（鲸派气功）时记下的目标：释放那一手打它；目标没了就改打第一个活人 */
  chargeTarget: number | null;
  /** 鬼敲门是谁敲的：那一手挨打时把伤害算在敲的人头上 */
  knockBy: number | null;
  /** 被送友风送走 / 已退场：气血还在也当淘汰，不再被选为目标 */
  out: boolean;
  /** 第几手被淘汰（排名同比例时后死的排前） */
  eliminatedAt: number;
}

export interface BrawlOptions {
  /** 切磋节奏（伤害缩放 / 单发封顶 / 主动技额度），群架默认开；测试可关掉做规则对照 */
  spar?: boolean;
  /** 人数少时也允许同一时刻按编号串行，默认就是 */
  maxActions?: number;
}

function makeBrawlSide(f: BrawlFighter, id: number, delay: number): BrawlSide {
  const side = makeSide(f, delay) as BrawlSide;
  side.id = id;
  side.chargeTarget = null;
  side.knockBy = null;
  side.out = false;
  side.eliminatedAt = 0;
  return side;
}

/** 群架：纯函数，同一颗种子打出同一串事件。 */
export function brawl(
  fighters: readonly BrawlFighter[],
  seed: string,
  controllers?: readonly BrawlController[],
  options: BrawlOptions = {},
): BrawlEvent[] {
  if (fighters.length < BRAWL_MIN || fighters.length > BRAWL_MAX) {
    throw new Error(`群架人数必须在 ${BRAWL_MIN}–${BRAWL_MAX} 之间`);
  }
  // 编号必须从 0 连续：事件里的 hp 数组下标就是编号，演出和协议都靠它对齐
  const ordered = [...fighters].sort((a, b) => a.id - b.id);
  ordered.forEach((f, i) => {
    if (f.id !== i) throw new Error('群架编号必须从 0 连续');
  });
  const spar = options.spar ?? true;
  // 1v1 仍是 30 手；人越多每人能出的手越少，按人数放宽，免得 5 人局没打完就按气血判
  const maxActions = options.maxActions ?? MAX_ACTIONS + (ordered.length - 2) * 12;
  const rng = rngFrom(seed + ':resolve');
  const decideRng = rngFrom(seed + ':decide');
  const picked = controllers ?? fighters.map(() => autoBrawlController(decideRng));
  if (picked.length !== fighters.length) throw new Error('控制器数量与人数对不上');

  const damageScale = spar ? SPAR_DAMAGE_SCALE : 1;
  const maxHitShare = spar ? SPAR_MAX_HIT_SHARE : undefined;
  const scaleDamage = (raw: number, target: BrawlSide): number => {
    if (raw <= 0) return raw;
    const scaled = Math.max(1, Math.floor(raw * damageScale));
    if (maxHitShare === undefined || maxHitShare <= 0) return scaled;
    return Math.min(scaled, Math.max(1, Math.floor(target.f.hp * maxHitShare)));
  };

  const sides = ordered.map((f) => makeBrawlSide(f, f.id, 0.8 + 0.4 * rng()));
  const byId = new Map(sides.map((s) => [s.id, s]));
  const events: BrawlEvent[] = [];
  const hpNow = (): number[] => sides.map((s) => s.hp);
  const aliveSide = (s: BrawlSide): boolean => s.hp > 0 && !s.out;
  const aliveIds = (): number[] => sides.filter(aliveSide).map((s) => s.id);
  const firstAliveOther = (self: BrawlSide): BrawlSide | null =>
    sides.find((s) => s.id !== self.id && aliveSide(s)) ?? null;

  let actions = 0;
  events.push({ actor: sides[0].id, kind: 'start', hp: hpNow() });

  // 淘汰记账：一手结束后统一扫一遍，保证「死在第几手」与事件顺序一致
  const eliminated = new Set<number>();
  const scanEliminations = (): void => {
    for (const s of sides) {
      if (!aliveSide(s) && !eliminated.has(s.id)) {
        eliminated.add(s.id);
        s.eliminatedAt = actions;
        events.push({ actor: s.id, kind: 'ko', target: s.id, hp: hpNow() });
      }
    }
  };

  const view = (self: BrawlSide): BrawlView => ({
    self: self.id,
    hp: hpNow(),
    maxHp: sides.map((s) => s.f.hp),
    alive: sides.map(aliveSide),
    you: {
      weapons: self.f.weapons,
      skills: self.f.skills,
      used: [...self.used],
      ...(self.sealed ? { sealed: self.sealed } : {}),
      ...(self.f.moves ? { moves: self.f.moves } : {}),
      ...(self.moveUses.size > 0
        ? {
            moveUses: [...self.moveUses.entries()].flatMap(([id, n]) => Array<MoveId>(n).fill(id)),
          }
        : {}),
      ...(spar ? { skillUsesLeft: self.skillUses } : {}),
    },
    foes: sides
      .filter((s) => s.id !== self.id && aliveSide(s))
      .map((s) => ({
        id: s.id,
        hp: s.hp,
        maxHp: s.f.hp,
        weapons: s.f.weapons,
        skills: s.f.skills,
        ...(s.f.moves ? { moves: s.f.moves } : {}),
        bubbles: s.bubbles,
        mirror: s.mirror,
      })),
  });

  const asleep = (side: BrawlSide): boolean =>
    side.skip && (side.skipCause === 'sleep' || side.skipCause === 'dream' || side.skipCause === 'float');

  const controlLands = (me: BrawlSide, target: BrawlSide, skill: SkillId): boolean => {
    if (target.controlled) return false;
    const chance = Math.min(
      CONTROL_MAX,
      Math.max(CONTROL_MIN, (CONTROL_BASE[skill] ?? 0.5) + (me.f.power - target.f.agility) * CONTROL_POWER_STEP),
    );
    return rng() < chance;
  };

  const control = (target: BrawlSide, cause: SkipCause): void => {
    target.skip = true;
    target.skipCause = cause;
    target.controlled = true;
  };

  /**
   * 伤害入口：先看目标身上有没有逆流护身印（弹回出手方），再走 `applyDamage`。
   * 与 1v1 的 `dealDamage` 同口径，只是「对方」显式传进来。
   */
  const dealDamage = (
    me: BrawlSide,
    target: BrawlSide,
    raw: number,
    opts: { pierce?: boolean; noPlayDead?: boolean } = {},
  ): { damage: number; blocked: boolean; playDead: boolean; reversed: boolean; mirrored: boolean } => {
    if (target.reversal > 0 && raw > 0) {
      target.reversal -= 1;
      const back = applyDamage(me, scaleDamage(Math.floor(raw * REVERSAL_SHARE), me));
      events.push({ actor: target.id, kind: 'reverse', target: me.id, damage: back.damage, hp: hpNow() });
      if (back.playDead) events.push({ actor: me.id, kind: 'play-dead', target: me.id, hp: hpNow() });
      return { damage: 0, blocked: false, playDead: false, reversed: true, mirrored: false };
    }
    if (spar && target.mirror > 0 && raw > 0 && !hasSkill(me, 'ghost-eye')) {
      target.mirror -= 1;
      events.push({ actor: me.id, kind: 'mirror', target: target.id, hp: hpNow() });
      return { damage: 0, blocked: false, playDead: false, reversed: false, mirrored: true };
    }
    const applied = applyDamage(target, scaleDamage(raw, target), opts);
    return { ...applied, reversed: false, mirrored: false };
  };

  /** 一次普通攻击（法宝 / 招式表 / 空手），命中、会心、连击、定身、反击、灵兽、替挡全照 1v1 */
  const attack = (
    me: BrawlSide,
    target: BrawlSide,
    action: Extract<Action, { kind: 'weapon' | 'move' | 'unarmed' }>,
    blinded: boolean,
  ): void => {
    const spec = action.kind === 'unarmed' ? null : specOf(action, me.f.pack);
    const comboCap = MAX_COMBOS;
    let combos = 0;
    const hits = spec ? spec.hits : 1;
    const surgeArmed = me.surge && (action.kind === 'weapon' || action.kind === 'unarmed');
    for (let hit = 0; hit < hits + combos && aliveSide(target); hit++) {
      const surgeHere = surgeArmed && hit === 0;
      if (surgeHere) me.surge = false;
      // 固定抽满六个：换招 / 换目标都不挪动后续结算序列
      const dodgeRoll = rng();
      const dmgRoll = rng();
      const critRoll = rng();
      const comboRoll = rng();
      const skipRoll = rng();
      const counterRoll = rng();
      if (target.blink) {
        events.push({ actor: me.id, kind: 'dodge', target: target.id, hp: hpNow() });
        continue;
      }
      if (blinded && dodgeRoll >= BLIND_MISS_FROM) {
        events.push({ actor: me.id, kind: 'miss', target: target.id, hp: hpNow() });
        continue;
      }
      const sure =
        me.field > 0 || me.blink || spec?.mustHit || (spec?.returnSure && hit === hits - 1) || asleep(target);
      if (!sure && dodgeRoll < dodgeRate(target)) {
        events.push({ actor: me.id, kind: 'dodge', target: target.id, hp: hpNow() });
        continue;
      }
      if (!sure && target.mirror > 0 && !hasSkill(me, 'ghost-eye')) {
        target.mirror -= 1;
        events.push({ actor: me.id, kind: 'mirror', target: target.id, hp: hpNow() });
        continue;
      }
      if (hasSkill(target, 'jelly-clone') && !hasSkill(me, 'ghost-eye') && counterRoll >= DECOY_FROM) {
        events.push({ actor: me.id, kind: 'decoy', target: target.id, hp: hpNow() });
        continue;
      }
      if (target.guardLeft > 0) {
        target.guardLeft -= 1;
        events.push({
          actor: me.id,
          kind: 'guard',
          target: target.id,
          by: target.f.guard?.by ?? '',
          hp: hpNow(),
        });
        continue;
      }
      let base = spec ? randBetween(dmgRoll, spec.min, spec.max) : randBetween(dmgRoll, 3, 6);
      const twin = !!spec && spec.twinChance > 0 && skipRoll < spec.twinChance;
      if (twin && spec) base += randBetween((dmgRoll * 7.31) % 1, spec.min, spec.max);
      const perPiece = Math.floor((me.f.power * POWER_FACTOR + target.f.hp * HP_BONUS) / (spec?.hits ?? 1));
      let damage = base + perPiece;
      const critChance = hasSkill(me, 'critical') ? CRIT_SKILL_CHANCE : BASE_CRIT;
      const crit = critRoll < critChance;
      if (crit) damage *= 2;
      const desperate = desperateFactor(me.f, me.hp);
      if (desperate !== 1) damage = Math.floor(damage * desperate);
      if (surgeHere) damage += DRAGON_SURGE_BASE + Math.floor(me.f.power * DRAGON_SURGE_POWER);
      const applied = dealDamage(me, target, damage);
      const kind = hit < hits ? 'hit' : 'combo';
      const slowed = !!spec?.slow && aliveSide(target) && !applied.reversed && !applied.mirrored;
      if (slowed) target.next += intervalOf(target) * SLOW_FACTOR;
      events.push({
        actor: me.id,
        kind,
        target: target.id,
        ...(spec ? (spec.isMove ? { move: spec.id as MoveId } : { weapon: spec.id as WeaponId }) : {}),
        damage: applied.damage,
        crit,
        blocked: applied.blocked,
        ...(slowed ? { slowed: true as const } : {}),
        ...(twin ? { twin: true as const } : {}),
        ...(surgeHere ? { surge: true as const } : {}),
        hp: hpNow(),
      });
      if (applied.playDead) events.push({ actor: target.id, kind: 'play-dead', target: target.id, hp: hpNow() });
      if (
        spec &&
        spec.skipChance > 0 &&
        !applied.reversed &&
        !applied.mirrored &&
        !target.controlled &&
        skipRoll < spec.skipChance
      ) {
        control(target, spec.skipCause);
      }
      if (
        !applied.reversed &&
        !applied.mirrored &&
        !spec?.ranged &&
        aliveSide(target) &&
        hasSkill(target, 'sixth-sense') &&
        counterRoll < SIXTH_SENSE_CHANCE
      ) {
        const counterDmg = randBetween(rng(), 3, 6) + Math.floor(target.f.power * POWER_FACTOR);
        const back = applyDamage(me, scaleDamage(counterDmg, me));
        events.push({
          actor: target.id,
          kind: 'counter',
          target: me.id,
          damage: back.damage,
          blocked: back.blocked,
          hp: hpNow(),
        });
        if (back.playDead) events.push({ actor: me.id, kind: 'play-dead', target: me.id, hp: hpNow() });
      }
      if (
        aliveSide(target) &&
        combos < comboCap &&
        hit + 1 >= hits &&
        comboRoll <
          Math.min(0.3, me.f.agility * 0.01) + (spec?.comboBonus ?? 0) + (hasSkill(me, 'shadow-fists') ? 0.15 : 0)
      ) {
        combos += 1;
      }
    }
    // 灵兽：自己前几次出手后追加一击，照 1v1 打这一手的目标
    if (me.beastLeft > 0 && aliveSide(target)) {
      me.beastLeft -= 1;
      const dodgeRoll = rng();
      const dmgRoll = rng();
      if (!target.blink && (asleep(target) || !(dodgeRoll < dodgeRate(target)))) {
        const applied = applyDamage(target, scaleDamage(randBetween(dmgRoll, 4, 7), target));
        events.push({
          actor: me.id,
          kind: 'beast',
          target: target.id,
          damage: applied.damage,
          blocked: applied.blocked,
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: target.id, kind: 'play-dead', target: target.id, hp: hpNow() });
      } else {
        events.push({ actor: me.id, kind: 'dodge', target: target.id, hp: hpNow() });
      }
    }
    if (me.field > 0) me.field -= 1;
    if (me.blink) me.blink = false;
  };

  /** 动作不合法（没有的法宝 / 招式、用过的主动、被封的那一类）按空手处理 */
  const legalize = (me: BrawlSide, action: Action, sealed: Side['sealed']): Action => {
    if (sealed === 'weapon' && action.kind === 'weapon') return { kind: 'unarmed' };
    if (sealed === 'skill' && action.kind === 'skill') return { kind: 'unarmed' };
    if (action.kind === 'weapon' && me.f.weapons.includes(action.weapon)) return action;
    if (action.kind === 'move' && me.f.moves?.includes(action.move)) {
      const cap = MOVES[action.move].uses;
      const used = me.moveUses.get(action.move) ?? 0;
      if (cap === undefined || used < cap) return action;
      return { kind: 'unarmed' };
    }
    if (
      action.kind === 'skill' &&
      me.f.skills.includes(action.skill) &&
      ACTIVE_SKILLS.includes(action.skill) &&
      !me.used.has(action.skill) &&
      (!spar || me.skillUses > 0)
    ) {
      return action;
    }
    return { kind: 'unarmed' };
  };

  /** 自增益招不需要目标；其余招必须有活着的目标 */
  const needsTarget = (action: Action): boolean =>
    !(
      action.kind === 'skill' &&
      (action.skill === 'bloom' ||
        action.skill === 'myriad-self' ||
        action.skill === 'reverse-seal' ||
        action.skill === 'ancients' ||
        action.skill === 'tide-cannon' ||
        action.skill === 'abyss-field' ||
        action.skill === 'shadow-step')
    );

  const resolveTarget = (me: BrawlSide, asked: number): BrawlSide | null => {
    const chosen = byId.get(asked);
    if (chosen && chosen.id !== me.id && aliveSide(chosen)) return chosen;
    return firstAliveOther(me);
  };

  /** 一次出手，返回实际执行的动作（凭空生花会在里面递归补一手） */
  const takeAction = (me: BrawlSide, askedTarget: number): Action => {
    // 深渊领域：所有铺了领域的其他人，在这一手之前各 tick 一口（被控跳过不算）
    for (const owner of sides) {
      if (owner.id === me.id || !aliveSide(owner) || owner.field <= 0) continue;
      const applied = applyDamage(me, scaleDamage(FIELD_TICK, me));
      events.push({ actor: owner.id, kind: 'field', target: me.id, damage: applied.damage, hp: hpNow() });
      if (applied.playDead) events.push({ actor: me.id, kind: 'play-dead', target: me.id, hp: hpNow() });
      if (!aliveSide(me)) return { kind: 'unarmed' };
    }
    // 鬼敲门：谁敲的记在 knockBy 上，伤害算在敲的人头上
    if (me.knock) {
      me.knock = false;
      const applied = applyDamage(me, scaleDamage(KNOCK_BASE + Math.floor(me.f.hp * HP_BONUS * KNOCK_HP_SHARE), me));
      events.push({
        actor: me.knockBy ?? me.id,
        kind: 'knock',
        target: me.id,
        damage: applied.damage,
        hp: hpNow(),
      });
      if (applied.playDead) events.push({ actor: me.id, kind: 'play-dead', target: me.id, hp: hpNow() });
      if (!aliveSide(me)) return { kind: 'unarmed' };
    }
    // 鲸派气功：聚过气后下一次真正出手直接释放，打聚气时记下的目标
    if (me.charge > 0) {
      me.charge = 0;
      const target = resolveTarget(me, me.chargeTarget ?? -1) ?? firstAliveOther(me);
      const action: BrawlAction = { kind: 'skill', skill: 'tide-cannon', target: target?.id ?? me.id };
      events.push({ actor: me.id, kind: 'decide', action, autoRelease: true, hp: hpNow() });
      if (target) {
        const applied = applyDamage(
          target,
          scaleDamage(
            TIDE_BASE + Math.floor(me.f.power * POWER_FACTOR) + Math.floor(target.f.hp * HP_BONUS * TIDE_HP_SHARE),
            target,
          ),
        );
        events.push({
          actor: me.id,
          kind: 'skill',
          target: target.id,
          skill: 'tide-cannon',
          release: true,
          damage: applied.damage,
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: target.id, kind: 'play-dead', target: target.id, hp: hpNow() });
      }
      return action;
    }

    const decided = picked[me.id].decide(view(me));
    const action = legalize(me, decided, me.sealed);
    let target = resolveTarget(me, decided.target);
    if (needsTarget(action) && !target) {
      // 没有活着的目标：只能空手（这时通常已经收场）
      events.push({ actor: me.id, kind: 'decide', action: { kind: 'unarmed', target: me.id }, hp: hpNow() });
      return { kind: 'unarmed' };
    }
    // 自增益招的目标只是占位，记自己
    const targetId = needsTarget(action) && target ? target.id : me.id;
    me.sealed = null;
    events.push({ actor: me.id, kind: 'decide', action: { ...action, target: targetId }, hp: hpNow() });

    if (me.ancient) {
      me.ancient = false;
      if (target) {
        if (spar && target.mirror > 0 && !hasSkill(me, 'ghost-eye')) {
          target.mirror -= 1;
          events.push({ actor: me.id, kind: 'mirror', target: target.id, hp: hpNow() });
        } else {
          const strike = applyDamage(target, scaleDamage(ANCIENT_BASE, target));
          events.push({ actor: me.id, kind: 'ancient', target: target.id, damage: strike.damage, hp: hpNow() });
          if (strike.playDead) events.push({ actor: target.id, kind: 'play-dead', target: target.id, hp: hpNow() });
        }
        if (!aliveSide(target)) target = null;
      }
    }

    const blinded = me.blind > 0;
    if (blinded) me.blind -= 1;

    if (action.kind === 'move') {
      me.moveUses.set(action.move, (me.moveUses.get(action.move) ?? 0) + 1);
      if (target) attack(me, target, action, blinded);
    } else if (action.kind === 'skill') {
      me.used.add(action.skill);
      if (spar) {
        me.skillUses -= 1;
        if (SPAR_DODGE_SKILLS.includes(action.skill) && target) {
          const hitRoll = rng();
          const sure = SPAR_SURE_SKILLS.includes(action.skill) || asleep(target);
          if (!sure && hitRoll < dodgeRate(target)) {
            if (action.skill === 'eat-hardship') me.blind = 0;
            events.push({ actor: me.id, kind: 'dodge', target: target.id, hp: hpNow() });
            return action;
          }
        }
      }
      const t = target;
      if (action.skill === 'bloom') {
        const heal = Math.ceil((me.f.hp * 18) / 100);
        me.hp = Math.min(me.f.hp, me.hp + heal);
        events.push({ actor: me.id, kind: 'skill', skill: 'bloom', heal, hp: hpNow() });
        return takeAction(me, askedTarget);
      }
      if (action.skill === 'lion-roar' && t) {
        const applied = dealDamage(me, t, LION_BASE + Math.floor((t.f.hp * HP_BONUS * LION_HP_SHARE) / 1));
        const landed = !applied.reversed && !applied.mirrored && aliveSide(t) && controlLands(me, t, 'lion-roar');
        if (landed) control(t, 'stun');
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'lion-roar',
          damage: applied.damage,
          ...(aliveSide(t) && !landed ? { resisted: true as const } : {}),
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
      }
      if (action.skill === 'blue-whale' && t) {
        const raw = 34 + me.f.power + Math.floor(t.f.hp * HP_BONUS);
        const applied = dealDamage(me, t, spar ? Math.floor(raw * BLUE_WHALE_SPAR_SHARE) : raw);
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'blue-whale',
          damage: applied.damage,
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
      }
      if (action.skill === 'whale-song' && t) {
        const applied = dealDamage(
          me,
          t,
          WHALE_SONG_BASE +
            Math.floor(me.f.power * POWER_FACTOR * 0.6) +
            Math.floor(t.f.hp * HP_BONUS * WHALE_SONG_HP_SHARE),
        );
        const landed = !applied.reversed && !applied.mirrored && aliveSide(t) && controlLands(me, t, 'whale-song');
        if (landed) control(t, 'sleep');
        else if (!applied.reversed && !applied.mirrored && aliveSide(t)) t.next += intervalOf(t) * SLOW_FACTOR;
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'whale-song',
          damage: applied.damage,
          ...(aliveSide(t) && !landed ? { resisted: true as const } : {}),
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
      }
      if (action.skill === 'ink' && t) {
        if (!hasSkill(t, 'ghost-eye')) t.blind = INK_TURNS;
        events.push({ actor: me.id, kind: 'skill', target: t.id, skill: 'ink', hp: hpNow() });
      }
      if (action.skill === 'whale-gulp' && t) {
        const applied = dealDamage(
          me,
          t,
          18 + Math.floor(me.f.power * POWER_FACTOR) + Math.floor(t.f.hp * HP_BONUS * GULP_HP_SHARE),
        );
        const heal = Math.min(Math.floor(applied.damage / 2), me.f.hp - me.hp);
        me.hp += heal;
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'whale-gulp',
          damage: applied.damage,
          heal,
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
      }
      if (action.skill === 'myriad-self') {
        me.mirror += MYRIAD_MIRRORS;
        events.push({ actor: me.id, kind: 'skill', skill: 'myriad-self', hp: hpNow() });
      }
      if (action.skill === 'dream-chant' && t) {
        const applied = dealDamage(
          me,
          t,
          14 + Math.floor(me.f.power * POWER_FACTOR) + Math.floor(t.f.hp * HP_BONUS * CHANT_HP_SHARE),
        );
        const landed = !applied.reversed && !applied.mirrored && aliveSide(t) && controlLands(me, t, 'dream-chant');
        if (landed) control(t, 'dream');
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'dream-chant',
          damage: applied.damage,
          ...(aliveSide(t) && !landed ? { resisted: true as const } : {}),
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
      }
      if (action.skill === 'finger-sword' && t) {
        const hadBubble = t.bubbles > 0;
        const applied = dealDamage(
          me,
          t,
          22 + Math.floor(me.f.power * POWER_FACTOR) + Math.floor(t.f.hp * HP_BONUS * FIST_HP_SHARE),
          { pierce: true },
        );
        const pierced = hadBubble && !applied.reversed && !applied.mirrored;
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'finger-sword',
          damage: applied.damage,
          ...(pierced ? { pierce: true as const } : {}),
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
      }
      if (action.skill === 'dragon-palm' && t) {
        const applied = dealDamage(
          me,
          t,
          DRAGON_PALM_BASE +
            Math.floor(me.f.power * POWER_FACTOR) +
            Math.floor(t.f.hp * HP_BONUS * DRAGON_PALM_HP_SHARE),
        );
        if (!applied.mirrored) me.surge = true;
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'dragon-palm',
          damage: applied.damage,
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
      }
      if (action.skill === 'farewell-wind' && t) {
        const applied = dealDamage(
          me,
          t,
          FAREWELL_BASE + Math.floor(me.f.power * POWER_FACTOR) + Math.floor(t.f.hp * HP_BONUS * FAREWELL_HP_SHARE),
        );
        const landed = !applied.reversed && !applied.mirrored && aliveSide(t) && controlLands(me, t, 'farewell-wind');
        if (landed) control(t, 'float');
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'farewell-wind',
          damage: applied.damage,
          ...(aliveSide(t) && !landed ? { resisted: true as const } : {}),
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
      }
      if (action.skill === 'myriad-palm' && t) {
        const applied = dealDamage(
          me,
          t,
          PALM_BASE + Math.floor(me.f.power * POWER_FACTOR) + Math.floor(t.f.hp * HP_BONUS * PALM_HP_SHARE),
        );
        const sealed = !applied.reversed && !applied.mirrored && aliveSide(t);
        if (sealed) t.sealed = 'weapon';
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'myriad-palm',
          damage: applied.damage,
          ...(sealed ? { sealed: 'weapon' as const } : {}),
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
      }
      if (action.skill === 'reverse-seal') {
        me.reversal = REVERSAL_TIMES;
        events.push({ actor: me.id, kind: 'skill', skill: 'reverse-seal', hp: hpNow() });
      }
      if (action.skill === 'ancients') {
        me.ancient = true;
        events.push({ actor: me.id, kind: 'skill', skill: 'ancients', hp: hpNow() });
      }
      if (action.skill === 'eat-hardship' && t) {
        me.blind = 0;
        if (t.bubbles > 0) {
          t.bubbles -= 1;
          const heal = Math.min(Math.floor(me.f.hp * EAT_HEAL), me.f.hp - me.hp);
          me.hp += heal;
          events.push({ actor: me.id, kind: 'devour', target: t.id, what: 'bubble', heal, hp: hpNow() });
        } else if (t.mirror > 0) {
          t.mirror -= 1;
          const heal = Math.min(Math.floor(me.f.hp * EAT_MIRROR_HEAL), me.f.hp - me.hp);
          me.hp += heal;
          events.push({ actor: me.id, kind: 'devour', target: t.id, what: 'mirror', heal, hp: hpNow() });
        } else {
          const applied = dealDamage(me, t, EAT_BITE_BASE + Math.floor(me.f.power * 0.4));
          const heal = Math.min(Math.floor(applied.damage / 2), me.f.hp - me.hp);
          me.hp += heal;
          events.push({
            actor: me.id,
            kind: 'devour',
            target: t.id,
            what: 'bite',
            damage: applied.damage,
            heal,
            hp: hpNow(),
          });
          if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
        }
      }
      if (action.skill === 'ghost-hand' && t) {
        const applied = dealDamage(
          me,
          t,
          HAND_BASE + Math.floor(me.f.power * POWER_FACTOR) + Math.floor(t.f.hp * HP_BONUS * HAND_HP_SHARE),
        );
        const sealed = !applied.reversed && !applied.mirrored && aliveSide(t);
        if (sealed) t.sealed = 'skill';
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'ghost-hand',
          damage: applied.damage,
          ...(sealed ? { sealed: 'skill' as const } : {}),
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
      }
      if (action.skill === 'headless-shadow' && t) {
        const applied = dealDamage(
          me,
          t,
          SHADOW_BASE + Math.floor(me.f.power * 0.5) + Math.floor(t.f.hp * HP_BONUS * SHADOW_HP_SHARE),
          { noPlayDead: true },
        );
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'headless-shadow',
          damage: applied.damage,
          ...(!aliveSide(t) ? { behead: true as const } : {}),
          hp: hpNow(),
        });
      }
      if (action.skill === 'ghost-knock' && t) {
        t.knock = true;
        t.knockBy = me.id;
        events.push({ actor: me.id, kind: 'skill', target: t.id, skill: 'ghost-knock', hp: hpNow() });
      }
      if (action.skill === 'ghost-painting' && t) {
        const passives = t.f.skills.filter((id) => SKILLS[id].kind === '被动');
        if (passives.length > 0) {
          const sealedPassive = pick(rng, passives);
          t.sealedPassive = sealedPassive;
          if (sealedPassive === 'bubble') t.bubbles = 0;
          if (sealedPassive === 'spirit-beast') t.beastLeft = 0;
          events.push({
            actor: me.id,
            kind: 'skill',
            target: t.id,
            skill: 'ghost-painting',
            paint: sealedPassive,
            hp: hpNow(),
          });
        } else {
          const applied = dealDamage(me, t, PAINT_BASE + Math.floor(me.f.power * PAINT_POWER));
          events.push({
            actor: me.id,
            kind: 'skill',
            target: t.id,
            skill: 'ghost-painting',
            damage: applied.damage,
            hp: hpNow(),
          });
          if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
        }
      }
      if (action.skill === 'ghost-blood' && t) {
        const passives = t.f.skills.filter((id) => SKILLS[id].kind === '被动').length;
        const applied = dealDamage(
          me,
          t,
          BLOOD_BASE + Math.floor(me.f.power * BLOOD_POWER) + passives * BLOOD_PER_PASSIVE,
        );
        events.push({
          actor: me.id,
          kind: 'skill',
          target: t.id,
          skill: 'ghost-blood',
          damage: applied.damage,
          hp: hpNow(),
        });
        if (applied.playDead) events.push({ actor: t.id, kind: 'play-dead', target: t.id, hp: hpNow() });
      }
      if (action.skill === 'tide-cannon') {
        me.charge = 1;
        me.chargeTarget = t?.id ?? null;
        events.push({ actor: me.id, kind: 'skill', skill: 'tide-cannon', charging: true, hp: hpNow() });
      }
      if (action.skill === 'abyss-field') {
        me.field = FIELD_TURNS;
        events.push({ actor: me.id, kind: 'skill', skill: 'abyss-field', hp: hpNow() });
      }
      if (action.skill === 'shadow-step') {
        me.blink = true;
        events.push({ actor: me.id, kind: 'skill', skill: 'shadow-step', hp: hpNow() });
      }
    } else if (target) {
      attack(me, target, action, blinded);
    }
    return action;
  };

  // -------------------------------------------------------------------------
  // 主循环：按遁速时间轴取 next 最小的活人；同一时刻按编号升序串行
  // -------------------------------------------------------------------------
  const isDone = (): boolean => aliveIds().length <= 1;

  while (!isDone() && actions < maxActions) {
    let self: BrawlSide | null = null;
    for (const s of sides) {
      if (!aliveSide(s)) continue;
      if (!self || s.next < self.next || (s.next === self.next && s.id < self.id)) self = s;
    }
    if (!self) break;
    const me = self;
    const now = me.next;
    actions += 1;
    if (me.skip) {
      me.skip = false;
      events.push({ actor: me.id, kind: 'skip', cause: me.skipCause, hp: hpNow() });
      me.skipCause = 'stun';
      me.next = now + intervalOf(me);
    } else {
      me.controlled = false;
      const done = takeAction(me, firstAliveOther(me)?.id ?? me.id);
      const heavy =
        (done.kind === 'weapon' && WEAPONS[done.weapon].heavy) || (done.kind === 'move' && MOVES[done.move].heavy);
      me.next = now + intervalOf(me) * (heavy ? HEAVY_FACTOR : 1);
    }
    scanEliminations();
  }

  scanEliminations();

  // -------------------------------------------------------------------------
  // 收场：最后站着的赢；同时没了的按剩余比例、淘汰先后、编号排
  // -------------------------------------------------------------------------
  const rank = (): number[] => {
    return [...sides]
      .sort((a, b) => {
        const aliveA = aliveSide(a) ? 1 : 0;
        const aliveB = aliveSide(b) ? 1 : 0;
        if (aliveA !== aliveB) return aliveB - aliveA;
        const fracA = a.hp / a.f.hp;
        const fracB = b.hp / b.f.hp;
        if (fracA !== fracB) return fracB - fracA;
        if (a.eliminatedAt !== b.eliminatedAt) return b.eliminatedAt - a.eliminatedAt;
        return a.id - b.id;
      })
      .map((s) => s.id);
  };

  const ranking = rank();
  const survivors = aliveIds();
  const winner = survivors.length === 1 ? survivors[0] : null;
  const reason: 'ko' | 'timeout' = survivors.length === 1 ? 'ko' : 'timeout';
  events.push({ actor: winner ?? sides[0].id, kind: 'end', winner, reason, ranking, hp: hpNow() });
  return events;
}

/**
 * 群架的合法动作（AI 与手动共用）：形状照 `legalActions`，目标由调用方另挑。
 */
export function legalBrawlActions(view: BrawlView): Action[] {
  const actions: Action[] =
    view.you.sealed === 'weapon' ? [] : view.you.weapons.map((weapon): Action => ({ kind: 'weapon', weapon }));
  actions.push({ kind: 'unarmed' });
  const skillBudget = view.you.skillUsesLeft === undefined || view.you.skillUsesLeft > 0;
  if (view.you.sealed !== 'skill' && skillBudget) {
    for (const skill of view.you.skills) {
      if (ACTIVE_SKILLS.includes(skill) && !view.you.used.includes(skill)) actions.push({ kind: 'skill', skill });
    }
  }
  const used = view.you.moveUses ?? [];
  for (const move of view.you.moves ?? []) {
    const cap = MOVES[move].uses;
    const count = used.filter((id) => id === move).length;
    if (cap === undefined || count < cap) actions.push({ kind: 'move', move });
  }
  return actions;
}

/** 自增益招：选目标那一步可以跳过 */
export function brawlNeedsTarget(action: Action): boolean {
  return !(
    action.kind === 'skill' &&
    (action.skill === 'bloom' ||
      action.skill === 'myriad-self' ||
      action.skill === 'reverse-seal' ||
      action.skill === 'ancients' ||
      action.skill === 'tide-cannon' ||
      action.skill === 'abyss-field' ||
      action.skill === 'shadow-step')
  );
}

/**
 * 群架自动出招：先把多目标视野压成「自己 + 一个主目标」的 1v1 视野，直接复用 `autoController`
 * 的整套策略（回血、吃泡泡、残血收人头……），再把动作配上目标编号。
 *
 * 主目标只在「最残的一档」里随机挑，避免所有 AI 都照着编号集火同一个人（否则编号越大越稳赢）；
 * 只有两个活人时天然等同 1v1，不额外抽随机数。
 */
export function autoBrawlController(rng: () => number): BrawlController {
  const inner = autoController(rng);
  return {
    decide(view: BrawlView): BrawlAction {
      const foes = [...view.foes].sort((a, b) => {
        const fa = a.hp / a.maxHp;
        const fb = b.hp / b.maxHp;
        if (fa !== fb) return fa - fb;
        return a.id - b.id;
      });
      const foe = foes.length > 1 ? spreadTarget(foes, rng) : foes[0];
      if (!foe) return { kind: 'unarmed', target: view.self };
      const oneOnOne: BattleView = {
        self: 0 as const,
        hp: [view.hp[view.self], foe.hp],
        maxHp: [view.maxHp[view.self], foe.maxHp],
        you: view.you,
        foe: {
          weapons: foe.weapons,
          skills: foe.skills,
          ...(foe.moves ? { moves: foe.moves } : {}),
          bubbles: foe.bubbles,
          mirror: foe.mirror,
        },
      };
      const action = inner.decide(oneOnOne);
      return { ...action, target: brawlNeedsTarget(action) ? foe.id : view.self };
    },
  };
}

/** 在「最残的一档」里随机挑一个目标：残血优先，但同档分散，不按编号集火 */
function spreadTarget(foes: BrawlView['foes'], rng: () => number): BrawlView['foes'][number] {
  const lowest = foes[0].hp / foes[0].maxHp;
  const pool = foes.filter((f) => f.hp / f.maxHp <= lowest + 0.12);
  return pool[Math.floor(rng() * pool.length)] ?? foes[0];
}

/** 名字表按编号排好（演出用） */
export function brawlNames(fighters: readonly BrawlFighter[]): string[] {
  return [...fighters].sort((a, b) => a.id - b.id).map((f) => f.name);
}

/** 名帖 → 群架选手（联机加入时用）：编号由开桌方分配 */
export function brawlFighterOf(card: Fighter, id: number): BrawlFighter {
  return { ...card, id };
}

/** 这一场每人还剩多少气血（结算用） */
export function brawlHpOf(events: readonly BrawlEvent[], ids: readonly number[]): number[] {
  const last = events[events.length - 1];
  if (!last) return ids.map(() => 0);
  return last.hp.slice();
}

/** 1v1 的胜者编号（2 人局退化用） */
export function brawlWinner(events: readonly BrawlEvent[]): number | null {
  const end = events.find((e) => e.kind === 'end');
  return end && end.kind === 'end' ? end.winner : null;
}

/** 起始气血（带 hpNow 的秘境成员）；与 1v1 同口径 */
export function brawlStartingHp(f: Fighter): number {
  return startingHp(f);
}
