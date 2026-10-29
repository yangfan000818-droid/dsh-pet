/**
 * 对战引擎（修炼路线 X0）：纯函数，同一组输入加同一个种子必然打出同一场。
 *
 * 不碰 Electron、不调模型、不读写文件。图鉴（法宝 / 招式）、自动出招、时间轴出手顺序、结算、
 * 渡劫和心魔都在这里；解说词在 battle-lines.ts。随机数分两路：决策和结算各喂一个由种子派生的
 * sfc32（sha256(seed + ':decide' / ':resolve')），以后手动对战换掉决策一路也不影响结算的复现。
 */
import { createHash } from 'node:crypto';

/** 图鉴条目都会上网（X5 名帖），编号用 ASCII；name 只在本机和局域网里显示（素材名在 battle-show.ts 的演出表里） */
export type WeaponId =
  | 'water-gun'
  | 'poker'
  | 'shuttlecock'
  | 'snowball'
  | 'duster'
  | 'juggle'
  | 'top'
  | 'whale-tail'
  | 'tray'
  | 'slingshot'
  | 'firework';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  grade: '凡器' | '灵器' | '神器';
  /** 伤害区间（结算前，还没加灵力、会心、泡泡护体） */
  min: number;
  max: number;
  /** 一次几件齐发，每件独立判定命中 */
  hits: number;
  /** 连击率加成 */
  comboBonus: number;
  /** 命中后让对方跳过下一次出手的概率 */
  skipChance: number;
  /** 必中（不判闪避） */
  mustHit: boolean;
  /** 远程：不会被反击 */
  ranged: boolean;
  /** 重：用它出手后，下次出手间隔 ×1.15 */
  heavy: boolean;
  /** 定身的样子（演出与解说用）：陀螺是晕（stun），雪球是冻住（freeze） */
  skipCause: 'stun' | 'freeze';
  /** 迟缓（鸡毛掸子，X8）：打中就让对方下次出手往后推半个出手间隔 */
  slow: boolean;
  /** 回旋（银托盘，X8）：最后一段是飞回来从背后磕的，必中 */
  returnSure: boolean;
  /** 一发打两颗的概率（弹弓，X8）：这一下伤害再加一次区间随机 */
  twinChance: number;
}

const weapon = (
  id: WeaponId,
  name: string,
  grade: WeaponDef['grade'],
  min: number,
  max: number,
  extra: Partial<WeaponDef> = {},
): WeaponDef => ({
  id,
  name,
  grade,
  min,
  max,
  hits: 1,
  comboBonus: 0,
  skipChance: 0,
  mustHit: false,
  ranged: false,
  heavy: false,
  skipCause: 'stun',
  slow: false,
  returnSure: false,
  twinChance: 0,
  ...extra,
});

/** 法宝图鉴 */
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  'water-gun': weapon('water-gun', '水枪', '凡器', 6, 10, { ranged: true }),
  poker: weapon('poker', '扑克牌', '凡器', 3, 8, { hits: 2 }),
  shuttlecock: weapon('shuttlecock', '毽子', '凡器', 5, 9, { comboBonus: 0.1 }),
  snowball: weapon('snowball', '雪球', '凡器', 4, 8, { skipChance: 0.1, skipCause: 'freeze' }),
  duster: weapon('duster', '鸡毛掸子', '凡器', 3, 7, { slow: true }),
  juggle: weapon('juggle', '三球', '灵器', 2, 6, { hits: 3 }),
  top: weapon('top', '陀螺', '灵器', 6, 10, { skipChance: 0.15 }),
  'whale-tail': weapon('whale-tail', '鲸尾', '灵器', 10, 16, { heavy: true }),
  tray: weapon('tray', '银托盘', '灵器', 4, 7, { hits: 2, returnSure: true }),
  slingshot: weapon('slingshot', '弹弓', '灵器', 6, 10, { ranged: true, twinChance: 0.15 }),
  firework: weapon('firework', '烟花', '神器', 8, 13, { mustHit: true }),
};

export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];

export type SkillId =
  | 'play-dead'
  | 'dove'
  | 'bubble'
  | 'sixth-sense'
  | 'shadow-fists'
  | 'critical'
  | 'spirit-beast'
  | 'bloom'
  | 'lion-roar'
  | 'blue-whale'
  | 'whale-song'
  | 'ink'
  | 'whale-gulp'
  | 'jelly-clone'
  | 'myriad-self'
  | 'dream-chant'
  | 'finger-sword'
  | 'dragon-palm'
  | 'farewell-wind';

export interface SkillDef {
  id: SkillId;
  name: string;
  kind: '被动' | '主动';
}

const skill = (id: SkillId, name: string, kind: SkillDef['kind']): SkillDef => ({
  id,
  name,
  kind,
});

/** 招式图鉴 */
export const SKILLS: Record<SkillId, SkillDef> = {
  'play-dead': skill('play-dead', '假死遁', '被动'),
  dove: skill('dove', '化鸽遁', '被动'),
  bubble: skill('bubble', '泡泡护体', '被动'),
  'sixth-sense': skill('sixth-sense', '第六感', '被动'),
  'shadow-fists': skill('shadow-fists', '无影手', '被动'),
  critical: skill('critical', '会心一击', '被动'),
  'spirit-beast': skill('spirit-beast', '灵兽助阵', '被动'),
  bloom: skill('bloom', '凭空生花', '主动'),
  'lion-roar': skill('lion-roar', '狮子吼', '主动'),
  'blue-whale': skill('blue-whale', '蓝鲸现世', '主动'),
  'whale-song': skill('whale-song', '鲸歌', '主动'),
  ink: skill('ink', '墨汁喷射', '主动'),
  'whale-gulp': skill('whale-gulp', '鲸吞', '主动'),
  'jelly-clone': skill('jelly-clone', '水母分身', '被动'),
  'myriad-self': skill('myriad-self', '万我', '主动'),
  'dream-chant': skill('dream-chant', '魂牵梦绕', '主动'),
  'finger-sword': skill('finger-sword', '五指拳心剑', '主动'),
  'dragon-palm': skill('dragon-palm', '降龙十八掌', '主动'),
  'farewell-wind': skill('farewell-wind', '送友风', '主动'),
};

export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];

/** 招式编号（历练路线 Y0）：对手招式和一转蛊，另开一张表，不进图鉴、不进名帖、不会掉落 */
export type MoveId =
  | 'gu-dogs'
  | 'gu-crane'
  | 'gu-egg'
  | 'dog-bite'
  | 'egg-burst'
  | 'mastiff-maul'
  | 'han-dogs'
  | 'moon-blade'
  | 'gold-needle'
  | 'gold-blade'
  | 'ice-blade'
  | 'frost'
  | 'bingpo';

export interface MoveDef {
  id: MoveId;
  name: string;
  /** 结算字段与 WeaponDef 一样（伤害区间、段数、连击、定身、必中、远程、重） */
  min: number;
  max: number;
  hits: number;
  comboBonus: number;
  skipChance: number;
  mustHit: boolean;
  ranged: boolean;
  heavy: boolean;
  skipCause: 'stun' | 'freeze';
  /** 一场最多用几次（爆蛋蛊 3 颗、金色飞刀一次、北冥冰魄爆发一次）；不给 = 不限次 */
  uses?: number;
  /** 段数 = 驭犬蛊带来的狗数（Fighter.pack），不用 hits */
  packHits?: boolean;
}

const move = (id: MoveId, name: string, min: number, max: number, extra: Partial<MoveDef> = {}): MoveDef => ({
  id,
  name,
  min,
  max,
  hits: 1,
  comboBonus: 0,
  skipChance: 0,
  mustHit: false,
  ranged: false,
  heavy: false,
  skipCause: 'stun',
  ...extra,
});

/** 招式表（历练路线 Y0）：宠物的一转蛊 + 对手的招式；起点值按模拟调（任务书 §3 Y0） */
export const MOVES: Record<MoveId, MoveDef> = {
  'gu-dogs': move('gu-dogs', '驭犬蛊', 2, 4, { packHits: true, ranged: true }),
  'gu-crane': move('gu-crane', '纸鹤蛊', 3, 5, { ranged: true }),
  'gu-egg': move('gu-egg', '爆蛋蛊', 10, 14, { mustHit: true, uses: 3 }),
  'dog-bite': move('dog-bite', '扑咬', 2, 4, { hits: 2 }),
  'egg-burst': move('egg-burst', '撞上来炸开', 5, 8, { skipChance: 0.1 }),
  'mastiff-maul': move('mastiff-maul', '扑击', 9, 13, { heavy: true }),
  'han-dogs': move('han-dogs', '驱犬围攻', 3, 5, { hits: 3, ranged: true }),
  'moon-blade': move('moon-blade', '月刃', 6, 10, { ranged: true }),
  'gold-needle': move('gold-needle', '金针', 3, 5, { hits: 3 }),
  'gold-blade': move('gold-blade', '金色飞刀', 17, 23, { mustHit: true, uses: 1 }),
  'ice-blade': move('ice-blade', '冰刃', 3, 6, { hits: 3 }),
  frost: move('frost', '寒气', 5, 8, { skipChance: 0.15, skipCause: 'freeze' }),
  bingpo: move('bingpo', '北冥冰魄爆发', 16, 22, { mustHit: true, uses: 1 }),
};

export const MOVE_IDS = Object.keys(MOVES) as MoveId[];

/**
 * 引擎版本（X5 名帖的 v）：结算规则、图鉴内容变了就 +1。切磋双方在名帖里各带一份，
 * 两边不同就切不了（谁也不知道对方那版引擎会打出什么）。
 */
export const BATTLE_VERSION = 6;

/**
 * 切磋节奏（X23）：切磋 / 隔空只结算 65% 伤害，把「两三手互秒」拉成有来有回的长局。
 * 只影响切磋和隔空，历练、心魔、渡劫照旧按全额算。
 */
export const SPAR_DAMAGE_SCALE = 0.65;

/**
 * 切磋里单次伤害最多打掉目标最大气血的三成（X23）：暴击 / 大招式也不至于一发带走。
 * 只封切磋和隔空，历练、心魔、渡劫不传。
 */
export const SPAR_MAX_HIT_SHARE = 0.3;

/** 主动招式（Action 里允许出现的） */
const ACTIVE_SKILLS: readonly SkillId[] = [
  'bloom',
  'lion-roar',
  'blue-whale',
  'whale-song',
  'ink',
  'whale-gulp',
  'myriad-self',
  'dream-chant',
  'finger-sword',
  'dragon-palm',
  'farewell-wind',
];

/** 会造成伤害的主动招式（X23：切磋里这些必中也能被魂影替） */
const DAMAGING_SKILLS: readonly SkillId[] = [
  'lion-roar',
  'blue-whale',
  'whale-song',
  'whale-gulp',
  'dream-chant',
  'finger-sword',
  'dragon-palm',
  'farewell-wind',
];

export interface Fighter {
  name: string; // 显示用
  hp: number; // 气血上限
  power: number; // 灵力
  agility: number; // 身法
  speed: number; // 遁速
  weapons: WeaponId[];
  skills: SkillId[];
  /** 开打时的气血（秘境里气血跨场保留）：不给 = 满血，夹在 1 到 hp 之间（Y0） */
  hpNow?: number;
  /** 招式表里的编号（对手、一转蛊）；不带时决策随机数的抽取次数和以前一样（Y0） */
  moves?: MoveId[];
  /** 驭犬蛊的狗数（gu-dogs 的段数）；一场里由调用方按驭犬蛊数摆好（Y0） */
  pack?: number;
  /** 秘境加持对战机的修正（Y0）：闪避率加成（闪避上限照旧）、气血低于三成时的伤害倍率 */
  mods?: { dodge?: number; desperate?: number };
  /** 替挡：挨打的前 times 下整下被别人挡掉（定仙游结局白凝冰挡在前面，Y0） */
  guard?: { by: string; times: number };
}

export type Action =
  | { kind: 'weapon'; weapon: WeaponId }
  | { kind: 'unarmed' }
  | { kind: 'skill'; skill: SkillId }
  | { kind: 'move'; move: MoveId };

/** 出手时引擎交给出招者的视野；以后手动对战时界面也从这里取 */
export interface BattleView {
  /** 自己是 0 还是 1 */
  self: 0 | 1;
  hp: [number, number];
  maxHp: [number, number];
  you: {
    weapons: WeaponId[];
    skills: SkillId[];
    /** 这场已经用过的招式（主动的一次性、被动见次数说明） */ used: SkillId[];
    /** 身上的招式（一转蛊 / 对手招式）；不带招式的一方给空数组（Y0） */
    moves?: MoveId[];
    /** 这场用掉的带次数限制的招，每次使用追加一个编号（Y0） */
    moveUses?: MoveId[];
  };
  foe: { weapons: WeaponId[]; skills: SkillId[]; moves?: MoveId[] };
}

export interface Controller {
  decide(view: BattleView): Action;
}

/**
 * 逐手出招（X17）时每一边的出招来源：`'auto'` 走 `autoController`（吃决策随机数），
 * 一串已经定好的 `Action` 则照着出手，用完就停下来等外层补一手。
 */
export type ActionSource = 'auto' | readonly Action[];

/** 逐手对战停在哪个决策点：轮到哪一边、它看到的视野（外层照 `legalActions(view)` 挑下一手） */
export interface DecisionNeed {
  side: 0 | 1;
  view: BattleView;
}

export interface FightUntilDecisionResult {
  /** 已经算出来的事件（停下的那一手还没有 `decide` 事件） */
  events: BattleEvent[];
  /** 打完了是 null；否则是等外层补一手的地方 */
  need: DecisionNeed | null;
}

/** 跳过出手的原因：陀螺 / 狮子吼是晕，雪球是冻住，鲸歌是睡着，魂牵梦绕是入梦，送友风是飘起来，假死遁是躺着装死（X16/X20） */
export type SkipCause = 'stun' | 'freeze' | 'sleep' | 'dream' | 'float' | 'sham';

export type BattleEvent =
  | { actor: 0 | 1; kind: 'start'; hp: [number, number] }
  | { actor: 0 | 1; kind: 'decide'; action: Action; hp: [number, number] }
  | {
      actor: 0 | 1;
      kind: 'hit';
      weapon?: WeaponId;
      /** 用招式表里的招打出的这一下（Y0） */
      move?: MoveId;
      damage: number;
      crit: boolean;
      blocked: boolean;
      /** 鸡毛掸子这一下让对方迟缓了（X8） */
      slowed?: true;
      /** 弹弓这一下打了两颗（X8） */
      twin?: true;
      /** 这一下带着降龙十八掌的后劲（X16） */
      surge?: true;
      hp: [number, number];
    }
  | {
      actor: 0 | 1;
      kind: 'combo';
      weapon?: WeaponId;
      /** 用招式表里的招打出的这一下（Y0） */
      move?: MoveId;
      damage: number;
      crit: boolean;
      blocked: boolean;
      slowed?: true;
      twin?: true;
      /** 这一下带着降龙十八掌的后劲（X16） */
      surge?: true;
      hp: [number, number];
    }
  | { actor: 0 | 1; kind: 'dodge'; hp: [number, number] }
  | { actor: 0 | 1; kind: 'counter'; damage: number; blocked: boolean; hp: [number, number] }
  | { actor: 0 | 1; kind: 'beast'; damage: number; blocked: boolean; hp: [number, number] }
  /** 跳过一次出手；`cause`：陀螺 / 狮子吼是晕（stun），雪球是冻住（freeze），鲸歌是睡着（sleep），魂牵梦绕是入梦（dream） */
  | { actor: 0 | 1; kind: 'skip'; cause?: SkipCause; hp: [number, number] }
  /** 被墨汁糊了眼，这一下打空（X8；actor 是出手的那一方） */
  | { actor: 0 | 1; kind: 'miss'; hp: [number, number] }
  /** 水母分身替挨了这一下（X8；actor 是挨打的那一方） */
  | { actor: 0 | 1; kind: 'decoy'; hp: [number, number] }
  /** 万我的魂影替挨了这一下（X9；actor 是挨打的那一方，同 decoy） */
  | { actor: 0 | 1; kind: 'mirror'; hp: [number, number] }
  /** 别人替挨了这一下（Y0 定仙游结局；actor 是挨打的那一方，by 是替挡者的名字） */
  | { actor: 0 | 1; kind: 'guard'; by: string; hp: [number, number] }
  | { actor: 0 | 1; kind: 'play-dead'; hp: [number, number] }
  | {
      actor: 0 | 1;
      kind: 'skill';
      skill: SkillId;
      damage?: number;
      heal?: number;
      /** 五指拳心剑穿了护体（X9） */
      pierce?: true;
      /** 控制没压住（X20 平衡）：狮子吼 / 鲸歌 / 魂牵梦绕 / 送友风被对方扛住了，这一拍没有跳过 */
      resisted?: true;
      hp: [number, number];
    }
  | { actor: 0 | 1; kind: 'strike'; index: number; damage: number; blocked: boolean; hp: [number, number] }
  | { actor: 0 | 1; kind: 'end'; winner: 0 | 1; reason: 'ko' | 'timeout' | 'farewell'; hp: [number, number] };

/** 一个小 PRNG（sfc32），种子取 sha256 摘要的前 16 字节，不引依赖 */
function sfc32(seed: Buffer): () => number {
  let a = seed.readUInt32LE(0) | 0;
  let b = seed.readUInt32LE(4) | 0;
  let c = seed.readUInt32LE(8) | 0;
  let d = seed.readUInt32LE(12) | 0;
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11) | 0;
    d = (d + 1) | 0;
    const out = (t + d) | 0;
    c = (c + out) | 0;
    return (out >>> 0) / 4294967296;
  };
}

/** 种子 → 随机数序列（sha256 → sfc32）。切磋的解说台词也用它，两边用同一对随机数才挑得出同一句（X12） */
export function rngFrom(seedText: string): () => number {
  return sfc32(createHash('sha256').update(seedText).digest());
}

/**
 * 到达 stage 一共经过几次大境界突破：炼气九层（stage 0–8）之内没有，之后每 3 个小境界一次
 * （进 9 筑基、12 金丹、15 元婴、18 化神、21 炼虚、24 合体、27 大乘）。X1 的正式成长也用它。
 */
export function majorBreaks(stage: number): number {
  return stage < 9 ? 0 : 1 + Math.floor((stage - 9) / 3);
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** 闪避率 = min(35%, 身法 × 1.5% + 化鸽遁 8% + 加持的闪避加成（Y0，上限照旧）) */
function dodgeRate(f: Fighter): number {
  return Math.min(0.35, f.agility * 0.015 + (f.skills.includes('dove') ? 0.08 : 0) + (f.mods?.dodge ?? 0));
}

/** 背水一战（Y0）：气血低于三成的伤害倍率，不带 mods 的一方恒为 1（不改变原来的结算） */
function desperateFactor(f: Fighter, hp: number): number {
  const mult = f.mods?.desperate;
  return mult !== undefined && hp * 10 < f.hp * 3 ? mult : 1;
}

/** 开打时的气血（Y0）：`hpNow` 夹在 1 到上限之间；不给就是满血 */
export function startingHp(f: Fighter): number {
  return f.hpNow === undefined ? f.hp : Math.max(1, Math.min(f.hp, Math.floor(f.hpNow)));
}

/**
 * 切磋不比修为（X20）：两边的境界、属性、法宝和招式件数都拉平，胜负交给招式搭配和临场。
 *
 * 1. 四项属性向中点拉平（`keep` 默认 0 = 完全拉平；留一点差距可传 0–1）；
 * 2. 法宝、招式各按少的一方的件数取齐（多的一方只带最早收齐的那几件）——
 *    高境界多出来的法宝 / 招式本来就是修为攒出来的，不比修为就不能拿件数压人。
 *
 * 名帖照旧带真实属性（给擂台名牌、境界上限校验用）；演出的气血也用拉平后的这一对。
 * 不拉平的话，模拟里高一个大境界胜率约 0.75，高五个大境界约 0.85 以上。
 */
export function fairSparPair(a: Fighter, b: Fighter, keep = 0): [Fighter, Fighter] {
  const level = (x: number, y: number): [number, number] => {
    const mid = (x + y) / 2;
    const half = ((x - y) * keep) / 2;
    return [Math.max(1, Math.round(mid + half)), Math.max(1, Math.round(mid - half))];
  };
  const [hpA, hpB] = level(a.hp, b.hp);
  const [powerA, powerB] = level(a.power, b.power);
  const [agilityA, agilityB] = level(a.agility, b.agility);
  const [speedA, speedB] = level(a.speed, b.speed);
  const weapons = Math.min(a.weapons.length, b.weapons.length);
  const skills = Math.min(a.skills.length, b.skills.length);
  return [
    {
      ...a,
      hp: hpA,
      power: powerA,
      agility: agilityA,
      speed: speedA,
      weapons: a.weapons.slice(0, weapons),
      skills: a.skills.slice(0, skills),
    },
    {
      ...b,
      hp: hpB,
      power: powerB,
      agility: agilityB,
      speed: speedB,
      weapons: b.weapons.slice(0, weapons),
      skills: b.skills.slice(0, skills),
    },
  ];
}

interface Side {
  f: Fighter;
  hp: number;
  /** 下次出手时刻（时间轴） */
  next: number;
  /** 下一次出手是否被定住跳过 */
  skip: boolean;
  /** 刚被控住、还没出手（X20）：这期间再吃控制一律不生效，防止连控成锁 */
  controlled: boolean;
  /** 跳过的原因（演出与解说用）：晕、冻住、睡着、被魂牵梦绕牵进梦里 */
  skipCause: SkipCause;
  /** 墨汁：接下来还有几次出手被糊着眼 */
  blind: number;
  /** 万我：还剩几重魂影能替自己挨打（X9） */
  mirror: number;
  used: Set<SkillId>;
  /** 泡泡护体这场还能挡几次 */
  bubbles: number;
  /** 灵兽还跟着出几次手 */
  beastLeft: number;
  /** 这场用掉的次数（Y0：`uses` 限制的招，按编号计） */
  moveUses: Map<MoveId, number>;
  /** 替挡还剩几下（Y0） */
  guardLeft: number;
  /** 降龙十八掌的后劲还挂着（X16）：下一次法宝 / 空手出手的第一下打中时加伤，打空就作废 */
  surge: boolean;
}

function makeSide(f: Fighter, initialDelay: number): Side {
  return {
    f,
    hp: startingHp(f),
    next: (100 / (f.speed + 10)) * initialDelay,
    skip: false,
    controlled: false,
    skipCause: 'stun',
    blind: 0,
    mirror: 0,
    used: new Set(),
    bubbles: f.skills.includes('bubble') ? 2 : 0,
    beastLeft: f.skills.includes('spirit-beast') ? 3 : 0,
    moveUses: new Map(),
    guardLeft: f.guard ? f.guard.times : 0,
    surge: false,
  };
}

function intervalOf(s: Side): number {
  return 100 / (s.f.speed + 10);
}

function hpPair(a: Side, b: Side): [number, number] {
  return [a.hp, b.hp];
}

/**
 * 结算一次伤害：泡泡护体挡一半（向下取整），致命一击被假死遁救下时留 1 点（一场一次）。
 * `pierce`（X9 的五指拳心剑）：穿护体——不消耗泡泡、也不打折。
 */
function applyDamage(
  target: Side,
  raw: number,
  opts: { pierce?: boolean } = {},
): { damage: number; blocked: boolean; playDead: boolean } {
  let damage = raw;
  const blocked = !opts.pierce && target.bubbles > 0;
  if (blocked) {
    target.bubbles -= 1;
    damage = Math.floor(damage * BUBBLE_FACTOR);
  }
  const before = target.hp;
  target.hp = Math.max(0, target.hp - damage);
  if (target.hp === 0 && before > 0 && target.f.skills.includes('play-dead') && !target.used.has('play-dead')) {
    target.hp = 1;
    target.used.add('play-dead');
    // 装死要躺一拍才爬起来（X20 平衡）：不然这一场凭空多一整手，持有方胜率一直顶在 0.65
    target.skip = true;
    target.skipCause = 'sham';
    return { damage, blocked, playDead: true };
  }
  return { damage, blocked, playDead: false };
}

/**
 * 一次出手（法宝或招式）的结算口径。把 `WeaponDef` 和 `MoveDef` 收成同一张形状，
 * attack() 里只认这些字段（法宝另有 slow / returnSure / twinChance，招式没有 = 不生效）。
 */
interface AttackSpec {
  id: WeaponId | MoveId;
  /** 招式表里的招（事件里记 `move` 而不是 `weapon`） */
  isMove: boolean;
  min: number;
  max: number;
  /** 段数：招式带 packHits 时是驭犬蛊的狗数（Fighter.pack，至少 1） */
  hits: number;
  comboBonus: number;
  skipChance: number;
  skipCause: SkipCause;
  mustHit: boolean;
  ranged: boolean;
  heavy: boolean;
  slow: boolean;
  returnSure: boolean;
  twinChance: number;
}

function specOf(action: Extract<Action, { kind: 'weapon' | 'move' }>, pack: number | undefined): AttackSpec {
  if (action.kind === 'weapon') {
    const w = WEAPONS[action.weapon];
    return {
      id: w.id,
      isMove: false,
      min: w.min,
      max: w.max,
      hits: w.hits,
      comboBonus: w.comboBonus,
      skipChance: w.skipChance,
      skipCause: w.skipCause,
      mustHit: w.mustHit,
      ranged: w.ranged,
      heavy: w.heavy,
      slow: w.slow,
      returnSure: w.returnSure,
      twinChance: w.twinChance,
    };
  }
  const m = MOVES[action.move];
  return {
    id: m.id,
    isMove: true,
    min: m.min,
    max: m.max,
    hits: m.packHits ? Math.max(1, Math.floor(pack ?? 1)) : m.hits,
    comboBonus: m.comboBonus,
    skipChance: m.skipChance,
    skipCause: m.skipCause,
    mustHit: m.mustHit,
    ranged: m.ranged,
    heavy: m.heavy,
    slow: false,
    returnSure: false,
    twinChance: 0,
  };
}

/** 主动招式与部分被动的次数说明见 SKILLS 表；autoController 的策略写在任务书 §X0、招式部分见 §3 Y0 */

export function autoController(rng: () => number): Controller {
  return {
    decide(view: BattleView): Action {
      const hp = view.hp[view.self];
      const maxHp = view.maxHp[view.self];
      const foeSide = view.self === 0 ? 1 : 0;
      const foeHp = view.hp[foeSide];
      const foeMax = view.maxHp[foeSide];
      const unused = view.you.skills.filter((s) => ACTIVE_SKILLS.includes(s) && !view.you.used.includes(s));
      if (unused.includes('bloom') && hp * 2 < maxHp) return { kind: 'skill', skill: 'bloom' };
      // 鲸吞带回血：气血低于七成时先用
      if (unused.includes('whale-gulp') && hp * 10 < maxHp * 7) return { kind: 'skill', skill: 'whale-gulp' };
      // 五指拳心剑收人头（X9）：对方剩不到三成半就捅
      if (unused.includes('finger-sword') && foeHp * 100 < foeMax * 35) return { kind: 'skill', skill: 'finger-sword' };
      // 魂牵梦绕先把入梦挂上（X9）：对方还满着就先念咒
      if (unused.includes('dream-chant') && foeHp * 10 > foeMax * 7) return { kind: 'skill', skill: 'dream-chant' };
      const actives = unused.filter((s) => s !== 'bloom');
      if (actives.length > 0 && rng() < 0.25) return { kind: 'skill', skill: pick(rng, actives) };
      // 招式（Y0）：只在身上有招时才多抽随机数——不带 moves 的 Fighter，决策抽取次数和以前一样
      const moves = view.you.moves ?? [];
      if (moves.length > 0) {
        const used = view.you.moveUses ?? [];
        // 有次数限制的招：每次 35% 用，用完为止
        const limited = moves.filter((id) => {
          const cap = MOVES[id].uses;
          return cap !== undefined && used.filter((x) => x === id).length < cap;
        });
        if (limited.length > 0 && rng() < 0.35) return { kind: 'move', move: pick(rng, limited) };
        const rest = moves.filter((id) => MOVES[id].uses === undefined);
        // 只有招、没有法宝（对手、压境入内的宠物）：驭犬蛊每次都用，别的招 80% 用、20% 空手
        if (view.you.weapons.length === 0) {
          if (rest.includes('gu-dogs')) return { kind: 'move', move: 'gu-dogs' };
          if (rest.length > 0 && rng() < 0.8) return { kind: 'move', move: pick(rng, rest) };
          return { kind: 'unarmed' };
        }
        // 其余的招和法宝放在一起随机挑（20% 空手，和只有法宝时同口径）
        const pool: Action[] = [
          ...view.you.weapons.map((w): Action => ({ kind: 'weapon', weapon: w })),
          ...rest.map((m): Action => ({ kind: 'move', move: m })),
        ];
        if (rng() >= 0.2) return pick(rng, pool);
        return { kind: 'unarmed' };
      }
      if (view.you.weapons.length > 0 && rng() >= 0.2) return { kind: 'weapon', weapon: pick(rng, view.you.weapons) };
      return { kind: 'unarmed' };
    },
  };
}

/** 出手满这么多还没分出胜负就按剩余气血比例判 */
export const MAX_ACTIONS = 30;

/**
 * 这一手能出什么（X17）：自有法宝、空手、还没用过的主动招式、还有次数的招式表招式。
 * AI 和手动点招、X19 收到的对方出手都先过这里；不合法就当没选。
 */
export function legalActions(view: BattleView): Action[] {
  const actions: Action[] = view.you.weapons.map((weapon): Action => ({ kind: 'weapon', weapon }));
  actions.push({ kind: 'unarmed' });
  for (const skill of view.you.skills) {
    if (ACTIVE_SKILLS.includes(skill) && !view.you.used.includes(skill)) actions.push({ kind: 'skill', skill });
  }
  const used = view.you.moveUses ?? [];
  for (const move of view.you.moves ?? []) {
    const cap = MOVES[move].uses;
    const count = used.filter((id) => id === move).length;
    if (cap === undefined || count < cap) actions.push({ kind: 'move', move });
  }
  return actions;
}

/**
 * 后备挑法（X17）：AI 超时 / 答不出合法的招、手动没点时的这一手。
 * 随机数单独一路（`seed:fallback:index`），不吃决策随机数——从头重算时对面的挑法不会跟着变。
 */
export function fallbackAction(view: BattleView, seed: string, index: number): Action {
  return autoController(rngFrom(`${seed}:fallback:${index}`)).decide(view);
}
/** 基础会心率（会心一击的持有者是 CRIT_SKILL_CHANCE） */
const BASE_CRIT = 0.08;
/** 灵力对伤害的加成比例（整段出手合计） */
const POWER_FACTOR = 0.75;
/**
 * 渡劫：单道天雷伤害 ≈ 典型气血 ÷ 雷数 ×（TRIBULATION_BASE + 境界 × TRIBULATION_STEP）。
 * X4 落地后按正式成长（fighterAt 同口径）对七个渡劫分界重标过（2026-10-25）：
 * 旧值 0.54 / 0.024 / 0.35 下成功率 0.30–0.72 不齐（早期偏难），调后不吃丹全站 0.59–0.67、吃丹 0.83–0.89。
 * X8 招式表从 10 个扩到 14 个（2026-10-26）：同样四五次二选一，攒到泡泡 / 化鸽 / 假死 / 生花这几门防身的
 * 概率变低，后期偏难（不吃丹 0.44–0.59）；网格重标为 0.47 / 0.0198 / 0.002 / 0.368，七站不吃丹 0.59–0.70、吃丹 0.83–0.91。
 * X16 招式表再扩到 19 门（降龙十八掌、送友风）：后期攒到防身招式的概率又被摊薄，不吃丹掉到 0.52–0.66；
 * 重扫七个分界后把炼虚往上的附加斜率改成 -0.0065（仍是随境界涨，只是涨得慢一些），
 * 现值为 0.47 / 0.0198 / -0.0065 / 0.368，七站不吃丹 0.55–0.71、吃丹 0.86–0.90。
 */
const TRIBULATION_BASE = 0.47;
const TRIBULATION_STEP = 0.0198;
/** 炼虚往上的附加斜率（X16 起为负）：技能攒得全，单道雷随境界涨得慢一些 */
const TRIBULATION_LATE_STEP = -0.0065;
/** 渡劫：单道雷按渡劫者自身气血加成的比例（吃丹加的血也走这里，丹的收益不至于陡成必过） */
const TRIBULATION_HP_CUT = 0.368;
/** 破势：伤害里随防守方气血上限加成的比例 */
const HP_BONUS = 0.25;
const CRIT_SKILL_CHANCE = 0.18;
/** 狮子吼伤害里吃的破势份额（蓝鲸吃整份） */
const LION_HP_SHARE = 0.6;
/** 狮子吼的伤害基数（X20 从 15 提到 22：控制改成有几率以后，这一招不能比普通攻击还弱） */
const LION_BASE = 22;
/** 蓝鲸现世在切磋里的额外收束（X23）：原式 34 + 灵力 + 整份破势，缩放后仍常顶满 30% 单次封顶 */
const BLUE_WHALE_SPAR_SHARE = 0.75;

/** 泡泡护体挡伤后剩下的比例（§平衡：X20 从 0.55 提到 0.78，把这一招的持有优势收回 0.6 以内） */
const BUBBLE_FACTOR = 0.78;
/** 第六感的反击概率（§平衡；X20 从 0.28 提到 0.45） */
const SIXTH_SENSE_CHANCE = 0.45;
/**
 * 控制（让对方跳过下一次出手）的命中判定（X20 平衡）。以前狮子吼 / 鲸歌 / 魂牵梦绕 / 送友风
 * 都是无条件生效，手动出招时先出手的一方把四招连着放，对面一拍都出不了，谁先手谁赢；
 * 现在改成：基础几率 + 灵力压身法（每差 1 点 2%），夹在 25%–85%。
 * 另外刚被控过、还没出手的一方一律控不住（`Side.controlled`）——最多控一拍、放一拍，连不成锁。
 */
const CONTROL_POWER_STEP = 0.02;
const CONTROL_MIN = 0.25;
const CONTROL_MAX = 0.85;
/** 几个控制招式的基础几率：狮子吼、鲸歌、魂牵梦绕、送友风都先出伤害，再判这一下控不控得住 */
const CONTROL_BASE: Partial<Record<SkillId, number>> = {
  'lion-roar': 0.6,
  'whale-song': 0.75,
  'dream-chant': 0.55,
  'farewell-wind': 0.65,
};

/** 连击：同一回合最多再补这么次数 */
const MAX_COMBOS = 2;
/** 墨汁糊眼：dodgeRoll 落在这以上就打空（五成半） */
const BLIND_MISS_FROM = 0.45;
/** 墨汁糊眼管几次出手 */
const INK_TURNS = 3;
/** 水母分身：counterRoll 落在这以上就打在分身上（一成） */
const DECOY_FROM = 0.9;
/** 鸡毛掸子：对方下次出手往后推的比例（出手间隔的一半 → X20 收到 0.35） */
const SLOW_FACTOR = 0.35;
/** 重（鲸尾 / 扑击）：出手间隔的倍数（X20 从 1.2 收到 1.15） */
const HEAVY_FACTOR = 1.15;
/** 鲸吞伤害里吃的破势份额 */
const GULP_HP_SHARE = 0.5;
/**
 * 魂牵梦绕伤害里吃的破势份额（X9）。起点是 20 + 破势×0.8，实测持有方胜率 0.70（上限 0.65）——
 * 大伤害＋入梦（白送一拍）叠在一起太强，按扫描降到 14 + 破势×0.5，落在 0.61。
 */
const CHANT_HP_SHARE = 0.5;
/** 五指拳心剑伤害里吃的破势份额（X9） */
const FIST_HP_SHARE = 0.8;
/** 万我：分出几重魂影（X9；用户选了 3 重，再往上就是「七重战神」） */
const MYRIAD_MIRRORS = 3;
/** 鲸歌（X20）：几声低吟带着灵压，伤害基数、灵力与破势份额 */
const WHALE_SONG_BASE = 16;
const WHALE_SONG_HP_SHARE = 0.3;
/** 降龙十八掌（X16）：必中伤害基数、吃的破势份额、后劲的固定与灵力份额；X20 基数 15→28、后劲 4→10 */
const DRAGON_PALM_BASE = 28;
const DRAGON_PALM_HP_SHARE = 0.6;
const DRAGON_SURGE_BASE = 10;
const DRAGON_SURGE_POWER = 0.25;
/** 送友风（X16）：必中伤害基数、吃的破势份额；X20 基数 12→18 */
const FAREWELL_BASE = 18;
const FAREWELL_HP_SHARE = 0.4;
/**
 * 串门切磋里送友风打中后把对方送走的概率（X16）。起点 0.3；battle-sim 的「送友风（串门）」
 * 超过 0.65 就往下调（数值记在 X16 的落地情况里）。
 */
export const FAREWELL_SEND_CHANCE = 0.3;

/** 一场对战的额外开关（X16）：`farewell` 只在串门切磋里传，隔空 / 心魔 / 秘境 / 渡劫都不传 */
export interface FightOptions {
  /** 送友风打中、对方还活着时，按 `FAREWELL_SEND_CHANCE` 抽一签把对方送走 */
  farewell?: boolean;
  /** 伤害整体乘这个系数（X23 切磋节奏）；不传按 1，历练 / 心魔 / 渡劫不受影响 */
  damageScale?: number;
  /** 单次伤害最多打掉目标最大气血的几成（X23 切磋）；不传不封顶 */
  maxHitShare?: number;
}

export function fight(
  a: Fighter,
  b: Fighter,
  seed: string,
  controllers?: [Controller, Controller],
  options?: FightOptions,
): BattleEvent[] {
  if (!controllers) {
    const decideRng = rngFrom(seed + ':decide');
    controllers = [autoController(decideRng), autoController(decideRng)];
  }
  return runFight(a, b, seed, controllers, options);
}

/** 一次「要决策但那一串已经用完」的信号（只在 fightUntilDecision 内部抛，不落到外层） */
class DecisionNeeded {
  readonly need: DecisionNeed;
  constructor(need: DecisionNeed) {
    this.need = need;
  }
}

/**
 * 逐手对战（X17）：照「重放到缺决策处」的走法，`fight` 保持同步、纯函数。
 * 两边都是 `'auto'` 时和 `fight()` 打出同一串事件；某一边是一串定好的 `Action` 时，
 * 轮到它、那串用完就停下返回 `need`，外层把这一手补进那一串、**从头再算一遍**。
 */
export function fightUntilDecision(
  a: Fighter,
  b: Fighter,
  seed: string,
  sources: readonly [ActionSource, ActionSource],
  options?: FightOptions,
): FightUntilDecisionResult {
  const decideRng = rngFrom(seed + ':decide');
  let need: DecisionNeed | null = null;
  const controllers = sources.map((source, side): Controller => {
    if (source === 'auto') return autoController(decideRng);
    let index = 0;
    return {
      decide(view: BattleView): Action {
        if (index >= source.length) {
          need = { side: side as 0 | 1, view };
          throw new DecisionNeeded(need);
        }
        return source[index++];
      },
    };
  }) as [Controller, Controller];
  const events: BattleEvent[] = [];
  try {
    runFight(a, b, seed, controllers, options, events);
  } catch (error) {
    if (error instanceof DecisionNeeded) return { events, need };
    throw error;
  }
  return { events, need: null };
}

function runFight(
  a: Fighter,
  b: Fighter,
  seed: string,
  controllers: [Controller, Controller],
  options?: FightOptions,
  events: BattleEvent[] = [],
): BattleEvent[] {
  // 结算随机数只由种子决定，是这一场内部的局部状态
  const rng = rngFrom(seed + ':resolve');
  // 切磋节奏（X23）：所有落到气血上的伤害先过这一道；不传时原样返回，PvE 结算不变
  const damageScale = options?.damageScale ?? 1;
  const maxHitShare = options?.maxHitShare;
  const sparRules = damageScale !== 1 || maxHitShare !== undefined;
  const scaleDamage = (raw: number, target: Side): number => {
    if (raw <= 0) return raw;
    const scaled = Math.max(1, Math.floor(raw * damageScale));
    if (maxHitShare === undefined || maxHitShare <= 0) return scaled;
    return Math.min(scaled, Math.max(1, Math.floor(target.f.hp * maxHitShare)));
  };
  const scaledApplyDamage = (target: Side, raw: number, opts: { pierce?: boolean } = {}) =>
    applyDamage(target, scaleDamage(raw, target), opts);
  // 送走用单独一条种子流（X16）：只在串门切磋里送友风打中时抽，不挪结算序列
  const farewellRng = options?.farewell ? rngFrom(seed + ':farewell') : null;
  const sides = [makeSide(a, 0.8 + 0.4 * rng()), makeSide(b, 0.8 + 0.4 * rng())];
  events.push({ actor: 0, kind: 'start', hp: [sides[0].hp, sides[1].hp] });

  const view = (self: 0 | 1): BattleView => {
    const me = sides[self];
    const foe = sides[self ^ 1];
    return {
      self,
      hp: [sides[0].hp, sides[1].hp],
      maxHp: [sides[0].f.hp, sides[1].f.hp],
      you: {
        weapons: me.f.weapons,
        skills: me.f.skills,
        used: [...me.used],
        ...(me.f.moves ? { moves: me.f.moves } : {}),
        ...(me.moveUses.size > 0
          ? {
              moveUses: [...me.moveUses.entries()].flatMap(([id, n]) => Array<MoveId>(n).fill(id)),
            }
          : {}),
      },
      foe: { weapons: foe.f.weapons, skills: foe.f.skills, ...(foe.f.moves ? { moves: foe.f.moves } : {}) },
    };
  };

  /** 对方睡着 / 被牵进梦里 / 被送友风吹得飘起来：这会儿挨的攻击都不判闪避 */
  const asleep = (side: Side): boolean =>
    side.skip && (side.skipCause === 'sleep' || side.skipCause === 'dream' || side.skipCause === 'float');

  /** 控制判定（X20）：刚被控过、还没出手的不再吃控；否则按基础几率 + 灵力压身法抽一签 */
  const controlLands = (self: 0 | 1, skill: SkillId): boolean => {
    const me = sides[self];
    const foe = sides[self ^ 1];
    if (foe.controlled) return false;
    const chance = Math.min(
      CONTROL_MAX,
      Math.max(CONTROL_MIN, (CONTROL_BASE[skill] ?? 0.5) + (me.f.power - foe.f.agility) * CONTROL_POWER_STEP),
    );
    return rng() < chance;
  };

  /** 控住：对方跳过下一次出手，并记下「还没出手、这期间不再吃控」 */
  const control = (self: 0 | 1, cause: SkipCause): void => {
    const foe = sides[self ^ 1];
    foe.skip = true;
    foe.skipCause = cause;
    foe.controlled = true;
  };

  /**
   * 一次攻击（法宝、招式或空手）：命中、会心、连击、定身、反击、灵兽、替挡都从这进。
   * @param blinded 这次出手被墨汁糊着眼（X8）：每一下有一半打空
   */
  const attack = (
    self: 0 | 1,
    action: Extract<Action, { kind: 'weapon' | 'move' | 'unarmed' }>,
    blinded: boolean,
  ): void => {
    const me = sides[self];
    const foe = sides[self ^ 1];
    const spec = action.kind === 'unarmed' ? null : specOf(action, me.f.pack);
    const comboCap = MAX_COMBOS;
    let combos = 0;
    const hits = spec ? spec.hits : 1;
    // 降龙十八掌的后劲只跟法宝 / 空手走（X16）；招式表里的招和别的主动招式不消耗它
    const surgeArmed = me.surge && (action.kind === 'weapon' || action.kind === 'unarmed');
    for (let hit = 0; hit < hits + combos && foe.hp > 0; hit++) {
      // 后劲只加在这一手的第一下：打空 / 被闪避 / 打分身 / 魂影 / 替挡都算没打中，直接作废
      const surgeHere = surgeArmed && hit === 0;
      if (surgeHere) me.surge = false;
      // 每次挥击固定抽满六个，抽了不用的也抽：换出招者不挪动结算序列
      const dodgeRoll = rng();
      const dmgRoll = rng();
      const critRoll = rng();
      const comboRoll = rng();
      const skipRoll = rng();
      const counterRoll = rng();
      // 墨汁糊眼：打空用 dodgeRoll 的高段（闪避用的是低段，互不重叠；不新增抽签）
      if (blinded && dodgeRoll >= BLIND_MISS_FROM) {
        events.push({ actor: self, kind: 'miss', hp: hpPair(sides[0], sides[1]) });
        continue;
      }
      // 必中：烟花；银托盘最后一段从背后回旋磕过来；对方睡着 / 入梦
      const sure = spec?.mustHit || (spec?.returnSure && hit === hits - 1) || asleep(foe);
      if (!sure && dodgeRoll < dodgeRate(foe.f)) {
        events.push({ actor: (self ^ 1) as 0 | 1, kind: 'dodge', hp: hpPair(sides[0], sides[1]) });
        continue;
      }
      // 万我的魂影（X9）：替本体挨这一下。X23 切磋里必中也能替；PvE 必中仍打本体
      if ((sparRules || !sure) && foe.mirror > 0) {
        foe.mirror -= 1;
        events.push({ actor: (self ^ 1) as 0 | 1, kind: 'mirror', hp: hpPair(sides[0], sides[1]) });
        continue;
      }
      // 水母分身：counterRoll 的高段（反击用低段；分身作废后本来就不判反击）
      if (foe.f.skills.includes('jelly-clone') && counterRoll >= DECOY_FROM) {
        events.push({ actor: (self ^ 1) as 0 | 1, kind: 'decoy', hp: hpPair(sides[0], sides[1]) });
        continue;
      }
      // 替挡（Y0）：挨打的前 times 下整下替掉——不掉血、不消耗泡泡、不判反击（不新增抽签）
      if (foe.guardLeft > 0) {
        foe.guardLeft -= 1;
        events.push({
          actor: (self ^ 1) as 0 | 1,
          kind: 'guard',
          by: foe.f.guard?.by ?? '',
          hp: hpPair(sides[0], sides[1]),
        });
        continue;
      }
      let base = spec ? randBetween(dmgRoll, spec.min, spec.max) : randBetween(dmgRoll, 3, 6);
      // 弹弓一发打两颗：用 skipRoll（弹弓没有定身），第二颗的点数由 dmgRoll 派生（不新增抽签）
      const twin = !!spec && spec.twinChance > 0 && skipRoll < spec.twinChance;
      if (twin && spec) base += randBetween((dmgRoll * 7.31) % 1, spec.min, spec.max);
      // 灵力和破势（伤害随对手气血上限加成，§平衡：不然境界高一线、血厚一线就接近稳赢）
      // 都是整段出手合计一份，多段法宝每段按段数分摊（否则一次三张/三件会吃成三倍）
      const perPiece = Math.floor((me.f.power * POWER_FACTOR + foe.f.hp * HP_BONUS) / (spec?.hits ?? 1));
      let damage = base + perPiece;
      // 会心：人人有个基础会心率，会心一击把它提到 10%（§平衡：加方差，免得境界高一线就稳赢）
      const critChance = me.f.skills.includes('critical') ? CRIT_SKILL_CHANCE : BASE_CRIT;
      const crit = critRoll < critChance;
      if (crit) damage *= 2;
      // 背水一战（Y0）：自己气血低于三成时这一段伤害翻倍率（不带 mods 时 ×1，结算不变）
      const desperate = desperateFactor(me.f, me.hp);
      if (desperate !== 1) damage = Math.floor(damage * desperate);
      // 亢龙有悔的后劲（X16）：这一下打中才加，加在会心 / 背水之后
      if (surgeHere) damage += DRAGON_SURGE_BASE + Math.floor(me.f.power * DRAGON_SURGE_POWER);
      const applied = scaledApplyDamage(foe, damage);
      const kind = hit < hits ? 'hit' : 'combo';
      // 鸡毛掸子：打中（含被泡泡挡下）就笑岔气，对方下次出手往后推半个间隔
      const slowed = !!spec?.slow && foe.hp > 0;
      if (slowed) foe.next += intervalOf(foe) * SLOW_FACTOR;
      events.push({
        actor: self,
        kind,
        ...(spec ? (spec.isMove ? { move: spec.id as MoveId } : { weapon: spec.id as WeaponId }) : {}),
        damage: applied.damage,
        crit,
        blocked: applied.blocked,
        ...(slowed ? { slowed: true as const } : {}),
        ...(twin ? { twin: true as const } : {}),
        ...(surgeHere ? { surge: true as const } : {}),
        hp: hpPair(sides[0], sides[1]),
      });
      if (applied.playDead)
        events.push({ actor: (self ^ 1) as 0 | 1, kind: 'play-dead', hp: hpPair(sides[0], sides[1]) });
      // 定身（陀螺是晕，雪球是冻住）：刚被控过、还没出手的不再吃控（X20，防连控成锁）
      if (spec && spec.skipChance > 0 && !foe.controlled && skipRoll < spec.skipChance) {
        control(self, spec.skipCause);
      }
      // 反击：远程、灵兽和反击本身不会被反击
      if (!spec?.ranged && foe.hp > 0 && foe.f.skills.includes('sixth-sense') && counterRoll < SIXTH_SENSE_CHANCE) {
        const counterDmg = randBetween(rng(), 3, 6) + Math.floor(foe.f.power * POWER_FACTOR);
        const back = scaledApplyDamage(me, counterDmg);
        events.push({
          actor: (self ^ 1) as 0 | 1,
          kind: 'counter',
          damage: back.damage,
          blocked: back.blocked,
          hp: hpPair(sides[0], sides[1]),
        });
        if (back.playDead) events.push({ actor: self, kind: 'play-dead', hp: hpPair(sides[0], sides[1]) });
      }
      // 连击：打中后才判，最多 MAX_COMBOS 次
      if (
        foe.hp > 0 &&
        combos < comboCap &&
        hit + 1 >= hits &&
        comboRoll <
          Math.min(0.3, me.f.agility * 0.01) +
            (spec?.comboBonus ?? 0) +
            (me.f.skills.includes('shadow-fists') ? 0.15 : 0)
      ) {
        combos += 1;
      }
    }
    // 灵兽：自己前几次出手后追加一击（可被闪避，不会被反击）
    if (me.beastLeft > 0 && foe.hp > 0) {
      me.beastLeft -= 1;
      const dodgeRoll = rng();
      const dmgRoll = rng();
      if (asleep(foe) || !(dodgeRoll < dodgeRate(foe.f))) {
        const applied = scaledApplyDamage(foe, randBetween(dmgRoll, 4, 7));
        events.push({
          actor: self,
          kind: 'beast',
          damage: applied.damage,
          blocked: applied.blocked,
          hp: hpPair(sides[0], sides[1]),
        });
        if (applied.playDead)
          events.push({ actor: (self ^ 1) as 0 | 1, kind: 'play-dead', hp: hpPair(sides[0], sides[1]) });
      } else {
        events.push({ actor: (self ^ 1) as 0 | 1, kind: 'dodge', hp: hpPair(sides[0], sides[1]) });
      }
    }
  };

  /** 出招者交代的动作不合法（没有的法宝 / 招式、用过的主动招式）时按空手处理 */
  const legalize = (me: Side, action: Action): Action => {
    if (action.kind === 'weapon' && me.f.weapons.includes(action.weapon)) return action;
    if (action.kind === 'move' && me.f.moves?.includes(action.move)) {
      const cap = MOVES[action.move].uses;
      const used = me.moveUses.get(action.move) ?? 0;
      if (cap === undefined || used < cap) return action;
      return { kind: 'unarmed' }; // 次数用完：按空手处理
    }
    if (
      action.kind === 'skill' &&
      me.f.skills.includes(action.skill) &&
      ACTIVE_SKILLS.includes(action.skill) &&
      !me.used.has(action.skill)
    ) {
      return action;
    }
    return { kind: 'unarmed' };
  };

  /** 送友风把对方送走了（X16）：这一场到此为止，`end` 已经推进事件里，不再排后面的事件 */
  let farewellEnd = false;

  /** 一次出手（含主动招式），返回实际执行的动作；凭空生花的「马上再出手一次」在里面就地补一次 */
  const takeAction = (self: 0 | 1): Action => {
    const me = sides[self];
    const asked = controllers[self].decide(view(self));
    const action = legalize(me, asked);
    events.push({ actor: self, kind: 'decide', action, hp: hpPair(sides[0], sides[1]) });
    // 墨汁：糊着眼的这次出手用掉一次（放招式也算一次，只是招式不受影响）
    const blinded = me.blind > 0;
    if (blinded) me.blind -= 1;
    // 招式（Y0）：记账用了几次，然后和法宝走同一条结算路
    if (action.kind === 'move') {
      me.moveUses.set(action.move, (me.moveUses.get(action.move) ?? 0) + 1);
      attack(self, action, blinded);
    } else if (action.kind === 'skill') {
      me.used.add(action.skill);
      const foe = sides[self ^ 1];
      // X23：切磋里主动招式也能被魂影替；只挡会造成伤害的招式，buff / 回血不挡
      if (sparRules && foe.mirror > 0 && DAMAGING_SKILLS.includes(action.skill)) {
        foe.mirror -= 1;
        events.push({ actor: (self ^ 1) as 0 | 1, kind: 'mirror', hp: hpPair(sides[0], sides[1]) });
        return action;
      }
      if (action.skill === 'bloom') {
        const heal = Math.ceil((me.f.hp * 18) / 100);
        me.hp = Math.min(me.f.hp, me.hp + heal);
        events.push({ actor: self, kind: 'skill', skill: 'bloom', heal, hp: hpPair(sides[0], sides[1]) });
        return takeAction(self); // 马上再出手一次（凭空生花已用过，再要也只是空手）
      }
      if (action.skill === 'lion-roar') {
        // 狮子吼的音波也算破势的一环，伤害吃半份破势（§平衡：主动招式别比普通攻击还弱）
        const applied = scaledApplyDamage(foe, LION_BASE + Math.floor((foe.f.hp * HP_BONUS * LION_HP_SHARE) / 1));
        const landed = foe.hp > 0 && controlLands(self, 'lion-roar');
        if (landed) control(self, 'stun');
        events.push({
          actor: self,
          kind: 'skill',
          skill: 'lion-roar',
          damage: applied.damage,
          ...(foe.hp > 0 && !landed ? { resisted: true as const } : {}),
          hp: hpPair(sides[0], sides[1]),
        });
        if (applied.playDead)
          events.push({ actor: (self ^ 1) as 0 | 1, kind: 'play-dead', hp: hpPair(sides[0], sides[1]) });
      }
      if (action.skill === 'blue-whale') {
        // 约一次满额法宝攻击的 1.5–2 倍：固定伤害 + 灵力 + 整份破势；切磋里再收 25%（X23）
        const raw = 34 + me.f.power + Math.floor(foe.f.hp * HP_BONUS);
        const applied = scaledApplyDamage(foe, sparRules ? Math.floor(raw * BLUE_WHALE_SPAR_SHARE) : raw);
        events.push({
          actor: self,
          kind: 'skill',
          skill: 'blue-whale',
          damage: applied.damage,
          hp: hpPair(sides[0], sides[1]),
        });
        if (applied.playDead)
          events.push({ actor: (self ^ 1) as 0 | 1, kind: 'play-dead', hp: hpPair(sides[0], sides[1]) });
      }
      if (action.skill === 'whale-song') {
        // 鲸歌：几声低吟带着灵压，-伤害；控住就睡着，跳过下一次出手（睡着期间挨的攻击都不判闪避）。
        // X20 改成有几率以后补了一点伤害，没控住（或没哄睡）也不至于白费一整手
        const applied = scaledApplyDamage(
          foe,
          WHALE_SONG_BASE +
            Math.floor(me.f.power * POWER_FACTOR * 0.6) +
            Math.floor(foe.f.hp * HP_BONUS * WHALE_SONG_HP_SHARE),
        );
        const landed = foe.hp > 0 && controlLands(self, 'whale-song');
        if (landed) control(self, 'sleep');
        // 没哄睡也别白放：听着犯困，出手慢半拍（X20）
        else if (foe.hp > 0) foe.next += intervalOf(foe) * SLOW_FACTOR;
        events.push({
          actor: self,
          kind: 'skill',
          skill: 'whale-song',
          damage: applied.damage,
          ...(foe.hp > 0 && !landed ? { resisted: true as const } : {}),
          hp: hpPair(sides[0], sides[1]),
        });
        if (applied.playDead)
          events.push({ actor: (self ^ 1) as 0 | 1, kind: 'play-dead', hp: hpPair(sides[0], sides[1]) });
      }
      if (action.skill === 'ink') {
        // 墨汁喷射：对方接下来两次出手糊着眼
        foe.blind = INK_TURNS;
        events.push({ actor: self, kind: 'skill', skill: 'ink', hp: hpPair(sides[0], sides[1]) });
      }
      if (action.skill === 'whale-gulp') {
        // 鲸吞：伤害吃半份破势，回复实际伤害的一半（不超上限）
        const applied = scaledApplyDamage(
          foe,
          18 + Math.floor(me.f.power * POWER_FACTOR) + Math.floor(foe.f.hp * HP_BONUS * GULP_HP_SHARE),
        );
        const heal = Math.min(Math.floor(applied.damage / 2), me.f.hp - me.hp);
        me.hp += heal;
        events.push({
          actor: self,
          kind: 'skill',
          skill: 'whale-gulp',
          damage: applied.damage,
          heal,
          hp: hpPair(sides[0], sides[1]),
        });
        if (applied.playDead)
          events.push({ actor: (self ^ 1) as 0 | 1, kind: 'play-dead', hp: hpPair(sides[0], sides[1]) });
      }
      if (action.skill === 'myriad-self') {
        // 万我：分出几重魂影——无数个「我」，杀不尽的替身；必中的照样打本体（见 attack）
        me.mirror += MYRIAD_MIRRORS;
        events.push({ actor: self, kind: 'skill', skill: 'myriad-self', hp: hpPair(sides[0], sides[1]) });
      }
      if (action.skill === 'dream-chant') {
        // 魂牵梦绕：必中伤害；控住就把对方神魂牵进梦里，下一拍动不了（入梦期间挨打不判闪避，同睡着）
        const applied = scaledApplyDamage(
          foe,
          14 + Math.floor(me.f.power * POWER_FACTOR) + Math.floor(foe.f.hp * HP_BONUS * CHANT_HP_SHARE),
        );
        const landed = foe.hp > 0 && controlLands(self, 'dream-chant');
        if (landed) control(self, 'dream');
        events.push({
          actor: self,
          kind: 'skill',
          skill: 'dream-chant',
          damage: applied.damage,
          ...(foe.hp > 0 && !landed ? { resisted: true as const } : {}),
          hp: hpPair(sides[0], sides[1]),
        });
        if (applied.playDead)
          events.push({ actor: (self ^ 1) as 0 | 1, kind: 'play-dead', hp: hpPair(sides[0], sides[1]) });
      }
      if (action.skill === 'finger-sword') {
        // 五指拳心剑：拳心藏剑，剑气穿体——必中，且护体挡不住（不消耗泡泡、不打折）
        const pierced = foe.bubbles > 0;
        const applied = scaledApplyDamage(
          foe,
          22 + Math.floor(me.f.power * POWER_FACTOR) + Math.floor(foe.f.hp * HP_BONUS * FIST_HP_SHARE),
          { pierce: true },
        );
        events.push({
          actor: self,
          kind: 'skill',
          skill: 'finger-sword',
          damage: applied.damage,
          ...(pierced ? { pierce: true as const } : {}),
          hp: hpPair(sides[0], sides[1]),
        });
        if (applied.playDead)
          events.push({ actor: (self ^ 1) as 0 | 1, kind: 'play-dead', hp: hpPair(sides[0], sides[1]) });
      }
      if (action.skill === 'dragon-palm') {
        // 降龙十八掌（X16）：必中；「亢龙有悔」的后劲留给下一次法宝 / 空手的第一下
        const applied = scaledApplyDamage(
          foe,
          DRAGON_PALM_BASE +
            Math.floor(me.f.power * POWER_FACTOR) +
            Math.floor(foe.f.hp * HP_BONUS * DRAGON_PALM_HP_SHARE),
        );
        me.surge = true;
        events.push({
          actor: self,
          kind: 'skill',
          skill: 'dragon-palm',
          damage: applied.damage,
          hp: hpPair(sides[0], sides[1]),
        });
        if (applied.playDead)
          events.push({ actor: (self ^ 1) as 0 | 1, kind: 'play-dead', hp: hpPair(sides[0], sides[1]) });
      }
      if (action.skill === 'farewell-wind') {
        // 送友风（X16）：必中伤害；控住就飘起来跳过下一拍（飘着时挨打不判闪避）
        const applied = scaledApplyDamage(
          foe,
          FAREWELL_BASE + Math.floor(me.f.power * POWER_FACTOR) + Math.floor(foe.f.hp * HP_BONUS * FAREWELL_HP_SHARE),
        );
        const landed = foe.hp > 0 && controlLands(self, 'farewell-wind');
        if (landed) control(self, 'float');
        events.push({
          actor: self,
          kind: 'skill',
          skill: 'farewell-wind',
          damage: applied.damage,
          ...(foe.hp > 0 && !landed ? { resisted: true as const } : {}),
          hp: hpPair(sides[0], sides[1]),
        });
        if (applied.playDead)
          events.push({ actor: (self ^ 1) as 0 | 1, kind: 'play-dead', hp: hpPair(sides[0], sides[1]) });
        // 串门切磋里另有一次送走判定：单独一条 `:farewell` 种子流，抽中就当场收场
        if (foe.hp > 0 && farewellRng && farewellRng() < FAREWELL_SEND_CHANCE) {
          events.push({ actor: self, kind: 'end', winner: self, reason: 'farewell', hp: hpPair(sides[0], sides[1]) });
          farewellEnd = true;
        }
      }
    } else {
      attack(self, action, blinded);
    }
    return action;
  };

  let actions = 0;
  while (sides[0].hp > 0 && sides[1].hp > 0 && actions < MAX_ACTIONS && !farewellEnd) {
    const self: 0 | 1 = sides[0].next <= sides[1].next ? 0 : 1; // 同一时刻 a 先
    const me = sides[self];
    const now = me.next;
    actions += 1;
    if (me.skip) {
      me.skip = false;
      events.push({ actor: self, kind: 'skip', cause: me.skipCause, hp: hpPair(sides[0], sides[1]) });
      me.skipCause = 'stun';
    } else {
      // 轮到自己出手了：上一拍被控的「还没出手」解除，下一次控制才能再压上来（X20）
      me.controlled = false;
      const done = takeAction(self);
      // 鲸尾 / 扑击：用它出手后，下次出手间隔 ×1.15
      const heavy =
        (done.kind === 'weapon' && WEAPONS[done.weapon].heavy) || (done.kind === 'move' && MOVES[done.move].heavy);
      me.next = now + intervalOf(me) * (heavy ? HEAVY_FACTOR : 1);
      continue;
    }
    me.next = now + intervalOf(me);
  }

  // 送友风已经推过 end（X16）：别再补一条普通收场
  if (farewellEnd) return events;

  const alive = [sides[0].hp > 0, sides[1].hp > 0];
  let winner: 0 | 1;
  let reason: 'ko' | 'timeout';
  if (alive[0] !== alive[1]) {
    winner = alive[0] ? 0 : 1;
    reason = 'ko';
  } else {
    reason = 'timeout';
    const frac = [sides[0].hp / sides[0].f.hp, sides[1].hp / sides[1].f.hp];
    if (frac[0] === frac[1])
      winner = sides[0].f.speed === sides[1].f.speed ? 0 : sides[0].f.speed > sides[1].f.speed ? 0 : 1;
    else winner = frac[0] > frac[1] ? 0 : 1;
  }
  events.push({ actor: winner, kind: 'end', winner, reason, hp: hpPair(sides[0], sides[1]) });
  return events;
}

function randBetween(roll: number, min: number, max: number): number {
  return min + Math.floor(roll * (max - min + 1));
}

/** 渡劫：N 道天雷依次劈下。能用上的：闪避（按一半闪避率算）、泡泡护体、假死遁、凭空生花 */
export function tribulate(f: Fighter, strikes: number, stage: number, seed: string): BattleEvent[] {
  const rng = rngFrom(seed + ':tribulate');
  const events: BattleEvent[] = [];
  const me = makeSide(f, 1);
  me.next = 0;
  events.push({ actor: 0, kind: 'start', hp: [me.hp, 0] });
  // 天雷伤害基数随境界涨：跟该境界角色的典型气血和雷数挂钩（进阶雷更多，单道反而轻些）
  const big = majorBreaks(stage);
  const factor = TRIBULATION_BASE + stage * TRIBULATION_STEP + Math.max(0, stage - 12) * TRIBULATION_LATE_STEP;
  const base = Math.round(((50 + (stage - big) * 6 + big * 20) / strikes) * factor) - 3;
  for (let i = 0; i < strikes && me.hp > 0; i++) {
    // 两道雷之间：气血低于一半就凭空生花
    if (me.f.skills.includes('bloom') && !me.used.has('bloom') && me.hp * 2 < me.f.hp) {
      me.used.add('bloom');
      const heal = Math.ceil((me.f.hp * 18) / 100);
      me.hp = Math.min(me.f.hp, me.hp + heal);
      events.push({ actor: 0, kind: 'skill', skill: 'bloom', heal, hp: [me.hp, 0] });
    }
    const dodgeRoll = rng();
    const dmgRoll = rng();
    const halfRate = dodgeRate(me.f) / 2;
    if (dodgeRoll < halfRate) {
      events.push({ actor: 0, kind: 'dodge', hp: [me.hp, 0] });
      continue;
    }
    // 天雷里带一小块按自身气血算的分量：吃丹加了血，单道雷也跟着重一点，丹的收益就不会陡成必过
    const applied = applyDamage(
      me,
      randBetween(dmgRoll, base - 8, base + 13) + Math.floor((f.hp * TRIBULATION_HP_CUT) / strikes),
    );
    events.push({
      actor: 0,
      kind: 'strike',
      index: i,
      damage: applied.damage,
      blocked: applied.blocked,
      hp: [me.hp, 0],
    });
    if (applied.playDead) events.push({ actor: 0, kind: 'play-dead', hp: [me.hp, 0] });
  }
  const survived = me.hp > 0;
  events.push({ actor: survived ? 0 : 1, kind: 'end', winner: survived ? 0 : 1, reason: 'ko', hp: [me.hp, 0] });
  return events;
}

/** 心魔：属性 ×0.9（向下取整，最低 1），法宝招式相同 */
export function shadowOf(f: Fighter): Fighter {
  return {
    name: '心魔',
    hp: Math.max(1, Math.floor(f.hp * 0.9)),
    power: Math.max(1, Math.floor(f.power * 0.9)),
    agility: Math.max(1, Math.floor(f.agility * 0.9)),
    speed: Math.max(1, Math.floor(f.speed * 0.9)),
    weapons: [...f.weapons],
    skills: [...f.skills],
  };
}

/**
 * 能力上限：X5 校验名帖用。按 X1 的成长规则推到头（初始各 2–5、小境界随机一项 +1～2 且气血 +6、
 * 大境界突破三项各 +1 且气血 +20），再留 10% 余量。
 */
export function statCap(stage: number): { hp: number; power: number; agility: number; speed: number } {
  // 到达 stage 一共升了 stage 次；大境界突破见 majorBreaks
  const big = majorBreaks(stage);
  const small = stage - big;
  const margin = (n: number) => Math.floor(n * 1.1);
  return {
    hp: margin(50 + small * 6 + big * 20),
    power: margin(5 + small * 2 + big),
    agility: margin(5 + small * 2 + big),
    speed: margin(5 + small * 2 + big),
  };
}
