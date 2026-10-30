/**
 * 逐手对传（X19）的驱动测试：两边按同一串出手算出同一串事件；对面不合法的招、等超时都按掉线。
 * 协议层（/v1/spar/turn、/v1/duel/turn）在 visit.test.ts；features 接线在 features-spar-live.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalChoices, startLiveBattle, startLiveClient, startLiveServer, toneOf } from './battle-live.ts';
import type { LiveVersus } from './battle-live.ts';
import { fight, rngFrom } from './battle.ts';
import type { BattleEvent, BattleView, Controller, Fighter } from './battle.ts';
import type { ShowSides } from './battle-show.ts';

const a: Fighter = {
  name: '甲',
  hp: 60,
  power: 6,
  agility: 6,
  speed: 5,
  weapons: ['water-gun'],
  skills: ['dove'],
};
const b: Fighter = {
  name: '乙',
  hp: 58,
  power: 5,
  agility: 5,
  speed: 6,
  weapons: ['poker'],
  skills: [],
};
const seed = 'a'.repeat(64) + ':' + 'b'.repeat(64);

/** 不真开窗口的一套演出出口（测试里 skip 掉，只跑协议和决策） */
const silent: ShowSides = {
  self: { play: () => undefined, say: () => undefined },
  foe: { play: () => undefined, say: () => undefined },
  arena: () => undefined,
  shoot: () => undefined,
};

const noop = (): void => undefined;
const logs: string[] = [];

/** 同一个种子的解说随机数（两边各拿一颗，序列相同） */
const lineRng = (): (() => number) => {
  const rng = rngFrom(seed + ':lines');
  return rng;
};

function serve(waitMs = 2_000): LiveVersus {
  return startLiveServer({
    a,
    b,
    seed,
    local: 0,
    show: silent,
    lineRng: lineRng(),
    decide: async () => null,
    think: noop,
    log: (message) => logs.push(message),
    waitMs,
  });
}

function clientWith(server: LiveVersus, waitMs = 2_000): LiveVersus {
  return startLiveClient({
    a,
    b,
    seed,
    local: 1,
    show: silent,
    lineRng: lineRng(),
    decide: async () => null,
    think: noop,
    log: (message) => logs.push(message),
    waitMs,
    sendTurn: async (body) => server.turn(body.index, body.action),
  });
}

test('X19 逐手对传：两边按同一串出手，算出同一串事件', async () => {
  logs.length = 0;
  const server = serve();
  const client = clientWith(server);
  client.skip();
  server.skip();
  const [clientEvents, serverEvents] = await Promise.all([client.done, server.done]);
  assert.ok(clientEvents, '发起方打完了');
  assert.ok(serverEvents, '应战方打完了');
  assert.deepEqual(clientEvents, serverEvents, '两边的事件逐条相同');
  assert.ok(
    clientEvents.some((event) => event.kind === 'decide'),
    '逐手局每一手都记 decide',
  );
});

test('X16 逐手对传：farewell 开关传到底，两边按同一串出手算出同一场（含送走）', async () => {
  const fa: Fighter = {
    name: '甲',
    hp: 9_999,
    power: 6,
    agility: 0,
    speed: 50,
    weapons: [],
    skills: ['farewell-wind'],
  };
  const fb: Fighter = { name: '乙', hp: 9_999, power: 5, agility: 0, speed: 1, weapons: [], skills: [] };
  const pick: Controller = {
    decide: (view) =>
      view.you.skills.includes('farewell-wind') && !view.you.used.includes('farewell-wind')
        ? { kind: 'skill', skill: 'farewell-wind' }
        : { kind: 'unarmed' },
  };
  let chosen: { seed: string; events: ReturnType<typeof fight> } | null = null;
  for (let i = 0; i < 60 && chosen === null; i++) {
    const trial = `farewell-live-${i}`;
    const events = fight(fa, fb, trial, [pick, pick], { farewell: true });
    const end = events[events.length - 1];
    if (end.kind === 'end' && end.reason === 'farewell') chosen = { seed: trial, events };
  }
  assert.ok(chosen, '该有一个种子在逐手局里送走');
  const server = startLiveServer({
    a: fa,
    b: fb,
    seed: chosen!.seed,
    local: 0,
    show: silent,
    lineRng: rngFrom(chosen!.seed + ':lines'),
    farewell: true,
    decide: async (view) => ({ action: pick.decide(view) }),
    think: noop,
    log: noop,
    waitMs: 2_000,
  });
  const client = startLiveClient({
    a: fa,
    b: fb,
    seed: chosen!.seed,
    local: 1,
    show: silent,
    lineRng: rngFrom(chosen!.seed + ':lines'),
    farewell: true,
    decide: async (view) => ({ action: pick.decide(view) }),
    think: noop,
    log: noop,
    waitMs: 2_000,
    sendTurn: async (body) => server.turn(body.index, body.action),
  });
  client.skip();
  server.skip();
  const [clientEvents, serverEvents] = await Promise.all([client.done, server.done]);
  assert.ok(clientEvents && serverEvents);
  assert.deepEqual(clientEvents, chosen!.events, '逐手局和整场（同一个 farewell 开关）算出同一串');
  assert.deepEqual(serverEvents, chosen!.events);
  const end = clientEvents[clientEvents.length - 1];
  assert.equal(end.kind === 'end' && end.reason, 'farewell');
});

test('X19 逐手对传：对面出了不合法的招按掉线，不替它编招', async () => {
  const server = serve();
  const reply = await server.turn(0, { kind: 'skill', skill: 'dove' });
  assert.deepEqual(reply, { ok: false, reason: 'illegal' });
  assert.equal(await server.done, null, '这一场按掉线收，不算打完');
});

test('X19 逐手对传：等对面出手超时按掉线', async () => {
  const server = serve(20);
  assert.equal(await server.done, null);
});

test('X19 逐手对传：收到对面不合法的招 / 等不到对面都按掉线', async () => {
  const bad = startLiveClient({
    a,
    b,
    seed,
    local: 1,
    show: silent,
    lineRng: lineRng(),
    decide: async () => null,
    think: noop,
    log: noop,
    waitMs: 2_000,
    sendTurn: async (body) => (body.action ? { ok: true } : { ok: true, action: { kind: 'skill', skill: 'dove' } }),
  });
  bad.skip();
  assert.equal(await bad.done, null, '不合法的招按掉线');

  const late = startLiveClient({
    a,
    b,
    seed,
    local: 1,
    show: silent,
    lineRng: lineRng(),
    decide: async () => null,
    think: noop,
    log: noop,
    waitMs: 20,
    sendTurn: () => new Promise(() => undefined),
  });
  late.skip();
  assert.equal(await late.done, null, '等超时按掉线');
});

test('X17 出招分类：控制、回复保命与伤害按动作效果归类', () => {
  const cases = [
    [{ kind: 'weapon', weapon: 'snowball' }, 'control'],
    [{ kind: 'weapon', weapon: 'duster' }, 'control'],
    [{ kind: 'skill', skill: 'lion-roar' }, 'control'],
    [{ kind: 'skill', skill: 'ink' }, 'control'],
    [{ kind: 'skill', skill: 'whale-gulp' }, 'sustain'],
    [{ kind: 'skill', skill: 'bloom' }, 'sustain'],
    [{ kind: 'skill', skill: 'myriad-self' }, 'sustain'],
    [{ kind: 'skill', skill: 'finger-sword' }, 'damage'],
    [{ kind: 'skill', skill: 'dragon-palm' }, 'damage'],
    [{ kind: 'weapon', weapon: 'water-gun' }, 'damage'],
    [{ kind: 'unarmed' }, 'damage'],
  ] as const;
  for (const [action, tone] of cases) assert.equal(toneOf(action), tone);
});

test('X17 出招分类：legalChoices 带上 tone，pick 与动作顺序不变', () => {
  const view: BattleView = {
    self: 0,
    hp: [60, 60],
    maxHp: [60, 60],
    you: {
      weapons: ['snowball', 'duster', 'water-gun'],
      skills: ['lion-roar', 'bloom', 'whale-gulp', 'myriad-self', 'ink', 'finger-sword', 'dragon-palm'],
      used: [],
    },
    foe: { weapons: [], skills: [] },
  };
  const choices = legalChoices(view);
  assert.deepEqual(
    choices.map((choice) => choice.pick),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.deepEqual(
    choices.map((choice) => choice.tone),
    [
      'control',
      'control',
      'damage',
      'damage',
      'control',
      'sustain',
      'sustain',
      'sustain',
      'control',
      'damage',
      'damage',
    ],
  );
});

// ---------- X26 认输与切磋口径 ----------

const fastA: Fighter = { ...a, speed: 10 };
const slowB: Fighter = { ...b, speed: 1 };
const slowA: Fighter = { ...a, speed: 1 };
const fastB: Fighter = { ...b, speed: 10 };

/** 一直不返回的出招（模拟 AI / 手动还在等） */
function hold(): { started: Promise<void>; decide: () => Promise<never> } {
  let notify: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  return {
    started,
    decide: () => {
      notify();
      return new Promise<never>(() => undefined);
    },
  };
}

function endOf(events: BattleEvent[]): Extract<BattleEvent, { kind: 'end' }> {
  const end = events[events.length - 1];
  assert.equal(end?.kind, 'end', '最后一条是 end');
  return end as Extract<BattleEvent, { kind: 'end' }>;
}

const reasonOf = (end: Extract<BattleEvent, { kind: 'end' }>): string => (end as { reason: string }).reason;

function liveServer(aFighter: Fighter, bFighter: Fighter, decide: () => Promise<never>, waitMs = 2_000): LiveVersus {
  return startLiveServer({
    a: aFighter,
    b: bFighter,
    seed,
    local: 0,
    show: silent,
    lineRng: lineRng(),
    decide,
    think: noop,
    log: (message) => logs.push(message),
    waitMs,
  });
}

function liveClient(
  server: LiveVersus,
  aFighter: Fighter,
  bFighter: Fighter,
  decide: () => Promise<never>,
): LiveVersus {
  return startLiveClient({
    a: aFighter,
    b: bFighter,
    seed,
    local: 1,
    show: silent,
    lineRng: lineRng(),
    decide,
    think: noop,
    log: (message) => logs.push(message),
    waitMs: 2_000,
    sendTurn: (body) => server.turn(body.index, body.action, body.forfeit),
  });
}

test('X26 心魔本地认输：done 给出 forfeit 收场，气血用已确认的最新值', async () => {
  logs.length = 0;
  const held = hold();
  const battle = startLiveBattle({
    a,
    b,
    seed,
    mode: 'ai',
    show: silent,
    lineRng: lineRng(),
    decide: held.decide,
    think: noop,
    log: (message) => logs.push(message),
  });
  await held.started;
  battle.forfeit();
  const events = await battle.done;
  assert.ok(events, '认输回正常事件串，不是 null');
  const end = endOf(events);
  assert.equal(reasonOf(end), 'forfeit');
  assert.equal(end.winner, 1, '心魔（引擎 1 号）获胜');
  const before = events[events.length - 2]!;
  assert.ok('hp' in before, '前一条带着已确认的气血');
  assert.deepEqual(end.hp, before.hp);
  assert.ok(!logs.some((message) => message.includes('按后备挑法')), '认输后不再落一手');
});

test('X26 原 dispose / skip 行为不变：收摊回 null，快进照常打完', async () => {
  const disposedHeld = hold();
  const disposed = startLiveBattle({
    a,
    b,
    seed,
    mode: 'ai',
    show: silent,
    lineRng: lineRng(),
    decide: disposedHeld.decide,
    think: noop,
    log: noop,
  });
  await disposedHeld.started;
  disposed.dispose();
  assert.equal(await disposed.done, null);

  const skipped = startLiveBattle({
    a,
    b,
    seed,
    mode: 'ai',
    show: silent,
    lineRng: lineRng(),
    decide: async () => null,
    think: noop,
    log: noop,
  });
  skipped.skip();
  const events = await skipped.done;
  assert.ok(events, '快进仍按正常胜负收场');
  assert.notEqual(reasonOf(endOf(events)), 'forfeit');
});

test('X26 客户端认输（本地轮到自己）：两边 done 得到同一场 forfeit 结局', async () => {
  logs.length = 0;
  const serverHeld = hold();
  const server = liveServer(slowA, fastB, serverHeld.decide);
  const clientHeld = hold();
  const client = liveClient(server, slowA, fastB, clientHeld.decide);
  server.skip();
  client.skip();
  await clientHeld.started; // b 速度更快，客户端先出手
  client.forfeit();
  const [clientEvents, serverEvents] = await Promise.all([client.done, server.done]);
  assert.ok(clientEvents, '发起方不是掉线');
  assert.ok(serverEvents, '应战方也正常收场');
  assert.deepEqual(clientEvents, serverEvents, '两边同一场 forfeit 事件');
  const end = endOf(clientEvents);
  assert.equal(reasonOf(end), 'forfeit');
  assert.equal(end.winner, 0, '本地（引擎 1 号）认输，0 号获胜');
});

test('X26 服务端认输（本地轮到自己）：客户端收到认输通知，两边记账一致', async () => {
  logs.length = 0;
  const serverHeld = hold();
  const server = liveServer(fastA, slowB, serverHeld.decide);
  const clientHeld = hold();
  const client = liveClient(server, fastA, slowB, clientHeld.decide);
  server.skip();
  client.skip();
  await serverHeld.started; // a 速度更快，服务端先出手
  server.forfeit();
  const [clientEvents, serverEvents] = await Promise.all([client.done, server.done]);
  assert.ok(clientEvents && serverEvents);
  assert.deepEqual(clientEvents, serverEvents);
  const end = endOf(clientEvents);
  assert.equal(reasonOf(end), 'forfeit');
  assert.equal(end.winner, 1, '服务端（引擎 0 号）认输，1 号获胜');
  assert.ok(!logs.some((message) => message.includes('按掉线')), '认输不是掉线');
});

test('X26 客户端在等对面出手时认输：中止等待，对面请求挂着也能收场', async () => {
  logs.length = 0;
  const serverHeld = hold();
  const server = liveServer(fastA, slowB, serverHeld.decide);
  const clientHeld = hold();
  const client = liveClient(server, fastA, slowB, clientHeld.decide);
  server.skip();
  client.skip();
  await serverHeld.started; // 服务端正在想，客户端挂着等
  client.forfeit();
  const [clientEvents, serverEvents] = await Promise.all([client.done, server.done]);
  assert.ok(clientEvents && serverEvents);
  assert.deepEqual(clientEvents, serverEvents);
  const end = endOf(clientEvents);
  assert.equal(reasonOf(end), 'forfeit');
  assert.equal(end.winner, 0, '客户端认输，服务端获胜');
});

test('X26 认输网络没送到：客户端按掉线回 null，不伪装成认输成功', async () => {
  const clientHeld = hold();
  const client = startLiveClient({
    a: slowA,
    b: fastB,
    seed,
    local: 1,
    show: silent,
    lineRng: lineRng(),
    decide: clientHeld.decide,
    think: noop,
    log: noop,
    waitMs: 100,
    sendTurn: () => Promise.reject(new Error('down')),
  });
  client.skip();
  await clientHeld.started;
  client.forfeit();
  assert.equal(await client.done, null);
});

test('X26 认输重复 / 迟到：已结束幂等回认输通知，序号不对回 late 且不提前结算', async () => {
  logs.length = 0;
  const serverHeld = hold();
  const server = liveServer(fastA, slowB, serverHeld.decide);
  server.skip();
  // 先递一手空请求，让服务端进入出招等待；这一手等认输结算时回
  void server.turn(0);
  await serverHeld.started;
  // 序号对不上：回 late，这一场继续（不按掉线、不结算）
  assert.deepEqual(await server.turn(9, undefined, true), { ok: false, reason: 'late' });
  server.forfeit();
  const events = await server.done;
  assert.ok(events);
  assert.equal(reasonOf(endOf(events)), 'forfeit');
  // 已结束后重复认输 / 再送一手：都幂等地拿回同一个认输通知，不重复记账
  assert.deepEqual(await server.turn(0, undefined, true), { ok: true, forfeit: true });
  assert.deepEqual(await server.turn(0, { kind: 'unarmed' }), { ok: true, forfeit: true });
});

test('X26 逐手对传原 dispose 行为不变：收摊回 null', async () => {
  const server = serve();
  const client = clientWith(server);
  client.dispose();
  assert.equal(await client.done, null);
  server.dispose();
  assert.equal(await server.done, null);
});

test('X26 切磋面板：普通主动技不再写必中，招牌招保留必中，skillUsesLeft 供显示', () => {
  const view: BattleView = {
    self: 0,
    hp: [60, 60],
    maxHp: [60, 60],
    you: {
      weapons: [],
      skills: [
        'lion-roar',
        'dream-chant',
        'dragon-palm',
        'farewell-wind',
        'ghost-hand',
        'ghost-blood',
        'blue-whale',
        'finger-sword',
        'headless-shadow',
        'tide-cannon',
        'ancients',
        'ghost-knock',
        'bloom',
      ],
      used: [],
      skillUsesLeft: 2,
    } as BattleView['you'] & { skillUsesLeft?: number },
    foe: { weapons: [], skills: [] },
  };
  const effect = (skill: string): string => {
    const choice = legalChoices(view).find((item) => item.action.kind === 'skill' && item.action.skill === skill);
    assert.ok(choice, `清单里有 ${skill}`);
    return choice.effect;
  };
  for (const skill of ['lion-roar', 'dream-chant', 'dragon-palm', 'farewell-wind', 'ghost-hand', 'ghost-blood']) {
    assert.ok(!effect(skill).includes('必中'), `${skill} 在切磋里不是必中`);
    assert.ok(effect(skill).includes('可闪避'), `${skill} 标出可闪避`);
  }
  for (const skill of ['blue-whale', 'finger-sword', 'headless-shadow', 'ancients', 'ghost-knock']) {
    assert.ok(effect(skill).includes('必中'), `${skill} 是保留必中的招牌招`);
  }
  assert.ok(effect('tide-cannon').includes('必中'));
  assert.ok(!effect('bloom').includes('可闪避'), '凭空生花是自增益，不判命中');
  for (const choice of legalChoices(view)) if (choice.action.kind === 'skill') assert.equal(choice.note, '剩 2 次');

  // 非切磋（没有 skillUsesLeft）：口径保持原样
  const pve: BattleView = {
    ...view,
    you: { ...view.you, skillUsesLeft: undefined } as BattleView['you'] & { skillUsesLeft?: number },
  };
  const lion = legalChoices(pve).find((item) => item.action.kind === 'skill' && item.action.skill === 'lion-roar')!;
  assert.ok(lion.effect.includes('可能震晕'));
  assert.ok(!lion.effect.includes('可闪避'));
  assert.equal(lion.note, undefined);
});
