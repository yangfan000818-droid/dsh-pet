import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOf } from './battle-lines.ts';
import { SKILLS, SKILL_IDS, WEAPON_IDS, type BattleEvent, type SkillId } from './battle.ts';

/** 名字按 12 字上限来验长度 */
const names: [string, string] = ['小花小花小花小花', '心魔心魔心魔心魔'];
const pick = (rolls: number[], event: Partial<BattleEvent> & Pick<BattleEvent, 'kind' | 'actor'>): string[] => {
  const out: string[] = [];
  for (let i = 0; i < rolls.length; i++) {
    const line = lineOf({ hp: [10, 10], ...event } as BattleEvent, names, () => (i + 0.01) / rolls.length);
    if (line !== null) out.push(line);
  }
  return out;
};

test('start 和 decide 不配台词', () => {
  assert.equal(
    lineOf({ actor: 0, kind: 'start', hp: [10, 10] }, names, () => 0),
    null,
  );
  assert.equal(
    lineOf({ actor: 0, kind: 'decide', action: { kind: 'unarmed' }, hp: [10, 10] }, names, () => 0),
    null,
  );
});

test('每件法宝的命中都有专属台词，且不超过 40 字', () => {
  const weapons = WEAPON_IDS;
  for (const weapon of weapons) {
    const lines = pick([0, 0.4, 0.8], { actor: 0, kind: 'hit', weapon, damage: 9, crit: false, blocked: false });
    assert.ok(lines.length >= 2, `${weapon} 至少两句`);
    for (const line of lines) {
      assert.ok(line.length <= 40, `${weapon} 的台词超长：${line}`);
      assert.ok(line.includes(names[0]) && line.includes('9'), line);
    }
  }
  // 空手也有两句以上，说的是小拳头
  const unarmed = pick([0, 0.4, 0.8], { actor: 1, kind: 'hit', damage: 5, crit: false, blocked: false });
  assert.ok(unarmed.length >= 2 && unarmed.every((l) => l.includes(names[1]) && l.includes('5')));
  assert.ok(
    unarmed.some((l) => l.includes('拳头')),
    '空手说的是小拳头',
  );
});

test('会心和泡泡挡伤在台词里体现，总长仍 ≤ 40 字', () => {
  const crit = lineOf(
    { actor: 0, kind: 'hit', weapon: 'firework', damage: 30, crit: true, blocked: false, hp: [10, 2] },
    names,
    () => 0,
  );
  assert.ok(crit?.startsWith('会心一击！'), crit ?? '');
  assert.ok(crit!.length <= 40);
  const blocked = lineOf(
    { actor: 1, kind: 'combo', damage: 12, crit: false, blocked: true, hp: [10, 4] },
    names,
    () => 0,
  );
  assert.ok(blocked?.endsWith('（泡泡挡掉一半）'), blocked ?? '');
  assert.ok(blocked!.length <= 40);
});

test('化鸽遁那句只给真有化鸽遁的一方', () => {
  const event: BattleEvent = { actor: 0, kind: 'dodge', hp: [10, 10] };
  // 没传 skillSets 或双方都没有化鸽遁：只会说通用闪避句
  const noDove: ([SkillId[], SkillId[]] | undefined)[] = [undefined, [['bubble'], ['bubble']]];
  for (const sets of noDove) {
    for (const r of [0.01, 0.5, 0.99]) {
      const line = lineOf(event, names, () => r, sets);
      assert.ok(!line!.includes('鸽子'), `不该说鸽子：${line}`);
    }
  }
  // 有化鸽遁：才说得出鸽子句
  const withDove = new Set<string>();
  for (const r of [0.01, 0.25, 0.5, 0.75, 0.99]) {
    withDove.add(lineOf(event, names, () => r, [['dove'], []])!);
  }
  assert.ok(
    [...withDove].some((l) => l.includes('鸽子')),
    '有化鸽遁应该说得出鸽子句',
  );
});

test('其余事件各有台词，名字和数值都对得上', () => {
  const cases: [BattleEvent, (line: string) => boolean][] = [
    [{ actor: 0, kind: 'combo', damage: 7, crit: false, blocked: false, hp: [10, 3] }, (l) => l.includes('7')],
    [{ actor: 1, kind: 'counter', damage: 6, blocked: false, hp: [4, 10] }, (l) => l.includes('6')],
    [
      { actor: 0, kind: 'beast', damage: 5, blocked: false, hp: [10, 5] },
      (l) => l.includes(names[0]) && l.includes('5'),
    ],
    [{ actor: 1, kind: 'skip', hp: [10, 10] }, (l) => l.includes(names[1])],
    [{ actor: 0, kind: 'play-dead', hp: [1, 10] }, (l) => l.includes(names[0])],
    [{ actor: 0, kind: 'skill', skill: 'bloom', heal: 25, hp: [30, 10] }, (l) => l.includes('25')],
    [{ actor: 0, kind: 'skill', skill: 'lion-roar', damage: 15, hp: [10, 5] }, (l) => l.includes('15')],
    [{ actor: 0, kind: 'skill', skill: 'blue-whale', damage: 28, hp: [10, 2] }, (l) => l.includes('28')],
    [{ actor: 0, kind: 'strike', index: 0, damage: 21, blocked: false, hp: [9, 0] }, (l) => l.includes('21')],
    [
      { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp: [10, 0] },
      (l) => l.includes(names[0]) || l.includes(names[1]),
    ],
  ];
  for (const [event, check] of cases) {
    const line = lineOf(event, names, () => 0);
    assert.ok(line !== null, `${event.kind} 应该有台词`);
    assert.ok(check(line!), `${event.kind} 台词内容不对：${line}`);
    assert.ok(line!.length <= 40, `${event.kind} 台词超长：${line}`);
  }
});

test('同一种事件多次掷随机数会换着说', () => {
  const event: BattleEvent = { actor: 0, kind: 'dodge', hp: [10, 10] };
  const seen = new Set([
    lineOf(event, names, () => 0.01),
    lineOf(event, names, () => 0.5),
    lineOf(event, names, () => 0.99),
  ]);
  assert.ok(seen.size >= 2, '闪避的几句模板应该轮着来');
});

test('X8：新法宝的迟缓 / 两颗、跳过按原因、打空、分身、三个新主动都有台词，不超过 40 字', () => {
  const cases: [BattleEvent, (line: string) => boolean][] = [
    [
      { actor: 0, kind: 'hit', weapon: 'duster', damage: 6, crit: false, blocked: false, slowed: true, hp: [10, 4] },
      (l) => l.includes('6') && /笑|乐/.test(l),
    ],
    [
      { actor: 0, kind: 'hit', weapon: 'slingshot', damage: 16, crit: false, blocked: false, twin: true, hp: [10, 4] },
      (l) => l.includes('16') && /两颗/.test(l),
    ],
    [{ actor: 1, kind: 'skip', cause: 'freeze', hp: [10, 10] }, (l) => l.includes(names[1]) && /冰/.test(l)],
    [{ actor: 1, kind: 'skip', cause: 'sleep', hp: [10, 10] }, (l) => l.includes(names[1]) && /睡|呼/.test(l)],
    [{ actor: 1, kind: 'skip', cause: 'stun', hp: [10, 10] }, (l) => l.includes(names[1])],
    [{ actor: 1, kind: 'miss', hp: [10, 10] }, (l) => l.includes(names[1])],
    [{ actor: 1, kind: 'decoy', hp: [10, 10] }, (l) => l.includes(names[1]) && l.includes('水母')],
    [{ actor: 0, kind: 'skill', skill: 'whale-song', hp: [10, 10] }, (l) => l.includes(names[1])],
    [{ actor: 0, kind: 'skill', skill: 'ink', hp: [10, 10] }, (l) => l.includes(names[1]) && l.includes('墨')],
    [
      { actor: 0, kind: 'skill', skill: 'whale-gulp', damage: 22, heal: 11, hp: [10, 10] },
      (l) => l.includes('22') && l.includes('11'),
    ],
  ];
  for (const [event, check] of cases) {
    for (const roll of [0.01, 0.99]) {
      const line = lineOf(event, names, () => roll);
      assert.ok(line !== null, `${event.kind} 应该有台词`);
      assert.ok(check(line!), `${event.kind} 台词内容不对：${line}`);
      assert.ok(line!.length <= 40, `${event.kind} 台词超长：${line}`);
    }
  }
  // 迟缓 / 两颗的专属句叠上会心或挡伤，仍不超长
  for (const flag of [{ slowed: true as const }, { twin: true as const }]) {
    for (const extra of [
      { crit: true, blocked: false },
      { crit: false, blocked: true },
    ]) {
      const line = lineOf(
        { actor: 0, kind: 'hit', weapon: 'duster', damage: 99, ...extra, ...flag, hp: [10, 4] },
        names,
        () => 0.5,
      );
      assert.ok(line!.length <= 40, `叠加后超长：${line}`);
    }
  }
});

test('X9：魂影替挨、入梦、穿护体、三个新主动都有台词，不超过 40 字', () => {
  const names: [string, string] = ['阿鲸', '心魔'];
  const cases: Array<[BattleEvent, (line: string) => boolean]> = [
    [{ actor: 0, kind: 'mirror', hp: [10, 10] }, (l) => l.includes(names[0]) && l.includes('魂影')],
    [{ actor: 1, kind: 'skip', cause: 'dream', hp: [10, 10] }, (l) => l.includes(names[1]) && /梦/.test(l)],
    [{ actor: 0, kind: 'skill', skill: 'myriad-self', hp: [10, 10] }, (l) => l.includes(names[0])],
    [
      { actor: 0, kind: 'skill', skill: 'dream-chant', damage: 21, hp: [10, 4] },
      (l) => l.includes('21') && l.includes(names[1]),
    ],
    [{ actor: 0, kind: 'skill', skill: 'finger-sword', damage: 26, hp: [10, 4] }, (l) => l.includes('26')],
    [
      { actor: 0, kind: 'skill', skill: 'finger-sword', damage: 26, pierce: true, hp: [10, 4] },
      (l) => l.includes('26') && /护体/.test(l),
    ],
  ];
  for (const [event, check] of cases) {
    for (const roll of [0.01, 0.99]) {
      const line = lineOf(event, names, () => roll);
      assert.ok(line !== null, `${event.kind} 应该有台词`);
      assert.ok(check(line!), `${event.kind} 台词内容不对：${line}`);
      assert.ok(line!.length <= 40, `${event.kind} 台词超长：${line}`);
    }
  }
});

test('X16：降龙十八掌 / 送友风、后劲、飘起来、送走都有台词，不超过 40 字', () => {
  const names: [string, string] = ['小鱼', '心魔'];
  const cases: Array<[BattleEvent, (line: string) => boolean]> = [
    [
      { actor: 0, kind: 'hit', weapon: 'water-gun', damage: 18, crit: false, blocked: false, surge: true, hp: [10, 4] },
      (l) => l.includes('18') && /后劲|余劲/.test(l),
    ],
    [
      { actor: 0, kind: 'skill', skill: 'dragon-palm', damage: 28, hp: [10, 4] },
      (l) => l.includes('28') && /亢龙有悔|龙影/.test(l),
    ],
    [
      { actor: 0, kind: 'skill', skill: 'farewell-wind', damage: 22, hp: [10, 4] },
      (l) => l.includes('22') && /清风|一路顺风/.test(l),
    ],
    [{ actor: 1, kind: 'skip', cause: 'float', hp: [10, 10] }, (l) => l.includes(names[1]) && /飘/.test(l)],
    [
      { actor: 0, kind: 'end', winner: 0, reason: 'farewell', hp: [10, 4] },
      // 被送走的是输家（{b}）：每一句都得点它的名，不能写成赢家「被送回家了」
      (l) => l.includes(names[1]) && /送回家|送走/.test(l) && !l.startsWith(`${names[0]}被`),
    ],
  ];
  for (const [event, check] of cases) {
    const seen = new Set<string>();
    for (const roll of [0.01, 0.5, 0.99]) {
      const line = lineOf(event, names, () => roll);
      assert.ok(line !== null, `${event.kind} 应该有台词`);
      assert.ok(check(line!), `${event.kind} 台词内容不对：${line}`);
      assert.ok(line!.length <= 40, `${event.kind} 台词超长：${line}`);
      seen.add(line!);
    }
    assert.ok(seen.size >= 2, `${event.kind} 至少两句`);
  }
});

test('X21：万我大手印 / 逆流护身印 / 前有古人 / 吃苦吃亏、反弹、古人、三种吃法、封法宝都有台词，不超过 40 字', () => {
  // 名字按 12 字上限来验长度
  const names: [string, string] = ['小花小花小花小花', '心魔心魔心魔心魔'];
  const cases: Array<[BattleEvent, (line: string) => boolean]> = [
    [
      { actor: 0, kind: 'skill', skill: 'myriad-palm', damage: 30, hp: [10, 4] },
      (l) => l.includes('30') && /大手印|巨掌/.test(l),
    ],
    [
      { actor: 0, kind: 'skill', skill: 'myriad-palm', damage: 30, sealed: 'weapon', hp: [10, 4] },
      (l) => l.includes('30') && /法宝/.test(l),
    ],
    [
      { actor: 0, kind: 'skill', skill: 'reverse-seal', hp: [10, 10] },
      (l) => l.includes(names[0]) && /逆流|白袍|水雾/.test(l),
    ],
    [{ actor: 0, kind: 'skill', skill: 'ancients', hp: [10, 10] }, (l) => /古人|光阴/.test(l)],
    [{ actor: 0, kind: 'skill', skill: 'eat-hardship', hp: [10, 10] }, (l) => /吃|亏/.test(l)],
    [{ actor: 1, kind: 'reverse', damage: 21, hp: [7, 10] }, (l) => l.includes('21') && /打回|自食/.test(l)],
    [{ actor: 0, kind: 'ancient', damage: 80, hp: [10, 2] }, (l) => l.includes('80') && /古人/.test(l)],
    [{ actor: 0, kind: 'devour', what: 'bubble', heal: 17, hp: [10, 10] }, (l) => l.includes('17') && /泡泡/.test(l)],
    [{ actor: 0, kind: 'devour', what: 'mirror', heal: 13, hp: [10, 10] }, (l) => l.includes('13') && /魂影/.test(l)],
    [
      { actor: 0, kind: 'devour', what: 'bite', damage: 44, heal: 22, hp: [10, 4] },
      (l) => l.includes('44') && l.includes('22'),
    ],
  ];
  for (const [event, check] of cases) {
    const seen = new Set<string>();
    for (const roll of [0.01, 0.5, 0.99]) {
      const line = lineOf(event, names, () => roll);
      assert.ok(line !== null, `${event.kind} 应该有台词`);
      assert.ok(check(line!), `${event.kind} 台词内容不对：${line}`);
      assert.ok(line!.length <= 40, `${event.kind} 台词超长：${line}`);
      seen.add(line!);
    }
    assert.ok(seen.size >= 2, `${event.kind} 至少两句`);
  }
});

test('X22：鬼手 / 无头鬼影 / 鬼敲门 / 鬼画 / 鬼血、封招式、取首级、封被动、敲门反噬都有台词，不超过 40 字', () => {
  const names: [string, string] = ['小花小花小花小花', '心魔心魔心魔心魔'];
  const cases: Array<[BattleEvent, (line: string) => boolean]> = [
    [
      { actor: 0, kind: 'skill', skill: 'ghost-hand', damage: 26, hp: [10, 4] },
      (l) => l.includes('26') && /鬼手|掐/.test(l),
    ],
    [
      { actor: 0, kind: 'skill', skill: 'ghost-hand', damage: 26, sealed: 'skill', hp: [10, 4] },
      (l) => l.includes('26') && /招式/.test(l),
    ],
    [
      { actor: 0, kind: 'skill', skill: 'headless-shadow', damage: 40, hp: [10, 4] },
      (l) => l.includes('40') && /鬼影|影子/.test(l),
    ],
    [
      { actor: 0, kind: 'skill', skill: 'headless-shadow', damage: 40, behead: true, hp: [10, 0] },
      (l) => l.includes('40') && /头颅|没了头/.test(l),
    ],
    [{ actor: 0, kind: 'skill', skill: 'ghost-knock', hp: [10, 10] }, (l) => /敲|门/.test(l)],
    [{ actor: 0, kind: 'skill', skill: 'ghost-painting', paint: 'bubble', hp: [10, 10] }, (l) => /符|画|封/.test(l)],
    [{ actor: 0, kind: 'skill', skill: 'ghost-painting', damage: 20, hp: [10, 10] }, (l) => /符|画/.test(l)],
    [
      { actor: 0, kind: 'skill', skill: 'ghost-blood', damage: 30, hp: [10, 4] },
      (l) => l.includes('30') && /血珠|暗红/.test(l),
    ],
    [{ actor: 1, kind: 'knock', damage: 26, hp: [4, 10] }, (l) => l.includes('26') && /敲门|门响/.test(l)],
  ];
  for (const [event, check] of cases) {
    const seen = new Set<string>();
    for (const roll of [0.01, 0.5, 0.99]) {
      const line = lineOf(event, names, () => roll);
      assert.ok(line !== null, `${event.kind} 应该有台词`);
      assert.ok(check(line!), `${event.kind} 台词内容不对：${line}`);
      assert.ok(line!.length <= 40, `${event.kind} 台词超长：${line}`);
      seen.add(line!);
    }
    assert.ok(seen.size >= 2, `${event.kind} 至少两句`);
  }
  // 鬼眼是被动：化鸽遁之外，带鬼眼的一方闪避时说「看穿了」
  const ghostEyeSeen = new Set<string>();
  for (const roll of [0.01, 0.5, 0.99]) {
    ghostEyeSeen.add(lineOf({ actor: 0, kind: 'dodge', hp: [10, 10] }, names, () => roll, [['ghost-eye'], []])!);
  }
  assert.ok(
    [...ghostEyeSeen].every((l) => /鬼眼|幽光/.test(l)),
    `鬼眼闪避句不对：${[...ghostEyeSeen]}`,
  );
  assert.ok(ghostEyeSeen.size >= 2, '鬼眼闪避至少两句');
});

test('X11：名字以「的」结尾时，所有 {a}的 / {b}的 模板都不重复「的」', () => {
  const deNames: [string, string] = ['吃白饭的', '吃白饭的'];
  const hp: [number, number] = [10, 10];
  // 每个事件都固定对应一个模板数组；数组都少于 128 句，rng 扫满 [0, 1) 就能挑到每一句
  const events: BattleEvent[] = [
    ...WEAPON_IDS.map((weapon): BattleEvent => ({
      actor: 0,
      kind: 'hit',
      weapon,
      damage: 9,
      crit: false,
      blocked: false,
      hp,
    })),
    { actor: 0, kind: 'hit', damage: 9, crit: false, blocked: false, hp },
    { actor: 0, kind: 'hit', weapon: 'duster', damage: 9, crit: false, blocked: false, slowed: true, hp },
    { actor: 0, kind: 'hit', weapon: 'slingshot', damage: 9, crit: false, blocked: false, twin: true, hp },
    { actor: 0, kind: 'hit', weapon: 'water-gun', damage: 9, crit: false, blocked: false, surge: true, hp },
    { actor: 0, kind: 'combo', damage: 9, crit: false, blocked: false, hp },
    { actor: 0, kind: 'dodge', hp },
    { actor: 0, kind: 'counter', damage: 9, blocked: false, hp },
    { actor: 0, kind: 'beast', damage: 9, blocked: false, hp },
    { actor: 0, kind: 'skip', hp },
    { actor: 0, kind: 'skip', cause: 'freeze', hp },
    { actor: 0, kind: 'skip', cause: 'sleep', hp },
    { actor: 0, kind: 'skip', cause: 'dream', hp },
    { actor: 0, kind: 'skip', cause: 'float', hp },
    { actor: 0, kind: 'miss', hp },
    { actor: 0, kind: 'decoy', hp },
    { actor: 0, kind: 'mirror', hp },
    { actor: 0, kind: 'play-dead', hp },
    ...SKILL_IDS.filter((skill) => SKILLS[skill].kind === '主动').map((skill): BattleEvent => ({
      actor: 0,
      kind: 'skill',
      skill,
      damage: 9,
      heal: 3,
      hp,
    })),
    { actor: 0, kind: 'skill', skill: 'finger-sword', damage: 9, pierce: true, hp },
    // X21：封法宝、反弹、古人、三种吃法
    { actor: 0, kind: 'skill', skill: 'myriad-palm', damage: 9, sealed: 'weapon', hp },
    { actor: 0, kind: 'reverse', damage: 9, hp },
    { actor: 0, kind: 'ancient', damage: 9, hp },
    { actor: 0, kind: 'devour', what: 'bubble', heal: 3, hp },
    { actor: 0, kind: 'devour', what: 'mirror', heal: 3, hp },
    { actor: 0, kind: 'devour', what: 'bite', damage: 9, heal: 3, hp },
    // X22：封招式、取首级、封被动、敲门反噬
    { actor: 0, kind: 'skill', skill: 'ghost-hand', damage: 9, sealed: 'skill', hp },
    { actor: 0, kind: 'skill', skill: 'headless-shadow', damage: 9, behead: true, hp },
    { actor: 0, kind: 'skill', skill: 'ghost-painting', paint: 'bubble', hp },
    { actor: 0, kind: 'knock', damage: 9, hp },
    { actor: 0, kind: 'strike', index: 0, damage: 9, blocked: false, hp },
    { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp },
    { actor: 0, kind: 'end', winner: 0, reason: 'farewell', hp },
  ];
  const seen = new Set<string>();
  for (const event of events) {
    for (let i = 0; i < 128; i++) {
      const line = lineOf(event, deNames, () => (i + 0.5) / 128);
      assert.ok(line !== null, `${event.kind} 应该有台词`);
      seen.add(line!);
      assert.ok(!line!.includes('的的'), `「的」重复了：${line}`);
    }
  }
  // 主角、对手两个位置都真的覆盖到了
  for (const expected of [
    '吃白饭的王牌划过空气，-9',
    '吃白饭的雪球啪地糊在吃白饭的身上，-9',
    '吃白饭的掸子扫过吃白饭的鼻尖，-9',
    '吃白饭的灵兽窜上去咬了一口，-9',
    '吃白饭的水母分身替它挨了这下',
    '吃白饭的掸子挠得吃白饭的笑岔气，-9',
    '吃白饭的弹弓一发两颗，-9',
    '吃白饭的张嘴猛吸，吃白饭的灵气 -9，自己 +3',
    '吃白饭的低声念咒，魂丝缠上吃白饭的神魂，-9',
    '吃白饭的剑气穿过吃白饭的护体，-9',
  ]) {
    assert.ok(seen.has(expected), `没覆盖到：${expected}`);
  }
});

test('X11：普通名字照旧补「的」，名字中间的「的」不受影响', () => {
  const snowball: BattleEvent = {
    actor: 0,
    kind: 'hit',
    weapon: 'snowball',
    damage: 5,
    crit: false,
    blocked: false,
    hp: [10, 10],
  };
  assert.equal(
    lineOf(snowball, ['小蓝', '心魔'], () => 0.75),
    '小蓝的雪球啪地糊在心魔身上，-5',
  );
  assert.equal(
    lineOf(snowball, ['我的猫', '心魔'], () => 0.75),
    '我的猫的雪球啪地糊在心魔身上，-5',
  );
  // 只有名字以「的」结尾才不补；对手位置也一样
  const duster: BattleEvent = {
    actor: 0,
    kind: 'hit',
    weapon: 'duster',
    damage: 6,
    crit: false,
    blocked: false,
    hp: [10, 10],
  };
  assert.equal(
    lineOf(duster, ['小蓝', '吃白饭的'], () => 0.75),
    '小蓝的掸子扫过吃白饭的鼻尖，-6',
  );
  assert.equal(
    lineOf(duster, ['吃白饭的', '小蓝'], () => 0.75),
    '吃白饭的掸子扫过小蓝的鼻尖，-6',
  );
});
