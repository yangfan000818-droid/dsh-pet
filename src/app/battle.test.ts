import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  fight,
  fightUntilDecision,
  fallbackAction,
  legalActions,
  fairSparPair,
  rngFrom,
  tribulate,
  shadowOf,
  statCap,
  majorBreaks,
  autoController,
  MAX_ACTIONS,
  WEAPON_IDS,
  SKILL_IDS,
  type Fighter,
  type SkillId,
  type Controller,
  type BattleView,
  type BattleEvent,
  type Action,
  startingHp,
  SPAR_DAMAGE_SCALE,
  SPAR_MAX_HIT_SHARE,
} from './battle.ts';
import { fighterAt, seededRng } from './battle-testkit.ts';

const named = (f: Fighter, name: string): Fighter => ({ ...f, name });

const unarmedOnly = (): Controller => ({ decide: () => ({ kind: 'unarmed' }) });

/** 在固定种子里找到第一个让 predicate 成立的事件序列；找不到就返回 null 让测试报错 */
function findFight(
  make: (rng: () => number) => [Fighter, Fighter],
  predicate: (events: BattleEvent[]) => boolean,
  tries = 300,
): BattleEvent[] | null {
  for (let i = 0; i < tries; i++) {
    const [a, b] = make(seededRng(i * 7 + 1));
    const events = fight(named(a, '甲'), named(b, '乙'), `find-${i}`);
    if (predicate(events)) return events;
  }
  return null;
}

test('同种子同结果，不同种子不同结果', () => {
  const mk = (seed: number) => {
    const [a, b] = [fighterAt(6, seededRng(seed)), fighterAt(6, seededRng(seed + 100))];
    return fight(named(a, '甲'), named(b, '乙'), 'seed-1');
  };
  const first = mk(1);
  assert.deepEqual(mk(1), first, '输入和种子都相同必然同一场');
  assert.notDeepEqual(mk(2), first, '换了种子应该是另一场');
});

test('X17 逐手：两边都是 auto 时和 fight() 逐条一样（固定一批种子）', () => {
  for (let i = 0; i < 20; i++) {
    const a = named(fighterAt(8, seededRng(i)), '甲');
    const b = named(fighterAt(8, seededRng(i + 100)), '乙');
    const seed = `auto-${i}`;
    const whole = fight(a, b, seed);
    const stepwise = fightUntilDecision(a, b, seed, ['auto', 'auto']);
    assert.equal(stepwise.need, null);
    assert.deepEqual(stepwise.events, whole, `种子 ${seed}：逐手模式两边都自动，事件必须一字不差`);
  }
});

test('X17 逐手：一边一串定好的手，每补一手从头算，前缀与对面的挑法都不变', () => {
  const a = named(fighterAt(10, seededRng(3)), '甲');
  const b = named(fighterAt(10, seededRng(4)), '乙');
  const seed = 'predetermined';
  const decisions: Action[] = [];
  const prefixes: BattleEvent[][] = [];
  let result = fightUntilDecision(a, b, seed, [[], 'auto']);
  while (result.need) {
    assert.equal(result.need.side, 0, '只有自家这一边是定好的手');
    prefixes.push(result.events);
    const legal = legalActions(result.need.view);
    assert.ok(legal.length > 0);
    decisions.push(legal[decisions.length % legal.length]!);
    const next = fightUntilDecision(a, b, seed, [decisions, 'auto']);
    assert.deepEqual(next.events.slice(0, result.events.length), result.events, '补一手后之前的事件前缀不变');
    result = next;
  }
  assert.ok(prefixes.length > 0);
  // 对面只吃决策随机数：用同一个种子单独喂它，最终事件应和逐步重算的一字不差
  const replay = [...decisions];
  const self: Controller = { decide: () => replay.shift() ?? { kind: 'unarmed' } };
  const expected = fight(a, b, seed, [self, autoController(rngFrom(seed + ':decide'))]);
  assert.deepEqual(result.events, expected, '对面的挑法不因自家补手而变');
});

test('X17 legalActions：不列用过的主动招、次数用完的招；法宝、空手、被动不列', () => {
  const view: BattleView = {
    self: 0,
    hp: [50, 50],
    maxHp: [50, 50],
    you: {
      weapons: ['water-gun'],
      skills: ['bloom', 'dove', 'finger-sword'],
      used: ['bloom'],
      moves: ['gu-egg', 'gu-dogs'],
      moveUses: ['gu-egg', 'gu-egg', 'gu-egg'],
    },
    foe: { weapons: [], skills: [] },
  };
  assert.deepEqual(legalActions(view), [
    { kind: 'weapon', weapon: 'water-gun' },
    { kind: 'unarmed' },
    { kind: 'skill', skill: 'finger-sword' },
    { kind: 'move', move: 'gu-dogs' },
  ]);
});

test('X17 fallbackAction：单独一路随机数，不吃决策随机数（换对手的挑法不会变）', () => {
  const a = named(fighterAt(10, seededRng(7)), '甲');
  const b = named(fighterAt(10, seededRng(8)), '乙');
  const seed = 'fallback';
  const decisions: Action[] = [];
  let result = fightUntilDecision(a, b, seed, [[], 'auto']);
  while (result.need) {
    decisions.push(fallbackAction(result.need.view, seed, decisions.length));
    result = fightUntilDecision(a, b, seed, [decisions, 'auto']);
  }
  let index = 0;
  const self: Controller = { decide: (view) => fallbackAction(view, seed, index++) };
  const expected = fight(a, b, seed, [self, autoController(rngFrom(seed + ':decide'))]);
  assert.deepEqual(result.events, expected, '后备挑法若吃了决策随机数，对面的挑法会和这里对不上');
});

test('换出招者后结算序列照样可复现', () => {
  const a = fighterAt(6, seededRng(3));
  const b = fighterAt(6, seededRng(4));
  const run = () => fight(named(a, '甲'), named(b, '乙'), 'ctrl-seed', [unarmedOnly(), unarmedOnly()]);
  assert.deepEqual(run(), run(), '两边都换成永远空手，重放仍然一致');
  // 自动出招的同一场也可复现（默认两路随机数只由种子决定）
  assert.deepEqual(
    fight(named(a, '甲'), named(b, '乙'), 'ctrl-seed'),
    fight(named(a, '甲'), named(b, '乙'), 'ctrl-seed'),
  );
});

test('事件里的 hp 与逐事件推演一致，且不为负', () => {
  for (let i = 0; i < 20; i++) {
    const a = named(fighterAt(6, seededRng(i)), '甲');
    const b = named(fighterAt(6, seededRng(i + 50)), '乙');
    const events = fight(a, b, `hp-${i}`);
    const hp: [number, number] = [a.hp, b.hp];
    for (let idx = 0; idx < events.length; idx++) {
      const e = events[idx];
      if (e.kind === 'start') {
        assert.deepEqual(e.hp, [a.hp, b.hp]);
        continue;
      }
      const other = (e.actor ^ 1) as 0 | 1;
      if (e.kind === 'hit' || e.kind === 'combo' || e.kind === 'counter' || e.kind === 'beast' || e.kind === 'strike') {
        hp[other] = Math.max(0, hp[other] - e.damage);
      } else if (e.kind === 'skill') {
        if (e.damage) hp[other] = Math.max(0, hp[other] - e.damage);
        if (e.heal) hp[e.actor] = Math.min(e.actor === 0 ? a.hp : b.hp, hp[e.actor] + e.heal);
      } else if (e.kind === 'play-dead') {
        hp[e.actor] = 1; // 刚被打到 0，假死遁救回 1 点（play-dead 事件跟在那一击后面）
      }
      // 假死遁救场时，那一击事件里的 hp 已经是救回后的 1 点，下一个 play-dead 事件会正式记账
      const revived = hp[other] === 0 && e.hp[other] === 1 && events[idx + 1]?.kind === 'play-dead';
      if (!revived) assert.deepEqual(e.hp, hp, `事件 ${e.kind} 的 hp 对不上（种子 hp-${i}）`);
      if (revived) hp[other] = 1;
      assert.ok(e.hp[0] >= 0 && e.hp[1] >= 0, 'hp 不能为负');
    }
  }
});

test('任何一场出手都不超过 30 次封顶', () => {
  // 现在的数值下破势项让每次攻击都实打实掉血，对打总在封顶前分出胜负；封顶规则保留兜底
  for (let i = 0; i < 40; i++) {
    const a = named(fighterAt(10, seededRng(i)), '甲');
    const b = named(fighterAt(10, seededRng(i + 200)), '乙');
    const events = fight(a, b, `cap-${i}`);
    const end = events[events.length - 1];
    assert.equal(end.kind, 'end');
    assert.equal(end.reason, 'ko');
    assert.ok(
      events.filter((e) => e.kind === 'decide' || e.kind === 'skip').length <= MAX_ACTIONS,
      '出手次数不能超过封顶',
    );
  }
});

test('出招者交代不合法的动作时按空手处理：不会递归、不会回血两次', () => {
  // 总是选凭空生花：第一次合法（回血 + 补一次出手），之后已经用过，再要也只是空手
  const spam: Controller = { decide: () => ({ kind: 'skill', skill: 'bloom' }) };
  const a: Fighter = { name: '甲', hp: 60, power: 3, agility: 3, speed: 3, weapons: [], skills: ['bloom'] };
  const b: Fighter = { name: '乙', hp: 60, power: 3, agility: 3, speed: 3, weapons: [], skills: [] };
  const events = fight(a, b, 'spam', [spam, spam]);
  const heals = events.filter((e) => e.kind === 'skill' && e.skill === 'bloom');
  assert.equal(heals.length, 1, '凭空生花一场只回一次血');
  // decide 事件记的是实际执行的动作：只有第一次是生花，其余交代生花也按空手执行
  const asked = events.filter((e) => e.kind === 'decide' && e.action.kind === 'skill');
  assert.equal(asked.length, 1);
  // 没有的法宝 / 没有的招式（被动也算）同样按空手
  const weird: Controller = {
    decide: (view) =>
      view.self === 0 ? { kind: 'weapon', weapon: 'firework' } : { kind: 'skill', skill: 'play-dead' },
  };
  const events2 = fight(a, b, 'weird', [weird, weird]);
  assert.ok(
    events2.every((e) => e.kind !== 'decide' || e.action.kind === 'unarmed'),
    '不合法动作都按空手执行',
  );
  assert.ok(
    events2.some((e) => e.kind === 'hit'),
    '空手也真的在打',
  );
});

test('主动招式都会被用出来，事件里带招式编号', () => {
  const actives: SkillId[] = [
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
  for (const skill of actives) {
    const events = findFight(
      (rng) => {
        const a = fighterAt(6, rng);
        a.skills = [...new Set([...a.skills, skill])];
        return [a, fighterAt(6, seededRng(99))];
      },
      (ev) => ev.some((e) => e.kind === 'skill' && e.skill === skill),
    );
    assert.ok(events, `${skill} 应该在某个种子里被用出来`);
  }
});

test('假死遁一场只救一次', () => {
  const events = findFight(
    (rng) => [{ ...fighterAt(3, rng), skills: ['play-dead'] }, fighterAt(3, seededRng(77))],
    (ev) => ev.some((e) => e.kind === 'play-dead'),
  );
  assert.ok(events, '应该在某个种子里触发假死遁');
  const bySide = [0, 1].map((i) => events.filter((e) => e.kind === 'play-dead' && e.actor === i).length);
  assert.ok(
    bySide.every((n) => n <= 1),
    '同一场里一方最多救一次',
  );
});

test('被动招式各自确实生效', () => {
  // 泡泡护体：受伤减半的事件会出现
  assert.ok(
    findFight(
      (rng) => [{ ...fighterAt(6, rng), skills: ['bubble'] }, fighterAt(6, seededRng(5))],
      (ev) => ev.some((e) => (e.kind === 'hit' || e.kind === 'combo') && e.blocked),
    ),
    '泡泡护体应该挡下过一次',
  );
  // 第六感：反击事件会出现
  assert.ok(
    findFight(
      (rng) => [
        { ...fighterAt(6, seededRng(6)), skills: [] },
        { ...fighterAt(6, rng), skills: ['sixth-sense'] },
      ],
      (ev) => ev.some((e) => e.kind === 'counter'),
    ),
    '第六感应该反击过一下',
  );
  // 会心一击：暴击事件会出现
  assert.ok(
    findFight(
      (rng) => [{ ...fighterAt(6, rng), skills: ['critical'] }, fighterAt(6, seededRng(7))],
      (ev) => ev.some((e) => (e.kind === 'hit' || e.kind === 'combo') && e.crit),
    ),
    '会心一击应该暴击过',
  );
  // 灵兽助阵：灵兽一击会出现
  assert.ok(
    findFight(
      (rng) => [{ ...fighterAt(6, rng), skills: ['spirit-beast'] }, fighterAt(6, seededRng(8))],
      (ev) => ev.some((e) => e.kind === 'beast'),
    ),
    '灵兽应该追击过',
  );
  // 被定住跳过：气球 / 陀螺 / 狮子吼带来的 skip 事件
  assert.ok(
    findFight(
      (rng) => [{ ...fighterAt(6, rng), weapons: ['top'] }, fighterAt(6, seededRng(9))],
      (ev) => ev.some((e) => e.kind === 'skip'),
    ),
    '陀螺应该定住过对手',
  );
});

test('化鸽遁提高闪避、无影手提高连击（大量种子下方向正确）', () => {
  const countKind = (skill: SkillId | null, kind: string): number => {
    let n = 0;
    for (let i = 0; i < 120; i++) {
      const base = fighterAt(2, seededRng(i)); // 身法低，基础闪避 / 连击率小，加成才看得出来
      const a = skill ? { ...base, skills: [skill] } : base;
      const b: Fighter = { ...fighterAt(2, seededRng(i + 30)), skills: [] };
      n += fight(named(a, '甲'), named(b, '乙'), `passive-${skill}-${i}`).filter(
        (e) => e.kind === kind && e.actor === 0,
      ).length;
    }
    return n;
  };
  assert.ok(countKind('dove', 'dodge') > countKind(null, 'dodge'), '带化鸽遁的对手被打空更多');
  let combos = 0;
  let combosBase = 0;
  for (let i = 0; i < 120; i++) {
    const base = fighterAt(2, seededRng(i));
    const a: Fighter = { ...base, skills: ['shadow-fists'] };
    const b: Fighter = { ...fighterAt(2, seededRng(i + 30)), skills: [] };
    combos += fight(named(a, '甲'), named(b, '乙'), `fists-${i}`).filter(
      (e) => e.kind === 'combo' && e.actor === 0,
    ).length;
    combosBase += fight(named(base, '甲'), named(b, '乙'), `fists-base-${i}`).filter(
      (e) => e.kind === 'combo' && e.actor === 0,
    ).length;
  }
  assert.ok(combos > combosBase, '带无影手连击更多');
});

test('autoController：气血低于一半必用凭空生花，其余主动 25%，没法宝就空手', () => {
  const view = (hpFrac: number, used: SkillId[] = []): BattleView => ({
    self: 0,
    hp: [Math.floor(100 * hpFrac), 60],
    maxHp: [100, 100],
    you: { weapons: ['water-gun'], skills: ['bloom', 'lion-roar'], used },
    foe: { weapons: [], skills: [] },
  });
  // 气血低于一半：必用凭空生花（不管随机数给什么）
  assert.deepEqual(autoController(() => 0.99).decide(view(0.4)), { kind: 'skill', skill: 'bloom' });
  // 高于一半：凭空生花不进候选
  for (const r of [0.1, 0.5, 0.9]) {
    const action = autoController(() => r).decide(view(0.9));
    assert.notDeepEqual(action, { kind: 'skill', skill: 'bloom' });
  }
  // 25% 用主动招式（lion-roar 还没用过）
  assert.deepEqual(autoController(() => 0).decide(view(0.9)), { kind: 'skill', skill: 'lion-roar' });
  assert.equal(autoController(() => 0.26).decide(view(0.9)).kind, 'weapon');
  // 没有法宝：空手
  const noWeapon = autoController(() => 0.9);
  assert.deepEqual(noWeapon.decide({ ...view(0.9), you: { weapons: [], skills: [], used: [] } }), { kind: 'unarmed' });
});

test('shadowOf：属性 ×0.9 向下取整最低 1，法宝招式照抄', () => {
  const f: Fighter = { name: '本体', hp: 57, power: 7, agility: 5, speed: 4, weapons: ['top'], skills: ['dove'] };
  assert.deepEqual(shadowOf(f), {
    name: '心魔',
    hp: 51,
    power: 6,
    agility: 4,
    speed: 3,
    weapons: ['top'],
    skills: ['dove'],
  });
  const tiny = shadowOf({ name: 'x', hp: 1, power: 1, agility: 1, speed: 1, weapons: [], skills: [] });
  assert.deepEqual([tiny.hp, tiny.power, tiny.agility, tiny.speed], [1, 1, 1, 1], '最低 1');
});

test('statCap：按 X1 规则长出来的角色永远不超上限', () => {
  for (let stage = 0; stage <= 29; stage++) {
    const cap = statCap(stage);
    for (let i = 0; i < 50; i++) {
      const f = fighterAt(stage, seededRng(stage * 131 + i));
      assert.ok(f.hp <= cap.hp, `stage ${stage} 气血 ${f.hp} 超上限 ${cap.hp}`);
      assert.ok(f.power <= cap.power && f.agility <= cap.agility && f.speed <= cap.speed, `stage ${stage} 属性超上限`);
    }
  }
});

test('tribulate：同种子同结果，事件以 end 收尾', () => {
  const f = fighterAt(6, seededRng(1));
  const events = tribulate(f, 3, 6, 'trib-1');
  assert.deepEqual(tribulate(f, 3, 6, 'trib-1'), events);
  assert.equal(events[0].kind, 'start');
  assert.equal(events[events.length - 1].kind, 'end');
  assert.ok(events.filter((e) => e.kind === 'strike').length <= 3);
});

// ---------------------------------------------------------------------------
// 平衡断言：固定种子，跑起来是确定性的；数值由 scripts/dev/battle-sim.mjs 调出来
// ---------------------------------------------------------------------------

// 4000 场的 1σ ≈ 0.008：有招式的期望胜率贴着下限（约 0.41），600 场的噪声（1σ ≈ 0.02）会随机翻过界
const BALANCE_N = 4_000;
// 单件法宝 / 招式的持有方胜率贴着 0.65 的上限（假死遁、泡泡护体都在 0.63 上下），
// 4000 场的 1σ 有 0.008，够把 0.635 的期望抽成 0.650 翻过界——这一组用 8000 场（1σ ≈ 0.005）
const ITEM_BALANCE_N = 8_000;

const balanceRate = (make: (i: number) => [Fighter, Fighter], n = BALANCE_N): number => {
  let wins = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = make(i);
    const events = fight(named(a, '甲'), named(b, '乙'), `bal-${i}`);
    const end = events[events.length - 1];
    if (end.kind === 'end' && end.winner === 0) wins++;
  }
  return wins / n;
};

test('平衡：同境界随机配招，先手方胜率 40%–60%', () => {
  // 炼气五层、筑基中期、元婴中期、合体中期各测一遍
  for (const stage of [4, 10, 16, 25]) {
    const rate = balanceRate((i) => [fighterAt(stage, seededRng(i)), fighterAt(stage, seededRng(i + 500))]);
    assert.ok(rate >= 0.4 && rate <= 0.6, `stage ${stage} 实际 ${rate}`);
  }
});

test('平衡：切磋拉平修为后，高低境界的胜率都在 45%–55%（X20）', () => {
  // 高一个小境界、一个大境界、五个大境界，以及炼气 4 对 1：拉平属性、法宝和招式件数后都不该有修为优势
  for (const [hi, lo] of [
    [10, 9],
    [13, 10],
    [16, 13],
    [25, 10],
    [4, 1],
  ] as const) {
    const rate = balanceRate((i) => fairSparPair(fighterAt(hi, seededRng(i)), fighterAt(lo, seededRng(i + 500))));
    assert.ok(rate >= 0.45 && rate <= 0.55, `${hi} 对 ${lo} 实际 ${rate}`);
  }
});

test('X20 切磋拉平：属性取中点，法宝和招式按少的一方取齐（两边算出来一致、再拉一次不变）', () => {
  const a: Fighter = {
    name: '甲',
    hp: 100,
    power: 20,
    agility: 8,
    speed: 4,
    weapons: ['water-gun', 'poker', 'top'],
    skills: ['dove', 'bubble', 'myriad-self'],
  };
  const b: Fighter = {
    name: '乙',
    hp: 60,
    power: 6,
    agility: 16,
    speed: 12,
    weapons: ['slingshot'],
    skills: ['dragon-palm'],
  };
  const [x, y] = fairSparPair(a, b);
  for (const key of ['hp', 'power', 'agility', 'speed'] as const) {
    assert.equal(x[key], Math.round((a[key] + b[key]) / 2), `${key} 取中点`);
    assert.equal(y[key], x[key], `${key} 两边一样`);
  }
  assert.deepEqual(x.weapons, ['water-gun']);
  assert.deepEqual(y.weapons, ['slingshot']);
  assert.deepEqual(x.skills, ['dove']);
  assert.deepEqual(y.skills, ['dragon-palm']);
  // 同一对无论谁先谁后，拉出来的两只都一样；再拉一次不再变
  const [y2, x2] = fairSparPair(b, a);
  assert.deepEqual([x2, y2], [x, y]);
  assert.deepEqual(fairSparPair(x, y), [x, y]);
});

test('平衡：任一法宝或招式，持有方胜率在 44%–61% 之间（X20 收紧）', () => {
  // 持有方把一个随机招 / 一件法宝换成待测项（而不是白多一份），量出来的才是它本身的分量
  for (const id of WEAPON_IDS) {
    const rate = balanceRate((i) => {
      const a = fighterAt(10, seededRng(i));
      a.weapons = [id, ...a.weapons.filter((w) => w !== id)];
      const b = fighterAt(10, seededRng(i + 500));
      b.weapons = b.weapons.filter((w) => w !== id);
      return [a, b];
    }, ITEM_BALANCE_N);
    assert.ok(rate >= 0.44 && rate <= 0.61, `法宝 ${id} 实际 ${rate}`);
  }
  for (const id of SKILL_IDS) {
    const rate = balanceRate((i) => {
      const a = fighterAt(10, seededRng(i));
      if (a.skills.includes(id)) a.skills = a.skills.filter((s) => s !== id);
      if (a.skills.length > 0) a.skills[a.skills.length - 1] = id;
      else a.skills = [id];
      return [a, fighterAt(10, seededRng(i + 500))];
    }, ITEM_BALANCE_N);
    assert.ok(rate >= 0.44 && rate <= 0.61, `招式 ${id} 实际 ${rate}`);
  }
});

test('平衡：本体对心魔胜率 55%–70%', () => {
  let wins = 0;
  for (let i = 0; i < BALANCE_N; i++) {
    const a = fighterAt(10, seededRng(i));
    const events = fight(named(a, '甲'), shadowOf(a), `shadow-${i}`);
    const last = events[events.length - 1];
    if (last.kind === 'end' && last.winner === 0) wins++;
  }
  const rate = wins / BALANCE_N;
  assert.ok(rate >= 0.55 && rate <= 0.7, `实际 ${rate}`);
});

test('平衡：渡劫不吃丹约 65%、吃丹约 80%——七个渡劫分界全覆盖（X4 后按正式成长重标）', () => {
  // 七个渡劫分界：圆满 stage 8（炼气九层）→ 筑基、11 → 金丹、14 → 元婴、17 → 化神、20 → 炼虚、23 → 合体、26 → 大乘；
  // 雷数照 §X4（进筑基、金丹 3 道，进元婴、化神 6 道，之后 9 道）。旧参数只在 stage 12 一点标过，
  // 各分界 0.30–0.72 不齐；TRIBULATION_* 重标后全站落在带内（校准记录见 battle.ts 常量注释）。
  const FULL_STAGES = [8, 11, 14, 17, 20, 23, 26];
  const strikesOf = (stage: number): number => {
    const big = majorBreaks(stage + 1);
    return big <= 2 ? 3 : big <= 4 ? 6 : 9;
  };
  const TRIB_N = 600;
  for (const stage of FULL_STAGES) {
    const survive = (pill: boolean): number => {
      let ok = 0;
      for (let i = 0; i < TRIB_N; i++) {
        const f = fighterAt(stage, seededRng(i * 7 + stage));
        if (pill) f.hp = Math.floor(f.hp * 1.2);
        const events = tribulate(f, strikesOf(stage), stage, `trib-bal-${stage}-${i}`);
        const last = events[events.length - 1];
        if (last.kind === 'end' && last.winner === 0) ok++;
      }
      return ok / TRIB_N;
    };
    const noPill = survive(false);
    const pill = survive(true);
    assert.ok(noPill >= 0.55 && noPill <= 0.75, `stage ${stage} 不吃丹实际 ${noPill}`);
    assert.ok(pill >= 0.75 && pill <= 0.92, `stage ${stage} 吃丹实际 ${pill}`);
  }
});

// ---------------------------------------------------------------------------
// Y0 兼容快照：改引擎（hpNow / moves / mods / guard）之前先录下来的 200 场事件序列。
// 不带新字段的 Fighter 必须逐条打出同一串事件；X20 改了结算规则（控制判定、假死遁躺一拍、
// 图鉴数值重标）并升 BATTLE_VERSION 4 → 5，快照按新规则重录。
// ---------------------------------------------------------------------------

/**
 * 快照怎么生成的（`node --experimental-strip-types --import ./scripts/test-register.mjs` 跑同一份生成器）：
 * 200 场、一场一种子（`compat-<i>`）；i % 4 轮过 stage 4 / 10 / 16 / 25（炼气五层、筑基中期、元婴中期、合体中期）；
 * 两边的四项属性由 `fighterAt(stage, seededRng(i * 3 + 1))` / `seededRng(i * 5 + 2)` 随机成长，
 * **法宝和招式另行随机配招**（每个图鉴项独立 50% 入选，法宝最多 4 件、招式最多 6 门，随机数 `seededRng(i * 977 + 13)`），
 * 全默认 `autoController`。200 场合计 4620 个事件。
 */
const COMPAT_SNAPSHOT = '4133d29645c86e32b0bd3faddf275fdea16069a704385a3bfb6250c034beaa7a';

/**
 * 快照里配招用的旧图鉴（X16 之前的 17 门招式）：X16 把 `SKILL_IDS` 扩到 19，
 * 这里钉住旧清单，让这份快照继续守「加新招式不改变旧角色行为」——不重算摘要。
 */
const COMPAT_SKILLS: readonly SkillId[] = [
  'play-dead',
  'dove',
  'bubble',
  'sixth-sense',
  'shadow-fists',
  'critical',
  'spirit-beast',
  'bloom',
  'lion-roar',
  'blue-whale',
  'whale-song',
  'ink',
  'whale-gulp',
  'jelly-clone',
  'myriad-self',
  'dream-chant',
  'finger-sword',
];

function compatEvents(): BattleEvent[][] {
  const out: BattleEvent[][] = [];
  for (let i = 0; i < 200; i++) {
    const stage = [4, 10, 16, 25][i % 4];
    const rng = seededRng(i * 977 + 13);
    const take = <T>(pool: readonly T[], max: number): T[] =>
      pool
        .filter(() => rng() < 0.5)
        .slice(0, max)
        .slice();
    const a = fighterAt(stage, seededRng(i * 3 + 1));
    const b = fighterAt(stage, seededRng(i * 5 + 2));
    a.weapons = take(WEAPON_IDS, 4);
    a.skills = take(COMPAT_SKILLS, 6);
    b.weapons = take(WEAPON_IDS, 4);
    b.skills = take(COMPAT_SKILLS, 6);
    out.push(fight(named(a, '甲'), named(b, '乙'), `compat-${i}`));
  }
  return out;
}

/** 键名排序的规范 JSON：字段增减和数值变化都会改摘要，纯键序调整不会 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

test('Y0 兼容快照：不带新字段的 Fighter 逐条打出同一串事件（X20 重录）', () => {
  const digest = createHash('sha256')
    .update(
      compatEvents()
        .map((events) => canonical(events))
        .join('\n'),
    )
    .digest('hex');
  assert.equal(digest, COMPAT_SNAPSHOT);
});

/** 永远出同一招（招式用过以后引擎按空手处理） */
const always = (action: Action): Controller => ({ decide: () => action });

/** 一场里，从某个下标往后找下一个 `actor` 的出手（decide 或 skip） */
function nextTurn(events: BattleEvent[], from: number, actor: 0 | 1): BattleEvent | undefined {
  return events.slice(from + 1).find((e) => e.actor === actor && (e.kind === 'decide' || e.kind === 'skip'));
}

test('X8 定身的原因：雪球冻住（freeze），陀螺晕了（stun）', () => {
  for (const [weapon, cause] of [
    ['snowball', 'freeze'],
    ['top', 'stun'],
  ] as const) {
    let seen = false;
    for (let i = 0; i < 200 && !seen; i++) {
      const a = { ...fighterAt(8, seededRng(i)), weapons: [weapon] };
      const events = fight(named(a, '甲'), named(fighterAt(8, seededRng(i + 50)), '乙'), `cause-${weapon}-${i}`, [
        always({ kind: 'weapon', weapon }),
        unarmedOnly(),
      ]);
      const skips = events.filter((e) => e.kind === 'skip');
      for (const e of skips) assert.equal(e.kind === 'skip' && e.cause, cause, `${weapon} 的定身原因`);
      seen = skips.length > 0;
    }
    assert.ok(seen, `${weapon} 应该定住过对方`);
  }
});

test('X8 鸡毛掸子：打中就带 slowed，对方下次出手被推后（同一对属性，比空手时晚）', () => {
  const a = { ...fighterAt(8, seededRng(3)), weapons: ['duster' as const] };
  const b = fighterAt(8, seededRng(4));
  const events = fight(named(a, '甲'), named(b, '乙'), 'duster-1', [
    always({ kind: 'weapon', weapon: 'duster' }),
    unarmedOnly(),
  ]);
  const hits = events.filter((e) => e.kind === 'hit' && e.weapon === 'duster');
  assert.ok(hits.length > 0);
  for (const e of hits) if (e.kind === 'hit' && e.hp[1] > 0) assert.equal(e.slowed, true, '没打倒就迟缓');
  // 掸子方出手次数比空手对照多（对方被推后，轮到自己的次数变多）
  const turns = (ev: BattleEvent[]) => ev.filter((e) => e.kind === 'decide' && e.actor === 0).length;
  let slowAhead = 0;
  for (let i = 0; i < 60; i++) {
    const x = { ...fighterAt(8, seededRng(i)), weapons: ['duster' as const], power: 0 };
    const y = { ...fighterAt(8, seededRng(i + 70)), hp: 9_999 };
    const withDuster = fight(x, y, `slow-${i}`, [always({ kind: 'weapon', weapon: 'duster' }), unarmedOnly()]);
    const control = fight(x, y, `slow-${i}`, [unarmedOnly(), unarmedOnly()]);
    const share = (ev: BattleEvent[]) => turns(ev) / ev.filter((e) => e.kind === 'decide').length;
    if (share(withDuster) > share(control)) slowAhead++;
  }
  assert.ok(slowAhead >= 40, `大多数场次里掸子方的出手占比更高：${slowAhead}/60`);
});

test('X8 银托盘：两段，第二段（飞回来那一下）从不被闪避', () => {
  let checked = 0;
  for (let i = 0; i < 300; i++) {
    const a = { ...fighterAt(8, seededRng(i)), weapons: ['tray' as const] };
    const b = { ...fighterAt(8, seededRng(i + 9)), agility: 30, skills: ['dove' as const] };
    const events = fight(named(a, '甲'), named(b, '乙'), `tray-${i}`, [
      always({ kind: 'weapon', weapon: 'tray' }),
      unarmedOnly(),
    ]);
    events.forEach((e, k) => {
      if (e.kind !== 'decide' || e.actor !== 0) return;
      const segments = events.slice(k + 1).filter((x, j, all) => {
        const stop = all.findIndex(
          (y) => y.kind === 'decide' || y.kind === 'end' || y.kind === 'combo' || y.kind === 'skip',
        );
        return (
          (stop < 0 || j < stop) && (x.kind === 'hit' || x.kind === 'dodge' || x.kind === 'miss' || x.kind === 'decoy')
        );
      });
      if (segments.length === 2) {
        checked++;
        assert.notEqual(segments[1].kind, 'dodge', '第二段必中');
      }
    });
  }
  assert.ok(checked > 50, `该核到足够多的两段：${checked}`);
});

test('X8 弹弓：远程（不被反击），15% 一发两颗（twin）', () => {
  let twins = 0;
  let hits = 0;
  for (let i = 0; i < 200; i++) {
    const a = { ...fighterAt(8, seededRng(i)), weapons: ['slingshot' as const] };
    const b = { ...fighterAt(8, seededRng(i + 5)), skills: ['sixth-sense' as const] };
    const events = fight(named(a, '甲'), named(b, '乙'), `sling-${i}`, [
      always({ kind: 'weapon', weapon: 'slingshot' }),
      unarmedOnly(),
    ]);
    for (const e of events) {
      if (e.kind === 'hit' && e.weapon === 'slingshot') {
        hits++;
        if (e.twin) twins++;
      }
      assert.notEqual(e.kind === 'counter' && e.actor === 1, true, '弹弓不会被第六感反击');
    }
  }
  assert.ok(twins / hits > 0.08 && twins / hits < 0.23, `两颗的比例 ${twins}/${hits}`);
});

test('X8 鲸歌：控住就跳过下一拍（sleep），睡着期间挨的攻击不判闪避；控不住只迟缓', () => {
  let seen = 0;
  let resisted = 0;
  for (let i = 0; i < 100; i++) {
    const a = { ...fighterAt(8, seededRng(i)), skills: ['whale-song' as const], weapons: [], power: 60 };
    const b = { ...fighterAt(8, seededRng(i + 3)), agility: 30, skills: ['dove' as const] };
    const events = fight(named(a, '甲'), named(b, '乙'), `song-${i}`, [
      always({ kind: 'skill', skill: 'whale-song' }),
      unarmedOnly(),
    ]);
    const k = events.findIndex((e) => e.kind === 'skill' && e.skill === 'whale-song');
    if (k < 0) continue;
    seen++;
    const cast = events[k];
    if (cast.kind === 'skill' && cast.resisted) {
      resisted++;
      assert.notEqual(nextTurn(events, k, 1)?.kind, 'skip', '没哄睡就不该跳过出手');
      continue;
    }
    const turn = nextTurn(events, k, 1);
    if (turn) assert.deepEqual([turn.kind, turn.kind === 'skip' && turn.cause], ['skip', 'sleep']);
    const wake = events.findIndex((e, j) => j > k && e.kind === 'skip' && e.actor === 1);
    const between = events.slice(k + 1, wake < 0 ? undefined : wake);
    assert.equal(between.filter((e) => e.kind === 'dodge' && e.actor === 1).length, 0, '睡着时躲不开');
  }
  assert.ok(seen > 50);
  assert.ok(resisted > 0, '该有控不住的场次（X20）');
});

test('X8 墨汁：对方接下来三次出手里会打空（miss），之后不再打空', () => {
  let misses = 0;
  for (let i = 0; i < 100; i++) {
    const a = { ...fighterAt(8, seededRng(i)), skills: ['ink' as const], hp: 9_999 };
    const b = { ...fighterAt(8, seededRng(i + 3)), weapons: ['juggle' as const] };
    const events = fight(named(a, '甲'), named(b, '乙'), `ink-${i}`, [
      always({ kind: 'skill', skill: 'ink' }),
      always({ kind: 'weapon', weapon: 'juggle' }),
    ]);
    const k = events.findIndex((e) => e.kind === 'skill' && e.skill === 'ink');
    if (k < 0) continue;
    let turns = 0;
    for (let j = k + 1; j < events.length; j++) {
      const e = events[j];
      if ((e.kind === 'decide' || e.kind === 'skip') && e.actor === 1) turns++;
      if (e.kind === 'miss') {
        assert.equal(e.actor, 1, '打空的是被糊眼的那一方');
        assert.ok(turns >= 1 && turns <= 3, `只在糊眼后的三次出手里：第 ${turns} 次`);
        misses++;
      }
    }
    assert.equal(events.slice(0, k).filter((e) => e.kind === 'miss').length, 0, '糊眼之前不会打空');
  }
  assert.ok(misses > 30, `三球三下、三次出手，该打空不少：${misses}`);
});

test('X20 控制：控住一拍以后，对方还没出手前压不上第二下（连不成锁）', () => {
  const chain: Controller = {
    decide: (view) => {
      const next = (['whale-song', 'lion-roar', 'dream-chant'] as SkillId[]).find(
        (skill) => view.you.skills.includes(skill) && !view.you.used.includes(skill),
      );
      return next ? { kind: 'skill', skill: next } : { kind: 'unarmed' };
    },
  };
  let casts = 0;
  for (let i = 0; i < 40; i++) {
    const a = {
      ...fighterAt(10, seededRng(i)),
      weapons: [],
      skills: ['whale-song', 'lion-roar', 'dream-chant'] as SkillId[],
      power: 80,
      hp: 9_999,
    };
    const b = { ...fighterAt(10, seededRng(i + 300)), weapons: [], skills: [], agility: 0, hp: 9_999 };
    const events = fight(named(a, '甲'), named(b, '乙'), `chain-${i}`, [chain, unarmedOnly()]);
    casts += events.filter((e) => e.kind === 'skill' && e.actor === 0).length;
    events.forEach((e, k) => {
      if (e.kind !== 'skip' || e.actor !== 1) return;
      const next = events.slice(k + 1).find((x) => x.actor === 1 && (x.kind === 'decide' || x.kind === 'skip'));
      assert.equal(next?.kind, 'decide', `第 ${i} 场：连着被控两拍（${events[k + 1]?.kind}）`);
    });
  }
  assert.ok(casts > 60, `该放出去不少控制招：${casts}`);
});

test('X20 控制：身法越高越难被控住（灵力压身法）', () => {
  const rate = (agility: number): number => {
    let casts = 0;
    let resisted = 0;
    for (let i = 0; i < 120; i++) {
      const a = {
        ...fighterAt(8, seededRng(i)),
        weapons: [],
        skills: ['whale-song' as const],
        power: 10,
        hp: 9_999,
      };
      const b = { ...fighterAt(8, seededRng(i + 300)), weapons: [], skills: [], agility, hp: 9_999 };
      const events = fight(named(a, '甲'), named(b, '乙'), `resist-${agility}-${i}`, [
        castOnce('whale-song'),
        unarmedOnly(),
      ]);
      const k = events.findIndex((e) => e.kind === 'skill' && e.skill === 'whale-song');
      if (k < 0) continue;
      casts++;
      const cast = events[k];
      if (cast.kind === 'skill' && cast.resisted) resisted++;
    }
    return resisted / casts;
  };
  const nimble = rate(30);
  const slow = rate(0);
  assert.ok(nimble > slow + 0.15, `身法 30 被扛住 ${nimble}，身法 0 被扛住 ${slow}`);
});

test('X8 鲸吞：一场一次，回复实际伤害的一半（向下取整，不超上限）', () => {
  let seen = 0;
  for (let i = 0; i < 100; i++) {
    const a = { ...fighterAt(8, seededRng(i)), skills: ['whale-gulp' as const] };
    const b = fighterAt(8, seededRng(i + 3));
    const events = fight(named(a, '甲'), named(b, '乙'), `gulp-${i}`, [
      always({ kind: 'skill', skill: 'whale-gulp' }),
      unarmedOnly(),
    ]);
    const gulps = events.filter((e) => e.kind === 'skill' && e.skill === 'whale-gulp');
    assert.ok(gulps.length <= 1, '一场一次');
    for (const e of gulps) {
      if (e.kind !== 'skill') continue;
      seen++;
      assert.ok((e.heal ?? 0) <= Math.floor((e.damage ?? 0) / 2));
      assert.ok(e.hp[0] <= a.hp, '不超上限');
    }
  }
  assert.ok(seen > 50);
});

test('X8 水母分身：一成的攻击打在分身上（decoy），那一下不掉血、不触发反击', () => {
  let decoys = 0;
  let attacks = 0;
  for (let i = 0; i < 200; i++) {
    const a = fighterAt(8, seededRng(i));
    const b = {
      ...fighterAt(8, seededRng(i + 3)),
      skills: ['jelly-clone' as const, 'sixth-sense' as const],
      agility: 0,
    };
    const events = fight(named(a, '甲'), named(b, '乙'), `jelly-${i}`, [unarmedOnly(), unarmedOnly()]);
    events.forEach((e, k) => {
      if (e.kind === 'hit' && e.actor === 0) attacks++;
      if (e.kind !== 'decoy') return;
      decoys++;
      attacks++;
      assert.equal(e.actor, 1, '分身是挨打那一方的');
      assert.deepEqual(e.hp, events[k - 1].hp, '那一下不掉血');
      const next = events[k + 1];
      assert.ok(!next || next.kind !== 'counter', '分身挡下的不触发反击');
    });
  }
  assert.ok(decoys / attacks > 0.05 && decoys / attacks < 0.15, `分身比例 ${decoys}/${attacks}`);
});

/** 第一拍放这一招，之后一直空手（X9 的三招都是一场一次） */
const castOnce = (skill: SkillId): Controller => ({
  decide: (view) => (view.you.used.includes(skill) ? { kind: 'unarmed' } : { kind: 'skill', skill }),
});

test('X9 万我：三重魂影替本体挨三次普通攻击，第四下才打到本体', () => {
  let seen = 0;
  for (let i = 0; i < 60; i++) {
    // 甲身法拉满、带化鸽遁：挨打的次数少了才活得够久，能对着乙连出三下以上
    const a = { ...fighterAt(8, seededRng(i)), weapons: [], agility: 30, skills: ['dove' as const], hp: 9_999 };
    const b = {
      ...fighterAt(8, seededRng(i + 3)),
      skills: ['myriad-self' as const],
      weapons: [],
      agility: 0,
      hp: 9_999,
    };
    const events = fight(named(a, '甲'), named(b, '乙'), `myriad-${i}`, [unarmedOnly(), castOnce('myriad-self')]);
    const k = events.findIndex((e) => e.kind === 'skill' && e.skill === 'myriad-self');
    if (k < 0) continue;
    seen++;
    // 甲打乙的每一次落点：前两下是魂影，之后才是打在本体上的 hit（actor 0）
    const taken: string[] = [];
    for (let j = k + 1; j < events.length && taken.length < 4; j++) {
      const e = events[j];
      if (e.kind === 'mirror') taken.push('mirror');
      else if (e.kind === 'hit' && e.actor === 0) taken.push('hit');
    }
    assert.deepEqual(taken.slice(0, 3), ['mirror', 'mirror', 'mirror'], `第 ${i} 场：${taken.join(',')}`);
    assert.equal(taken[3] ?? 'hit', 'hit', `魂影用完就该打到本体：${taken.join(',')}`);
    const mirrors = events.filter((e) => e.kind === 'mirror');
    assert.equal(mirrors.length, 3, '就三重魂影');
    for (const m of mirrors) {
      assert.equal(m.actor, 1, '魂影是挨打那一方的');
      assert.deepEqual(m.hp, events[events.indexOf(m) - 1].hp, '魂影替挨的那一下不掉血');
    }
  }
  assert.ok(seen > 30, `该有几十场用上万我：${seen}`);
});

test('X9 万我：必中的（烟花）照样打本体，魂影不顶', () => {
  let seen = 0;
  for (let i = 0; i < 40; i++) {
    const a = { ...fighterAt(8, seededRng(i)), weapons: ['firework' as const], agility: 0, hp: 9_999 };
    const b = {
      ...fighterAt(8, seededRng(i + 3)),
      skills: ['myriad-self' as const],
      weapons: [],
      agility: 0,
      hp: 9_999,
    };
    const events = fight(named(a, '甲'), named(b, '乙'), `myriad-sure-${i}`, [
      always({ kind: 'weapon', weapon: 'firework' }),
      castOnce('myriad-self'),
    ]);
    const k = events.findIndex((e) => e.kind === 'skill' && e.skill === 'myriad-self');
    if (k < 0) continue;
    seen++;
    assert.equal(events.slice(k).filter((e) => e.kind === 'mirror').length, 0, '必中的不看魂影');
    assert.ok(events.slice(k).some((e) => e.kind === 'hit' && e.actor === 0 && e.weapon === 'firework'));
  }
  assert.ok(seen > 20, `该有几十场：${seen}`);
});

test('X23 切磋：必中的（烟花）也由魂影替，三重替完才打到本体', () => {
  let seen = 0;
  for (let i = 0; i < 40; i++) {
    const a = { ...fighterAt(8, seededRng(i)), weapons: ['firework' as const], agility: 0, hp: 9_999 };
    const b = {
      ...fighterAt(8, seededRng(i + 3)),
      skills: ['myriad-self' as const],
      weapons: [],
      agility: 0,
      hp: 9_999,
    };
    const events = fight(
      named(a, '甲'),
      named(b, '乙'),
      `myriad-sure-${i}`,
      [always({ kind: 'weapon', weapon: 'firework' }), castOnce('myriad-self')],
      { damageScale: SPAR_DAMAGE_SCALE, maxHitShare: SPAR_MAX_HIT_SHARE },
    );
    const k = events.findIndex((e) => e.kind === 'skill' && e.skill === 'myriad-self');
    if (k < 0) continue;
    seen++;
    const after = events.slice(k);
    assert.equal(after.filter((e) => e.kind === 'mirror').length, 3, '三重魂影都替必中');
    const firstHit = after.findIndex((e) => e.kind === 'hit' && e.actor === 0 && e.weapon === 'firework');
    assert.ok(firstHit >= 0, '魂影替完，烟花还是打到本体');
    assert.equal(after.slice(0, firstHit).filter((e) => e.kind === 'mirror').length, 3, '三重替完才打本体');
  }
  assert.ok(seen > 20, `该有几十场：${seen}`);
});

test('X23 切磋：主动招式（必中）也能被魂影替，伤害为 0', () => {
  const a = {
    ...fighterAt(8, seededRng(1)),
    weapons: [],
    skills: ['myriad-self' as const],
    agility: 0,
    hp: 9_999,
  };
  const b = {
    ...fighterAt(8, seededRng(2)),
    weapons: [],
    skills: ['lion-roar' as const],
    agility: 0,
    hp: 9_999,
  };
  const events = fight(
    named(a, '甲'),
    named(b, '乙'),
    'myriad-skill',
    [castOnce('myriad-self'), castOnce('lion-roar')],
    { damageScale: SPAR_DAMAGE_SCALE, maxHitShare: SPAR_MAX_HIT_SHARE },
  );
  const k = events.findIndex((e) => e.kind === 'skill' && e.skill === 'myriad-self');
  assert.ok(k >= 0, '先放万我');
  const after = events.slice(k);
  assert.ok(
    after.some((e) => e.kind === 'mirror'),
    '狮子吼被魂影替掉',
  );
  assert.ok(!after.some((e) => e.kind === 'skill' && e.skill === 'lion-roar'), '被魂影替的招式走不到伤害结算');
});

test('X23 切磋：暴击也打不出一发超过三成气血的伤害', () => {
  let crits = 0;
  for (let i = 0; i < 80; i++) {
    const a = { ...fighterAt(29, seededRng(i)), skills: ['critical' as const] };
    const b = fighterAt(29, seededRng(i + 100));
    const events = fight(named(a, '甲'), named(b, '乙'), `spar-cap-${i}`, undefined, {
      damageScale: SPAR_DAMAGE_SCALE,
      maxHitShare: SPAR_MAX_HIT_SHARE,
    });
    const start = events[0];
    assert.equal(start.kind, 'start');
    const max = start.hp;
    for (const e of events) {
      if (e.kind === 'hit' && e.crit) crits++;
      if (!('damage' in e) || typeof e.damage !== 'number' || e.damage <= 0) continue;
      const targetMax = max[1 - e.actor];
      assert.ok(
        e.damage <= Math.max(1, Math.floor(targetMax * SPAR_MAX_HIT_SHARE)),
        `第 ${i} 场 ${e.kind} 打了 ${e.damage}，目标上限 ${targetMax}`,
      );
    }
  }
  assert.ok(crits > 0, '该抽到会心');
});

test('X23 切磋：蓝鲸现世不再顶满单次伤害封顶', () => {
  const a = {
    ...fighterAt(8, seededRng(1)),
    hp: 300,
    power: 40,
    agility: 20,
    speed: 30,
    weapons: [],
    skills: ['blue-whale' as const],
  };
  const b = {
    ...fighterAt(8, seededRng(2)),
    hp: 300,
    power: 10,
    agility: 0,
    speed: 0,
    weapons: [],
    skills: [],
  };
  const events = fight(named(a, '甲'), named(b, '乙'), 'blue-whale-spar', [castOnce('blue-whale'), unarmedOnly()], {
    damageScale: SPAR_DAMAGE_SCALE,
    maxHitShare: SPAR_MAX_HIT_SHARE,
  });
  const hit = events.find(
    (e): e is Extract<BattleEvent, { kind: 'skill' }> => e.kind === 'skill' && e.skill === 'blue-whale',
  );
  const damage = hit?.damage ?? 0;
  assert.ok(damage > 0, '蓝鲸打中了');
  assert.ok(damage < Math.floor(300 * SPAR_MAX_HIT_SHARE), `蓝鲸 ${damage} 不该顶满 30% 封顶`);
});

test('X9 魂牵梦绕：控住就把对方牵进梦里（skip dream），入梦这一拍挨打不判闪避', () => {
  let seen = 0;
  let resisted = 0;
  for (let i = 0; i < 60; i++) {
    const a = {
      ...fighterAt(8, seededRng(i)),
      skills: ['dream-chant' as const],
      weapons: [],
      hp: 9_999,
      power: 60,
    };
    const b = {
      ...fighterAt(8, seededRng(i + 3)),
      agility: 30,
      skills: ['dove' as const],
      weapons: [],
      hp: 9_999,
    };
    const events = fight(named(a, '甲'), named(b, '乙'), `chant-${i}`, [castOnce('dream-chant'), unarmedOnly()]);
    const k = events.findIndex((e) => e.kind === 'skill' && e.skill === 'dream-chant');
    if (k < 0) continue;
    seen++;
    const cast = events[k];
    if (cast.kind === 'skill' && cast.resisted) {
      resisted++;
      assert.notEqual(nextTurn(events, k, 1)?.kind, 'skip', '没入梦就不该跳过出手');
      continue;
    }
    const turn = nextTurn(events, k, 1);
    assert.deepEqual([turn?.kind, turn?.kind === 'skip' && turn.cause], ['skip', 'dream']);
    const wake = events.findIndex((e, j) => j > k && e.kind === 'skip' && e.actor === 1);
    const between = events.slice(k + 1, wake < 0 ? undefined : wake);
    assert.equal(between.filter((e) => e.kind === 'dodge' && e.actor === 1).length, 0, '入梦时躲不开');
  }
  assert.ok(seen > 30, `该有几十场：${seen}`);
  assert.ok(resisted > 0, '该有控不住的场次（X20）');
});

test('X9 五指拳心剑：必中、穿护体（不减伤也不消耗泡泡），没护体时不带 pierce', () => {
  const expected = (a: Fighter, foeMaxHp: number): number =>
    22 + Math.floor(a.power * 0.75) + Math.floor(foeMaxHp * 0.25 * 0.8);
  let seen = 0;
  for (let i = 0; i < 40; i++) {
    const a = {
      ...fighterAt(8, seededRng(i)),
      skills: ['finger-sword' as const],
      weapons: [],
      agility: 0,
      hp: 9_999,
    };
    const b = {
      ...fighterAt(8, seededRng(i + 3)),
      skills: ['bubble' as const],
      weapons: [],
      agility: 0,
      hp: 9_999,
    };
    const events = fight(named(a, '甲'), named(b, '乙'), `fist-${i}`, [castOnce('finger-sword'), unarmedOnly()]);
    const k = events.findIndex((e) => e.kind === 'skill' && e.skill === 'finger-sword');
    if (k < 0) continue;
    seen++;
    const e = events[k];
    assert.equal(e.kind === 'skill' && e.pierce, true, '这一下标了穿护体');
    assert.equal(e.kind === 'skill' && e.damage, expected(a, 9_999), '护体没打折');
    const later = events.slice(k + 1).find((x) => x.kind === 'hit' && x.actor === 0);
    assert.equal(later?.kind === 'hit' && later.blocked, true, '泡泡没被这一下用掉');
  }
  assert.ok(seen > 20, `该有几十场：${seen}`);

  const a = { ...fighterAt(8, seededRng(7)), skills: ['finger-sword' as const], weapons: [] };
  const events = fight(named(a, '甲'), named(fighterAt(8, seededRng(9)), '乙'), 'fist-no-bubble', [
    castOnce('finger-sword'),
    unarmedOnly(),
  ]);
  const e = events.find((x) => x.kind === 'skill' && x.skill === 'finger-sword');
  assert.ok(e, '这一招该用出来');
  assert.equal(e.kind === 'skill' && e.pierce, undefined, '没护体就不标 pierce');
});

test('X16 降龙十八掌：必中，后劲只跟下一次法宝 / 空手的第一下', () => {
  const castThenGun: Controller = {
    decide: (view) =>
      view.you.used.includes('dragon-palm')
        ? { kind: 'weapon', weapon: 'water-gun' }
        : { kind: 'skill', skill: 'dragon-palm' },
  };
  const a = {
    ...fighterAt(8, seededRng(61)),
    weapons: ['water-gun' as const],
    skills: ['dragon-palm' as const],
    agility: 0,
    hp: 9_999,
  };
  // 必中：身法拉满、带化鸽遁也躲不开；伤害按 28 + 灵力×0.75 + 破势×0.6
  const dodgy = {
    ...fighterAt(8, seededRng(62)),
    weapons: [],
    skills: ['dove' as const],
    agility: 30,
    hp: 9_999,
  };
  const events = fight(named(a, '甲'), named(dodgy, '乙'), 'dragon-sure', [castThenGun, unarmedOnly()]);
  const k = events.findIndex((e) => e.kind === 'skill' && e.skill === 'dragon-palm');
  assert.ok(k > 0, '这一招该用出来');
  const skill = events[k];
  assert.equal(events[k - 1]?.kind, 'decide', '降龙十八掌不判闪避，decide 之后直接结算');
  assert.equal(
    skill.kind === 'skill' && skill.damage,
    28 + Math.floor(a.power * 0.75) + Math.floor(dodgy.hp * 0.25 * 0.6),
    '必中且按公式结算',
  );

  // 后劲：打中的那一记带 surge，只带一次；之后的连击 / 下一手都不再带
  const steady = { ...fighterAt(8, seededRng(63)), weapons: [], skills: [], agility: 0, hp: 9_999 };
  const ev = fight(named(a, '甲'), named(steady, '乙'), 'dragon-surge', [castThenGun, unarmedOnly()]);
  const k2 = ev.findIndex((e) => e.kind === 'skill' && e.skill === 'dragon-palm');
  assert.ok(k2 > 0);
  const hits = ev
    .slice(k2 + 1)
    .filter((e): e is Extract<BattleEvent, { kind: 'hit' | 'combo' }> => e.kind === 'hit' || e.kind === 'combo')
    .filter((e) => e.actor === 0);
  assert.ok(hits.length >= 2, '后劲之后还有普通出手');
  assert.equal(hits[0]?.surge, true, '下一次法宝的第一下带后劲');
  assert.ok(
    hits.slice(1).every((hit) => hit.surge === undefined),
    '后劲只加一次',
  );

  // 那一下没打中（闪避）：后劲作废，后面再打中也不带 surge
  const fast = { ...a, speed: 50 };
  const evasive = {
    ...fighterAt(8, seededRng(64)),
    weapons: [],
    skills: ['dove' as const],
    agility: 30,
    speed: 1,
    hp: 9_999,
  };
  let expired = false;
  for (let i = 0; i < 40 && !expired; i++) {
    const e = fight(named(fast, '甲'), named(evasive, '乙'), `dragon-miss-${i}`, [castThenGun, unarmedOnly()]);
    const at = e.findIndex((x) => x.kind === 'skill' && x.skill === 'dragon-palm');
    if (at < 0) continue;
    const firstAttack = e.findIndex((x, j) => j > at && x.kind === 'decide' && x.actor === 0);
    if (firstAttack < 0) continue;
    const outcome = e[firstAttack + 1];
    if (outcome?.kind !== 'dodge' || outcome.actor !== 1) continue;
    expired = true;
    assert.ok(
      !e.slice(at).some((x) => (x.kind === 'hit' || x.kind === 'combo') && x.surge === true),
      '第一下没打中，后劲作废',
    );
  }
  assert.ok(expired, '该有一个种子让后劲那一下被闪避');
});

test('X16 送友风：必中，控住就飘起来跳过一拍，飘着挨打不判闪避', () => {
  const a = {
    ...fighterAt(8, seededRng(65)),
    weapons: [],
    skills: ['farewell-wind' as const],
    agility: 0,
    power: 60,
    speed: 20,
    hp: 9_999,
  };
  const b = {
    ...fighterAt(8, seededRng(66)),
    weapons: [],
    skills: ['dove' as const],
    agility: 30,
    speed: 1,
    hp: 9_999,
  };
  let resisted = 0;
  for (let i = 0; i < 40; i++) {
    const events = fight(named(a, '甲'), named(b, '乙'), `farewell-base-${i}`, [
      castOnce('farewell-wind'),
      unarmedOnly(),
    ]);
    const k = events.findIndex((e) => e.kind === 'skill' && e.skill === 'farewell-wind');
    if (k <= 0) continue;
    const skill = events[k];
    assert.equal(
      skill.kind === 'skill' && skill.damage,
      18 + Math.floor(a.power * 0.75) + Math.floor(b.hp * 0.25 * 0.4),
      '必中且按公式结算',
    );
    const turn = nextTurn(events, k, 1);
    if (skill.kind === 'skill' && skill.resisted) {
      resisted++;
      assert.notEqual(turn?.kind, 'skip', '没吹起来就不该跳过出手');
      continue;
    }
    assert.deepEqual([turn?.kind, turn?.kind === 'skip' && turn.cause], ['skip', 'float'], '下一拍飘着');
    const wake = events.findIndex((e, j) => j > k && e.kind === 'skip' && e.actor === 1);
    const between = events.slice(k + 1, wake < 0 ? undefined : wake);
    assert.equal(between.filter((e) => e.kind === 'dodge' && e.actor === 1).length, 0, '飘着时躲不开');
  }
  assert.ok(resisted > 0, '该有控不住的场次（X20）');
});

test('X16 送友风：不传 farewell 绝不出现 farewell 收场', () => {
  for (let i = 0; i < 40; i++) {
    const a = {
      ...fighterAt(8, seededRng(i)),
      weapons: [],
      skills: ['farewell-wind' as const],
      hp: 9_999,
    };
    const b = {
      ...fighterAt(8, seededRng(i + 100)),
      weapons: [],
      skills: ['farewell-wind' as const],
      hp: 9_999,
    };
    const events = fight(named(a, '甲'), named(b, '乙'), `no-farewell-${i}`, [
      castOnce('farewell-wind'),
      castOnce('farewell-wind'),
    ]);
    assert.ok(
      events.some((e) => e.kind === 'skill' && e.skill === 'farewell-wind'),
      `第 ${i} 场该用出送友风`,
    );
    assert.ok(!events.some((e) => e.kind === 'end' && e.reason === 'farewell'), '没有 farewell 开关就不该送走');
  }
});

test('X16 串门送走：抽中立刻收场、施放方赢，没抽中照普通效果；同样的出手逐手重算一致', () => {
  const a = {
    ...fighterAt(8, seededRng(67)),
    weapons: [],
    skills: ['farewell-wind' as const],
    agility: 0,
    speed: 50,
    hp: 9_999,
  };
  const b = { ...fighterAt(8, seededRng(68)), weapons: [], skills: [], agility: 0, speed: 1, hp: 9_999 };
  const cast = castOnce('farewell-wind');
  let sent: { seed: string; events: BattleEvent[] } | null = null;
  let plain: BattleEvent[] | null = null;
  for (let i = 0; i < 80 && (sent === null || plain === null); i++) {
    const seed = `farewell-${i}`;
    const events = fight(named(a, '甲'), named(b, '乙'), seed, [cast, unarmedOnly()], { farewell: true });
    const end = events[events.length - 1];
    if (end.kind === 'end' && end.reason === 'farewell') {
      if (sent === null) sent = { seed, events };
    } else if (plain === null && events.some((e) => e.kind === 'skip' && e.cause === 'float')) {
      plain = events;
    }
  }
  assert.ok(sent, '该有一个种子抽中送走');
  const { seed, events } = sent!;
  const end = events[events.length - 1];
  assert.equal(end.kind === 'end' && end.winner, 0, '施放方赢');
  assert.equal(end.kind === 'end' && end.reason, 'farewell');
  const beforeEnd = events[events.length - 2];
  assert.equal(beforeEnd?.kind, 'skill', '送走紧跟在送友风这一下后面');
  assert.equal(beforeEnd?.kind === 'skill' && beforeEnd.skill, 'farewell-wind');
  // 同样的种子、同一串出手，逐手重算与整场一字不差（两边各算一遍也一致）
  const actions: [Action[], Action[]] = [[], []];
  for (const event of events) if (event.kind === 'decide') actions[event.actor].push(event.action);
  const stepwise = fightUntilDecision(a, b, seed, actions, { farewell: true });
  assert.equal(stepwise.need, null);
  assert.deepEqual(stepwise.events, events);
  assert.deepEqual(fightUntilDecision(a, b, seed, actions, { farewell: true }).events, stepwise.events);
  assert.ok(plain, '也该有没抽中的种子');
  assert.ok(!plain!.some((e) => e.kind === 'end' && e.reason === 'farewell'), '没抽中就照普通效果打下去');
});

test('Y0 引擎：hpNow 从残血开打（夹在 1..上限），不带时仍是满血', () => {
  const full = fighterAt(9, seededRng(3));
  assert.equal(startingHp(full), full.hp);
  assert.equal(startingHp({ ...full, hpNow: 0 }), 1);
  assert.equal(startingHp({ ...full, hpNow: full.hp + 999 }), full.hp);
  const hurt = { ...full, hpNow: 12 };
  const events = fight(named(hurt, '甲'), named(fighterAt(9, seededRng(9)), '乙'), 'hpnow');
  const first = events.find((e) => e.kind === 'decide');
  assert.equal(first?.kind === 'decide' ? first.hp[0] : -1, 12, '开打就是残血');
  const end = events[events.length - 1];
  assert.equal(end?.kind === 'end' && end.hp[0] <= 12, true);
});

test('Y0 引擎：招式出手、有限次数用完就不能再出', () => {
  const a = { ...fighterAt(9, seededRng(5)), weapons: [], skills: [], moves: ['gu-dogs' as const] };
  const b = { ...fighterAt(9, seededRng(6)), weapons: [], skills: [], agility: 0 };
  const useMove: Controller = { decide: () => ({ kind: 'move', move: 'gu-dogs' }) };
  const events = fight(named(a, '甲'), named(b, '乙'), 'move-basic', [useMove, unarmedOnly()]);
  const first = events.find((e) => e.kind === 'decide' && e.actor === 0);
  assert.deepEqual(first?.kind === 'decide' && first.action, { kind: 'move', move: 'gu-dogs' });
  assert.ok(
    events.some((e) => (e.kind === 'hit' || e.kind === 'combo') && e.move === 'gu-dogs'),
    '打出了招式',
  );
  // 限次招式：一场 1 次的北冥冰魄爆发，第二次出手会被换掉
  const c = { ...fighterAt(9, seededRng(7)), weapons: [], skills: [], moves: ['bingpo' as const] };
  const useOnce: Controller = { decide: () => ({ kind: 'move', move: 'bingpo' }) };
  const ev = fight(named(c, '甲'), named({ ...fighterAt(9, seededRng(8)), hp: 999 }, '乙'), 'move-once', [
    useOnce,
    unarmedOnly(),
  ]);
  const moves = ev.filter((e) => e.kind === 'decide' && e.action.kind === 'move');
  assert.equal(moves.length, 1, '一场只能出一次');
});

test('Y0 引擎：mods.dodge 加闪避、mods.desperate 在残血时加伤', () => {
  const count = (mods: { dodge?: number } | undefined): number => {
    let dodges = 0;
    for (let i = 0; i < 40; i++) {
      const a = { ...fighterAt(9, seededRng(i)), weapons: [], skills: [], agility: 0 };
      const b = { ...fighterAt(9, seededRng(i + 100)), weapons: [], skills: [], agility: 0, ...(mods ? { mods } : {}) };
      const events = fight(named(a, '甲'), named(b, '乙'), `dodge-${i}`, [unarmedOnly(), unarmedOnly()]);
      dodges += events.filter((e) => e.kind === 'dodge' && e.actor === 1).length;
    }
    return dodges;
  };
  const plain = count(undefined);
  const dodgy = count({ dodge: 0.3 });
  assert.ok(dodgy > plain, `加了闪避，挨打时躲开的次数该更多：${dodgy} vs ${plain}`);

  const hitHard = { ...fighterAt(9, seededRng(31)), weapons: [], skills: [], agility: 0, hp: 300, speed: 99 };
  const dummy = { ...fighterAt(9, seededRng(32)), weapons: [], skills: [], agility: 0, hp: 300, speed: 1 };
  const firstHit = (events: BattleEvent[]): number => {
    const hit = events.find((e) => (e.kind === 'hit' || e.kind === 'combo') && e.actor === 0);
    return hit?.kind === 'hit' || hit?.kind === 'combo' ? hit.damage : 0;
  };
  const normal = fight(named(hitHard, '甲'), named(dummy, '乙'), 'desperate-off', [unarmedOnly(), unarmedOnly()]);
  const low = fight(
    named({ ...hitHard, hpNow: 20, mods: { desperate: 2 } }, '甲'),
    named(dummy, '乙'),
    'desperate-on',
    [unarmedOnly(), unarmedOnly()],
  );
  assert.ok(firstHit(low) > firstHit(normal), `背水一战该更疼：${firstHit(low)} vs ${firstHit(normal)}`);
});

test('Y0 引擎：guard 替挡整下、按次数用完，事件带替挡的人', () => {
  const attacker = { ...fighterAt(9, seededRng(41)), weapons: [], skills: [], agility: 0 };
  const guarded = {
    ...fighterAt(9, seededRng(42)),
    weapons: [],
    skills: [],
    agility: 0,
    hp: 9999,
    guard: { by: '白凝冰', times: 2 },
  };
  const events = fight(named(attacker, '甲'), named(guarded, '乙'), 'guard-basic', [unarmedOnly(), unarmedOnly()]);
  const blocks = events.filter((e) => e.kind === 'guard');
  assert.equal(blocks.length, 2, '挡两下');
  assert.equal(blocks[0].kind === 'guard' && blocks[0].by, '白凝冰');
  for (const block of blocks) {
    assert.equal(block.kind === 'guard' && block.hp[1], 9999, '替挡整下不掉血');
  }
  // 挡完以后照常掉血
  const after = events.slice(events.findIndex((e) => e.kind === 'guard' && e === blocks[1]) + 1);
  assert.ok(after.some((e) => (e.kind === 'hit' || e.kind === 'combo') && e.actor === 0 && e.damage > 0));
});
