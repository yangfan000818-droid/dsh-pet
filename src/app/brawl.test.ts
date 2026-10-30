import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAWL_MAX,
  BRAWL_MIN,
  autoBrawlController,
  brawl,
  brawlNeedsTarget,
  brawlUntilDecision,
  brawlWinner,
  legalBrawlActions,
  type BrawlAction,
  type BrawlController,
  type BrawlEvent,
  type BrawlFighter,
} from './brawl';
import { rngFrom } from './battle';
import { fighterAt, seededRng } from './battle-testkit';

function roster(n: number, seed: number): BrawlFighter[] {
  const rng = seededRng(seed);
  return Array.from({ length: n }, (_, id) => {
    const f = fighterAt(12, rng);
    return { ...f, id, name: `p${id}` };
  });
}

function controllerFor(count: number, seed = 7): BrawlController[] {
  const rng = rngFrom(`test:${seed}`);
  return Array.from({ length: count }, () => autoBrawlController(rng));
}

test('群架：人数必须在 2–5 之间', () => {
  assert.throws(() => brawl([{ ...roster(1, 1)[0] }], 's'), /2–5/);
  assert.throws(() => brawl(roster(BRAWL_MAX + 1, 1), 's'), /2–5/);
  assert.equal(BRAWL_MIN, 2);
});

test('群架：编号必须从 0 连续', () => {
  const two = roster(2, 1);
  assert.throws(() => brawl([two[0], { ...two[1], id: 3 }], 's'), /连续/);
});

test('群架：同一颗种子打出的两场事件完全一致', () => {
  const a = brawl(roster(5, 3), 'seed-1', controllerFor(5));
  const b = brawl(roster(5, 3), 'seed-1', controllerFor(5));
  assert.deepEqual(a, b);
});

test('群架：5 人打完有 end，排名覆盖所有人，胜者是存活的那一个', () => {
  const events = brawl(roster(5, 4), 'seed-2', controllerFor(5));
  const end = events[events.length - 1];
  assert.ok(end && end.kind === 'end');
  assert.equal(end.ranking.length, 5);
  assert.deepEqual([...end.ranking].sort(), [0, 1, 2, 3, 4]);
  for (const hp of end.hp) assert.ok(hp >= 0);
  if (end.winner !== null) {
    assert.equal(end.hp[end.winner] > 0, true);
    assert.equal(end.ranking[0], end.winner);
  }
});

test('群架：每一条事件的 hp 快照长度都等于人数', () => {
  const events = brawl(roster(4, 5), 'seed-3', controllerFor(4));
  for (const event of events) assert.equal(event.hp.length, 4);
});

test('群架：攻击类事件的 target 永远不是出手方自己', () => {
  const events = brawl(roster(5, 6), 'seed-4', controllerFor(5));
  for (const event of events) {
    if (
      event.kind === 'hit' ||
      event.kind === 'combo' ||
      event.kind === 'dodge' ||
      event.kind === 'miss' ||
      event.kind === 'mirror' ||
      event.kind === 'decoy' ||
      event.kind === 'guard' ||
      event.kind === 'counter' ||
      event.kind === 'beast'
    ) {
      assert.notEqual(event.target, event.actor, `${event.kind} 打到自己身上`);
    }
  }
});

test('群架：非法目标回退到还活着的别人', () => {
  const fighters = roster(3, 7);
  const bad: BrawlController = { decide: () => ({ kind: 'unarmed', target: 99 }) };
  const events = brawl(fighters, 'seed-5', [bad, bad, bad]);
  const decide = events.find((event): event is Extract<BrawlEvent, { kind: 'decide' }> => event.kind === 'decide');
  assert.ok(decide);
  assert.ok(decide.action.target >= 0 && decide.action.target < 3);
  assert.notEqual(decide.action.target, decide.actor);
});

test('群架：自增益招的目标记自己', () => {
  const fighters: BrawlFighter[] = roster(2, 8).map((f, i) => ({
    ...f,
    weapons: [],
    skills: i === 0 ? ['bloom'] : [],
  }));
  let first = true;
  const caster: BrawlController = {
    decide: () => {
      if (first) {
        first = false;
        return { kind: 'skill', skill: 'bloom', target: 0 };
      }
      return { kind: 'unarmed', target: 1 };
    },
  };
  const events = brawl(fighters, 'seed-6', [caster, { decide: () => ({ kind: 'unarmed', target: 0 }) }]);
  const decide = events.find(
    (event): event is Extract<BrawlEvent, { kind: 'decide' }> =>
      event.kind === 'decide' && event.actor === 0 && event.action.kind === 'skill',
  );
  assert.ok(decide);
  if (decide.action.kind === 'skill') assert.equal(decide.action.target, 0);
});

test('群架：到出手上限按剩余气血判，reason 是 timeout', () => {
  const fighters = roster(5, 9).map((f) => ({ ...f, hp: 9999, weapons: ['water-gun' as const] }));
  const events = brawl(fighters, 'seed-7', controllerFor(5), { maxActions: 6, spar: false });
  const end = events[events.length - 1];
  assert.ok(end && end.kind === 'end');
  assert.equal(end.reason, 'timeout');
  assert.equal(end.ranking.length, 5);
});

test('群架：淘汰后不再被选为目标', () => {
  // 弱鸡对一群大汉：0 号很快就死，之后的事件里不该再拿它当目标
  const fighters = roster(3, 10);
  fighters[0] = { ...fighters[0], hp: 1, power: 1, agility: 1, weapons: [], skills: [] };
  fighters[1] = { ...fighters[1], hp: 400, power: 60, weapons: ['water-gun'] };
  fighters[2] = { ...fighters[2], hp: 400, power: 60, weapons: ['water-gun'] };
  const events = brawl(fighters, 'seed-8', controllerFor(3));
  const koAt = events.findIndex((event) => event.kind === 'ko' && event.target === 0);
  assert.ok(koAt >= 0);
  for (const event of events.slice(koAt + 1)) {
    if ('target' in event && typeof event.target === 'number' && event.kind !== 'ko' && event.kind !== 'forfeit') {
      assert.notEqual(event.target, 0, `${event.kind} 还在打已淘汰的 0 号`);
    }
  }
});

test('群架：2 人局能正常收场，胜者只有一位', () => {
  const events = brawl(roster(2, 11), 'seed-9', controllerFor(2));
  const winner = brawlWinner(events);
  assert.ok(winner === 0 || winner === 1);
});

test('群架：自增益招判定与合法动作清单', () => {
  assert.equal(brawlNeedsTarget({ kind: 'skill', skill: 'bloom' }), false);
  assert.equal(brawlNeedsTarget({ kind: 'skill', skill: 'shadow-step' }), false);
  assert.equal(brawlNeedsTarget({ kind: 'skill', skill: 'blue-whale' }), true);
  assert.equal(brawlNeedsTarget({ kind: 'unarmed' }), true);

  const view = {
    self: 0,
    hp: [50, 50],
    maxHp: [50, 50],
    alive: [true, true],
    you: { weapons: ['water-gun' as const], skills: ['bloom' as const, 'blue-whale' as const], used: [] as never[] },
    foes: [{ id: 1, hp: 50, maxHp: 50, weapons: [], skills: [] }],
  };
  const actions = legalBrawlActions(view);
  assert.ok(actions.some((a) => a.kind === 'weapon'));
  assert.ok(actions.some((a) => a.kind === 'skill' && a.skill === 'bloom'));
  assert.ok(actions.some((a) => a.kind === 'skill' && a.skill === 'blue-whale'));
});

test('分步群架：全自动与整场 brawl() 打出同一串事件', () => {
  for (const n of [2, 3, 4, 5]) {
    const fighters = roster(n, 21 + n);
    const whole = brawl(fighters, 'step-seed');
    const step = brawlUntilDecision(
      fighters,
      'step-seed',
      fighters.map(() => 'auto' as const),
    );
    assert.deepEqual(step.events, whole, `${n} 人`);
    assert.equal(step.need, null, '全自动一路打到底');
  }
});

test('分步群架：按收到的一手一手喂进去，事件与整场一致', () => {
  const fighters = roster(4, 33);
  const seed = 'step-feed';
  const rng = rngFrom(`${seed}:decide`);
  const controllers = fighters.map(() => autoBrawlController(rng));
  const whole = brawl(fighters, seed, controllers);
  // 整场里每一手（按顺序），联机时就是各家广播过来的那些
  const expected = whole.filter(
    (e): e is Extract<BrawlEvent, { kind: 'decide' }> => e.kind === 'decide' && !('autoRelease' in e),
  );
  const moves: BrawlAction[][] = fighters.map(() => []);
  let events: BrawlEvent[] = [];
  let cursor = 0;
  let need = brawlUntilDecision(fighters, seed, moves).need;
  for (let guard = 0; need && guard < 200; guard += 1) {
    const decision = expected[cursor];
    assert.ok(decision, `第 ${cursor} 手`);
    assert.equal(decision.actor, need.id, '停下来的正好是轮到的那一方');
    assert.equal(need.view.self, need.id, '视野里的自己');
    moves[need.id].push(decision.action);
    const step = brawlUntilDecision(fighters, seed, moves);
    events = step.events;
    need = step.need;
    cursor += 1;
  }
  assert.equal(need, null, '能够打到收场');
  assert.deepEqual(events, whole, '分步重算与整场事件一致');
  assert.equal(cursor, expected.length, '每一手都喂到了');
});

test('群架：认输退场按清单执行——之后不出手也不挨打，不补 ko，同一份清单打出同一串事件', () => {
  const fighters = roster(3, 21);
  const seed = 'forfeit:1';
  const options = { forfeits: [{ id: 1, at: 0 }] };
  const events = brawl(fighters, seed, controllerFor(3, 21), options);
  const at = events.findIndex((event) => event.kind === 'forfeit');
  assert.ok(at > 0, '有退场事件');
  const forfeit = events[at];
  assert.equal(forfeit.actor, 1);
  const after = events.slice(at + 1);
  assert.equal(
    after.some((event) => event.kind === 'decide' && event.actor === 1),
    false,
    '退场后不再出手',
  );
  assert.equal(
    after.some((event) => 'target' in event && event.target === 1),
    false,
    '退场后不再是目标',
  );
  assert.equal(
    events.some((event) => event.kind === 'ko' && event.target === 1),
    false,
    '退场不算被打倒',
  );
  assert.deepEqual(brawl(fighters, seed, controllerFor(3, 21), options), events, '同一份清单演同一场');
});
