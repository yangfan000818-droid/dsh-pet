import assert from 'node:assert/strict';
import test from 'node:test';
import { startLiveClient, startLiveServer, type LiveClientOptions, type LiveServerOptions } from './battle-live';
import { rngFrom, type Action, type BattleEvent, type Fighter } from './battle';
import { SPAR_OPTIONS, sparFighter } from './spar-rules';

const noop = () => undefined;
const firework: Action = { kind: 'weapon', weapon: 'firework' };
const base = {
  a: sparFighter('甲'),
  b: sparFighter('乙'),
  seed: 'round-network',
  ...SPAR_OPTIONS,
  show: { self: { play: noop, say: noop }, foe: { play: noop, say: noop }, arena: noop, shoot: noop },
  decide: async () => null,
  think: noop,
  log: noop,
  waitMs: 1_000,
};

function server(extra: Partial<LiveServerOptions> = {}) {
  return startLiveServer({ ...base, local: 0, lineRng: rngFrom('lines'), ...extra });
}

function client(host: ReturnType<typeof server>, extra: Partial<LiveClientOptions> = {}) {
  return startLiveClient({
    ...base,
    local: 1,
    lineRng: rngFrom('lines'),
    sendTurn: async (body) => host.turn(body.index, body.action, body.forfeit),
    ...extra,
  });
}

function hold<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (release = resolve));
  return { promise, release };
}

function endOf(events: BattleEvent[] | null) {
  const end = events?.[events.length - 1];
  assert.ok(end?.kind === 'end');
  return end;
}

test('同步对传：双方每轮各锁一手，两端事件一致', async () => {
  const host = server();
  const guest = client(host);
  host.skip();
  guest.skip();
  const [a, b] = await Promise.all([host.done, guest.done]);
  endOf(a);
  assert.deepEqual(a, b);
});

test('同步对传：房主尚未锁招时，不会向请求方泄露动作', async () => {
  const ready = hold<null>();
  const host = server({ decide: () => ready.promise });
  let replied = false;
  const request = host.turn(0, firework).then((reply) => {
    replied = true;
    return reply;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(replied, false);
  ready.release(null);
  host.skip();
  const reply = await request;
  assert.ok(reply.ok && reply.action);
  host.dispose();
});

test('同步对传：客户端认输能唤醒未选招的双方，结果一致', async () => {
  const choose = (_view: unknown, _round: number, signal: AbortSignal) =>
    new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
  const host = server({ decide: choose });
  const guest = client(host, { decide: choose });
  guest.forfeit();
  const [a, b] = await Promise.all([host.done, guest.done]);
  assert.deepEqual(a, b);
  const end = endOf(a);
  assert.equal(end.reason, 'forfeit');
  assert.equal(end.winner, 0);
});

test('同步对传：房主认输也能结束挂起的交换', async () => {
  const waiting = hold<null>();
  const host = server({ decide: () => waiting.promise });
  const guest = client(host);
  host.forfeit();
  const [a, b] = await Promise.all([host.done, guest.done]);
  const end = endOf(a);
  assert.equal(end.reason, 'forfeit');
  assert.equal(end.winner, 1);
  assert.deepEqual(a, b);
  waiting.release(null);
});

test('同步对传：最后一轮已经双亡，晚到的认输只取回最后一招', { timeout: 2_000 }, async () => {
  const tiny: Fighter = { ...base.a, hp: 1, agility: 1, weapons: ['firework'], skills: [] };
  const options = { a: tiny, b: { ...tiny, name: '乙' }, seed: 'double-ko', waitMs: 10_000 };
  const host = server(options);
  host.skip();
  const locked = hold<AbortSignal>();
  const guest = client(host, {
    ...options,
    sendTurn: async (body, signal) => {
      const reply = await host.turn(body.index, body.action, body.forfeit);
      if (body.forfeit) return reply;
      assert.ok(reply.ok && reply.action);
      locked.release(signal);
      // 最后一招已经算完，普通回包却没有交给客人。
      return new Promise(() => undefined);
    },
  });
  guest.skip();
  try {
    const signal = await locked.promise;
    const a = await host.done;
    host.forfeit();
    guest.forfeit();
    const b = await guest.done;
    assert.equal(signal.aborted, true);
    assert.deepEqual(a, b);
    const end = endOf(b);
    assert.deepEqual([end.reason, end.draw, end.hp], ['ko', true, [0, 0]]);
  } finally {
    host.dispose();
    guest.dispose();
  }
});

test('同步对传：非法动作拒绝且不伪造对方出招', async () => {
  const host = server();
  host.skip();
  assert.deepEqual(await host.turn(0, { kind: 'move', move: 'gu-dogs' }), { ok: false, reason: 'illegal' });
  assert.equal(await host.done, null);
});

test('同步对传：未收到对方时超时，挂起决策随取消清理', async () => {
  const host = server({ waitMs: 15 });
  host.skip();
  assert.equal(await host.done, null);
});

test('同步对传：两端快进都不等开演闸，照常打完且不会补播', { timeout: 2_000 }, async () => {
  const ready = hold<void>();
  const rendered: unknown[] = [];
  const options = { ready: ready.promise, show: { ...base.show, arena: (hp: [number, number]) => rendered.push(hp) } };
  const host = server(options);
  const guest = client(host, options);
  try {
    host.skip();
    guest.skip();
    const [a, b] = await Promise.all([host.done, guest.done]);
    assert.notEqual(endOf(a).reason, 'forfeit');
    assert.deepEqual(a, b);
    assert.deepEqual(rendered, []);
    ready.release(undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(rendered, []);
  } finally {
    host.dispose();
    guest.dispose();
    ready.release(undefined);
  }
});

test('同步对传：取消不等开演闸，收摊会回掉已入站的请求且不会补播', async () => {
  const ready = hold<void>();
  const waiting = hold<null>();
  const rendered: unknown[] = [];
  const show = { ...base.show, arena: (hp: [number, number]) => rendered.push(hp) };
  const options = { ready: ready.promise, decide: () => waiting.promise, show };
  const host = server(options);
  const guest = client(host, options);
  const request = host.turn(0, firework);
  host.dispose();
  guest.dispose();
  assert.deepEqual(await request, { ok: false, reason: 'not-visiting' });
  assert.deepEqual(await Promise.all([host.done, guest.done]), [null, null]);
  ready.release(undefined);
  waiting.release(null);
  assert.deepEqual(rendered, []);
});
