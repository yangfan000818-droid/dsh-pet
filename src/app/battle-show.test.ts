/**
 * 演出时间线与执行器的单测（X3、X7）。
 *
 * 时间线是纯函数：喂进引擎事件序列，直接核对排出来的每一步（出手动作、飞行物、命中时刻、受击、快进）。
 * 时刻一律用 battle-show 导出的口径算（releaseOffset / windupOf / animLength），不抄死数字——
 * 出手时刻表、前摇表随素材重量，断言跟着走。
 * 执行器注入假的手 + mock timers 拨时间，不真等（X2 的口径）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fighterAt } from './battle-testkit.ts';
import { MAX_STAGE, tribulationStrikes } from './cultivation.ts';
import {
  fight,
  MOVE_IDS,
  MOVES,
  shadowOf,
  tribulate,
  WEAPONS,
  type Action,
  type BattleEvent,
  type Fighter,
  type SkillId,
  type WeaponId,
} from './battle.ts';
import {
  ATTACK_SHOW,
  BEAT_MS,
  BattleShow,
  FX_ASSETS,
  LINE_MS,
  LiveTimeline,
  MOVE_SHOW,
  OPEN_MS,
  QUICK_OPEN_MS,
  REACT_WINDOW_MS,
  RELEASE,
  SHOW_ANIMS,
  SLOT_MS,
  TRIBULATION_FLY,
  TRIBULATION_LOSS_ANIM,
  TRIBULATION_PILL_ANIM,
  TRIBULATION_WIN_ANIM,
  actionRate,
  animLength,
  quickTimeline,
  rateFor,
  releaseOffset,
  swapSides,
  timeline,
  windupOf,
  type Shot,
  type ShowSides,
  type Step,
} from './battle-show.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 固定序列的随机数（常量会让「从几句里挑一句」永远挑同一句，看不出轮着来对不对） */
function seq(start = 0): () => number {
  let i = start;
  return () => ((i++ % 7) / 7 + 0.02) % 1;
}

const NAMES: [string, string] = ['小鱼', '心魔'];
const hp: [number, number] = [100, 90];
const HIT = '受击-正面';
const BUBBLE = '招式-泡泡护体';

const start = (actor: 0 | 1): BattleEvent => ({ actor, kind: 'start', hp });
const decide = (actor: 0 | 1, action: Action, after: [number, number] = hp): BattleEvent => ({
  actor,
  kind: 'decide',
  action,
  hp: after,
});
const hit = (
  actor: 0 | 1,
  damage = 20,
  after: [number, number] = [100, 70],
  blocked = false,
  weapon?: WeaponId,
): BattleEvent => ({ actor, kind: 'hit', damage, crit: false, blocked, hp: after, ...(weapon ? { weapon } : {}) });
const combo = (actor: 0 | 1, damage = 15, after: [number, number] = [100, 55], blocked = false): BattleEvent => ({
  actor,
  kind: 'combo',
  damage,
  crit: false,
  blocked,
  hp: after,
});
const counter = (actor: 0 | 1, damage = 12, after: [number, number] = [88, 70], blocked = false): BattleEvent => ({
  actor,
  kind: 'counter',
  damage,
  blocked,
  hp: after,
});
const beast = (actor: 0 | 1, damage = 6, after: [number, number] = [100, 74], blocked = false): BattleEvent => ({
  actor,
  kind: 'beast',
  damage,
  blocked,
  hp: after,
});
const dodge = (actor: 0 | 1, after: [number, number] = hp): BattleEvent => ({ actor, kind: 'dodge', hp: after });
const strike = (index = 0, damage = 30, after: [number, number] = [70, 0], blocked = false): BattleEvent => ({
  actor: 0,
  kind: 'strike',
  index,
  damage,
  blocked,
  hp: after,
});

/** 只用空手：出手次数可控（自动出招还会放招式、用法宝，格子数不好核） */
const unarmed: { decide(): Action } = { decide: () => ({ kind: 'unarmed' }) };
const UNARMED: Action = { kind: 'unarmed' };

const shotsOf = (steps: Step[]): Array<Step & { shot: Shot }> =>
  steps.filter((step): step is Step & { shot: Shot } => step.shot !== undefined);
const animsOf = (steps: Step[], anim: string): Step[] => steps.filter((step) => step.anim === anim);
const impactOf = (step: Step & { shot: Shot }): number => step.at + step.shot.flightMs;
/** 反应素材的倍速（时间线固定按 REACT_WINDOW_MS 算） */
const reactRate = (anim: string): number => rateFor(anim, REACT_WINDOW_MS);

test('rateFor：素材时长 ÷ 窗口，夹在 /anim 允许的 0.5–3', () => {
  // 战斗-倒地 5 秒要占满 2.4 秒的一步 → 2.083
  assert.equal(rateFor('战斗-倒地', SLOT_MS), 2.083);
  // 表里没列的（出手素材都是 4 秒）
  assert.equal(rateFor('出手-水枪', SLOT_MS), 1.667);
  // 反应素材按反应窗口算
  assert.equal(rateFor('招式-化鸽遁', REACT_WINDOW_MS), 2.222);
  // 6 秒的打坐摊到 2 秒 → 3，再长也夹到上限（越界宿主直接拒，那一下就没动画了）
  assert.equal(rateFor('修炼-打坐', 2_000), 3);
  // 4 秒的素材摊到 12 秒 → 0.333，夹到下限
  assert.equal(rateFor('战斗-起手', 12_000), 0.5);
});

test('开场：两边各一段起手式，都在 t=0', () => {
  const steps = timeline([start(0)], NAMES, seq());
  assert.deepEqual(
    steps.map((step) => [step.at, step.who, step.anim, step.rate]),
    [
      [0, 0, '战斗-起手', 1.667],
      [0, 1, '战斗-起手', 1.667],
    ],
  );
  assert.deepEqual(steps[0].hp, hp);
});

test('swapSides（X12）：who 与两条气血对调、其余字段原样，不改入参；换两次回原样', () => {
  const a: Fighter = { name: '小鱼', hp: 120, power: 10, agility: 8, speed: 9, weapons: ['poker'], skills: ['dove'] };
  const steps = timeline(fight(a, shadowOf(a), 'swap-1'), NAMES, seq(), [a.skills, a.skills]);
  const snapshot = steps.map((step) => ({ ...step }));
  const swapped = swapSides(steps);
  assert.equal(swapped.length, steps.length);
  for (let i = 0; i < steps.length; i += 1) {
    const before = steps[i];
    const after = swapped[i];
    assert.notEqual(after, before, '返回的是新数组里的新对象');
    assert.equal(after.who, (before.who ^ 1) as 0 | 1);
    assert.deepEqual(after.hp, [before.hp[1], before.hp[0]]);
    // 把换过的两项换回去，其余字段（at / anim / from / rate / line / shot / closing）逐项不变
    assert.deepEqual({ ...after, who: before.who, hp: before.hp }, before);
  }
  assert.deepEqual(steps, snapshot, '不改入参');
  assert.deepEqual(swapSides(swapped), steps, '换两次等于原样');
});

test('出手 → 飞行物 → 命中 → 受击（X7）：飞行物在离手那一刻放出，受击对准命中、扣掉前摇，台词和掉血都在命中', () => {
  const steps = timeline([start(0), decide(0, UNARMED), hit(0, 20, [100, 70])], NAMES, seq());
  const action = animsOf(steps, '战斗-直拳');
  assert.deepEqual(
    action.map((step) => [step.at, step.who, step.rate]),
    [[OPEN_MS, 0, rateFor('战斗-直拳', SLOT_MS)]],
  );
  const [shot] = shotsOf(steps);
  assert.equal(shot.at, OPEN_MS + releaseOffset('战斗-直拳'), '离手 = 起播 + 原速出手时刻 ÷ 倍速');
  assert.equal(shot.who, 0);
  assert.deepEqual([shot.shot.kind, shot.shot.track, shot.shot.hitFx, shot.shot.count], ['拳风', 'line', '命中-星', 1]);
  assert.deepEqual(shot.shot.hand, RELEASE['战斗-直拳'].hand, '起点是出手素材里那只手');
  assert.deepEqual(shot.hp, hp, '飞行物放出那一刻血还没掉');
  const impact = impactOf(shot);
  const react = animsOf(steps, HIT);
  assert.deepEqual(
    react.map((step) => [step.at, step.who, step.rate]),
    [[impact - windupOf(HIT), 1, reactRate(HIT)]],
    '挨打方在命中那一刻开始后仰',
  );
  assert.deepEqual(react[0].hp, hp, '受击起播比命中早一点点：那一刻血也还没掉');
  const landed = steps.find((step) => step.at === impact && step.line);
  assert.ok(landed && landed.who === 0, `结算台词在命中那一刻、出手方那边：${JSON.stringify(landed)}`);
  assert.match(landed.line ?? '', /小鱼/);
  assert.deepEqual(landed.hp, [100, 70], '命中那一刻掉血');
});

test('每一招都有自己的出手、飞行物、命中特效和受击（§X7 第三步那张表）', () => {
  const cases: Array<[string, Action, BattleEvent[]]> = [
    ...(Object.keys(WEAPONS) as WeaponId[]).map((id): [string, Action, BattleEvent[]] => [
      id,
      { kind: 'weapon', weapon: id },
      Array.from({ length: WEAPONS[id].hits }, (_, i) => hit(0, 5, [100, 90 - 5 * (i + 1)], false, id)),
    ]),
    ...(['lion-roar', 'blue-whale'] as SkillId[]).map((id): [string, Action, BattleEvent[]] => [
      id,
      { kind: 'skill', skill: id },
      [{ actor: 0, kind: 'skill', skill: id, damage: 20, hp: [100, 70] }],
    ]),
    // X8：没有伤害的两个主动（鲸歌、墨汁）也放一发、对方按招式反应
    ...(['whale-song', 'ink'] as SkillId[]).map((id): [string, Action, BattleEvent[]] => [
      id,
      { kind: 'skill', skill: id },
      [{ actor: 0, kind: 'skill', skill: id, hp }],
    ]),
    ['unarmed', UNARMED, [hit(0)]],
  ];
  for (const [key, action, landed] of cases) {
    const show = ATTACK_SHOW[key];
    const fly = show.fly;
    assert.ok(fly, `${key} 有飞行物`);
    const steps = timeline([start(0), decide(0, action), ...landed], NAMES, seq());
    assert.deepEqual(
      steps.filter((step) => step.anim && step.who === 0 && step.at >= OPEN_MS).map((step) => step.anim),
      [show.action],
      `${key}：出手方播自己的出手素材`,
    );
    const shots = shotsOf(steps);
    // 银托盘的两段是同一只托盘回旋（一发里带两个命中点），其余每一段伤害一发
    const expected = fly.track === 'boomerang' ? 1 : landed.length;
    assert.equal(shots.length, expected, `${key}：每一段伤害一发飞行物`);
    for (const step of shots) {
      assert.equal(step.shot.kind, fly.kind, key);
      assert.equal(step.shot.hitFx, fly.hitFx, key);
      assert.equal(step.shot.track, fly.track, key);
    }
    const react = fly.react ?? HIT;
    const reactions = steps.filter((step) => step.who === 1 && step.anim && step.at >= OPEN_MS);
    assert.deepEqual(
      reactions.map((step) => [step.anim, step.at]),
      [[react, impactOf(shots[0]) - windupOf(react)]],
      `${key}：挨打方按这一招的受击方式反应一次`,
    );
    assert.ok(RELEASE[show.action], `${key}：出手素材 ${show.action} 量过出手时刻`);
  }
  // 回血：作用在自己身上，照旧整段素材，没有飞行物也没有挨打
  const bloom = timeline(
    [
      start(0),
      decide(0, { kind: 'skill', skill: 'bloom' }, [60, 90]),
      { actor: 0, kind: 'skill', skill: 'bloom', heal: 20, hp: [80, 90] },
    ],
    NAMES,
    seq(),
  );
  assert.deepEqual(
    bloom.filter((step) => step.anim && step.at >= OPEN_MS).map((step) => [step.who, step.anim]),
    [[0, '招式-凭空生花']],
  );
  assert.equal(shotsOf(bloom).length, 0);
  // 血条和「气血 +N」等花绽开那一刻再刷：动作起播时还是回血前的血，回血那步排在后面
  const bloomAnim = bloom.find((step) => step.anim && step.at >= OPEN_MS);
  assert.deepEqual(bloomAnim?.hp, [60, 90], '起播时还是回血前的气血');
  const healed = bloom.filter((step) => step.at > (bloomAnim?.at ?? 0) && step.hp[0] === 80);
  assert.ok(healed.length > 0, '回血的气血条晚于动作起播');
  assert.ok(
    healed.some((step) => step.line !== undefined),
    '回血的台词也在花绽开那一刻',
  );
});

test('招式表（Y0 的 MOVES）都有自己的演出：一转蛊用现有宠物素材，对手招式用它的皮', () => {
  const webm = new Set(
    readdirSync(join(packageRoot, 'assets', 'webm'))
      .filter((file) => file.endsWith('.webm'))
      .map((file) => file.slice(0, -'.webm'.length)),
  );
  for (const id of MOVE_IDS) {
    const show = MOVE_SHOW[id];
    assert.ok(show, `${id} 没有演出表`);
    if (MOVES[id].packHits || ['gu-dogs', 'gu-crane', 'gu-egg'].includes(id)) {
      assert.ok(show.action, `${id} 是一转蛊，应该有宠物素材`);
      assert.ok(webm.has(show.action), `${id} 的宠物素材不存在：${show.action}`);
      assert.ok(SHOW_ANIMS.includes(show.action), `${id} 的宠物素材要在预取清单里`);
    } else {
      assert.ok(show.foe, `${id} 是给对手用的，应该说明走「出手」还是「绝招」`);
    }
    if (show.fly) assert.ok(FX_ASSETS.includes(show.fly.kind), `${id} 的飞行物要在预取清单里`);
  }
  // 一场一次的招按「绝招」演（白凝冰有绝招素材；金色飞刀没有，视频失败后由窗口退回 CSS）
  assert.equal(MOVE_SHOW['gold-blade'].foe, '绝招');
  assert.equal(MOVE_SHOW.bingpo.foe, '绝招');
});

test('一挥多段：驭犬蛊按狗数齐发（同一时刻、每只一发），不是串成一串', () => {
  const events: BattleEvent[] = [
    start(0),
    decide(0, { kind: 'move', move: 'gu-dogs' }),
    { actor: 0, kind: 'hit', move: 'gu-dogs', damage: 3, crit: false, blocked: false, hp: [100, 81] },
    { actor: 0, kind: 'hit', move: 'gu-dogs', damage: 3, crit: false, blocked: false, hp: [100, 78] },
    { actor: 1, kind: 'dodge', hp: [100, 78] },
  ];
  const steps = timeline(events, NAMES, seq());
  const shots = shotsOf(steps);
  assert.equal(shots.length, 3, '三条狗各一发');
  assert.ok(shots.every((step) => step.shot.kind === '犬影'));
  assert.deepEqual(
    shots.map((step) => step.at),
    [
      OPEN_MS + releaseOffset('出手-召唤灵兽'),
      OPEN_MS + releaseOffset('出手-召唤灵兽'),
      OPEN_MS + releaseOffset('出手-召唤灵兽'),
    ],
    '按狗数齐发',
  );
});

test('对手的皮（Y2）：给了 foe 时对手一边的动画全部带前缀，不给时和现在一样', () => {
  const events: BattleEvent[] = [
    start(0),
    decide(0, UNARMED),
    hit(0),
    decide(1, { kind: 'move', move: 'dog-bite' }),
    hit(1, 8, [80, 100]),
    { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp: [80, 0] },
  ];
  const plain = timeline(events, NAMES, seq());
  const skinned = timeline(events, NAMES, seq(), undefined, { foe: { prefix: '对手-野狗' } });
  const foeAnims = (steps: Step[]) => steps.filter((step) => step.who === 1 && step.anim).map((step) => step.anim);
  assert.ok(
    foeAnims(skinned).every((anim) => anim?.startsWith('对手-野狗-')),
    `对手的动画都换皮：${foeAnims(skinned).join(' / ')}`,
  );
  assert.ok(foeAnims(skinned).includes('对手-野狗-起手'));
  assert.ok(foeAnims(skinned).includes('对手-野狗-出手'));
  assert.ok(foeAnims(skinned).includes('对手-野狗-受击'));
  assert.ok(foeAnims(skinned).includes('对手-野狗-倒地'));
  // 不给 foe 时一个字不变
  assert.deepEqual(
    foeAnims(plain).filter((anim) => !anim?.startsWith('对手-')),
    foeAnims(plain),
  );
  assert.ok(foeAnims(plain).includes('战斗-起手'));
  // 换皮后的出手时刻按量好的对手动作算（野狗的手在最左边）
  const foeShot = shotsOf(skinned).find((step) => step.who === 1);
  assert.ok(foeShot);
  assert.deepEqual(foeShot.shot.hand, RELEASE['对手-野狗-出手'].hand);
});

test('替挡（guard）：飞行物停在挨打方身前、画雪花，挨打方不播受击，只出替挡的台词', () => {
  const steps = timeline(
    [
      start(0),
      decide(0, UNARMED),
      { actor: 1, kind: 'guard', by: '白凝冰', hp },
      { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp: [100, 0] },
    ],
    NAMES,
    seq(),
  );
  const shots = shotsOf(steps);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].shot.blocked, true, '打在身上之前被挡下');
  assert.equal(shots[0].shot.hitFx, '命中-雪花');
  assert.equal(animsOf(steps, HIT).length, 0, '挨打方不播受击');
  const line = steps.find((step) => step.line?.includes('白凝冰'));
  assert.ok(line && line.at === impactOf(shots[0]), `替挡的台词在命中那一刻：${JSON.stringify(line)}`);
});

test('齐发：水枪三发对准三下扳机、狮子吼三道声波，都是一步里的 count / gapMs', () => {
  const water = shotsOf(timeline([start(0), decide(0, { kind: 'weapon', weapon: 'water-gun' }), hit(0)], NAMES, seq()));
  assert.deepEqual(
    water.map((step) => [step.shot.count, step.shot.gapMs]),
    [[3, ATTACK_SHOW['water-gun'].fly?.gapMs]],
  );
  const roar = shotsOf(
    timeline(
      [
        start(0),
        decide(0, { kind: 'skill', skill: 'lion-roar' }),
        { actor: 0, kind: 'skill', skill: 'lion-roar', damage: 12, hp },
      ],
      NAMES,
      seq(),
    ),
  );
  assert.equal(roar[0].shot.count, 3);
});

test('多段法宝一把撒出去：几段紧挨着飞，三球逐段换色，对方只演一次反应', () => {
  const poker = timeline(
    [start(0), decide(0, { kind: 'weapon', weapon: 'poker' }), hit(0, 6, [100, 84]), hit(0, 6, [100, 78])],
    NAMES,
    seq(),
  );
  const release = OPEN_MS + releaseOffset('出手-扑克牌');
  const gap = ATTACK_SHOW.poker.fly?.gapMs ?? 0;
  assert.deepEqual(
    shotsOf(poker).map((step) => [step.at, step.shot.count]),
    [
      [release, 1],
      [release + gap, 1],
    ],
  );
  assert.equal(animsOf(poker, HIT).length, 1, '第二张牌打在还在后仰的人身上，不重新起播');
  // 两次掉血各在自己的命中时刻
  assert.deepEqual(
    poker.filter((step) => step.line).map((step) => step.at),
    shotsOf(poker).map(impactOf),
  );
  const juggle = timeline(
    [start(0), decide(0, { kind: 'weapon', weapon: 'juggle' }), hit(0), hit(0), hit(0)],
    NAMES,
    seq(),
  );
  assert.deepEqual(
    shotsOf(juggle).map((step) => step.shot.hue ?? 0),
    [0, 120, 240],
  );
});

test('多段里有的躲开有的打中：只演打中的那一下，躲开的那张只掠过去；全躲开才演闪避', () => {
  const mixed = timeline(
    [start(0), decide(0, { kind: 'weapon', weapon: 'poker' }), dodge(1), hit(0, 6, [100, 84])],
    NAMES,
    seq(),
  );
  const shots = shotsOf(mixed);
  assert.deepEqual(
    shots.map((step) => step.shot.miss ?? false),
    [true, false],
  );
  assert.deepEqual(
    mixed.filter((step) => step.who === 1 && step.anim && step.at >= OPEN_MS).map((step) => [step.anim, step.at]),
    [[HIT, impactOf(shots[1]) - windupOf(HIT)]],
    '先躲后挨会来回抽搐：只演挨的那一下',
  );
  const missed = timeline([start(0), decide(0, { kind: 'weapon', weapon: 'poker' }), dodge(1), dodge(1)], NAMES, seq());
  const missedShots = shotsOf(missed);
  assert.ok(missedShots.every((step) => step.shot.miss));
  assert.deepEqual(
    missed.filter((step) => step.who === 1 && step.anim && step.at >= OPEN_MS).map((step) => [step.anim, step.at]),
    [['战斗-闪避', impactOf(missedShots[0]) - windupOf('战斗-闪避')]],
  );
});

test('闪避：飞行物掠过（miss），闪避对准它掠过的时刻提前躲开；只有真有化鸽遁那一方化成鸽子', () => {
  const events = [start(0), decide(0, { kind: 'weapon', weapon: 'shuttlecock' }), dodge(1)];
  const anims = (skillSets: [SkillId[], SkillId[]]) => {
    const steps = timeline(events, NAMES, seq(), skillSets);
    const [shot] = shotsOf(steps);
    assert.equal(shot.shot.miss, true);
    return steps
      .filter((step) => step.who === 1 && step.anim && step.at >= OPEN_MS)
      .map((step) => [step.anim, step.at - impactOf(shot)]);
  };
  assert.deepEqual(anims([[], ['dove']]), [['招式-化鸽遁', -windupOf('招式-化鸽遁')]]);
  assert.deepEqual(anims([[], []]), [['战斗-闪避', -windupOf('战斗-闪避')]]);
  // 台词那边同样只看 skillSets（lineOf 的第四参数）
  const lines = timeline(events, NAMES, seq(), [[], ['dove']])
    .filter((step) => step.line)
    .map((step) => step.line);
  assert.ok(
    lines.some((line) => line?.includes('鸽子')),
    `化鸽遁的句子：${lines.join(' / ')}`,
  );
  // 手喂的序列里没有出手格子：只是自己一闪，排在那一拍
  const bare = timeline([start(0), dodge(1)], NAMES, seq(), [[], []]);
  assert.deepEqual(
    bare.filter((step) => step.anim && step.at >= OPEN_MS).map((step) => [step.at, step.who, step.anim]),
    [[OPEN_MS, 1, '战斗-闪避']],
  );
});

test('挡下：飞行物打在泡泡上（blocked），挨打方播泡泡护体（先吹好、命中那一刻被撞凹），不播受击', () => {
  const sets: [SkillId[], SkillId[]] = [[], ['bubble']];
  const steps = timeline(
    [start(0), decide(0, { kind: 'weapon', weapon: 'firework' }), hit(0, 20, [100, 80], true, 'firework')],
    NAMES,
    seq(),
    sets,
  );
  const [shot] = shotsOf(steps);
  assert.equal(shot.shot.blocked, true);
  assert.deepEqual(
    steps.filter((step) => step.who === 1 && step.anim && step.at >= OPEN_MS).map((step) => [step.anim, step.at]),
    [[BUBBLE, impactOf(shot) - windupOf(BUBBLE)]],
    '挡下了就不炸黑',
  );
  // combo / beast / counter 也一样看 blocked：挡下就是挨打那一边吹泡泡
  const blockedCases: Array<[string, BattleEvent, 0 | 1, [SkillId[], SkillId[]]]> = [
    ['combo', combo(0, 10, [100, 90], true), 1, [[], ['bubble']]],
    ['beast', beast(0, 5, [100, 95], true), 1, [['spirit-beast'], ['bubble']]],
    ['counter', counter(1, 8, [92, 90], true), 0, [['bubble'], ['sixth-sense']]],
  ];
  for (const [label, event, reactWho, skillSets] of blockedCases) {
    const got = timeline([start(0), decide(0, UNARMED), event], NAMES, seq(), skillSets);
    const bubbles = animsOf(got, BUBBLE);
    assert.equal(bubbles.length, 1, `${label} 挡下时只有一步泡泡护体`);
    assert.equal(bubbles[0].who, reactWho, `${label}：泡泡护体播在挨打那一方`);
    assert.equal(animsOf(got, HIT).length, 0, `${label}：挡下了就不播受击`);
    assert.ok(
      shotsOf(got).some((step) => step.shot.blocked),
      `${label}：那一发打在泡泡上`,
    );
  }
});

test('灵兽助阵：主攻的动作收势后再召唤，灵兽从指尖游过去；被躲开时照样召出来扑个空', () => {
  const sets: [SkillId[], SkillId[]] = [['spirit-beast'], []];
  const steps = timeline([start(0), decide(0, UNARMED), hit(0), beast(0, 6, [100, 64])], NAMES, seq(), sets);
  const main = animLength('战斗-直拳', rateFor('战斗-直拳', SLOT_MS));
  const summon = animsOf(steps, '出手-召唤灵兽');
  assert.deepEqual(
    summon.map((step) => [step.at, step.who]),
    [[OPEN_MS + main, 0]],
    '排在直拳播完之后（不把直拳从中间切断）',
  );
  const beastShot = shotsOf(steps).find((step) => step.shot.kind === '灵兽');
  assert.ok(beastShot);
  assert.equal(beastShot.at, summon[0].at + releaseOffset('出手-召唤灵兽'));
  assert.equal(animsOf(steps, HIT).length, 2, '直拳一下、灵兽一下，各演一次（第二次在上一段受击播完之后）');
  const beastLine = steps.find((step) => step.at === impactOf(beastShot) && step.line);
  assert.ok(beastLine && beastLine.who === 0, '灵兽那句台词在它撞上的那一刻、出手方那边');
  // 灵兽被躲开（引擎只记一条 dodge，且是这一格最后一件事）
  const dodged = timeline([start(0), decide(0, UNARMED), hit(0), dodge(1)], NAMES, seq(), sets);
  const dodgedShots = shotsOf(dodged);
  const last = dodgedShots[dodgedShots.length - 1];
  assert.equal(animsOf(dodged, '出手-召唤灵兽').length, 1);
  assert.deepEqual([last?.shot.kind, last?.shot.miss], ['灵兽', true]);
  // 没有灵兽助阵时，同样的序列是追击被躲开：飞的是同一格的拳风，不召唤
  const plain = timeline([start(0), decide(0, UNARMED), hit(0), dodge(1)], NAMES, seq(), [[], []]);
  assert.equal(animsOf(plain, '出手-召唤灵兽').length, 0);
  assert.deepEqual(
    shotsOf(plain).map((step) => step.shot.kind),
    ['拳风', '拳风'],
  );
});

test('第六感：反击方先挨完那一下、回到站姿，再闭眼感应反劈；掌劈飞回去，原攻击方在它到达时受击', () => {
  const steps = timeline(
    [start(0), decide(0, UNARMED), hit(0, 20, [100, 70]), counter(1, 12, [88, 70])],
    NAMES,
    seq(),
    [[], ['sixth-sense']],
  );
  const [first, chop] = shotsOf(steps);
  const firstReact = animsOf(steps, HIT).find((step) => step.who === 1);
  assert.ok(firstReact);
  assert.equal(firstReact.at, impactOf(first) - windupOf(HIT));
  const sense = animsOf(steps, '出手-第六感');
  assert.deepEqual(
    sense.map((step) => [step.at, step.who]),
    [[firstReact.at + animLength(HIT, reactRate(HIT)), 1]],
    '先挨后反：受击播完才反劈',
  );
  assert.deepEqual([chop.who, chop.shot.kind, chop.at], [1, '手刀', sense[0].at + releaseOffset('出手-第六感')]);
  const backReact = animsOf(steps, HIT).find((step) => step.who === 0);
  assert.equal(backReact?.at, impactOf(chop) - windupOf(HIT), '原攻击方在掌劈到达时受击');
  const counterLine = steps.find((step) => step.at === impactOf(chop) && step.line);
  assert.ok(counterLine && counterLine.who === 1, '反击的台词在反击方那边、命中那一刻');
});

test('无影手：主攻收势后接一段连拳，拳影齐发；没有无影手的追击只再放一发、不另播动作也不重新受击', () => {
  const events = [start(0), decide(0, UNARMED), hit(0), combo(0, 12, [100, 43])];
  const main = animLength('战斗-直拳', rateFor('战斗-直拳', SLOT_MS));
  const fists = timeline(events, NAMES, seq(), [['shadow-fists'], []]);
  const flurry = animsOf(fists, '战斗-连拳');
  assert.deepEqual(
    flurry.map((step) => [step.at, step.who]),
    [[OPEN_MS + main, 0]],
  );
  const fistShot = shotsOf(fists).find((step) => step.shot.kind === '拳影');
  assert.ok(fistShot);
  assert.deepEqual(
    [fistShot.at, fistShot.shot.count, fistShot.shot.gapMs],
    [flurry[0].at + releaseOffset('战斗-连拳'), 5, 100],
  );
  assert.equal(animsOf(fists, HIT).length, 2, '连拳到的时候上一段受击已经播完，重新挨一下');

  const plain = timeline(events, NAMES, seq(), [[], []]);
  assert.equal(animsOf(plain, '战斗-连拳').length, 0);
  const [, again] = shotsOf(plain);
  assert.deepEqual(
    [again.shot.kind, again.at],
    ['拳风', OPEN_MS + releaseOffset('战斗-直拳') + BEAT_MS],
    '手还伸着，再放一发同一格的拳风',
  );
  assert.equal(animsOf(plain, HIT).length, 1, '追击打在还在后仰的人身上：不重新起播');
  // 无影手只看出手方，不是挨打方
  assert.deepEqual(timeline(events, NAMES, seq(), [[], ['shadow-fists']]), plain);
});

test('收场：赢的播胜利、输的播倒地，结果台词和它们一起标 closing（快进跳到这几步）', () => {
  const steps = timeline(
    [start(0), { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp: [55, 0] } as BattleEvent],
    NAMES,
    seq(),
  );
  const closing = steps.filter((step) => step.closing);
  assert.deepEqual(
    closing.map((step) => [step.at, step.who, step.anim ?? 'line']),
    [
      [OPEN_MS, 0, '战斗-胜利'],
      [OPEN_MS, 1, '战斗-倒地'],
      [OPEN_MS, 0, 'line'],
    ],
  );
  assert.ok(closing.every((step) => step.hp[0] === 55 && step.hp[1] === 0));
});

test('收场等两只都回到站姿：最后一下的受击播完才庆祝 / 倒地', () => {
  const steps = timeline(
    [
      start(0),
      decide(0, UNARMED),
      hit(0, 90, [100, 0]),
      { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp: [100, 0] } as BattleEvent,
    ],
    NAMES,
    seq(),
  );
  const react = animsOf(steps, HIT)[0];
  const fall = animsOf(steps, '战斗-倒地')[0];
  assert.ok(fall.at >= react.at + animLength(HIT, reactRate(HIT)), '倒地不切断受击');
});

test('速战（Y2）：约 10 秒，只演伤害最大的一下，收场标 closing，最后一步的气血就是引擎结果', () => {
  const events: BattleEvent[] = [
    start(0),
    decide(0, UNARMED),
    hit(0, 20, [80, 100]),
    decide(1, { kind: 'weapon', weapon: 'poker' }),
    hit(1, 50, [0, 100], false, 'poker'),
    { actor: 1, kind: 'end', winner: 1, reason: 'ko', hp: [0, 100] },
  ];
  const steps = quickTimeline(events, NAMES, seq());
  const opening = steps.filter((step) => step.at === 0 && step.anim);
  assert.deepEqual(
    opening.map((step) => step.who),
    [0, 1],
    '开场两边各起手一拍',
  );
  assert.ok(opening.every((step) => step.rate === rateFor('战斗-起手', QUICK_OPEN_MS)));
  assert.equal(shotsOf(steps).length, 1, '中间只演伤害最大的那一下');
  assert.equal(shotsOf(steps)[0].who, 1);
  const closing = steps.filter((step) => step.closing);
  assert.deepEqual(
    closing.filter((step) => step.anim).map((step) => [step.who, step.anim]),
    [
      [1, '战斗-胜利'],
      [0, '战斗-倒地'],
    ],
  );
  const last = steps[steps.length - 1];
  assert.deepEqual(last.hp, [0, 100], '最后一步的气血等于引擎结果');
  assert.ok(last.at + LINE_MS <= 10_000, `总长不超过 10 秒：${last.at + LINE_MS}`);
  // 快进照旧直接跳到收场
  assert.ok(closing.length >= 2);
  // 一下都没打中（只有开场和收场）也压在 10 秒内
  const quiet = quickTimeline(
    [start(0), { actor: 0, kind: 'end', winner: 0, reason: 'timeout', hp: [100, 90] }],
    NAMES,
    seq(),
  );
  const quietLast = quiet[quiet.length - 1];
  assert.ok(quietLast.at + LINE_MS <= 10_000);
  assert.equal(shotsOf(quiet).length, 0);
});

test('速战 + 对手的皮：收场和中间那一下都用对手自己的动画名', () => {
  const events: BattleEvent[] = [
    start(0),
    decide(0, UNARMED),
    hit(0, 5, [100, 85]),
    decide(1, { kind: 'move', move: 'dog-bite' }),
    hit(1, 60, [0, 85]),
    { actor: 1, kind: 'end', winner: 1, reason: 'ko', hp: [0, 85] },
  ];
  const steps = quickTimeline(events, NAMES, seq(), undefined, { foe: { prefix: '对手-野狗' } });
  const foeAnims = steps.filter((step) => step.who === 1 && step.anim).map((step) => step.anim);
  assert.ok(foeAnims.includes('对手-野狗-起手'));
  assert.ok(foeAnims.includes('对手-野狗-出手'));
  assert.ok(foeAnims.includes('对手-野狗-胜利'));
  assert.deepEqual(
    steps.filter((step) => step.who === 0 && step.closing).map((step) => step.anim),
    ['战斗-倒地'],
  );
});

test('速战快进：收场那几步一放，run 立即结束（和完整演出同一套 skip）', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const steps = quickTimeline(
    [
      start(0),
      decide(0, UNARMED),
      hit(0, 20, [100, 80]),
      { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp: [100, 0] },
    ],
    NAMES,
    seq(),
  );
  const { self, foe, arena, show } = makeShow(steps);
  const done = show.run();
  t.mock.timers.tick(0);
  show.skip();
  await done;
  assert.ok(self.played.some(([anim]) => anim === '战斗-胜利'));
  assert.ok(foe?.played.some(([anim]) => anim === '战斗-倒地'));
  assert.deepEqual(arena[arena.length - 1], 100, '快进把气血条推到最终值');
});

test('假死遁：救回来那一下自己播招式-假死遁（对准致命那一下）；被定住只有台词没动画', () => {
  const steps = timeline(
    [
      start(0),
      hit(0, 200, [100, 0]),
      { actor: 1, kind: 'play-dead', hp: [100, 1] } as BattleEvent,
      { actor: 1, kind: 'skip', hp: [100, 1] } as BattleEvent,
    ],
    NAMES,
    seq(),
  );
  assert.deepEqual(
    steps.filter((step) => step.anim && step.at >= OPEN_MS).map((step) => [step.who, step.anim]),
    [[1, '招式-假死遁']],
    '这一拳被打倒又爬起来，不播受击（假死遁自己播）',
  );
  const skip = steps.find((step) => step.line?.includes('定在原地') || step.line?.includes('愣在原地'));
  assert.ok(skip && skip.who === 1, 'skip 有一句、出现在被定住那一方');
  // 有出手格子时：假死遁对准那一下的命中时刻
  const slotted = timeline(
    [start(0), decide(0, UNARMED), hit(0, 200, [100, 0]), { actor: 1, kind: 'play-dead', hp: [100, 1] } as BattleEvent],
    NAMES,
    seq(),
  );
  const [shot] = shotsOf(slotted);
  assert.equal(animsOf(slotted, '招式-假死遁')[0]?.at, impactOf(shot) - windupOf('招式-假死遁'));
});

test('渡劫：每道雷是一发天上来的飞行物（乌云 + 闪电），劈中那一刻触电；下一道等触电播完；挡下打在泡泡上', () => {
  const steps = timeline([start(0), strike(0), strike(1)], ['小鱼', '天雷'], seq());
  const shots = shotsOf(steps);
  assert.deepEqual(
    shots.map((step) => [step.who, step.shot.kind, step.shot.track, step.shot.sky, step.shot.hitFx]),
    [
      [0, '闪电', 'bolt', true, TRIBULATION_FLY.hitFx],
      [0, '闪电', 'bolt', true, TRIBULATION_FLY.hitFx],
    ],
  );
  assert.equal(shots[0].at, OPEN_MS);
  const shocks = animsOf(steps, '修炼-触电');
  assert.deepEqual(
    shocks.map((step) => [step.who, step.at]),
    shots.map((step) => [0, impactOf(step) - windupOf('修炼-触电')]),
  );
  assert.ok(shots[1].at >= shocks[0].at + animLength('修炼-触电', reactRate('修炼-触电')), '第二道等触电播完');
  assert.equal(animsOf(steps, HIT).length, 0);
  // 挡下的那道：渡劫者自己的泡泡护体，飞行物打在泡泡上（渡劫只有自家这一边）
  const blockedSteps = timeline([start(0), strike(0, 30, [85, 0], true)], ['小鱼', '天雷'], seq(), [['bubble'], []]);
  const [blockedShot] = shotsOf(blockedSteps);
  assert.equal(blockedShot.shot.blocked, true);
  assert.deepEqual(
    blockedSteps.filter((step) => step.anim && step.at >= OPEN_MS).map((step) => [step.at, step.who, step.anim]),
    [[impactOf(blockedShot) - windupOf(BUBBLE), 0, BUBBLE]],
  );
});

/** 渡劫事件序列（引擎里 actor 恒为 0，收场的 winner 0 = 扛住、1 = 没扛住） */
const tribEnd = (survived: boolean, after: [number, number] = [40, 0]): BattleEvent => ({
  actor: survived ? 0 : 1,
  kind: 'end',
  winner: survived ? 0 : 1,
  reason: 'ko',
  hp: after,
});
const TRIB = { tribulation: { pill: false } };
const TRIB_PILL = { tribulation: { pill: true } };

test('渡劫形态：没有对手窗口就不排起手式；吃丹先播一段 修炼-服丹', () => {
  const plain = timeline([start(0), strike(0), tribEnd(true)], ['小鱼', '天雷'], seq(), undefined, TRIB);
  assert.deepEqual(
    plain.filter((step) => step.at === 0 && step.anim).map((step) => [step.who, step.anim]),
    [],
    '不吃丹：开场没有动画（第一道雷自己就是开头）',
  );
  assert.equal(animsOf(plain, '战斗-起手').length, 0, '没有对手，不播两个起手式');

  const fed = timeline([start(0), strike(0), tribEnd(true)], ['小鱼', '天雷'], seq(), undefined, TRIB_PILL);
  assert.deepEqual(
    fed.filter((step) => step.at === 0 && step.anim).map((step) => [step.who, step.anim, step.rate]),
    [[0, '修炼-服丹', rateFor('修炼-服丹', OPEN_MS)]],
  );
});

test('渡劫形态：台词报第几道雷（第 i/N 道），一道雷一句，出在劈中那一刻', () => {
  const steps = timeline(
    [start(0), strike(0), strike(1), strike(2), tribEnd(false)],
    ['小鱼', '天雷'],
    seq(2),
    undefined,
    TRIB,
  );
  const lines = steps.filter((step) => step.line);
  assert.equal(lines.length, 3, '三道雷三句');
  assert.ok(
    lines.every((step) => (step.line ?? '').startsWith('第 ') && (step.line ?? '').includes('/3 道：')),
    `都报第几道：${lines.map((step) => step.line)}`,
  );
  assert.match(lines[0].line ?? '', /^第 1\/3 道：/);
  assert.match(lines[2].line ?? '', /^第 3\/3 道：/);
  assert.deepEqual(
    lines.map((step) => step.at),
    shotsOf(steps).map(impactOf),
  );
  // 被挡的那道照旧带「（泡泡挡掉一半）」
  const blocked = timeline([start(0), strike(0, 20, [80, 0], true)], ['小鱼', '天雷'], seq(2), [['bubble'], []], TRIB);
  assert.match(blocked.find((step) => step.line)?.line ?? '', /第 1\/1 道：.*（泡泡挡掉一半）$/);
  // 中途倒下的那场：引擎提前收尾、事件里只有挨到的那 2 道雷，N 用 plan 给的雷数（别报成 2/2）
  const early = timeline(
    [start(0), strike(0), strike(1, 999, [0, 0]), tribEnd(false, [0, 0])],
    ['小鱼', '天雷'],
    seq(2),
    undefined,
    { tribulation: { pill: false, strikes: 9 } },
  );
  const fallen = early.filter((step) => step.line).map((step) => step.line ?? '');
  assert.match(fallen[0], /^第 1\/9 道：/);
  assert.match(fallen[fallen.length - 1], /^第 2\/9 道：/);
});

test('渡劫形态：收场成功播 修炼-突破，失败播池里的 工作状态-垂头叹气冒汗（from = pool）', () => {
  const win = timeline([start(0), strike(0), tribEnd(true)], ['小鱼', '天雷'], seq(), undefined, TRIB);
  const closing = win.filter((step) => step.closing);
  assert.deepEqual(
    closing.map((step) => [step.who, step.anim, step.from, step.rate]),
    [[0, '修炼-突破', undefined, rateFor('修炼-突破', 3_000)]],
  );
  const lose = timeline(
    [start(0), strike(0, 999, [0, 0]), tribEnd(false, [0, 0])],
    ['小鱼', '天雷'],
    seq(),
    undefined,
    TRIB,
  );
  assert.deepEqual(
    lose.filter((step) => step.closing).map((step) => [step.who, step.anim, step.from]),
    [[0, '工作状态-垂头叹气冒汗', 'pool']],
    '失败那一下是池里的现有素材（名字形态播）',
  );
  // 两种收场都不带「谁赢了」那种台词：结果感言由调用方按人设说一句（§X4 每次渡劫 +1 次模型调用）
  assert.ok(
    lose.filter((step) => step.closing).every((step) => step.line === undefined),
    '收场只有动画，台词交给结果感言',
  );
  assert.equal(animsOf(lose, '战斗-倒地').length, 0);
});

test('气血：每一步都带上两条血（擂台照它刷新），最后停在结果', () => {
  const steps = timeline([start(0), decide(0, UNARMED), hit(0, 20, [100, 70])], NAMES, seq());
  assert.ok(steps.every((step) => step.hp.length === 2));
  assert.deepEqual(steps[steps.length - 1].hp, [100, 70]);
});

/** 每只宠物的动画按时间排开：下一段起播不早于上一段播完（假死遁可以打断——装死倒下那一下必须演出来） */
function assertNoCut(steps: Step[], label: string): void {
  for (const who of [0, 1] as const) {
    const anims = steps.filter((step) => step.who === who && step.anim);
    for (let i = 1; i < anims.length; i += 1) {
      const prev = anims[i - 1];
      const next = anims[i];
      if (next.anim === '招式-假死遁') continue;
      const ends = prev.at + animLength(prev.anim ?? '', prev.rate ?? 1);
      assert.ok(
        next.at >= ends - 1,
        `${label}：${who} 号的「${next.anim}」(${next.at}) 切断了「${prev.anim}」(${prev.at}–${ends})`,
      );
    }
  }
}

test('衔接（用户要求丝滑）：真引擎扫遍境界，同一只宠物的动画从不被下一段从中间切断', () => {
  for (let stage = 0; stage <= MAX_STAGE; stage += 1) {
    const you = fighterAt(stage, seq(stage));
    const foe = shadowOf(you);
    for (const [label, events] of [
      [`空手 ${stage}`, fight(you, foe, `cut-u-${stage}`, [unarmed, unarmed])],
      [`自动出招 ${stage}`, fight(you, foe, `cut-a-${stage}`)],
    ] as const) {
      assertNoCut(timeline(events, [you.name, foe.name], seq(), [you.skills, foe.skills]), label);
    }
    const tribulated = tribulate(you, tribulationStrikes(stage + 1), stage, `cut-t-${stage}`);
    assertNoCut(timeline(tribulated, [you.name, '天雷'], seq(), [you.skills, []], TRIB), `渡劫 ${stage}`);
  }
});

test('真引擎的一场：时间线按时间递增，整场长度可控（一场别拖太久）', () => {
  const a: Fighter = { name: '小鱼', hp: 120, power: 10, agility: 8, speed: 9, weapons: ['poker'], skills: ['dove'] };
  const b = shadowOf(a);
  const steps = timeline(fight(a, b, 'show-1', [unarmed, unarmed]), NAMES, seq(), [a.skills, b.skills]);
  assert.ok(steps.length > 4, '该排出一串步骤');
  assert.ok(
    steps.every((step, i) => i === 0 || steps[i - 1].at <= step.at),
    '时间线按时间递增',
  );
  assert.ok(steps[steps.length - 1].at < 120_000, `整场不超过 2 分钟：实际 ${steps[steps.length - 1].at / 1000} 秒`);
});

/** 执行器用的假手：记下每次调用（`from = 'pool'` 的素材走名字形态，这里一并记下来核对） */
interface FakeSide {
  played: Array<[string, number]>;
  pooled: Array<[string, number]>;
  said: Array<[string, number]>;
  play(anim: string, rate: number, from?: 'pool'): void;
  say(line: string, durationMs: number): void;
}

function fakeSide(): FakeSide {
  const played: Array<[string, number]> = [];
  const pooled: Array<[string, number]> = [];
  const said: Array<[string, number]> = [];
  return {
    played,
    pooled,
    said,
    play: (anim, rate, from) => void (from === 'pool' ? pooled : played).push([anim, rate]),
    say: (line, durationMs) => void said.push([line, durationMs]),
  };
}

/** 注入给执行器的定时器（测试里用 mock.timers 拨时间） */
const timers = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const stepAt = (at: number, who: 0 | 1, over: Partial<Step> = {}): Step => ({ at, who, hp: [10, 10], ...over });
const SHOT: Shot = { kind: '拳风', track: 'line', flightMs: 380, count: 1, gapMs: 0, hitFx: '命中-星', hand: [1, 2] };

/** 一边演一边核对：各边的记录本 + 擂台推过的值 + 特效窗口收到的飞行物 */
function makeShow(steps: Step[], foe: FakeSide | null = fakeSide(), lead?: [number, number]) {
  const self = fakeSide();
  const arena: number[] = [];
  const shots: Array<[Shot, 0 | 1]> = [];
  const sides: ShowSides = {
    self,
    foe,
    arena: (pair) => void arena.push(pair[0]),
    shoot: (shot, who) => void shots.push([shot, who]),
  };
  return { self, foe, arena, shots, show: new BattleShow(steps, sides, timers, lead) };
}

test('执行器：按 at 依次播，台词按 LINE_MS 显示，飞行物交给特效窗口，最后一步放完才 resolve', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const { self, foe, arena, shots, show } = makeShow([
    stepAt(0, 0, { anim: '战斗-起手', rate: 1.5 }),
    stepAt(0, 1, { line: '起手' }),
    stepAt(500, 0, { shot: SHOT }),
    stepAt(SLOT_MS, 0, { line: '一拳', hp: [10, 3] }),
  ]);
  let settled = false;
  const done = show.run();
  void done.then(() => (settled = true));

  t.mock.timers.tick(0);
  assert.deepEqual(self.played, [['战斗-起手', 1.5]]);
  assert.deepEqual(foe?.said, [['起手', LINE_MS]]);
  assert.deepEqual(shots, []);

  t.mock.timers.tick(500);
  assert.deepEqual(shots, [[SHOT, 0]], '飞行物到点交给特效窗口，带上出手方');

  t.mock.timers.tick(SLOT_MS - 500);
  assert.deepEqual(self.said, [['一拳', LINE_MS]]);
  assert.deepEqual(arena, [10, 10, 10, 10]);
  assert.equal(settled, false, '台词还在显示，不算演完');

  t.mock.timers.tick(LINE_MS);
  await done;
  assert.equal(settled, true);
});

test('执行器 animLeadMs：动画按各边的提前量早发（上屏有延迟），飞行物、台词、气血照原时刻', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const { self, foe, shots, show } = makeShow(
    [
      stepAt(1_000, 0, { anim: '战斗-直拳', rate: 1.667 }),
      stepAt(1_000, 1, { anim: HIT, rate: 2.2, line: '哎哟' }),
      stepAt(1_000, 0, { shot: SHOT }),
      stepAt(50, 1, { anim: '战斗-起手', rate: 1 }),
    ],
    fakeSide(),
    [120, 80],
  );
  const done = show.run();
  t.mock.timers.tick(0);
  assert.deepEqual(foe?.played, [['战斗-起手', 1]], '提前量比 at 还大：夹到 0 立刻发');
  t.mock.timers.tick(879);
  assert.deepEqual(self.played, [], '自家宠物还没到提前的时刻');
  t.mock.timers.tick(1);
  assert.deepEqual(self.played, [['战斗-直拳', 1.667]], '自家宠物提前 120ms');
  t.mock.timers.tick(40);
  assert.deepEqual(foe?.played[foe.played.length - 1], [HIT, 2.2], '对手提前 80ms');
  assert.deepEqual(foe?.said, [], '台词不提前');
  assert.deepEqual(shots, [], '飞行物不提前');
  t.mock.timers.tick(80);
  assert.deepEqual(foe?.said, [['哎哟', LINE_MS]]);
  assert.deepEqual(shots, [[SHOT, 0]]);
  show.dispose();
  await done;
});

test('没有对手窗口（X4 渡劫）：对手那几步只是没画面，气血条照更新，不报错', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const { self, arena, show } = makeShow(
    [stepAt(0, 0, { line: '第一道雷' }), stepAt(100, 1, { anim: HIT }), stepAt(200, 0, { line: '第二道雷' })],
    null,
  );
  const done = show.run();
  t.mock.timers.tick(10_000);
  await done;
  assert.deepEqual(
    self.said.map(([line]) => line),
    ['第一道雷', '第二道雷'],
  );
  assert.deepEqual(arena, [10, 10, 10], '三步都刷了擂台');
});

test('渡劫形态整场跑一遍：雷一道道劈（天上来的飞行物）、劈中触电、失败那一下走池内素材的名字形态', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const steps = timeline(
    [start(0), strike(0, 40, [60, 0]), strike(1, 60, [0, 0]), tribEnd(false, [0, 0])],
    ['小鱼', '天雷'],
    seq(2),
    undefined,
    TRIB,
  );
  const { self, shots, show } = makeShow(steps, null);
  const done = show.run();
  t.mock.timers.tick(steps[steps.length - 1].at + LINE_MS);
  await done;
  assert.deepEqual(
    self.played.map(([anim]) => anim),
    ['修炼-触电', '修炼-触电'],
    '两道雷各一段触电（url 形态）',
  );
  assert.deepEqual(
    shots.map(([shot, who]) => [shot.kind, shot.sky, who]),
    [
      ['闪电', true, 0],
      ['闪电', true, 0],
    ],
  );
  assert.deepEqual(
    self.pooled.map(([anim]) => anim),
    ['工作状态-垂头叹气冒汗'],
    '失败收场走名字形态（池内素材）',
  );
});

test('快进：剩下的步骤不播，直接到结果（收场几步 + 最终气血），run 立即结束', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const { self, foe, arena, shots, show } = makeShow([
    stepAt(0, 0, { anim: '战斗-起手' }),
    stepAt(SLOT_MS, 0, { line: '打你' }),
    stepAt(3_000, 0, { shot: SHOT }),
    stepAt(6_000, 0, { anim: '战斗-胜利', hp: [50, 0], closing: true }),
    stepAt(6_000, 1, { line: '我赢了', hp: [50, 0], closing: true }),
  ]);
  let settled = false;
  const done = show.run();
  void done.then(() => (settled = true));
  t.mock.timers.tick(SLOT_MS);
  assert.deepEqual(self.said, [['打你', LINE_MS]]);
  show.skip();
  await done;
  assert.equal(settled, true);
  assert.deepEqual(self.played, [
    ['战斗-起手', 1],
    ['战斗-胜利', 1],
  ]);
  assert.deepEqual(foe?.said, [['我赢了', LINE_MS]]);
  assert.deepEqual(arena, [10, 10, 50, 50]);
  assert.deepEqual(shots, [], '快进掉的飞行物不再放');
  show.skip();
  assert.equal(self.played.length, 2, '已经收场，再快进不重复播');
});

test('快进时时间线没有收场那几步：至少把气血条推到最终值', async () => {
  const { arena, show } = makeShow([stepAt(0, 0, { anim: '战斗-起手', hp: [7, 3] })]);
  const done = show.run();
  show.skip();
  await done;
  assert.deepEqual(arena, [7]);
});

test('dispose：挂着的步骤一步都不再播，run 立即结束', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const { self, arena, show } = makeShow([stepAt(0, 0, { anim: '战斗-起手' }), stepAt(5_000, 0, { line: '后话' })]);
  const done = show.run();
  t.mock.timers.tick(0);
  show.dispose();
  await done;
  t.mock.timers.tick(60_000);
  assert.deepEqual(self.played, [['战斗-起手', 1]], 'dispose 之前那一步照播');
  assert.deepEqual(self.said, [], '后面的不播');
  assert.deepEqual(arena, [10]);
});

test('空时间线：run 直接结束（引擎没给事件也不能卡住调用方）', async () => {
  const { show, self } = makeShow([]);
  await show.run();
  assert.deepEqual(self.played, []);
});

test('素材都在包里：出手 / 受击素材、特效贴图、客人窗口预取清单，一个不缺', () => {
  const webm = new Set(
    readdirSync(join(packageRoot, 'assets', 'webm'))
      .filter((file) => file.endsWith('.webm'))
      .map((file) => file.slice(0, -'.webm'.length)),
  );
  for (const show of Object.values(ATTACK_SHOW)) {
    assert.ok(webm.has(show.action), `出手素材不存在：${show.action}`);
    if (show.fly?.react) assert.ok(webm.has(show.fly.react), `受击素材不存在：${show.fly.react}`);
    if (show.fly) assert.ok(RELEASE[show.action], `${show.action} 没量出手时刻`);
  }
  for (const anim of SHOW_ANIMS) assert.ok(webm.has(anim), `预取清单里的素材不存在：${anim}`);
  for (const name of FX_ASSETS) {
    assert.ok(existsSync(join(packageRoot, 'assets', 'pic', 'fx', `${name}.png`)), `特效贴图不存在：${name}`);
  }
  assert.ok(FX_ASSETS.includes('乌云'), '天雷顺带画的乌云也要预加载');
  // X16 的三段动作和三张新贴图：表里加上了就一定要真在包里、也在预取清单里
  for (const anim of ['出手-降龙', '出手-送友风', '受击-飘起']) {
    assert.ok(webm.has(anim), `X16 素材不存在：${anim}`);
    assert.ok(SHOW_ANIMS.includes(anim), `X16 素材要在预取清单里：${anim}`);
  }
  for (const name of ['金龙', '命中-龙吟', '清风']) {
    assert.ok(FX_ASSETS.includes(name as (typeof FX_ASSETS)[number]), `X16 贴图要在预取清单里：${name}`);
  }
});

test('真引擎的若干场：素材名都对得上包内素材、倍速都在 /anim 允许区间、整场不拖沓', () => {
  // 倍速越界宿主直接回 bad-request，等于那一下没动画；素材名拼错同理——逐个核到文件
  const assets = new Set(
    readdirSync(join(packageRoot, 'assets', 'webm'))
      .filter((file) => file.endsWith('.webm'))
      .map((file) => file.slice(0, -'.webm'.length)),
  );
  // X4 渡劫失败那一下是**动画池里的现有素材**（名字形态播）：除了文件在，还得真在池里（config 的
  // animations.events.workStatus 那一档），不然宿主回 unknown-animation，那一下就是没动画。
  assert.ok(assets.has(TRIBULATION_LOSS_ANIM), `${TRIBULATION_LOSS_ANIM} 有素材文件`);
  const pool = readFileSync(join(packageRoot, 'assets', 'config.jsonc'), 'utf8');
  assert.match(
    pool.slice(pool.indexOf('"workStatus"')),
    new RegExp(`${TRIBULATION_LOSS_ANIM}"`),
    '池子里点得到它（用户没换配置时）',
  );
  const played = new Set<string>();
  for (let stage = 0; stage <= MAX_STAGE; stage += 1) {
    const you = fighterAt(stage, seq(stage));
    const foe = shadowOf(you);
    const tribulated = tribulate(you, tribulationStrikes(stage + 1), stage, `tribulate-${stage}`);
    for (const [events, options] of [
      [fight(you, foe, `sweep-${stage}`, [unarmed, unarmed]), undefined] as const,
      [fight(you, foe, `sweep-auto-${stage}`), undefined] as const,
      // 渡劫：吃丹不吃丹两种开场 × 扛住没扛住两种收场（雷数照 §X4 的规则，境界扫到顶也就排到 9 道）
      [tribulated, { tribulation: { pill: false } }] as const,
      [tribulated, { tribulation: { pill: true } }] as const,
    ]) {
      const steps = timeline(events, [you.name, foe.name], seq(), [you.skills, foe.skills], options);
      for (const step of steps) {
        if (step.anim) {
          assert.ok(assets.has(step.anim), `素材不存在：${step.anim}`);
          played.add(step.anim);
        }
        if (step.rate !== undefined) assert.ok(step.rate >= 0.5 && step.rate <= 3, `倍速越界：${step.rate}`);
        // 渡劫这一场只有自家这一边（没有对手窗口）：排到 who = 1 就是映射漏了
        if (options) assert.equal(step.who, 0, `渡劫不该有对手那一边：${step.anim ?? step.line}`);
      }
      assert.ok(steps[steps.length - 1].at < 120_000, `整场不超过 2 分钟：${steps[steps.length - 1].at / 1000}`);
    }
  }
  // 境界扫到顶时 fighterAt 攒得出这几门被动招式：没演到就是扫描白跑（招式攒不满、映射没生效都算）
  for (const anim of ['出手-召唤灵兽', '出手-第六感', '战斗-连拳', BUBBLE, '修炼-触电']) {
    assert.ok(played.has(anim), `这批扫描没演到 ${anim}`);
  }
  for (const anim of [TRIBULATION_PILL_ANIM, TRIBULATION_WIN_ANIM, TRIBULATION_LOSS_ANIM]) {
    assert.ok(played.has(anim), `扫描没演到 ${anim}`);
  }
});

test('X8 银托盘：一只托盘回旋两段——擦过正面、绕到背后再磕一下、飞回手里接住；第一段被躲开也照样绕回来磕', () => {
  const tray: Action = { kind: 'weapon', weapon: 'tray' };
  const steps = timeline(
    [start(0), decide(0, tray), hit(0, 6, [100, 84], false, 'tray'), hit(0, 6, [100, 78], false, 'tray')],
    NAMES,
    seq(),
  );
  const [shot] = shotsOf(steps);
  assert.equal(shotsOf(steps).length, 1);
  assert.equal(shot.at, OPEN_MS + releaseOffset('出手-托盘'));
  assert.equal(shot.shot.boomerang?.second, 'hit');
  const second = shot.at + (shot.shot.boomerang?.secondMs ?? 0);
  // 两次掉血：第一段在擦过正面时，第二段在绕到背后时
  assert.deepEqual(
    steps.filter((step) => step.line).map((step) => step.at),
    [impactOf(shot), second],
  );
  // 回到手里的那一刻对准素材里接住托盘的那一帧（出手素材按 3 秒的窗口播）
  const rate = actionRate('出手-托盘');
  assert.equal(rate, rateFor('出手-托盘', 3_000));
  assert.equal(
    shot.at + (shot.shot.boomerang?.totalMs ?? 0),
    OPEN_MS + Math.round((RELEASE['出手-托盘'].catchMs ?? 0) / rate),
  );
  // 第一段被躲开：托盘从头顶掠过，绕回来第二段必中，对方的反应对准第二段
  const dodged = timeline([start(0), decide(0, tray), dodge(1), hit(0, 6, [100, 84], false, 'tray')], NAMES, seq());
  const [loop] = shotsOf(dodged);
  assert.deepEqual([loop.shot.miss, loop.shot.boomerang?.second], [true, 'hit']);
  const react = animsOf(dodged, HIT)[0];
  assert.equal(react.at, loop.at + (loop.shot.boomerang?.secondMs ?? 0) - windupOf(HIT));
  // 第一段就打倒了（没有第二段）：托盘照样飞回来，第二个命中点不放特效
  const ko = timeline([start(0), decide(0, tray), hit(0, 99, [100, 0], false, 'tray')], NAMES, seq());
  assert.equal(shotsOf(ko)[0].shot.boomerang?.second, 'none');
});

test('X8 弹弓：一发打两颗时两颗星星糖几乎一起飞出去', () => {
  const sling: Action = { kind: 'weapon', weapon: 'slingshot' };
  const one = shotsOf(timeline([start(0), decide(0, sling), hit(0, 8, [100, 82], false, 'slingshot')], NAMES, seq()));
  assert.deepEqual([one[0].shot.kind, one[0].shot.count], ['星星糖', 1]);
  const twin = { ...hit(0, 16, [100, 74], false, 'slingshot'), twin: true } as BattleEvent;
  const two = shotsOf(timeline([start(0), decide(0, sling), twin], NAMES, seq()));
  assert.deepEqual([two[0].shot.count, two[0].shot.gapMs], [2, 70]);
});

test('X8 鲸歌：音符飘过去对方打瞌睡；跳过的那一拍再演一遍犯困（冻住的那一拍演冻僵），不切断上一段', () => {
  const steps = timeline(
    [
      start(0),
      decide(0, { kind: 'skill', skill: 'whale-song' }),
      { actor: 0, kind: 'skill', skill: 'whale-song', hp },
      { actor: 1, kind: 'skip', cause: 'sleep', hp },
    ],
    NAMES,
    seq(),
  );
  const [notes] = shotsOf(steps);
  assert.deepEqual([notes.shot.kind, notes.shot.track, notes.shot.count], ['音符', 'float', 3]);
  const sleepy = animsOf(steps, '受击-犯困');
  assert.equal(sleepy.length, 2, '中招一次、跳过的那一拍再一次');
  assert.equal(sleepy[0].at, impactOf(notes) - windupOf('受击-犯困'));
  assertNoCut(steps, '鲸歌');
  const frozen = timeline(
    [
      start(0),
      decide(0, { kind: 'weapon', weapon: 'snowball' }),
      hit(0, 6, [100, 84], false, 'snowball'),
      { actor: 1, kind: 'skip', cause: 'freeze', hp: [100, 84] },
    ],
    NAMES,
    seq(),
  );
  assert.equal(animsOf(frozen, '受击-冻僵').length, 2);
  // 晕了（stun）照旧只有台词
  const stunned = timeline([start(0), { actor: 1, kind: 'skip', cause: 'stun', hp }], NAMES, seq());
  assert.equal(stunned.filter((step) => step.anim && step.at >= OPEN_MS).length, 0);
});

test('X8 墨汁与致盲：糊脸那一下对方演糊脸；被糊眼的一方出手打空，飞行物远远打歪、对方不反应', () => {
  const steps = timeline(
    [
      start(0),
      decide(0, { kind: 'skill', skill: 'ink' }),
      { actor: 0, kind: 'skill', skill: 'ink', hp },
      decide(1, { kind: 'weapon', weapon: 'poker' }),
      { actor: 1, kind: 'miss', hp },
      hit(1, 6, [94, 90], false, 'poker'),
    ],
    NAMES,
    seq(),
  );
  const [ink, wild, landed] = shotsOf(steps);
  assert.equal(ink.shot.kind, '墨汁');
  assert.equal(animsOf(steps, '受击-墨汁')[0]?.at, impactOf(ink) - windupOf('受击-墨汁'));
  assert.deepEqual([wild.who, wild.shot.wild, landed.shot.wild], [1, true, undefined]);
  // 打空的那张牌：自家宠物不躲也不挨；打中的那张照常受击
  const selfReacts = steps.filter((step) => step.who === 0 && step.anim && step.at > ink.at);
  assert.deepEqual(
    selfReacts.map((step) => [step.anim, step.at]),
    [[HIT, impactOf(landed) - windupOf(HIT)]],
  );
});

test('X8 鲸吞：灵光从对方身上被吸走（放出那一刻对方就起反应），最后一颗飞回嘴边时掉血回血一起结算', () => {
  const steps = timeline(
    [
      start(0),
      decide(0, { kind: 'skill', skill: 'whale-gulp' }),
      { actor: 0, kind: 'skill', skill: 'whale-gulp', damage: 20, heal: 10, hp: [100, 70] },
    ],
    NAMES,
    seq(),
  );
  const [suck] = shotsOf(steps);
  assert.deepEqual([suck.shot.kind, suck.shot.reverse, suck.shot.count], ['灵光', true, 6]);
  assert.deepEqual(suck.shot.hand, RELEASE['出手-鲸吞'].hand, '终点是出手方的嘴');
  const arrive = suck.at + suck.shot.flightMs + (suck.shot.count - 1) * suck.shot.gapMs;
  assert.equal(animsOf(steps, HIT)[0]?.at, suck.at - windupOf(HIT), '被吸的那一刻就起反应');
  const settled = steps.find((step) => step.line);
  assert.deepEqual([settled?.at, settled?.hp], [arrive, [100, 70]]);
});

test('X8 水母分身：那一下打在原地的水母替身上（decoy），本体侧身躲开，闪避对准命中', () => {
  const steps = timeline(
    [start(0), decide(0, { kind: 'weapon', weapon: 'firework' }), { actor: 1, kind: 'decoy', hp }],
    NAMES,
    seq(),
    [[], ['jelly-clone']],
  );
  const [shot] = shotsOf(steps);
  assert.equal(shot.shot.decoy, true);
  assert.deepEqual(
    steps.filter((step) => step.who === 1 && step.anim && step.at >= OPEN_MS).map((step) => [step.anim, step.at]),
    [['战斗-闪避', impactOf(shot) - windupOf('战斗-闪避')]],
  );
  assert.equal(animsOf(steps, '受击-炸黑').length, 0, '本体没挨着');
});

test('X17 逐手演出：分段追加的时间线和整场生成的时间线对得上（时刻、动作、台词）', () => {
  const a = { ...fighterAt(10, () => 0.37), name: '小鱼' };
  const b = { ...fighterAt(10, () => 0.61), name: '心魔' };
  const events = fight(a, b, 'live-timeline');
  // 每个 decide 之前是一个决策点：前缀 = 从头到这一手之前；最后再补整场
  const cuts = events.flatMap((event, index) => (event.kind === 'decide' ? [index] : []));
  const prefixes = [...cuts.map((index) => events.slice(0, index)), events];
  const live = new LiveTimeline(NAMES, seq(), [a.skills, b.skills]);
  const segmented = prefixes.flatMap((prefix) => live.push(prefix));
  const whole = timeline(events, NAMES, seq(), [a.skills, b.skills]);
  assert.deepEqual(segmented, whole, '分段接起来必须和整场时间线一致');
  assert.deepEqual(live.steps(), whole, '已经排好的全部步骤也一致');
  assert.ok(segmented.length > 0);
});

test('X17 逐手演出：AI 给的台词替掉这一手模板解说里自家宠物的那句', () => {
  const a = { ...fighterAt(10, () => 0.37), name: '小鱼' };
  const b = { ...fighterAt(10, () => 0.61), name: '心魔' };
  const events = fight(a, b, 'live-line');
  const index = events.findIndex((event) => event.kind === 'decide' && event.actor === 0);
  assert.ok(index >= 0, '这一场有自家的 decide');
  const line = '先用陀螺晕住它！';
  const steps = timeline(events, NAMES, seq(), [a.skills, b.skills], {
    decideLines: new Map([[index, line]]),
  });
  assert.ok(
    steps.some((step) => step.who === 0 && step.line === line),
    'AI 的台词排在出手那一刻',
  );
  const plain = timeline(events, NAMES, seq(), [a.skills, b.skills]);
  const template = plain.filter((step) => step.who === 0 && step.line && step.line !== line).length;
  assert.ok(
    steps.filter((step) => step.who === 0 && step.line && step.line !== line).length <= template,
    '这一手自家宠物的模板解说被替掉了一句',
  );
});

test('X16 降龙十八掌：冲过去推掌（正好在离手那一刻到），金龙约 200ms 扑到身上，打中后退回原位', () => {
  const action: Action = { kind: 'skill', skill: 'dragon-palm' };
  const landed: BattleEvent = { actor: 0, kind: 'skill', skill: 'dragon-palm', damage: 28, hp: [100, 62] };
  const steps = timeline([start(0), decide(0, action), landed], NAMES, seq());
  const show = ATTACK_SHOW['dragon-palm'];
  assert.deepEqual(show.dash, { outMs: 260, backMs: 320 });
  const [actionStep] = animsOf(steps, '出手-降龙');
  assert.ok(actionStep, '播出手-降龙');
  const release = actionStep.at + releaseOffset('出手-降龙');
  const [shot] = shotsOf(steps);
  assert.deepEqual(
    [shot.shot.kind, shot.shot.track, shot.shot.hitFx, shot.shot.flightMs],
    ['金龙', 'surge', '命中-龙吟', 200],
  );
  assert.equal(shot.at, release, '金龙在推掌伸到最远那一刻从掌心出去');
  const dashes = steps.filter((step) => step.dash);
  assert.deepEqual(
    dashes.map((step) => [step.at, step.who, step.dash]),
    [
      [Math.max(OPEN_MS, release - 260), 0, { dir: 'out', ms: 260 }],
      [impactOf(shot), 0, { dir: 'back', ms: 320 }],
    ],
    '出掌前 260ms 冲过去，命中那一刻往回退 320ms',
  );
  // 冲上去那一步没有动画和台词：只有位移
  assert.equal(dashes[0].anim, undefined);
  assert.equal(dashes[0].line, undefined);
});

test('X16 冲刺只给降龙十八掌：空手、鲸尾这些照旧原地出招，没有 dash 步', () => {
  for (const action of [
    { kind: 'unarmed' } as Action,
    { kind: 'weapon', weapon: 'whale-tail' } as Action,
    { kind: 'skill', skill: 'farewell-wind' } as Action,
  ]) {
    const landed: BattleEvent =
      action.kind === 'skill'
        ? { actor: 0, kind: 'skill', skill: 'farewell-wind', damage: 12, hp: [100, 78] }
        : { actor: 0, kind: 'hit', damage: 8, crit: false, blocked: false, hp: [100, 82] };
    const steps = timeline([start(0), decide(0, action), landed], NAMES, seq());
    assert.equal(steps.filter((step) => step.dash).length, 0, `${JSON.stringify(action)} 不该冲`);
  }
});

test('X16 后劲：带 surge 的那一下命中处多打一发（Shot.surge），没带就没有', () => {
  const normal = timeline([start(0), decide(0, UNARMED), hit(0, 20, [100, 70])], NAMES, seq());
  assert.equal(shotsOf(normal)[0].shot.surge, undefined);
  const surged: BattleEvent = {
    actor: 0,
    kind: 'hit',
    damage: 26,
    crit: false,
    blocked: false,
    surge: true,
    hp: [100, 64],
  };
  const steps = timeline([start(0), decide(0, UNARMED), surged], NAMES, seq());
  assert.equal(shotsOf(steps)[0].shot.surge, true);
  // 追击（combo）也认
  const comboEvent: BattleEvent = {
    actor: 0,
    kind: 'combo',
    damage: 9,
    crit: false,
    blocked: false,
    surge: true,
    hp: [100, 55],
  };
  const comboSteps = timeline([start(0), decide(0, UNARMED), hit(0), comboEvent], NAMES, seq());
  assert.equal(shotsOf(comboSteps)[1].shot.surge, true);
});

test('X16 送友风：清风慢飘过去，命中-旋风；飘起来那一拍挨打方重播受击-飘起', () => {
  const action: Action = { kind: 'skill', skill: 'farewell-wind' };
  const events: BattleEvent[] = [
    start(0),
    decide(0, action),
    { actor: 0, kind: 'skill', skill: 'farewell-wind', damage: 16, hp: [100, 74] },
    { actor: 1, kind: 'skip', cause: 'float', hp: [100, 74] },
  ];
  const steps = timeline(events, NAMES, seq());
  const [shot] = shotsOf(steps);
  assert.deepEqual(
    [shot.shot.kind, shot.shot.track, shot.shot.hitFx, shot.shot.flightMs],
    ['清风', 'float', '命中-旋风', 900],
  );
  assert.equal(shot.at, animsOf(steps, '出手-送友风')[0].at + releaseOffset('出手-送友风'));
  const floats = animsOf(steps, '受击-飘起');
  assert.ok(floats.length >= 2, `命中一次、跳过那一拍再演一次：${floats.length}`);
  assert.deepEqual(
    floats.map((step) => step.who),
    [1, 1],
  );
  assert.equal(floats[0].at, impactOf(shot) - windupOf('受击-飘起'), '命中那一刻开始飘（前摇 42ms）');
});

test('X16 串门里送走（end.reason = farewell）：不演胜利 / 倒地，被送走的飘起来，收场几步能快进', () => {
  const action: Action = { kind: 'skill', skill: 'farewell-wind' };
  const events: BattleEvent[] = [
    start(0),
    decide(0, action),
    { actor: 0, kind: 'skill', skill: 'farewell-wind', damage: 16, hp: [100, 74] },
    { actor: 0, kind: 'end', winner: 0, reason: 'farewell', hp: [100, 74] },
  ];
  const steps = timeline(events, NAMES, seq());
  assert.equal(animsOf(steps, '战斗-胜利').length, 0, '送走不是打赢，不播胜利');
  assert.equal(animsOf(steps, '战斗-倒地').length, 0, '被送走不是倒地');
  const floats = animsOf(steps, '受击-飘起');
  assert.ok(floats.length >= 1 && floats.every((step) => step.who === 1), '客人飘起来');
  const closing = steps.filter((step) => step.closing);
  assert.ok(
    closing.some((step) => step.anim === '受击-飘起'),
    '飘起属于收场：快进也要演',
  );
  assert.ok(
    closing.some((step) => step.line),
    '送走的台词也在收场',
  );
});

test('执行器 X16：dash 步到点交给冲刺的手；自然演完 / 快进都收一下冲刺（快进立刻复位）', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const calls: Array<[0 | 1, string, number]> = [];
  const ends: boolean[] = [];
  const sides: ShowSides = {
    self: fakeSide(),
    foe: fakeSide(),
    arena: () => undefined,
    shoot: () => undefined,
    dash: (who, dir, ms) => void calls.push([who, dir, ms]),
    dashEnd: (force) => void ends.push(force ?? false),
  };
  const dashStep: Step = { at: 300, who: 0, hp: [10, 10], dash: { dir: 'out', ms: 260 } };
  const show = new BattleShow([dashStep], sides, timers);
  const done = show.run();
  t.mock.timers.tick(299);
  assert.deepEqual(calls, [], '还没到点');
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [[0, 'out', 260]]);
  t.mock.timers.tick(LINE_MS);
  await done;
  assert.deepEqual(ends, [false], '自然演完：让还在退的那一步退完，不硬拽');

  const skipped = new BattleShow([dashStep], sides, timers);
  const pending = skipped.run();
  skipped.skip();
  await pending;
  assert.deepEqual(ends, [false, true], '快进：立刻复位');
});

test('X21 万我大手印：巨掌从天上压下来，对方播受击-碾压', () => {
  const landed: BattleEvent = {
    actor: 0,
    kind: 'skill',
    skill: 'myriad-palm',
    damage: 28,
    sealed: 'weapon',
    hp: [100, 62],
  };
  const steps = timeline([start(0), decide(0, { kind: 'skill', skill: 'myriad-palm' }), landed], NAMES, seq());
  const [shot] = shotsOf(steps);
  assert.deepEqual(
    [shot.shot.kind, shot.shot.track, shot.shot.hitFx, shot.shot.flightMs],
    ['巨掌', 'slam', '命中-巨浪', 700],
  );
  assert.ok(
    steps.some((step) => step.who === 1 && step.anim === '受击-碾压'),
    '对方播受击-碾压',
  );
});

test('X21 前有古人：古人虚影从出手方冲出去补一击，命中那一刻对方受击', () => {
  const steps = timeline(
    [
      start(0),
      decide(0, { kind: 'skill', skill: 'ancients' }),
      { actor: 0, kind: 'skill', skill: 'ancients', hp: [100, 100] },
      decide(0, { kind: 'unarmed' }),
      { actor: 0, kind: 'ancient', damage: 80, hp: [100, 20] },
    ],
    NAMES,
    seq(),
  );
  const [shot] = shotsOf(steps);
  assert.deepEqual([shot.shot.kind, shot.shot.track, shot.shot.hitFx], ['古人虚影', 'line', '命中-斩']);
  assert.ok(
    steps.some((step) => step.who === 1 && step.anim === '受击-正面'),
    '补的那一击对方要起反应',
  );
});

test('X21 吃苦吃亏：咬一口时对方播受击-被吃，吃泡泡不播受击', () => {
  const base = [start(0), decide(0, { kind: 'skill', skill: 'eat-hardship' })];
  const cast: BattleEvent = { actor: 0, kind: 'skill', skill: 'eat-hardship', hp: [100, 100] };
  const bite = timeline(
    [...base, cast, { actor: 0, kind: 'devour', what: 'bite', damage: 44, heal: 22, hp: [100, 56] }],
    NAMES,
    seq(),
  );
  assert.ok(
    bite.some((step) => step.who === 1 && step.anim === '受击-被吃'),
    '咬一口对方有反应',
  );
  const bubble = timeline(
    [...base, cast, { actor: 0, kind: 'devour', what: 'bubble', heal: 15, hp: [100, 100] }],
    NAMES,
    seq(),
  );
  assert.ok(
    !bubble.some((step) => step.who === 1 && step.anim === '受击-被吃'),
    '吃泡泡只刷血条与台词，对方不播被吃的受击',
  );
});

test('X21 逆流护身印：白袍铺在出手方身上，反弹那一刻只刷台词与血条，不切断攻击方刚出的手', () => {
  const steps = timeline(
    [
      start(0),
      decide(1, { kind: 'skill', skill: 'reverse-seal' }),
      { actor: 1, kind: 'skill', skill: 'reverse-seal', hp: [100, 100] },
      { actor: 1, kind: 'reverse', damage: 14, hp: [86, 100] },
    ],
    NAMES,
    seq(),
  );
  const [robe] = shotsOf(steps);
  assert.deepEqual([robe.shot.kind, robe.shot.hold?.anchor, robe.who], ['逆流袍', 'self', 1]);
  assert.ok(robe.shot.hold && robe.shot.hold.ms >= 2_000, '白袍要铺满一整个回合，不是闪一下');
  assert.ok(
    steps.some((step) => step.line && step.who === 1),
    '反弹这一刻出「原样打回」的台词',
  );
  assert.ok(
    steps.some((step) => step.hp[0] === 86 && step.hp[1] === 100),
    '血条在反弹那一刻刷新',
  );
  assert.ok(!steps.some((step) => step.anim === '受击-正面'), '不另起一段受击（攻击方的出手还在播）');
});

test('X22 鬼手：鬼手贴图掐过去，对方播受击-掐住', () => {
  const landed: BattleEvent = {
    actor: 0,
    kind: 'skill',
    skill: 'ghost-hand',
    damage: 30,
    sealed: 'skill',
    hp: [100, 70],
  };
  const steps = timeline([start(0), decide(0, { kind: 'skill', skill: 'ghost-hand' }), landed], NAMES, seq());
  const [shot] = shotsOf(steps);
  assert.deepEqual([shot.shot.kind, shot.shot.track, shot.shot.hitFx], ['鬼手', 'thrust', '命中-斩']);
  assert.ok(
    steps.some((step) => step.who === 1 && step.anim === '受击-掐住'),
    '对方播受击-掐住',
  );
});

test('X22 无头鬼影：黑影冲出去取首级，对方播受击-断头', () => {
  const landed: BattleEvent = {
    actor: 0,
    kind: 'skill',
    skill: 'headless-shadow',
    damage: 40,
    behead: true,
    hp: [100, 0],
  };
  const steps = timeline([start(0), decide(0, { kind: 'skill', skill: 'headless-shadow' }), landed], NAMES, seq());
  const [shot] = shotsOf(steps);
  assert.deepEqual([shot.shot.kind, shot.shot.hitFx], ['无头鬼影', '命中-魂碎']);
  assert.ok(
    steps.some((step) => step.who === 1 && step.anim === '受击-断头'),
    '对方播受击-断头',
  );
});

test('X22 鬼敲门：门立在两只中间，敲门声只刷台词与血条，不排受击切断它自己的出手', () => {
  const steps = timeline(
    [
      start(0),
      decide(0, { kind: 'skill', skill: 'ghost-knock' }),
      { actor: 0, kind: 'skill', skill: 'ghost-knock', hp: [100, 100] },
      { actor: 1, kind: 'knock', damage: 26, hp: [100, 74] },
      decide(1, { kind: 'unarmed' }),
    ],
    NAMES,
    seq(),
  );
  const [door] = shotsOf(steps);
  assert.deepEqual([door.shot.kind, door.shot.hold?.anchor], ['门', 'mid']);
  assert.ok((door.shot.hold?.shake ?? 0) > 0, '门要跟着敲门声轻颤');
  assert.ok(
    shotsOf(steps).some((step) => step.shot.hold?.anchor === 'self' && step.shot.kind === '门'),
    '敲门声真的响那一刻，门在挨门的人面前再抖一下',
  );
  assert.ok(
    steps.some((step) => step.line && step.who === 1),
    '敲门的台词',
  );
  assert.ok(
    steps.some((step) => step.hp[1] === 74),
    '血条在敲门那一刻刷新',
  );
  assert.ok(!steps.some((step) => step.anim === '受击-门响'), '不排整段受击');
});

test('X22 鬼画：符纹从指尖飞过去贴在对方身上', () => {
  const steps = timeline(
    [
      start(0),
      decide(0, { kind: 'skill', skill: 'ghost-painting' }),
      { actor: 0, kind: 'skill', skill: 'ghost-painting', paint: 'bubble', hp: [100, 100] },
    ],
    NAMES,
    seq(),
  );
  const shots = shotsOf(steps);
  assert.deepEqual([shots[0].shot.kind, shots[0].shot.track], ['符画', 'line']);
  // X24：符纹等手指画完才离手（素材 2.7 秒处），不能一出招就飞过去
  const cast = steps.find((step) => step.anim === '出手-鬼画');
  assert.ok(cast, '要先播画符的出手动作');
  assert.equal(shots[0].at, cast.at + releaseOffset('出手-鬼画'), '符纹在离手时刻起飞');
  const stick = shots.find((step) => step.shot.hold);
  assert.ok(stick, '符纹贴上以后要停在对方身上一会儿');
  assert.deepEqual([stick!.shot.kind, stick!.shot.hold?.anchor], ['符画', 'foe']);
  assert.equal(stick!.at, shots[0].at + shots[0].shot.flightMs, '贴在对方身上的时刻就是命中时刻');
  assert.equal(stick!.shot.hold?.dy, 0.1, '往下挪一点，别糊在脸上');
});

test('X22 鬼血：三颗血珠一起飞过去', () => {
  const steps = timeline(
    [
      start(0),
      decide(0, { kind: 'skill', skill: 'ghost-blood' }),
      { actor: 0, kind: 'skill', skill: 'ghost-blood', damage: 30, hp: [100, 70] },
    ],
    NAMES,
    seq(),
  );
  const [shot] = shotsOf(steps);
  assert.deepEqual([shot.shot.kind, shot.shot.count], ['血珠', 3]);
});
