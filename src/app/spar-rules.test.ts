import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fight,
  fightUntilDecision,
  legalActions,
  type Action,
  type BattleEvent,
  type Controller,
  type Fighter,
} from './battle';
import { SPAR_OPTIONS, sparFighter } from './spar-rules';

const act = (action: Action): Controller => ({ decide: () => action });
const skill = (skill: Extract<Action, { kind: 'skill' }>['skill']): Action => ({ kind: 'skill', skill });
const weapon = (weapon: Extract<Action, { kind: 'weapon' }>['weapon']): Action => ({ kind: 'weapon', weapon });
const unarmed: Action = { kind: 'unarmed' };
const roundFighter = (name: string, skills: Fighter['skills'], weapons: Fighter['weapons'] = []): Fighter => ({
  name,
  hp: 230,
  power: 20,
  agility: 0,
  speed: 20,
  weapons,
  skills,
});
const tiny = (name: string): Fighter => ({
  name,
  hp: 1,
  power: 20,
  agility: 1,
  speed: 20,
  weapons: ['firework'],
  skills: [],
});
const endOf = (events: BattleEvent[]) => {
  const end = events[events.length - 1];
  assert.equal(end.kind, 'end');
  if (end.kind !== 'end') throw new Error('missing end');
  return end;
};

test('公共切磋配装返回独立库存，不读取或继承成长加持', () => {
  const a = sparFighter('甲');
  const b = sparFighter('乙');
  assert.equal(a.hp, 230);
  assert.equal(a.weapons.length, 11);
  assert.equal(a.skills.length, 32);
  a.skills.pop();
  assert.equal(b.skills.length, 32);
  assert.equal(a.mods, undefined);
});

const precisionAttacker: Fighter = {
  ...roundFighter('甲', ['critical', 'shadow-fists', 'abyss-field'], ['firework', 'tray', 'water-gun']),
  agility: 20,
  speed: 99,
};
const precisionDefender: Fighter = { ...roundFighter('乙', ['dove', 'shadow-step']), agility: 20, speed: 1 };
const weaponDamage = (events: BattleEvent[]) =>
  events.flatMap((event) =>
    event.actor === 0 && (event.kind === 'hit' || event.kind === 'combo') && event.weapon
      ? [[event.kind, event.damage]]
      : [],
  );

test('烟花保留必中，少吃破势且不连击；瞬影仍能躲过烟花', () => {
  // 本轮闪避签低于 35%，连击签也低于 35%，正好覆盖两条判定。
  const seed = 'spar-precision-firework-22';
  const firework = weapon('firework');
  const resolve = (answer: Action) =>
    fightUntilDecision(precisionAttacker, precisionDefender, seed, [[firework], [answer]], SPAR_OPTIONS).events;
  assert.deepEqual(weaponDamage(resolve(unarmed)), [['hit', 37]]);
  const blink = resolve(skill('shadow-step'));
  assert.deepEqual(weaponDamage(blink), []);
  assert.ok(blink.some((event) => event.kind === 'dodge' && event.actor === 1));
});

test('银托盘只减少自带必中的回旋段破势，首段和随机连击不减', () => {
  const { events } = fightUntilDecision(
    precisionAttacker,
    precisionDefender,
    'spar-precision-tray-1',
    [[weapon('tray')], [unarmed]],
    SPAR_OPTIONS,
  );
  assert.deepEqual(weaponDamage(events), [
    ['hit', 27],
    ['hit', 18],
    ['combo', 27],
  ]);
});

test('领域让水枪临时必中但不减破势；旧时间轴烟花仍能满额连击', () => {
  const field = fightUntilDecision(
    precisionAttacker,
    precisionDefender,
    'spar-precision-field-3',
    [
      [skill('abyss-field'), weapon('water-gun')],
      [unarmed, unarmed],
    ],
    SPAR_OPTIONS,
  );
  assert.deepEqual(weaponDamage(field.events), [['hit', 50]]);

  const legacy = fightUntilDecision(precisionAttacker, precisionDefender, 'spar-precision-old-3', [
    [weapon('firework')],
    [],
  ]);
  assert.deepEqual(weaponDamage(legacy.events), [
    ['hit', 81],
    ['combo', 168],
  ]);
});

test('同步轮双方视野在任一动作结算之前，补齐双方动作后才结算', () => {
  const a = tiny('甲');
  const b = tiny('乙');
  const first = fightUntilDecision(a, b, 'locked-before-hit', [[], []], SPAR_OPTIONS);
  assert.ok(first.need?.views);
  assert.equal(first.need.view.round, 0);
  assert.deepEqual(
    first.need.views.map((v) => v.hp),
    [
      [1, 1],
      [1, 1],
    ],
  );
  const one = fightUntilDecision(
    a,
    b,
    'locked-before-hit',
    [[{ kind: 'weapon', weapon: 'firework' }], []],
    SPAR_OPTIONS,
  );
  assert.equal(one.need?.side, 1);
  assert.equal(one.events.length, 1);
  assert.deepEqual(one.need?.view.hp, [1, 1]);
  const both = fightUntilDecision(
    a,
    b,
    'locked-before-hit',
    [[{ kind: 'weapon', weapon: 'firework' }], [{ kind: 'weapon', weapon: 'firework' }]],
    SPAR_OPTIONS,
  );
  assert.equal(both.need, null);
  assert.equal(both.events.filter((e) => e.kind === 'decide').length, 2);
  assert.equal(endOf(both.events).draw, true);
  assert.deepEqual(endOf(both.events).hp, [0, 0]);
});

test('同步轮双亡为平局，双方已锁动作不会被致命伤取消', () => {
  const events = fight(
    tiny('甲'),
    tiny('乙'),
    'double-ko',
    [act({ kind: 'weapon', weapon: 'firework' }), act({ kind: 'weapon', weapon: 'firework' })],
    SPAR_OPTIONS,
  );
  assert.equal(events.filter((e) => e.kind === 'hit').length, 2);
  assert.equal(endOf(events).draw, true);
  assert.equal(endOf(events).reason, 'ko');
});

test('双方同轮防守先建立，逆流不会因为展示顺序晚而失效', () => {
  for (const side of [0, 1] as const) {
    const defender: Fighter = { ...sparFighter('守'), skills: ['reverse-seal'], weapons: [], hp: 1000 };
    const attacker: Fighter = { ...sparFighter('攻'), skills: [], weapons: ['firework'], hp: 1000 };
    const def: Action[] = [{ kind: 'skill', skill: 'reverse-seal' }];
    const atk: Action[] = [{ kind: 'weapon', weapon: 'firework' }];
    const result = fightUntilDecision(
      side === 0 ? defender : attacker,
      side === 0 ? attacker : defender,
      'same-round-defence',
      side === 0 ? [def, atk] : [atk, def],
      SPAR_OPTIONS,
    );
    assert.ok(result.events.some((e) => e.kind === 'reverse' && e.actor === side));
    assert.equal(result.need?.view.round, 1);
  }
});

test('生花在同步切磋占一轮回血，不递归追加选择', () => {
  const f = { ...sparFighter('甲'), hpNow: 100, skills: ['bloom'] as const };
  const result = fightUntilDecision(
    { ...f, skills: [...f.skills] },
    sparFighter('乙'),
    'one-bloom',
    [[{ kind: 'skill', skill: 'bloom' }], [{ kind: 'skill', skill: 'bloom' }]],
    SPAR_OPTIONS,
  );
  assert.equal(result.need?.view.round, 1);
  assert.equal(result.events.filter((e) => e.kind === 'decide' && e.actor === 0).length, 1);
  assert.equal(result.need?.views?.[0].you.skillUsesLeft, 2);
  assert.equal(result.need?.views?.[0].hp[0], 142);
});

test('同轮封法宝从下一轮生效，不撤销对方已锁的法宝', () => {
  const a = { ...sparFighter('甲'), hp: 1000 };
  const b = { ...sparFighter('乙'), hp: 1000, agility: 1, skills: [] };
  let covered = false;
  for (let i = 0; i < 40; i++) {
    const result = fightUntilDecision(
      a,
      b,
      'seal-next-' + i,
      [[{ kind: 'skill', skill: 'myriad-palm' }], [{ kind: 'weapon', weapon: 'firework' }]],
      SPAR_OPTIONS,
    );
    if (!result.events.some((e) => e.kind === 'skill' && e.sealed === 'weapon')) continue;
    assert.ok(result.events.some((e) => e.kind === 'hit' && e.actor === 1 && e.weapon === 'firework'));
    assert.equal(result.need?.views?.[1].you.sealed, 'weapon');
    assert.ok(legalActions(result.need!.views![1]).every((a) => a.kind !== 'weapon'));
    covered = true;
    break;
  }
  assert.ok(covered);
});

test('控制只跳过下一轮，当前轮的锁招仍然完整执行', () => {
  const f = { ...sparFighter('甲'), hp: 1000, agility: 1 };
  let covered = false;
  for (let i = 0; i < 80; i++) {
    const first = fightUntilDecision(
      f,
      { ...f, name: '乙' },
      'control-next-' + i,
      [[{ kind: 'skill', skill: 'whale-song' }], [{ kind: 'weapon', weapon: 'firework' }]],
      SPAR_OPTIONS,
    );
    if (!first.need?.views?.[1].you.status?.skip) continue;
    assert.ok(first.events.some((e) => e.kind === 'hit' && e.actor === 1));
    assert.deepEqual(legalActions(first.need.views[1]), [{ kind: 'unarmed' }]);
    const second = fightUntilDecision(
      f,
      { ...f, name: '乙' },
      'control-next-' + i,
      [
        [{ kind: 'skill', skill: 'whale-song' }, { kind: 'unarmed' }],
        [{ kind: 'weapon', weapon: 'firework' }, { kind: 'unarmed' }],
      ],
      SPAR_OPTIONS,
    );
    assert.ok(second.events.some((e) => e.kind === 'skip' && e.actor === 1));
    assert.equal(second.need?.view.round, 2);
    covered = true;
    break;
  }
  assert.ok(covered);
});

test('鲸派气功受控时保留蓄力，下一次用占位动作自动释放且不再扣额度', () => {
  const a = roundFighter('甲', ['tide-cannon'], ['firework']);
  const b = roundFighter('乙', ['whale-song']);
  const seed = 'tide-after-skip';
  const charge = skill('tide-cannon');
  const song = skill('whale-song');
  const charged = fightUntilDecision(a, b, seed, [[charge], [song]], SPAR_OPTIONS);
  assert.ok(charged.events.some((event) => event.kind === 'skill' && event.charging && event.damage === undefined));
  assert.equal(charged.need?.view.you.status?.skip, true);
  assert.equal(charged.need?.view.you.skillUsesLeft, 2);

  const skipped = fightUntilDecision(
    a,
    b,
    seed,
    [
      [charge, unarmed],
      [song, unarmed],
    ],
    SPAR_OPTIONS,
  );
  const skippedEvents = skipped.events.slice(charged.events.length);
  assert.deepEqual(
    skippedEvents.filter((event) => event.actor === 0).map((event) => event.kind),
    ['round-action', 'skip', 'round-end'],
  );
  assert.ok(skipped.need);
  assert.equal(skipped.need.view.round, 2);
  assert.equal(skipped.need.view.you.status?.skip, false);
  assert.equal(skipped.need.view.you.status?.charge, 1);
  assert.deepEqual(legalActions(skipped.need.view), [unarmed]);

  const left = [charge, unarmed, unarmed];
  const pending = fightUntilDecision(a, b, seed, [left, [song, unarmed]], SPAR_OPTIONS);
  assert.equal(pending.need?.side, 1);
  assert.deepEqual(pending.events, skipped.events);

  const released = fightUntilDecision(a, b, seed, [left, [song, unarmed, unarmed]], SPAR_OPTIONS);
  const events = released.events.slice(skipped.events.length);
  const decision = events.find((event) => event.kind === 'decide' && event.actor === 0);
  assert.ok(decision?.kind === 'decide' && decision.autoRelease);
  assert.deepEqual(decision.action, charge);
  const release = events.find((event) => event.kind === 'skill' && event.skill === 'tide-cannon');
  assert.ok(release?.kind === 'skill' && release.release && (release.damage ?? 0) > 0);
  assert.equal(released.need?.view.round, 3);
  assert.equal(released.need?.view.you.status?.charge, 0);
  assert.equal(released.need?.view.you.skillUsesLeft, 2);
});

test('同轮最后一层泡泡先挡正面攻击，不再减免逆流反伤', () => {
  const a = roundFighter('甲', ['bubble', 'bloom'], ['firework']);
  const b = roundFighter('乙', ['reverse-seal'], ['firework']);
  const seed = 'one-bubble-for-two-hits';
  const firework = weapon('firework');
  const aSetup = [unarmed, skill('bloom')];
  const bSetup = [firework, skill('reverse-seal')];
  const before = fightUntilDecision(a, b, seed, [aSetup, bSetup], SPAR_OPTIONS);
  assert.equal(before.need?.views?.[0].you.status?.bubbles, 1);
  assert.equal(before.need?.views?.[1].you.status?.reversal, 1);

  const after = fightUntilDecision(
    a,
    b,
    seed,
    [
      [...aSetup, firework],
      [...bSetup, firework],
    ],
    SPAR_OPTIONS,
  );
  const events = after.events.slice(before.events.length);
  const direct = events.find((event) => event.kind === 'hit' && event.actor === 1);
  assert.ok(direct?.kind === 'hit' && direct.blocked);
  assert.equal(direct.damage, 28);
  const reverse = events.find((event) => event.kind === 'reverse' && event.actor === 1);
  assert.ok(reverse?.kind === 'reverse');
  assert.equal(reverse.damage, 27);
  assert.equal(after.need?.views?.[0].you.status?.bubbles, 0);
  assert.deepEqual(after.need?.view.hp, [175, 180]);
});

test('鬼画不取消同轮灵兽补击，从下一轮起才封住被动', () => {
  const a = roundFighter('甲', ['ghost-painting']);
  const b = roundFighter('乙', ['spirit-beast'], ['firework']);
  const seed = 'paint-passive-next-round';
  const paint = skill('ghost-painting');
  const firework = weapon('firework');
  const first = fightUntilDecision(a, b, seed, [[paint], [firework]], SPAR_OPTIONS);
  const painted = first.events.find((event) => event.kind === 'skill' && event.skill === 'ghost-painting');
  assert.equal(painted?.kind === 'skill' && painted.paint, 'spirit-beast');
  assert.ok(first.events.some((event) => event.kind === 'beast' && event.actor === 1 && event.damage > 0));
  assert.equal(first.need?.view.round, 1);
  assert.equal(first.need?.views?.[1].you.status?.sealedPassive, 'spirit-beast');

  const second = fightUntilDecision(
    a,
    b,
    seed,
    [
      [paint, unarmed],
      [firework, firework],
    ],
    SPAR_OPTIONS,
  );
  const events = second.events.slice(first.events.length);
  assert.equal(second.need?.view.round, 2);
  assert.ok(events.some((event) => event.kind === 'hit' && event.actor === 1 && event.weapon === 'firework'));
  assert.ok(!events.some((event) => event.kind === 'beast' || (event.kind === 'dodge' && event.beast)));
});

test('领域按轮衰减，连续施放主动也不会无限续领域', () => {
  const f = {
    ...sparFighter('甲'),
    hp: 10000,
    skills: ['abyss-field', 'reverse-seal', 'ancients'] as Fighter['skills'],
  };
  const actions: Action[] = [
    { kind: 'skill', skill: 'abyss-field' },
    { kind: 'skill', skill: 'reverse-seal' },
    { kind: 'skill', skill: 'ancients' },
  ];
  const result = fightUntilDecision(
    f,
    { ...f, name: '乙' },
    'field-duration',
    [actions, [{ kind: 'unarmed' }, { kind: 'unarmed' }, { kind: 'unarmed' }]],
    SPAR_OPTIONS,
  );
  assert.equal(result.need?.view.round, 3);
  assert.equal(result.need?.views?.[0].you.status?.field, 0);
});

test('暗流先用掉最后一层泡泡，正面攻击不再重复减伤', () => {
  const [a, b] = [sparFighter('甲'), sparFighter('乙')];
  const actions: [Action[], Action[]] = [
    [skill('abyss-field'), skill('bloom'), skill('headless-shadow')],
    [skill('myriad-self'), skill('bloom'), skill('ancients')],
  ];
  const before = fightUntilDecision(
    a,
    b,
    'shared-bubble',
    [actions[0].slice(0, 2), actions[1].slice(0, 2)],
    SPAR_OPTIONS,
  );
  assert.equal(before.need?.views?.[1].you.status?.bubbles, 1);
  const after = fightUntilDecision(a, b, 'shared-bubble', actions, SPAR_OPTIONS);
  const events = after.events.slice(before.events.length);
  assert.equal(events.find((event) => event.kind === 'field')?.damage, 7);
  const ghost = events.find((event) => event.kind === 'skill' && event.skill === 'headless-shadow');
  assert.equal(ghost?.kind === 'skill' && ghost.damage, 40);
  assert.equal(after.need?.views?.[1].you.status?.bubbles, 0);
  assert.deepEqual(after.need?.view.hp, [230, 183]);
});

test('无头鬼影与同轮鲸吞合计仍致命时，假死遁救不回来', () => {
  const [a, b] = [sparFighter('甲'), sparFighter('乙')];
  const gun = weapon('water-gun');
  const { events, need } = fightUntilDecision(
    a,
    b,
    'lethal-heal-148',
    [
      [gun, gun, skill('headless-shadow')],
      [gun, gun, skill('whale-gulp')],
    ],
    SPAR_OPTIONS,
  );
  assert.equal(need, null);
  const ghost = events.find((event) => event.kind === 'skill' && event.skill === 'headless-shadow');
  const gulp = events.find((event) => event.kind === 'skill' && event.skill === 'whale-gulp');
  assert.ok(ghost?.kind === 'skill' && gulp?.kind === 'skill');
  assert.equal(ghost.hp[1], 16);
  assert.deepEqual([ghost.damage, ghost.behead, gulp.heal], [40, true, 19]);
  assert.ok(!events.some((event) => event.actor === 1 && event.kind === 'play-dead'));
  assert.deepEqual(endOf(events).hp, [147, 0]);
});

test('同轮生花足以抵消无头鬼影的致命伤，血量为正就不算斩杀', () => {
  const a = sparFighter('甲');
  const b: Fighter = { ...sparFighter('乙'), hpNow: 16, skills: ['bloom', 'play-dead'] };
  const { events, need } = fightUntilDecision(
    a,
    b,
    'bloom-outheals-ghost',
    [[skill('headless-shadow')], [skill('bloom')]],
    SPAR_OPTIONS,
  );
  assert.deepEqual(need?.view.hp, [230, 18]);
  assert.ok(!events.some((event) => event.kind === 'play-dead' || (event.kind === 'skill' && event.behead)));
});

test('独立切磋串门与隔空使用相同规则，不随机送走', () => {
  const f = sparFighter('甲');
  const controller = () => {
    let n = 0;
    return {
      decide: () =>
        n++ === 0
          ? ({ kind: 'skill', skill: 'farewell-wind' } as Action)
          : ({ kind: 'weapon', weapon: 'firework' } as Action),
    };
  };
  for (let i = 0; i < 20; i++) {
    const seed = 'same-location-' + i;
    assert.deepEqual(
      fight(f, f, seed, [controller(), controller()], { ...SPAR_OPTIONS, farewell: true }),
      fight(f, f, seed, [controller(), controller()], SPAR_OPTIONS),
    );
  }
});

test('逐轮重放与整场同步结算完全一致', () => {
  const a = sparFighter('甲'),
    b = sparFighter('乙');
  const action: Action = { kind: 'weapon', weapon: 'firework' };
  const sources: [Action[], Action[]] = [[], []];
  let result = fightUntilDecision(a, b, 'replay-rounds', sources, SPAR_OPTIONS);
  for (let n = 0; result.need && n < 30; n++) {
    for (const side of [0, 1] as const)
      sources[side].push(
        legalActions(result.need.views![side]).find((a) => a.kind === 'weapon' && a.weapon === 'firework') ?? {
          kind: 'unarmed',
        },
      );
    result = fightUntilDecision(a, b, 'replay-rounds', sources, SPAR_OPTIONS);
  }
  assert.equal(result.need, null);
  assert.deepEqual(result.events, fight(a, b, 'replay-rounds', [act(action), act(action)], SPAR_OPTIONS));
});
