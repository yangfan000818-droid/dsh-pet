/**
 * X19 切磋逐手对传的接线测试：串门切磋、隔空切磋各走一场逐手局（自己发起的选自动也走逐手局），
 * 打完才记账、掉线不记账、窗口全关；和旧对端打的全自动局在 features-spar.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startLiveClient, startLiveServer } from './battle-live.ts';
import type { LiveClientOptions, LiveVersus } from './battle-live.ts';
import type { Action, BattleEvent } from './battle.ts';
import { fightUntilDecision, rngFrom } from './battle.ts';
import { SPAR_OPTIONS, sparFighter } from './spar-rules.ts';
import type { SparOutcome } from './features/spar-result.ts';
import type { ShowSides } from './battle-show.ts';
import type { DiaryDay } from './diary.ts';
import {
  cultivationEarly,
  cultivationSave,
  deferred,
  emitPetBounds,
  env,
  freeUdpPort,
  guestCard,
  hostedApp,
  knockIn,
  last,
  liveWindowsOn,
  neighborRecord,
  neighborsSave,
  pickPanel,
  sparCount,
  until,
  visitConfig,
  windowOn,
  windows,
  withFeatures,
} from './features-testkit.ts';
import { generateVisitIdentity } from './visit-identity.ts';
import {
  encodeBeacon,
  sendDuel,
  sendDuelReveal,
  sendDuelTurn,
  sendReveal,
  sendSpar,
  sendSparTurn,
  sparCardOf,
  sparCommit,
  SPAR_LIVE_MODE,
  VisitHost,
} from './visit.ts';

const noop = (): void => undefined;
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 假对面按后备挑法出手用的一套不真开窗口的演出出口 */
const silent: ShowSides = {
  self: { play: noop, say: noop },
  foe: { play: noop, say: noop },
  arena: noop,
  shoot: noop,
};

const fakeCard = sparCardOf(sparFighter('大个'), 0);
const HOST_NONCE = 'b'.repeat(64);

function sparDiaryEntries(home: string): string[] {
  const dir = join(home, 'diary');
  return readdirSync(dir)
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .flatMap((file) => {
      const day = JSON.parse(readFileSync(join(dir, file), 'utf8')) as DiaryDay;
      return day.events.filter((event) => event.kind === 'cultivate' && event.text.includes('切磋，'));
    })
    .map((event) => event.text);
}

function assertUnsettled(home: string, message: string, priorCount = 0): void {
  assert.equal(sparCount(home), priorCount, message);
  assert.deepEqual(sparDiaryEntries(home), [], message);
}

function matchEnd(events: BattleEvent[] | null) {
  const end = events && last(events);
  assert.ok(end?.kind === 'end', '对端拿到了完整的结局');
  return end;
}

function localOutcome(end: ReturnType<typeof matchEnd>, local: 0 | 1): SparOutcome {
  return end.draw ? 'draw' : end.winner === local ? 'win' : 'loss';
}

async function assertSettlement(
  home: string,
  neighborId: string,
  matchup: string,
  outcome: SparOutcome,
  before = { sparWins: 0, sparLosses: 0, lastSparWon: null as boolean | null },
): Promise<void> {
  const result = { win: '赢了', loss: '输了', draw: '打平了' }[outcome];
  const entry = `${matchup}，${result}`;
  // 平局也写日记，但不会推进邻居簿里的胜负计数。
  await until(() => sparDiaryEntries(home).includes(entry), `结算日记：${entry}`, 400);
  assert.deepEqual(sparDiaryEntries(home), [entry], '这一场只写一条结算日记');
  const record = neighborsSave(home).find(({ id }) => id === neighborId);
  assert.ok(record, '按身份找到对手的邻居记录');
  assert.deepEqual(
    { sparWins: record.sparWins, sparLosses: record.sparLosses, lastSparWon: record.lastSparWon },
    {
      sparWins: before.sparWins + Number(outcome === 'win'),
      sparLosses: before.sparLosses + Number(outcome === 'loss'),
      lastSparWon: outcome === 'draw' ? before.lastSparWon : outcome === 'win',
    },
    `邻居战绩与这场结局一致：${result}`,
  );
}

async function assertBattleControlsCleared(menus: string[][], ...restored: string[]): Promise<void> {
  await until(() => {
    const labels = last(menus) ?? [];
    return (
      labels.length > 0 &&
      restored.every((label) => labels.includes(label)) &&
      !labels.some((label) => /^(切磋|修炼)\/(快进|认输)$/.test(label))
    );
  }, '赛后快进和认输都撤下，常驻菜单恢复');
}

/** 假对面（串门切磋）：按后备挑法应战，逐手局的每一手经 sparTurn 递进来 */
async function fakeLiveSparHost(): Promise<{
  host: VisitHost;
  id: string;
  port: number;
  liveSeen: () => boolean;
  turns: () => number;
  done: () => BattleEvent[] | null;
}> {
  let live = false;
  let turnCalls = 0;
  let server: LiveVersus | null = null;
  let events: BattleEvent[] | null = null;
  const identity = generateVisitIdentity();
  const host = new VisitHost(
    {
      canHost: () => true,
      knocked: () => setTimeout(() => host.answer(true), 30),
      knockEnded: noop,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async (_visitor, _card, _commit, isLive) => {
        live = isLive === true;
        return { ok: true, card: fakeCard, nonce: HOST_NONCE };
      },
      reveal: async (_visitor, nonce) => {
        // 切磋和修炼解绑：两边都用同一套固定配装，出手才过得了 legalActions
        const a = sparFighter('大个');
        const b = sparFighter('桌宠');
        server = startLiveServer({
          a,
          b,
          seed: `${nonce}:${HOST_NONCE}`,
          local: 0,
          show: silent,
          lineRng: rngFrom(`${nonce}:${HOST_NONCE}:lines`),
          ...SPAR_OPTIONS,
          decide: async () => null,
          think: noop,
          log: noop,
          waitMs: 5_000,
        });
        server.skip();
        void server.done.then((result) => (events = result));
        return { ok: true };
      },
      sparTurn: async (_visitor, index, action, forfeit) => {
        turnCalls += 1;
        // 每一手故意慢一点：测试好在「打完了吗」之前检查还没记账
        await delay(15);
        return server ? server.turn(index, action, forfeit) : { ok: false, reason: 'not-visiting' as const };
      },
      duel: async () => ({ ok: false, reason: 'off' as const }),
      duelReveal: noop,
      duelConceded: noop,
      left: noop,
    },
    { log: noop, identity },
  );
  const port = await host.listen('127.0.0.1');
  return { host, id: identity.id, port, liveSeen: () => live, turns: () => turnCalls, done: () => events };
}

/** 假对面（隔空切磋）：签名验过后按后备挑法应战，逐手局的每一手经 duelTurn 递进来 */
async function fakeLiveDuelHost(): Promise<{
  host: VisitHost;
  id: string;
  port: number;
  liveSeen: () => boolean;
  done: () => BattleEvent[] | null;
}> {
  let live = false;
  let server: LiveVersus | null = null;
  let events: BattleEvent[] | null = null;
  const identity = generateVisitIdentity();
  const host = new VisitHost(
    {
      canHost: () => true,
      knocked: noop,
      knockEnded: noop,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async () => ({ ok: false, reason: 'off' as const }),
      reveal: async () => ({ ok: false, reason: 'late' as const }),
      duel: async (_visitor, _card, _commit, isLive) => {
        live = isLive === true;
        return { ok: true, card: fakeCard, nonce: HOST_NONCE };
      },
      duelReveal: (_visitor, nonce) => {
        const a = sparFighter('大个');
        const b = sparFighter('桌宠');
        server = startLiveServer({
          a,
          b,
          seed: `${nonce}:${HOST_NONCE}`,
          local: 0,
          show: silent,
          lineRng: rngFrom(`${nonce}:${HOST_NONCE}:lines`),
          ...SPAR_OPTIONS,
          decide: async () => null,
          think: noop,
          log: noop,
          waitMs: 5_000,
        });
        server.skip();
        void server.done.then((result) => (events = result));
      },
      duelTurn: async (_visitor, index, action, forfeit) =>
        server ? server.turn(index, action, forfeit) : { ok: false, reason: 'not-visiting' as const },
      duelConceded: noop,
      left: noop,
    },
    { log: noop, identity },
  );
  const port = await host.listen('127.0.0.1');
  return { host, id: identity.id, port, liveSeen: () => live, done: () => events };
}

test('X19 串门切磋逐手局（客人）：自动 / AI / 手动各打一场（选自动也走逐手对传），打完才记账，窗口收干净', async () => {
  for (const pick of [1, 2, 3] as const) {
    const clicks: string[] = [];
    windows.length = 0;
    env.battleCalls = 0;
    env.battleReplies = Array.from({ length: 60 }, () => '{"pick":1}');
    env.battleHold = null;
    const fake = await fakeLiveSparHost();
    const beaconPort = await freeUdpPort();
    const beacon = createSocket('udp4');
    beacon.on('error', () => undefined);
    const payload = encodeBeacon({ id: fake.id, owner: '测试邻居', pet: '大个', port: fake.port });
    const sendBeacon = () => beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
    sendBeacon();
    const timer = setInterval(sendBeacon, 300);
    const config = visitConfig();
    config.visit.hosting = false;
    config.visit.visiting = true;
    try {
      await withFeatures(
        {
          config,
          cultivation: cultivationEarly(),
          clicks,
          modeTimeoutMs: 2_000,
          aiTurnTimeoutMs: 500,
          actionTimeoutMs: 2_000,
          turnWaitMs: 2_000,
          beacon: { port: beaconPort, targets: () => [] },
        },
        async (features, said, _bodies, home, extras) => {
          const { menus } = extras;
          emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
          await until(
            () => menus.some((labels) => labels.some((label) => label.startsWith('串门/去 '))),
            '信标听见了邻居',
            400,
          );
          clicks.push('串门/去 测试邻居 家');
          await until(() => menus.some((labels) => labels.includes('切磋/找主人家的宠物切磋')), '切磋项');
          clicks.push('切磋/找主人家的宠物切磋');
          await pickPanel(features, pick, `第 ${pick} 种方式`);
          await until(() => fake.liveSeen(), '对面收到了 mode: live');
          // 三扇窗（对手 / 擂台 / 特效层）
          await until(
            () =>
              windowOn('/app/guest') !== undefined &&
              windowOn('/app/arena') !== undefined &&
              windowOn('/app/fx') !== undefined,
            '逐手切磋三扇窗',
            800,
          );
          if (pick === 2) {
            await until(() => env.battleCalls > 0, 'AI 问了一手', 800);
          } else if (pick === 3) {
            // 同步轮先锁自己的动作，手动点招之后才会向对面发第一手。
            await until(() => features.battle.state()?.kind === 'action', '手动出招面板', 800);
            assert.ok(features.battle.choose(1), '手动点了第一手');
          }
          await until(() => fake.turns() > 0, '对传了一手', 800);
          assertUnsettled(home, '打完之前不记账');
          await until(() => (last(menus) ?? []).includes('修炼/快进'), '打的时候有快进');
          clicks.push('修炼/快进');
          await until(() => fake.done() !== null, '对面算完了这一场', 800);
          const end = matchEnd(fake.done());
          await assertSettlement(home, fake.id, '和 测试邻居 家的 大个 切磋', localOutcome(end, 1));
          assert.ok(!said.some((text) => text.includes('切磋断了')), '这一场不是掉线');
          await until(
            () =>
              (windowOn('/app/guest')?.destroyed ?? false) &&
              (windowOn('/app/arena')?.destroyed ?? false) &&
              (windowOn('/app/fx')?.destroyed ?? false),
            '收摊窗口全关',
            800,
          );
        },
      );
    } finally {
      clearInterval(timer);
      beacon.close();
      await fake.host.close();
      env.battleReplies = [];
      env.battleHold = null;
    }
  }
});

test('X19 串门切磋逐手局：对面不再回手，按掉线收，不记账、窗口全关', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const fake = await fakeLiveSparHost();
  // 这一场对面故意不回：把 sparTurn 换成永不返回
  const droppingIdentity = generateVisitIdentity();
  const dropping = new VisitHost(
    {
      canHost: () => true,
      knocked: () => setTimeout(() => dropping.answer(true), 30),
      knockEnded: noop,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async () => ({ ok: true, card: fakeCard, nonce: HOST_NONCE }),
      reveal: async () => ({ ok: true }),
      sparTurn: () => new Promise(() => undefined),
      duel: async () => ({ ok: false, reason: 'off' as const }),
      duelReveal: noop,
      duelConceded: noop,
      left: noop,
    },
    { log: noop, identity: droppingIdentity },
  );
  const port = await dropping.listen('127.0.0.1');
  const beaconPort = await freeUdpPort();
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const payload = encodeBeacon({ id: droppingIdentity.id, owner: '测试邻居', pet: '大个', port });
  const sendBeacon = () => beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const timer = setInterval(sendBeacon, 300);
  const config = visitConfig();
  config.visit.hosting = false;
  config.visit.visiting = true;
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        clicks,
        modeTimeoutMs: 2_000,
        turnWaitMs: 200,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        const { menus } = extras;
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        await until(
          () => menus.some((labels) => labels.some((label) => label.startsWith('串门/去 '))),
          '信标听见了邻居',
          400,
        );
        clicks.push('串门/去 测试邻居 家');
        await until(() => menus.some((labels) => labels.includes('切磋/找主人家的宠物切磋')), '切磋项');
        clicks.push('切磋/找主人家的宠物切磋');
        await pickPanel(features, 2, 'AI 出招');
        // 掉线这一条不关心演出：先快进，等对面那一手超时
        await until(() => (last(menus) ?? []).includes('修炼/快进'), '打的时候有快进');
        clicks.push('修炼/快进');
        await until(() => said.some((text) => text.includes('切磋断了')), '掉线说了一句', 1_000);
        assertUnsettled(home, '掉线不记账');
        await until(
          () =>
            (windowOn('/app/guest')?.destroyed ?? true) &&
            (windowOn('/app/arena')?.destroyed ?? true) &&
            (windowOn('/app/fx')?.destroyed ?? true),
          '掉线窗口全关',
          800,
        );
      },
    );
  } finally {
    clearInterval(timer);
    beacon.close();
    await dropping.close();
    await fake.host.close();
    env.battleReplies = [];
  }
});

test('X19 隔空切磋逐手局（应战方）：关闭修炼也能接到挑战并打完，窗口收干净', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const challenger = generateVisitIdentity();
  const ownNonce = 'c'.repeat(64);
  const config = visitConfig();
  config.cultivation.enabled = false;
  const cultivation = cultivationEarly();
  const priorSpars = { sparWins: 2, sparLosses: 3, lastSparWon: false };
  await withFeatures(
    {
      config,
      cultivation,
      neighbors: { neighbors: [neighborRecord(challenger.id, '小李', '阿花', priorSpars)] },
      clicks,
      modeTimeoutMs: 2_000,
      turnWaitMs: 2_000,
      beacon: { port: await freeUdpPort(), targets: () => [] },
    },
    async (features, said, _bodies, home, extras) => {
      emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
      const { port, hostId } = await hostedApp(home, extras);
      const target = { address: '127.0.0.1', port };
      const asking = sendDuel(target, hostId, { owner: '小李', pet: '阿花' }, challenger, {
        mode: SPAR_LIVE_MODE,
        card: guestCard(),
        commit: sparCommit(ownNonce),
      });
      // 挑战一到就直接弹出应战面板，不用先右键找「应战」
      await until(() => features.battle.state() !== null, '应战面板');
      const prompt = features.battle.state()!;
      assert.match(prompt.title, /小李 家的 阿花 想跟你切磋/);
      assert.deepEqual(
        prompt.options.map((option) => option.label),
        ['自动', 'AI 出招', '手动', '不应战'],
      );
      await until(() => (last(extras.menus) ?? []).includes('切磋/应战：小李 家的 阿花'), '应战菜单仍保留作兜底');
      assert.ok(features.battle.choose(1), '面板上直接选自动应战');
      const reply = await asking;
      assert.ok(reply.ok, `应战没成：${JSON.stringify(reply)}`);
      if (!reply.ok) return;
      assert.deepEqual(await sendDuelReveal(target, { token: reply.token, nonce: ownNonce, line: '' }), { ok: true });
      // 挑战方这一侧按后备挑法打完，配装与应战方一致。
      const [hostSide, guestSide] = [sparFighter('桌宠'), sparFighter('阿花')];
      const client = startLiveClient({
        a: hostSide,
        b: guestSide,
        seed: `${ownNonce}:${reply.nonce}`,
        local: 1,
        show: silent,
        lineRng: rngFrom(`${ownNonce}:${reply.nonce}:lines`),
        ...SPAR_OPTIONS,
        decide: async () => null,
        think: noop,
        log: noop,
        waitMs: 2_000,
        sendTurn: (body, signal) => sendDuelTurn(target, { token: reply.token, ...body }, signal),
      });
      client.skip();
      await until(
        () =>
          windowOn('/app/guest') !== undefined &&
          windowOn('/app/arena') !== undefined &&
          windowOn('/app/fx') !== undefined,
        '应战方三扇窗',
        800,
      );
      // 三扇窗先开、菜单后换；等菜单实际更新再点。
      await until(() => (last(extras.menus) ?? []).includes('切磋/快进'), '关闭修炼时也能快进');
      assertUnsettled(home, '打完之前不记账', priorSpars.sparWins + priorSpars.sparLosses);
      clicks.push('切磋/快进');
      const end = matchEnd(await client.done);
      await assertSettlement(home, challenger.id, '和 小李 家的 阿花 隔空切磋', localOutcome(end, 0), priorSpars);
      await assertBattleControlsCleared(extras.menus);
      assert.ok(!(last(extras.menus) ?? []).some((label) => /^切磋\/(应战：|不应战$)/.test(label)), '应战菜单也撤下');
      assert.equal(features.battle.state(), null, '应战与出招面板都收起');
      assert.ok(!said.some((text) => text.includes('切磋断了')), '这一场不是掉线');
      await until(
        () =>
          (windowOn('/app/guest')?.destroyed ?? false) &&
          (windowOn('/app/arena')?.destroyed ?? false) &&
          (windowOn('/app/fx')?.destroyed ?? false),
        '应战方收摊全关',
        800,
      );
      assert.deepEqual(cultivationSave(home), cultivation, '切磋不修改已有修炼存档');
    },
  );
});

test('X19 隔空切磋逐手局（应战方）：熟人自动应战不挂菜单，但照样弹面板选自家方式（选手动就轮到自家时等点招）', async () => {
  windows.length = 0;
  const challenger = generateVisitIdentity();
  const ownNonce = 'c'.repeat(64);
  const config = visitConfig();
  config.visit.hosting = true;
  config.visit.autoAdmitFriends = true;
  await withFeatures(
    {
      config,
      cultivation: cultivationEarly(),
      neighbors: { neighbors: [neighborRecord(challenger.id, '小李', '阿花', { friend: true })] },
      clicks: [],
      modeTimeoutMs: 2_000,
      actionTimeoutMs: 2_000,
      turnWaitMs: 2_000,
      beacon: { port: await freeUdpPort(), targets: () => [] },
    },
    async (features, said, _bodies, home, extras) => {
      emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
      // 主人在电脑前才会自动应战
      await until(() => features.activity()?.present === true, '主人在电脑前');
      const { port, hostId } = await hostedApp(home, extras);
      const target = { address: '127.0.0.1', port };
      const asking = sendDuel(target, hostId, { owner: '小李', pet: '阿花' }, challenger, {
        mode: SPAR_LIVE_MODE,
        card: guestCard(),
        commit: sparCommit(ownNonce),
      });
      await until(() => said.some((text) => text.includes('直接应战')), '说了直接应战');
      await pickPanel(features, 3, '熟人应战方式');
      const reply = await asking;
      assert.ok(reply.ok, `熟人应自动应战：${JSON.stringify(reply)}`);
      if (!reply.ok) return;
      assert.ok(
        extras.menus.every((labels) => !labels.some((label) => label.startsWith('切磋/应战'))),
        '自动应战不挂「应战」菜单',
      );
      assert.deepEqual(await sendDuelReveal(target, { token: reply.token, nonce: ownNonce, line: '' }), { ok: true });
      // 挑战方用与应战方相同的固定配装。
      const [hostSide, guestSide] = [sparFighter('桌宠'), sparFighter('阿花')];
      const client = startLiveClient({
        a: hostSide,
        b: guestSide,
        seed: `${ownNonce}:${reply.nonce}`,
        local: 1,
        show: silent,
        lineRng: rngFrom(`${ownNonce}:${reply.nonce}:lines`),
        ...SPAR_OPTIONS,
        decide: async () => null,
        think: noop,
        log: noop,
        waitMs: 2_000,
        sendTurn: (body, signal) => sendDuelTurn(target, { token: reply.token, ...body }, signal),
      });
      client.skip();
      // 选的是手动：轮到自家时出招面板等主人点
      await until(() => features.battle.state()?.kind === 'action', '手动出招面板', 2_000);
      assertUnsettled(home, '打完之前不记账');
    },
  );
});

test('X19 隔空切磋逐手局（应战方）：对面一直不传下一手，按掉线收，不记账', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const challenger = generateVisitIdentity();
  const ownNonce = 'c'.repeat(64);
  const config = visitConfig();
  config.visit.hosting = true;
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        neighbors: { neighbors: [neighborRecord(challenger.id, '小李', '阿花')] },
        clicks,
        modeTimeoutMs: 2_000,
        turnWaitMs: 200,
        beacon: { port: await freeUdpPort(), targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        const { port, hostId } = await hostedApp(home, extras);
        const asking = sendDuel({ address: '127.0.0.1', port }, hostId, { owner: '小李', pet: '阿花' }, challenger, {
          mode: SPAR_LIVE_MODE,
          card: guestCard(),
          commit: sparCommit(ownNonce),
        });
        // 挑战一到就弹应战面板；直接在面板上选自动
        await until(() => features.battle.state() !== null, '应战面板');
        assert.equal(features.battle.choose(1), true, '面板上直接选自动应战');
        const reply = await asking;
        assert.ok(reply.ok);
        if (!reply.ok) return;
        await sendDuelReveal({ address: '127.0.0.1', port }, { token: reply.token, nonce: ownNonce, line: '' });
        // 之后一手都不发：应战方等 200ms 就按掉线
        await until(() => said.some((text) => text.includes('切磋断了')), '掉线说了一句', 1_000);
        assertUnsettled(home, '掉线不记账');
        await until(
          () =>
            (windowOn('/app/guest')?.destroyed ?? false) &&
            (windowOn('/app/arena')?.destroyed ?? false) &&
            (windowOn('/app/fx')?.destroyed ?? false),
          '掉线窗口全关',
          800,
        );
      },
    );
  } finally {
    env.battleReplies = [];
  }
});

test('X19 隔空切磋逐手局（挑战方）：AI 出招，打完才记账，窗口收干净', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  env.battleCalls = 0;
  env.battleReplies = Array.from({ length: 60 }, () => '{"pick":1}');
  env.battleHold = null;
  const fake = await fakeLiveDuelHost();
  const beaconPort = await freeUdpPort();
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const payload = encodeBeacon({ id: fake.id, owner: '测试邻居', pet: '大个', port: fake.port });
  const sendBeacon = () => beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const timer = setInterval(sendBeacon, 300);
  const config = visitConfig();
  config.visit.hosting = false;
  config.visit.visiting = true;
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        neighbors: { neighbors: [neighborRecord(fake.id, '测试邻居', '大个')] },
        clicks,
        modeTimeoutMs: 2_000,
        aiTurnTimeoutMs: 500,
        turnWaitMs: 2_000,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        await until(() => extras.menus.some((labels) => labels.includes('切磋/测试邻居 家的 大个')), '挑战项', 400);
        clicks.push('切磋/测试邻居 家的 大个');
        await pickPanel(features, 2, 'AI 出招');
        await until(() => fake.liveSeen(), '对面收到了 mode: live');
        await until(
          () =>
            windowOn('/app/guest') !== undefined &&
            windowOn('/app/arena') !== undefined &&
            windowOn('/app/fx') !== undefined,
          '挑战方三扇窗',
          800,
        );
        await until(() => env.battleCalls > 0, 'AI 问了一手', 800);
        assertUnsettled(home, '打完之前不记账');
        await until(() => (last(extras.menus) ?? []).includes('修炼/快进'), '打的时候有快进');
        clicks.push('修炼/快进');
        await until(() => fake.done() !== null, '对面算完了这一场', 800);
        const end = matchEnd(fake.done());
        await assertSettlement(home, fake.id, '和 测试邻居 家的 大个 隔空切磋', localOutcome(end, 1));
        assert.ok(!said.some((text) => text.includes('切磋断了')), '这一场不是掉线');
        await until(
          () =>
            (windowOn('/app/guest')?.destroyed ?? false) &&
            (windowOn('/app/arena')?.destroyed ?? false) &&
            (windowOn('/app/fx')?.destroyed ?? false),
          '挑战方收摊全关',
          800,
        );
      },
    );
  } finally {
    clearInterval(timer);
    beacon.close();
    await fake.host.close();
    env.battleReplies = [];
    env.battleHold = null;
  }
});

test('X19 隔空切磋（挑战方）：选自动也走逐手对传 → 自家屏幕演全套、打完才记账、感言照说、没出门', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const fake = await fakeLiveDuelHost();
  const beaconPort = await freeUdpPort();
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const payload = encodeBeacon({ id: fake.id, owner: '测试邻居', pet: '大个', port: fake.port });
  const sendBeacon = () => beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const timer = setInterval(sendBeacon, 300);
  const config = visitConfig();
  config.cultivation.enabled = false;
  config.visit.hosting = false;
  config.visit.visiting = true;
  const oldAnswer = env.memeAnswer;
  env.memeAnswer = '隔空切磋的感言～';
  try {
    await withFeatures(
      {
        config,
        neighbors: { neighbors: [neighborRecord(fake.id, '测试邻居', '大个')] },
        clicks,
        modeTimeoutMs: 2_000,
        turnWaitMs: 2_000,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (features, said, bodies, home, extras) => {
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        await until(() => extras.menus.some((labels) => labels.includes('切磋/测试邻居 家的 大个')), '挑战项出现', 400);
        clicks.push('切磋/测试邻居 家的 大个');
        // 选自动：自家每手按后备挑法出，但照样逐手对传，应战方好选它自己的方式
        await pickPanel(features, 1, '隔空切磋方式');
        await until(() => said.some((text) => text.includes('等它应战')), '出门那句');
        await until(() => fake.liveSeen(), '对面收到了 mode: live');
        // 自家屏幕上也是全套：对手窗口（粉色、名牌是应战方的）、擂台、特效层
        await until(
          () =>
            windowOn('/app/guest') !== undefined &&
            windowOn('/app/arena') !== undefined &&
            windowOn('/app/fx') !== undefined,
          '挑战方的三扇窗',
          800,
        );
        const foe = windowOn('/app/guest')!;
        const arena = windowOn('/app/arena')!;
        const fx = windowOn('/app/fx')!;
        await until(
          () => foe.calls.some((code) => code.startsWith('guest.arrive(') && code.includes('测试邻居')),
          '对手窗口名牌是应战方的',
        );
        assert.ok(!foe.calls.some((code) => code.includes('"shadow"')), '隔空切磋的对手窗口照旧粉色');
        await until(
          () =>
            extras.anims.some(
              (anim) => String(anim.url ?? '').includes(encodeURIComponent('战斗-起手')) && anim.facing !== undefined,
            ),
          '自家宠物播 url 形态的动画、带朝向',
          800,
        );
        const hold = extras.requests.findIndex((request) => request.path === '/lock');
        assert.ok(hold >= 0, '开演前拿了锁');
        assert.ok(hold < extras.requests.findIndex((request) => request.path === '/anim'), '拿锁在自家第一段动画之前');
        await until(() => arena.calls.some((code) => code.startsWith('arena.update(')), '擂台按时间线刷气血', 800);
        await until(() => (last(extras.menus) ?? []).includes('切磋/快进'), '未开修炼也可快进');
        assertUnsettled(home, '打完之前不记账');
        clicks.push('切磋/快进');
        await until(() => fake.done() !== null, '对面算完了这一场', 800);
        const end = matchEnd(fake.done());
        await assertSettlement(home, fake.id, '和 测试邻居 家的 大个 隔空切磋', localOutcome(end, 1));
        await until(() => extras.requests.some((request) => request.path === '/lock/release'), '演完放锁', 800);
        await until(() => foe.destroyed && arena.destroyed && fx.destroyed, '收摊全关', 800);
        // 结果与感言照说；没被叫回家（还在自家），挑战项也回来了
        await until(() => bodies.some((body) => String(body.text).includes('这场隔空切磋')), '结果说出来了', 1000);
        await until(() => bodies.some((body) => body.text === env.memeAnswer), '感言说出来了', 1000);
        assert.ok(!said.some((text) => text.includes('切磋断了')), '这一场不是掉线');
        await assertBattleControlsCleared(extras.menus, '切磋/测试邻居 家的 大个');
        assert.equal(features.battle.state(), null, '赛后没有残留面板');
        assert.ok(!said.some((line) => /修为\s*\+/.test(line)), '切磋不再奖励修为');
        assert.equal(cultivationSave(home), null, '隔空切磋不创建修炼存档');
        assert.ok(
          extras.menus.every((labels) => !labels.includes('从 测试邻居 家回来')),
          '一直在自家，没有出门',
        );
      },
    );
  } finally {
    clearInterval(timer);
    beacon.close();
    await fake.host.close();
    env.memeAnswer = oldAnswer;
  }
  assert.ok(
    windows.every((win) => win.destroyed),
    '退出时窗口全关',
  );
});

test('X19 旧对端回 unsupported-mode：串门 / 隔空都说「还不会逐手切磋」，不记账', async () => {
  // 串门：假主人家不认 mode: live
  const clicks: string[] = [];
  windows.length = 0;
  const strangerIdentity = generateVisitIdentity();
  const host = new VisitHost(
    {
      canHost: () => true,
      knocked: () => setTimeout(() => host.answer(true), 30),
      knockEnded: noop,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async () => ({ ok: false, reason: 'unsupported-mode' }),
      reveal: async () => ({ ok: false, reason: 'late' }),
      duel: async () => ({ ok: false, reason: 'off' }),
      duelReveal: noop,
      duelConceded: noop,
      left: noop,
    },
    { log: noop, identity: strangerIdentity },
  );
  const port = await host.listen('127.0.0.1');
  const beaconPort = await freeUdpPort();
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const payload = encodeBeacon({ id: strangerIdentity.id, owner: '测试邻居', pet: '大个', port });
  const sendBeacon = () => beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const timer = setInterval(sendBeacon, 300);
  const config = visitConfig();
  config.visit.hosting = false;
  config.visit.visiting = true;
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        clicks,
        modeTimeoutMs: 2_000,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        await until(
          () => extras.menus.some((labels) => labels.some((label) => label.startsWith('串门/去 '))),
          '信标听见了邻居',
          400,
        );
        clicks.push('串门/去 测试邻居 家');
        await until(() => extras.menus.some((labels) => labels.includes('切磋/找主人家的宠物切磋')), '切磋项');
        clicks.push('切磋/找主人家的宠物切磋');
        await pickPanel(features, 2, 'AI 出招');
        await until(() => said.some((text) => text.includes('还不会逐手切磋')), '串门说了还不会逐手', 800);
        assertUnsettled(home, '没打成不记账');
      },
    );
  } finally {
    clearInterval(timer);
    beacon.close();
    await host.close();
  }

  // 隔空：假挑战方不应战（旧对端在协议层回 unsupported-mode）
  const duelIdentity = generateVisitIdentity();
  const duelHost = new VisitHost(
    {
      canHost: () => true,
      knocked: noop,
      knockEnded: noop,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async () => ({ ok: false, reason: 'off' }),
      reveal: async () => ({ ok: false, reason: 'late' }),
      duel: async () => ({ ok: false, reason: 'unsupported-mode' }) as never,
      duelReveal: noop,
      duelConceded: noop,
      left: noop,
    },
    { log: noop, identity: duelIdentity },
  );
  const duelPort = await duelHost.listen('127.0.0.1');
  const duelClicks: string[] = [];
  windows.length = 0;
  const duelBeaconPort = await freeUdpPort();
  const duelBeacon = createSocket('udp4');
  duelBeacon.on('error', () => undefined);
  const duelPayload = encodeBeacon({ id: duelIdentity.id, owner: '测试邻居', pet: '大个', port: duelPort });
  const send = () => duelBeacon.send(duelPayload, duelBeaconPort, '127.0.0.1', () => undefined);
  send();
  const duelTimer = setInterval(send, 300);
  const duelConfig = visitConfig();
  duelConfig.visit.hosting = false;
  duelConfig.visit.visiting = true;
  try {
    await withFeatures(
      {
        config: duelConfig,
        cultivation: cultivationEarly(),
        clicks: duelClicks,
        modeTimeoutMs: 2_000,
        beacon: { port: duelBeaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        await until(() => extras.menus.some((labels) => labels.includes('切磋/测试邻居 家的 大个')), '挑战项', 400);
        duelClicks.push('切磋/测试邻居 家的 大个');
        await pickPanel(features, 2, 'AI 出招');
        await until(() => said.some((text) => text.includes('还不会逐手切磋')), '隔空说了还不会逐手', 800);
        assertUnsettled(home, '没打成不记账');
      },
    );
  } finally {
    clearInterval(duelTimer);
    duelBeacon.close();
    await duelHost.close();
  }
});

test('X26 串门切磋逐手局（客人）：关闭修炼也能从菜单确认认输，双方拿到同一场 forfeit 结局', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const fake = await fakeLiveSparHost();
  const beaconPort = await freeUdpPort();
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const payload = encodeBeacon({ id: fake.id, owner: '测试邻居', pet: '大个', port: fake.port });
  const sendBeacon = () => beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const timer = setInterval(sendBeacon, 300);
  const config = visitConfig();
  config.cultivation.enabled = false;
  config.visit.hosting = false;
  config.visit.visiting = true;
  const decision = deferred();
  env.battleCalls = 0;
  env.battleHold = decision.promise;
  try {
    await withFeatures(
      {
        config,
        clicks,
        modeTimeoutMs: 2_000,
        aiTurnTimeoutMs: 5_000,
        actionTimeoutMs: 5_000,
        turnWaitMs: 10_000,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        const { menus } = extras;
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        await until(
          () => menus.some((labels) => labels.some((label) => label.startsWith('串门/去 '))),
          '信标听见了邻居',
          400,
        );
        clicks.push('串门/去 测试邻居 家');
        await until(() => menus.some((labels) => labels.includes('切磋/找主人家的宠物切磋')), '切磋项');
        clicks.push('切磋/找主人家的宠物切磋');
        // 等模型卡在第一手，不靠随机出招能打多久，也不占用认输确认面板。
        await pickPanel(features, 2, 'AI 出招');
        await until(() => env.battleCalls > 0, 'AI 等着出第一手');
        await until(() => (last(menus) ?? []).includes('切磋/认输'), '关闭修炼时也能认输');
        assertUnsettled(home, '认输前不记账');
        clicks.push('切磋/认输');
        await until(() => /确定认输/.test(features.battle.state()?.title ?? ''), '认输二次确认');
        assert.ok(features.battle.choose(2), '确认认输');
        await until(() => fake.done() !== null, '对面也按认输收场', 1_000);
        const end = matchEnd(fake.done());
        assert.equal(end.reason, 'forfeit', '双方拿到同一场 forfeit 结局');
        assert.equal(localOutcome(end, 1), 'loss', '认输方（客人）判负');
        await assertSettlement(home, fake.id, '和 测试邻居 家的 大个 切磋', 'loss');
        await assertBattleControlsCleared(menus, '切磋/找主人家的宠物切磋', '从 测试邻居 家回来');
        assert.equal(features.battle.state(), null, '认输确认和出招面板都收起');
        assert.ok(!said.some((text) => text.includes('切磋断了')), '这一场不是掉线');
      },
    );
  } finally {
    decision.resolve();
    env.battleHold = null;
    clearInterval(timer);
    beacon.close();
    await fake.host.close();
  }
});

test('X26 隔空切磋逐手局（应战方）：对面认输，双方拿到同一场 forfeit 结局，自家记胜场', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const challenger = generateVisitIdentity();
  const ownNonce = 'c'.repeat(64);
  const config = visitConfig();
  config.visit.hosting = true;
  await withFeatures(
    {
      config,
      cultivation: cultivationEarly(),
      neighbors: { neighbors: [neighborRecord(challenger.id, '小李', '阿花')] },
      clicks,
      modeTimeoutMs: 2_000,
      turnWaitMs: 10_000,
      beacon: { port: await freeUdpPort(), targets: () => [] },
    },
    async (features, said, _bodies, home, extras) => {
      emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
      const { port, hostId } = await hostedApp(home, extras);
      const target = { address: '127.0.0.1', port };
      const asking = sendDuel(target, hostId, { owner: '小李', pet: '阿花' }, challenger, {
        mode: SPAR_LIVE_MODE,
        card: guestCard(),
        commit: sparCommit(ownNonce),
      });
      await until(() => features.battle.state() !== null, '应战面板');
      // 手动应战：应战方停在等点招那一手，挑战方这时认输才测得到「对局进行中」
      assert.equal(features.battle.choose(3), true, '选手动应战');
      const reply = await asking;
      assert.ok(reply.ok, `应战没成：${JSON.stringify(reply)}`);
      if (!reply.ok) return;
      assert.deepEqual(await sendDuelReveal(target, { token: reply.token, nonce: ownNonce, line: '' }), { ok: true });
      const [hostSide, guestSide] = [sparFighter('桌宠'), sparFighter('阿花')];
      const client = startLiveClient({
        a: hostSide,
        b: guestSide,
        seed: `${ownNonce}:${reply.nonce}`,
        local: 1,
        show: silent,
        lineRng: rngFrom(`${ownNonce}:${reply.nonce}:lines`),
        ...SPAR_OPTIONS,
        decide: async () => null,
        think: noop,
        log: noop,
        waitMs: 10_000,
        sendTurn: (body, signal) => sendDuelTurn(target, { token: reply.token, ...body }, signal),
      });
      // 挑战方这边的演出没有窗口，快进掉；协议照常一手一手传
      client.skip();
      await until(() => windowOn('/app/arena') !== undefined, '应战方开打', 800);
      // 应战方轮到自家、面板等点招：这时对局一定还没打完
      await until(() => features.battle.state()?.kind === 'action', '应战方等点招', 2_000);
      // 挑战方这一手认输：应战方（app）也要按同一场 forfeit 收场，记自家胜场
      client.forfeit();
      const end = matchEnd(await client.done);
      assert.equal(end.reason, 'forfeit', '挑战方拿到 forfeit 结局');
      assert.equal(localOutcome(end, 0), 'win', '认输方（挑战方）判负');
      await assertSettlement(home, challenger.id, '和 小李 家的 阿花 隔空切磋', 'win');
      await assertBattleControlsCleared(extras.menus);
      assert.ok(!said.some((text) => text.includes('切磋断了')), '不是掉线');
    },
  );
});

for (const kind of ['spar', 'duel'] as const) {
  const label = kind === 'spar' ? '串门' : '隔空';
  test(`${label}同步轮：应战方认输收场后，发起方用回执补齐没收到的一轮`, async () => {
    const clicks: string[] = [];
    windows.length = 0;
    const lock = deferred();
    const identity = generateVisitIdentity();
    const ownNonce = 'c'.repeat(64);
    const config = visitConfig();
    config.cultivation.enabled = false;
    try {
      await withFeatures(
        {
          config,
          clicks,
          modeTimeoutMs: 10_000,
          actionTimeoutMs: 10_000,
          turnWaitMs: 30_000,
          lockGate: lock.promise,
          beacon: { port: await freeUdpPort(), targets: () => [] },
        },
        async (features, said, _bodies, home, extras) => {
          emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
          const { port, hostId } = await hostedApp(home, extras);
          const target = { address: '127.0.0.1', port };
          const visitor = kind === 'spar' ? await knockIn(home, clicks, extras) : undefined;
          const offer = { mode: SPAR_LIVE_MODE, card: guestCard(), commit: sparCommit(ownNonce) };
          const pending = visitor
            ? sendSpar(target, { ...offer, token: visitor.token })
            : sendDuel(target, hostId, { owner: '小李', pet: '阿花' }, identity, offer);
          await pickPanel(features, 1, `${label}选自动应战`);
          const reply = await pending;
          assert.ok(reply.ok);
          const match = reply.nonce;
          const reveal = { nonce: ownNonce, line: '' };
          let send: LiveClientOptions['sendTurn'];
          if (visitor) {
            const { token } = visitor;
            assert.deepEqual(await sendReveal(target, { ...reveal, token, match }), { ok: true });
            send = (body, signal) => sendSparTurn(target, { token, match, ...body }, signal);
          } else {
            assert.ok('token' in reply);
            const { token } = reply;
            assert.deepEqual(await sendDuelReveal(target, { ...reveal, token }), { ok: true });
            send = (body, signal) => sendDuelTurn(target, { token, ...body }, signal);
          }
          const seed = `${ownNonce}:${match}`;
          const [a, b] = [sparFighter('桌宠'), sparFighter('阿花')];
          const ordinary: { actions?: [Action, Action]; signal?: AbortSignal } = {};
          let requests = 0;
          const client = startLiveClient({
            ...SPAR_OPTIONS,
            a,
            b,
            seed,
            local: 1,
            show: silent,
            lineRng: rngFrom(`${seed}:lines`),
            decide: async () => null,
            think: noop,
            log: noop,
            waitMs: 30_000,
            sendTurn: async (body, signal) => {
              const answer = await send(body, signal);
              if (body.forfeit) return answer;
              requests++;
              if (answer.ok && !answer.forfeit && answer.action && body.action) {
                ordinary.actions = [answer.action, body.action];
                ordinary.signal = signal;
              }
              // 房主已算完这一轮，但发起方没收到普通回包。
              return new Promise(() => undefined);
            },
          });
          client.skip();
          try {
            await until(() => ordinary.actions !== undefined, '房主锁完第一轮');
            const [first, second] = ordinary.actions!;
            const replay = fightUntilDecision(a, b, seed, [[first], [second]], SPAR_OPTIONS);
            assert.ok(replay.need, '第一轮未自然结束');
            await until(() => (last(extras.menus) ?? []).includes('切磋/认输'), '房主认输菜单');
            assertUnsettled(home, '认输前不记账');
            clicks.push('切磋/认输');
            await until(() => /确定认输/.test(features.battle.state()?.title ?? ''), '房主确认认输');
            assert.ok(features.battle.choose(2));
            const neighborId = kind === 'spar' ? String(neighborsSave(home)[0]?.id) : identity.id;
            const matchup = `和 小李 家的 阿花 ${kind === 'duel' ? '隔空' : ''}切磋`;
            await assertSettlement(home, neighborId, matchup, 'loss');
            await assertBattleControlsCleared(extras.menus);
            await until(() => liveWindowsOn('/app/arena').length === 0, '应战方已收起擂台');
            assert.ok(!extras.requests.some(({ path }) => path === '/lock/release'), '占用锁仍没到手');

            // 发起方也认输，但以应战方先确定的结果为准。无需等挂起的普通回包。
            client.forfeit();
            await until(() => ordinary.signal?.aborted === true, '认输回执取消普通请求');
            assert.deepEqual(await client.done, [
              ...replay.events,
              { actor: 0, kind: 'end', winner: 1, reason: 'forfeit', hp: replay.need.view.hp },
            ]);
            assert.equal(requests, 1);
            assert.ok(!said.some((text) => text.includes('切磋断了')));
            lock.resolve();
            await until(() => extras.requests.some(({ path }) => path === '/lock/release'), '迟到的占用锁也释放');
          } finally {
            client.dispose();
          }
        },
      );
    } finally {
      lock.resolve();
    }
  });
}
