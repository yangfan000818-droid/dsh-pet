import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoBrawlController, brawlWinner, type BrawlAction, type BrawlFighter } from './brawl';
import { rngFrom } from './battle';
import { createBrawlLive, type BrawlLive, type BrawlLiveMove } from './brawl-live';
import { fighterAt, seededRng } from './battle-testkit';

function roster(n: number, seed: number): BrawlFighter[] {
  const rng = seededRng(seed);
  return Array.from({ length: n }, (_, id) => {
    const f = fighterAt(12, rng);
    return { ...f, id, name: `p${id}` };
  });
}

/** 假网络：给这一手补上全场序号再广播给所有还在线的驱动（房主校验在 brawl-net 的测试里） */
function makeBus(drivers: Array<{ id: number; live: BrawlLive | null }>) {
  const posts: BrawlLiveMove[] = [];
  // 按到达顺序一条条投递：投递途中岔出来的新报文先排队，不插队（真实邮箱就是这样按序取）
  const queue: BrawlLiveMove[] = [];
  let flushing = false;
  const flush = (): void => {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length > 0) {
        const move = queue.shift();
        if (!move) break;
        for (const node of drivers) node.live?.push(move);
      }
    } finally {
      flushing = false;
    }
  };
  const deliver = (move: BrawlLiveMove): void => {
    const stamped = { ...move, index: posts.length };
    posts.push(stamped);
    queue.push(stamped);
    flush();
  };
  return { posts, deliver };
}

/** 每个参与者：自己的选择用自己的一颗自动随机数（各家不必相同，只要网络转发一致） */
function participant(fighters: BrawlFighter[], seed: string, id: number, submit: (move: BrawlLiveMove) => void) {
  const controller = autoBrawlController(rngFrom(`${seed}:pick:${id}`));
  return createBrawlLive({
    fighters,
    seed,
    self: id,
    choose: (view) => controller.decide(view),
    submit: (target, action) => submit({ index: -1, actor: id, target, action }),
  });
}

test('定手：各家拿到同一串选择，重放出来的事件一模一样，整场能定完', () => {
  const fighters = roster(3, 11);
  const seed = 'live:1';
  const nodes = fighters.map((f) => ({ id: f.id, live: null as BrawlLive | null }));
  let bus: ReturnType<typeof makeBus> | null = null;
  bus = makeBus(nodes);
  for (const node of nodes) {
    node.live = participant(fighters, seed, node.id, (move) => bus?.deliver({ ...move }));
  }
  // 起手：谁轮到谁交，广播后继续，直到整场定完（同步链路，最多几十手）
  for (const node of nodes) node.live?.pump();
  for (const node of nodes) assert.ok(node.live?.done(), `p${node.id} 应该已经定完整场`);
  const reference = nodes[0].live?.events() ?? [];
  assert.ok(reference.length > 5);
  for (const node of nodes.slice(1)) {
    assert.deepEqual(node.live?.events(), reference, `p${node.id} 的事件与他人一致`);
  }
  // 每一手都走了网络，序号连续、出手人就是当时轮到的那个
  assert.ok(bus.posts.length > 0);
  assert.equal(brawlWinner(reference) !== undefined, true);
});

test('定手：某方一直不交，判它退场后其余各方接着打，结局仍一致', () => {
  const fighters = roster(4, 12);
  const seed = 'live:2';
  const nodes = fighters.map((f) => ({ id: f.id, live: null as BrawlLive | null }));
  // 2 号机不上线：它的提交没人转发
  const bus = makeBus(nodes);
  for (const node of nodes) {
    if (node.id === 2) continue;
    node.live = participant(fighters, seed, node.id, (move) => bus.deliver({ ...move }));
  }
  const alive = nodes.filter((node) => node.live);
  for (const node of alive) node.live?.pump();
  assert.equal(
    alive.some((node) => node.live?.done()),
    false,
    '等 2 号这一手时卡住',
  );
  // 各方本地判掉线（房主广播退场的那一步由 brawl-net 做）
  for (const node of alive) node.live?.out(2);
  for (const node of alive) assert.ok(node.live?.done());
  const reference = alive[0].live?.events() ?? [];
  for (const node of alive.slice(1)) assert.deepEqual(node.live?.events(), reference);
});

test('定手：序号接不上、出手人不对的一手不收', () => {
  const fighters = roster(3, 13);
  const seed = 'live:3';
  const live = createBrawlLive({
    fighters,
    seed,
    self: 0,
    choose: (view) => autoBrawlController(rngFrom('solo')).decide(view),
    submit: () => undefined,
  });
  live.pump();
  const first = live.pending();
  assert.ok(first, '第一手还没定');
  const target = (first.id + 1) % fighters.length;
  const action: BrawlAction = { kind: 'unarmed', target };
  assert.equal(live.push({ index: 5, actor: first.id, target, action }), false, '序号接不上');
  assert.equal(live.push({ index: 0, actor: (first.id + 1) % fighters.length, target, action }), false, '出手人不对');
  assert.equal(live.push({ index: 0, actor: first.id, target, action }), true, '对得上的收下');
  assert.equal(live.done(), false, '还有下一手');
});
