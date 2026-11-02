import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPON_IDS, type Fighter } from './battle';
import { BRAWL_VERSION } from './brawl';
import {
  createBrawlNet,
  type BrawlClock,
  type BrawlExit,
  type BrawlMove,
  type BrawlNet,
  type BrawlNetMsg,
  type BrawlRejectReason,
  type BrawlResult,
} from './brawl-net';
import { seedOf } from './dungeon';
import { fighterAt, seededRng } from './battle-testkit';

// ---------------------------------------------------------------------------
// 假时钟：只跑到期的 timer；同一时刻按 setTimeout 的先后（编号）跑
// ---------------------------------------------------------------------------

interface FakeTimer {
  at: number;
  cb: () => void;
}

class FakeClock implements BrawlClock {
  private now = 0;
  private seq = 0;
  private timers = new Map<number, FakeTimer>();

  setTimeout(cb: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      let picked: number | null = null;
      let pickedTimer: FakeTimer | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue;
        if (
          picked === null ||
          pickedTimer === null ||
          timer.at < pickedTimer.at ||
          (timer.at === pickedTimer.at && id < picked)
        ) {
          picked = id;
          pickedTimer = timer;
        }
      }
      if (picked === null || pickedTimer === null) break;
      this.timers.delete(picked);
      this.now = pickedTimer.at;
      pickedTimer.cb();
    }
    this.now = target;
  }
}

// ---------------------------------------------------------------------------
// 内存总线：按信封的 to 投递；block(id) 模拟这台机子失联
// ---------------------------------------------------------------------------

interface TestBus {
  send: (msg: BrawlNetMsg) => void;
  /** 绕过断线直接塞一条报文（用于旧 epoch / 乱序等恶意输入） */
  deliver: (msg: BrawlNetMsg) => void;
  register: (id: number, net: BrawlNet) => void;
  block: (id: number) => void;
  unblock: (id: number) => void;
  log: BrawlNetMsg[];
}

function makeBus(): TestBus {
  const nodes = new Map<number, BrawlNet>();
  const blocked = new Set<number>();
  const log: BrawlNetMsg[] = [];
  return {
    log,
    register: (id, net) => {
      nodes.set(id, net);
    },
    block: (id) => {
      blocked.add(id);
    },
    unblock: (id) => {
      blocked.delete(id);
    },
    send: (msg) => {
      log.push(msg);
      if (blocked.has(msg.from) || blocked.has(msg.to)) return;
      nodes.get(msg.to)?.receive(msg);
    },
    deliver: (msg) => {
      log.push(msg);
      nodes.get(msg.to)?.receive(msg);
    },
  };
}

// ---------------------------------------------------------------------------
// 参与者与观测
// ---------------------------------------------------------------------------

interface Spy {
  moves: BrawlMove[];
  rejects: BrawlRejectReason[];
  exits: BrawlExit[];
  changes: Array<{ host: number; epoch: number }>;
  ends: BrawlResult[];
}

interface Party {
  net: BrawlNet;
  spy: Spy;
}

function fighterFor(id: number): Fighter {
  const f = fighterAt(12, seededRng(1000 + id));
  return {
    ...f,
    name: `p${id}`,
    weapons: [...f.weapons],
    skills: [...f.skills],
    ...(f.moves ? { moves: [...f.moves] } : {}),
  };
}

function nonceOf(id: number): string {
  return id.toString(16).repeat(64).slice(0, 64);
}

function last<T>(list: readonly T[]): T | undefined {
  return list[list.length - 1];
}

function party(bus: TestBus, clock: FakeClock, id: number, card: Fighter = fighterFor(id)): Party {
  const spy: Spy = { moves: [], rejects: [], exits: [], changes: [], ends: [] };
  const net = createBrawlNet({
    self: id,
    card,
    nonce: nonceOf(id),
    clock,
    send: bus.send,
    onDeliver: (move) => spy.moves.push(move),
    onReject: (reason) => spy.rejects.push(reason),
    onExit: (who, reason) => spy.exits.push({ id: who, reason }),
    onHostChange: (host, epoch) => spy.changes.push({ host, epoch }),
    onEnd: (result) => spy.ends.push(result),
  });
  bus.register(id, net);
  return { net, spy };
}

function setup(count: number): { clock: FakeClock; bus: TestBus; parties: Party[] } {
  const clock = new FakeClock();
  const bus = makeBus();
  const parties = Array.from({ length: count }, (_, id) => party(bus, clock, id));
  for (let id = 1; id < count; id++) parties[id].net.join();
  parties[0].net.start();
  return { clock, bus, parties };
}

// ---------------------------------------------------------------------------
// 1. 组局与种子
// ---------------------------------------------------------------------------

test('联机：开桌 + 加入，各方算出的种子一致', () => {
  const { parties } = setup(3);
  const expected = seedOf([nonceOf(0), nonceOf(1), nonceOf(2)]);
  for (const { net } of parties) {
    const state = net.state();
    assert.equal(state.phase, 'running');
    assert.equal(state.seed, expected);
    assert.deepEqual(
      state.players.map((p) => p.id),
      [0, 1, 2],
    );
    assert.deepEqual(state.alive, [0, 1, 2]);
    assert.equal(state.host, 0);
    assert.equal(state.epoch, 0);
  }
});

test('联机：房主把各家的收件地址塞进 start，客人按编号取得到（不知道的留空串）', () => {
  const clock = new FakeClock();
  const bus = makeBus();
  const addresses = ['http://10.0.0.1:7340', 'http://10.0.0.2:7340', null];
  const host = party(bus, clock, 0);
  const guests = [1, 2].map((id) => party(bus, clock, id));
  // 房主的 net 已经建好，addressOf 只能在建的时候给：重建一个带地址的房主
  host.net.dispose();
  const withAddresses = createBrawlNet({
    self: 0,
    card: fighterFor(0),
    nonce: nonceOf(0),
    clock,
    send: bus.send,
    addressOf: (id) => addresses[id] ?? null,
  });
  bus.register(0, withAddresses);
  for (const g of guests) g.net.join();
  withAddresses.start();
  const starts = bus.log.filter((msg): msg is Extract<BrawlNetMsg, { kind: 'start' }> => msg.kind === 'start');
  assert.equal(starts.length, 2, '每个客人各收一份 start');
  for (const msg of starts) {
    assert.deepEqual(msg.addresses, ['http://10.0.0.1:7340', 'http://10.0.0.2:7340', '']);
  }
});

test('联机：人数不足 / 版本不同 / 满员拒入', () => {
  const clock = new FakeClock();
  const bus = makeBus();
  const host = party(bus, clock, 0);
  assert.throws(() => host.net.start(), /2–5/);

  const wrong = createBrawlNet({
    self: 1,
    card: fighterFor(1),
    nonce: nonceOf(1),
    version: BRAWL_VERSION + 1,
    clock,
    send: bus.send,
  });
  bus.register(1, wrong);
  wrong.join();
  assert.deepEqual(
    host.net.state().players.map((p) => p.id),
    [0],
  );
  const reject = bus.log.find((m) => m.kind === 'reject');
  assert.equal(reject?.kind === 'reject' ? reject.reason : null, 'version');
});

test('联机：两台同时报名撞同一个编号，后到的按最新名单重报就进得来', () => {
  const clock = new FakeClock();
  const bus = makeBus();
  const host = party(bus, clock, 0);
  const first = party(bus, clock, 1);
  first.net.join();
  assert.deepEqual(
    host.net.state().players.map((p) => p.id),
    [0, 1],
  );

  // 第二台也以为自己是 1 号：join 直接递给房主（不占 bus 的 1 号节点，模拟另一条连接）
  const late = createBrawlNet({
    self: 1,
    card: fighterFor(1),
    nonce: nonceOf(1),
    clock,
    send: (msg) => {
      if (msg.kind === 'join') host.net.receive(msg);
    },
  });
  late.join();
  assert.deepEqual(
    host.net.state().players.map((p) => p.id),
    [0, 1],
    '撞号的那一家不占座位，先到的也不受影响',
  );
  const rejects = bus.log.filter((m): m is Extract<BrawlNetMsg, { kind: 'reject' }> => m.kind === 'reject');
  assert.equal(last(rejects)?.reason, 'id', '撞号按 id 拒收');

  // 后到的那台按房主最新名单用 2 号重报：房主收下，整桌能开打
  const retry = party(bus, clock, 2);
  retry.net.join();
  assert.deepEqual(
    host.net.state().players.map((p) => p.id),
    [0, 1, 2],
  );
  host.net.start();
  for (const node of [first, retry]) assert.equal(node.net.state().phase, 'running');
});

test('联机：每一手广播给所有参与者，index 连续', () => {
  const { parties } = setup(3);
  parties[0].net.submitMove(1, { kind: 'unarmed' });
  parties[1].net.submitMove(2, { kind: 'unarmed' });
  parties[2].net.submitMove(0, { kind: 'unarmed' });

  for (const { net, spy } of parties) {
    assert.deepEqual(
      spy.moves.map((m) => m.index),
      [0, 1, 2],
    );
    assert.deepEqual(
      spy.moves.map((m) => m.actor),
      [0, 1, 2],
    );
    assert.deepEqual(
      spy.moves.map((m) => m.target),
      [1, 2, 0],
    );
    assert.equal(net.state().index, 3);
  }
});

// ---------------------------------------------------------------------------
// 3. 非法动作 / 越权
// ---------------------------------------------------------------------------

test('联机：越权出手与非法动作被房主拒收，不推进状态', () => {
  const clock = new FakeClock();
  const bus = makeBus();
  const host = party(bus, clock, 0);
  // 这只有一把法宝都没有，任何法宝都算非法动作
  const g1 = party(bus, clock, 1, { ...fighterFor(1), weapons: [] });
  const g2 = party(bus, clock, 2);
  g1.net.join();
  g2.net.join();
  host.net.start();

  // 不是自己的轮次（该 0 号出）：直接塞给房主
  bus.deliver({
    kind: 'move',
    from: 1,
    to: 0,
    index: 0,
    epoch: 0,
    actor: 1,
    target: 2,
    action: { kind: 'unarmed' },
  });
  assert.deepEqual(g1.spy.rejects, ['turn']);
  assert.equal(host.net.state().index, 0);

  host.net.submitMove(1, { kind: 'unarmed' });
  assert.equal(host.net.state().index, 1);

  // 动作图鉴里有、但这只没有：房主按 action 拒收
  g1.net.submitMove(2, { kind: 'weapon', weapon: WEAPON_IDS[0] });
  assert.equal(last(g1.spy.rejects), 'action');
  assert.equal(host.net.state().index, 1);

  // 目标选自己：拒收
  g1.net.submitMove(1, { kind: 'unarmed' });
  assert.equal(last(g1.spy.rejects), 'target');
  assert.equal(host.net.state().index, 1);

  // 换合法一手就能继续
  g1.net.submitMove(2, { kind: 'unarmed' });
  assert.equal(host.net.state().index, 2);
  assert.deepEqual(
    g1.spy.moves.map((m) => m.index),
    [0, 1],
  );
});

// ---------------------------------------------------------------------------
// 4. 重复 / 乱序 / 旧 epoch
// ---------------------------------------------------------------------------

test('联机：重复、乱序报文被丢弃且不影响状态', () => {
  const { bus, parties } = setup(3);
  parties[0].net.submitMove(1, { kind: 'unarmed' });
  parties[1].net.submitMove(2, { kind: 'unarmed' });
  const before = parties.map(({ net }) => net.state().index);
  assert.deepEqual(before, [2, 2, 2]);

  // 重复：已经收过的 index 1
  bus.deliver({
    kind: 'move',
    from: 1,
    to: 0,
    index: 1,
    epoch: 0,
    actor: 1,
    target: 2,
    action: { kind: 'unarmed' },
  });
  // 乱序：跳到 index 9
  bus.deliver({
    kind: 'move',
    from: 2,
    to: 0,
    index: 9,
    epoch: 0,
    actor: 2,
    target: 0,
    action: { kind: 'unarmed' },
  });
  // 客人侧的重复广播
  bus.deliver({
    kind: 'move',
    from: 0,
    to: 2,
    index: 1,
    epoch: 0,
    actor: 1,
    target: 2,
    action: { kind: 'unarmed' },
  });

  assert.deepEqual(
    parties.map(({ net }) => net.state().index),
    before,
  );
  assert.equal(parties[0].spy.moves.length, 2);
  assert.equal(parties[2].spy.moves.length, 2);
});

// ---------------------------------------------------------------------------
// 5. 掉线
// ---------------------------------------------------------------------------

test('联机：某方超时退场，剩余继续；只剩一人结束', () => {
  const { clock, parties } = setup(3);
  parties[0].net.submitMove(1, { kind: 'unarmed' });
  assert.equal(parties[0].net.state().index, 1);

  // 轮到 1 号，35 秒没来
  clock.advance(35_000);
  for (const { net } of parties) {
    const state = net.state();
    assert.deepEqual(state.alive, [0, 2]);
    assert.deepEqual(state.exits, [{ id: 1, reason: 'timeout' }]);
    assert.equal(state.index, 1);
  }
  assert.deepEqual(parties[1].spy.exits, [{ id: 1, reason: 'timeout' }]);

  // 剩余继续：轮到 2 号
  parties[2].net.submitMove(0, { kind: 'unarmed' });
  assert.equal(parties[0].net.state().index, 2);
  // 再轮到 0 号
  parties[0].net.submitMove(2, { kind: 'unarmed' });
  assert.equal(parties[0].net.state().index, 3);

  // 轮到 2 号又没来，只剩 0 号
  clock.advance(35_000);
  for (const { net } of parties) {
    const state = net.state();
    assert.equal(state.phase, 'ended');
    assert.deepEqual(state.result, { winner: 0, ranking: [0, 2, 1] });
  }
});

// ---------------------------------------------------------------------------
// 6. 认输
// ---------------------------------------------------------------------------

test('联机：认输经房主确认后转发，全体同一结局', () => {
  const { parties } = setup(3);
  parties[1].net.forfeit();

  for (const { net } of parties) {
    const state = net.state();
    assert.deepEqual(state.alive, [0, 2]);
    assert.deepEqual(state.exits, [{ id: 1, reason: 'forfeit' }]);
    assert.equal(state.result, null);
  }
  assert.deepEqual(parties[1].spy.exits, [{ id: 1, reason: 'forfeit' }]);

  parties[2].net.forfeit();
  for (const { net } of parties) {
    const state = net.state();
    assert.equal(state.phase, 'ended');
    assert.deepEqual(state.result, { winner: 0, ranking: [0, 2, 1] });
  }
  for (const { spy } of parties) {
    assert.deepEqual(spy.ends, [{ winner: 0, ranking: [0, 2, 1] }]);
  }
});

// ---------------------------------------------------------------------------
// 7. 房主移交
// ---------------------------------------------------------------------------

test('联机：房主掉线，编号最小的存活者接任并广播 hostChange；旧 epoch 作废', () => {
  const { clock, bus, parties } = setup(3);
  const [, g1, g2] = parties;
  // 房主作为中继和出手方都失联
  bus.block(0);
  clock.advance(35_000);

  for (const { net } of [g1, g2]) {
    const state = net.state();
    assert.equal(state.phase, 'running');
    assert.equal(state.host, 1);
    assert.equal(state.epoch, 1);
    assert.deepEqual(state.alive, [1, 2]);
    assert.deepEqual(state.exits, [{ id: 0, reason: 'timeout' }]);
  }
  assert.deepEqual(g1.spy.changes, [{ host: 1, epoch: 1 }]);
  assert.deepEqual(g2.spy.changes, [{ host: 1, epoch: 1 }]);

  // 接任者用新 epoch 出手，另一方认
  g1.net.submitMove(2, { kind: 'unarmed' });
  assert.equal(last(g1.spy.moves)?.epoch, 1);
  assert.equal(last(g1.spy.moves)?.index, 0);
  assert.equal(g2.net.state().index, 1);
  assert.deepEqual(
    g2.spy.moves.map((m) => ({ index: m.index, epoch: m.epoch, actor: m.actor })),
    [{ index: 0, epoch: 1, actor: 1 }],
  );

  // 旧 epoch 报文一律丢弃，不推进状态
  const before = g1.net.state().index;
  bus.deliver({
    kind: 'move',
    from: 0,
    to: 1,
    index: 1,
    epoch: 0,
    actor: 0,
    target: 1,
    action: { kind: 'unarmed' },
  });
  assert.equal(g1.net.state().index, before);
  assert.equal(g1.spy.moves.length, 1);

  // 原房主不再入场：开打中再报名被拒
  bus.deliver({
    kind: 'join',
    from: 0,
    to: 1,
    version: BRAWL_VERSION,
    card: fighterFor(0),
    nonce: nonceOf(0),
  });
  assert.equal(bus.log.filter((m) => m.kind === 'reject' && m.to === 0 && m.reason === 'closed').length, 1);
  // 名册里还留着旧房主的编号（事件 hp 数组要对齐），但已经不在存活名单里
  assert.equal(g1.net.state().players.filter((p) => p.id === 0).length, 1);
  assert.deepEqual(g1.net.state().alive, [1, 2]);

  // 剩余两人继续，index 连得上
  g2.net.submitMove(1, { kind: 'unarmed' });
  assert.equal(g1.net.state().index, before + 1);
  assert.equal(g2.net.state().index, before + 1);
});

test('联机：房主掉线后新工头再次掉线，按同一规则继续移交', () => {
  const { clock, bus, parties } = setup(4);
  const [, g1, g2, g3] = parties;
  bus.block(0);
  clock.advance(35_000);
  assert.equal(g1.net.state().host, 1);
  assert.equal(g3.net.state().host, 1);

  // 新工头 1 也失联；轮到它时 2 号接任
  bus.block(1);
  clock.advance(35_000);
  for (const { net } of [g2, g3]) {
    const state = net.state();
    assert.equal(state.host, 2);
    assert.equal(state.epoch, 2);
    assert.deepEqual(state.alive, [2, 3]);
  }
  assert.deepEqual(last(g2.spy.changes), { host: 2, epoch: 2 });

  g2.net.submitMove(3, { kind: 'unarmed' });
  assert.equal(g3.net.state().index, 1);
});
