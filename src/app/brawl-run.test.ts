/**
 * X27 群架本地窗口编排（B1）的单测：窗口数量与摆位、记分板行数、时间线顺序、收场 / 异常清理。
 *
 * 全部用假 electron / 假窗口 / 假定时器：不真开窗口，也不真等几十秒的演出。
 * 假定时器按「时刻 + 注册顺序」执行；每执行一拍让出一次微任务，让 loadURL 的 then 先把队列里的
 * executeJavaScript 补发掉（和真窗口加载完再收页面调用同一口径）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rngFrom } from './battle.ts';
import { autoBrawlController, brawl, type BrawlFighter } from './brawl.ts';
import { brawlArenaPage } from './brawl-arena.ts';
import { runBrawl, type BrawlRunHost, type BrawlRunTimers } from './brawl-run.ts';
import { brawlTimeline } from './brawl-show.ts';
import type { PetBox, Rect, WindowElectron } from './visit-windows.ts';

const SEED = 'brawl-run-test';
const AREA: Rect = { x: 0, y: 0, width: 1_600, height: 1_000 };
const HOME: PetBox = { left: 800, top: 520, size: 300, bottomPad: 20 };

function roster(count: number): BrawlFighter[] {
  return Array.from({ length: count }, (_, id) => ({
    id,
    name: `p${id}`,
    hp: 100,
    power: 12,
    agility: 12,
    speed: 12,
    weapons: ['water-gun'],
    skills: [],
  }));
}

function controllers(count: number) {
  return Array.from({ length: count }, (_, id) => autoBrawlController(rngFrom(`ctl:${id}`)));
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function assertInside(rect: Rect, area: Rect): void {
  assert.ok(rect.x >= area.x, `left ${rect.x} < ${area.x}`);
  assert.ok(rect.y >= area.y, `top ${rect.y} < ${area.y}`);
  assert.ok(rect.x + rect.width <= area.x + area.width, `right ${rect.x + rect.width} > ${area.x + area.width}`);
  assert.ok(rect.y + rect.height <= area.y + area.height, `bottom ${rect.y + rect.height} > ${area.y + area.height}`);
}

class FakeWin {
  readonly options: Record<string, unknown>;
  bounds: Rect;
  readonly history: Rect[] = [];
  readonly codes: string[] = [];
  readonly urls: string[] = [];
  readonly ignored: boolean[] = [];
  shown = 0;
  hidden = 0;
  destroyed = false;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.bounds = {
      x: Number(options.x) || 0,
      y: Number(options.y) || 0,
      width: Number(options.width) || 0,
      height: Number(options.height) || 0,
    };
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getBounds(): Rect {
    return { ...this.bounds };
  }

  setBounds(rect: Rect): void {
    this.bounds = { ...rect };
    this.history.push({ ...rect });
  }

  setIgnoreMouseEvents(ignore: boolean): void {
    this.ignored.push(ignore);
  }

  setAlwaysOnTop(): void {}

  moveTop(): void {}

  setVisibleOnAllWorkspaces(): void {}

  loadURL(url: string): Promise<void> {
    this.urls.push(url);
    return Promise.resolve();
  }

  showInactive(): void {
    this.shown += 1;
  }

  show(): void {}

  hide(): void {
    this.hidden += 1;
  }

  focus(): void {}

  once(): void {}

  destroy(): void {
    this.destroyed = true;
  }

  webContents = {
    getURL: (): string => this.urls[0] ?? '',
    executeJavaScript: (code: string): Promise<unknown> => {
      this.codes.push(code);
      return Promise.resolve(undefined);
    },
  };
}

interface FakeTimers {
  timers: BrawlRunTimers;
  runAll(): Promise<void>;
  executed: number[];
  now(): number;
}

function fakeTimers(): FakeTimers {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; seq: number; callback: () => void }>();
  const executed: number[] = [];
  const timers: BrawlRunTimers = {
    setTimeout(callback, ms) {
      const id = (seq += 1);
      pending.set(id, { at: now + Math.max(0, ms), seq: id, callback });
      return id;
    },
    clearTimeout(handle) {
      if (typeof handle === 'number') pending.delete(handle);
    },
  };
  const next = () => {
    let best: { at: number; seq: number; callback: () => void } | null = null;
    for (const entry of pending.values()) {
      if (!best || entry.at < best.at || (entry.at === best.at && entry.seq < best.seq)) best = entry;
    }
    return best;
  };
  const runAll = async (): Promise<void> => {
    for (;;) {
      const entry = next();
      if (!entry) return;
      pending.delete(entry.seq);
      now = Math.max(now, entry.at);
      executed.push(now);
      entry.callback();
      // 让 loadURL 的 then 先把队列里的页面调用补发掉（真窗口也是加载完才补发）
      await Promise.resolve();
    }
  };
  return { timers, runAll, executed, now: () => now };
}

function makeHost(home: PetBox = HOME) {
  const wins: FakeWin[] = [];
  const BrowserWindow = function (_options: Record<string, unknown>): FakeWin {
    const win = new FakeWin(_options);
    wins.push(win);
    return win;
  } as unknown as WindowElectron['BrowserWindow'];
  (BrowserWindow as unknown as { getAllWindows: () => FakeWin[] }).getAllWindows = () => wins;
  const electron: WindowElectron = {
    BrowserWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: AREA.x + 10, y: AREA.y + 10 }),
      getDisplayNearestPoint: () => ({ workArea: AREA }),
    },
    ipcMain: {
      on: () => undefined,
      removeListener: () => undefined,
    },
  };
  const clock = fakeTimers();
  const plays: Array<{ anim: string; facing: 'left' | 'right'; rate: number; at: number }> = [];
  const said: string[] = [];
  const logs: string[] = [];
  const host: BrawlRunHost = {
    electron,
    pages: { foe: 'http://127.0.0.1:1/app/foe', fx: 'http://127.0.0.1:1/app/fx', arena: '/app/brawl-arena' },
    home: () => home,
    workArea: () => AREA,
    playExtra: (anim, opts) => void plays.push({ anim, ...opts, at: clock.now() }),
    say: (line) => void said.push(line),
    log: (msg) => void logs.push(msg),
    timers: clock.timers,
  };
  return { host, wins, clock, plays, said, logs };
}

/** 页面收到的 `brawlArena.update` 载荷 → 每次更新的行数 */
function arenaRowCounts(codes: readonly string[]): number[] {
  const prefix = 'brawlArena.update(';
  const counts: number[] = [];
  for (const code of codes) {
    if (!code.startsWith(prefix)) continue;
    const payload = JSON.parse(code.slice(prefix.length, -1)) as { rows: unknown[] };
    counts.push(payload.rows.length);
  }
  return counts;
}

for (const count of [3, 4, 5]) {
  test(`群架 ${count} 人：开 ${count - 1} 个对手窗口、矩形在工作区、记分板 N 行、按 at 执行、结束全关`, async () => {
    const h = makeHost();
    const fighters = roster(count);
    // 同一颗种子 + 同一批控制器种子 → 时间线可复现，用来核对执行顺序
    const expected = brawlTimeline(
      brawl(fighters, SEED, controllers(count)),
      fighters.map((f) => f.name),
    )
      .map((step) => step.at)
      .sort((a, b) => a - b);

    const pending = runBrawl(h.host, fighters, { seed: SEED, controllers: controllers(count) });
    await h.clock.runAll();
    const events = await pending;
    await tick();

    assert.ok(events.length > 0, '应当打出事件');
    // N-1 个对手窗口 + 环心记分板 + 特效层
    assert.equal(h.wins.length, count + 1);

    const foeWins = h.wins.slice(0, count - 1);
    assert.equal(foeWins.length, count - 1);
    for (const win of foeWins) {
      const moved = win.history[win.history.length - 1];
      assert.ok(moved, '对手窗口收到 moveTo');
      // 窗口顶上留了气泡的空间（可以伸出工作区），舞台（贴窗底）必须整块在工作区里
      const stageHeight = (moved.width * 9) / 16;
      assertInside({ x: moved.x, y: moved.y + moved.height - stageHeight, width: moved.width, height: stageHeight }, AREA);
      assert.equal(win.options.transparent, true);
      assert.equal(win.options.focusable, false);
      assert.ok(win.ignored.includes(true), '整窗鼠标穿透');
    }

    const arenaWin = h.wins[count - 1];
    const counts = arenaRowCounts(arenaWin.codes);
    assert.ok(counts.length > 0, '记分板收到 update');
    for (const rows of counts) assert.equal(rows, count, '每次更新都是全场 N 行');

    // 假定时器的执行时刻就是时间线排序后的 at
    assert.deepEqual(h.clock.executed.slice(0, expected.length), expected);
    assert.equal(h.clock.executed.length, expected.length + 1, '最后多一个收场定时器');

    for (const win of h.wins) assert.equal(win.destroyed, true, '收场后窗口全部关闭');
  });
}

test('异常也清理：playExtra 抛错时窗口全部关闭', async () => {
  const h = makeHost();
  h.host.playExtra = () => {
    throw new Error('boom');
  };
  const pending = runBrawl(h.host, roster(3), { seed: SEED, controllers: controllers(3) });
  await h.clock.runAll();
  await assert.rejects(pending, /boom/);
  await tick();

  assert.ok(h.wins.length > 0, '窗口已经开了');
  for (const win of h.wins) assert.equal(win.destroyed, true, '异常后也要关窗');
});

test('宠物贴着屏幕边：先把它挪到环的 6 点钟，演完挪回原位', async () => {
  // 左上角的宠物：整环被夹进来以后 6 点钟离它很远
  const corner: PetBox = { left: 0, top: 0, size: 300, bottomPad: 20 };
  const h = makeHost(corner);
  const moves: Array<{ x: number; y: number }> = [];
  h.host.moveSelf = (x, y) => void moves.push({ x, y });

  const pending = runBrawl(h.host, roster(3), { seed: SEED, controllers: controllers(3) });
  await h.clock.runAll();
  await pending;
  await tick();

  assert.equal(moves.length, 2, '开场挪过去、收场挪回来');
  const [to, back] = moves;
  for (const move of moves) {
    assert.ok(move.x >= 0 && move.x <= 1, `x 是归一化坐标：${move.x}`);
    assert.ok(move.y >= 0 && move.y <= 1, `y 是归一化坐标：${move.y}`);
  }
  // 回去的是宠物原来的中心（0 号在 6 点钟时：中心 ≈ (150, 104)）
  assert.ok(Math.abs(back.x - 150 / AREA.width) < 0.01, `回原位 x=${back.x}`);
  assert.ok(Math.abs(back.y - (20 + (300 * 9) / 32) / AREA.height) < 0.01, `回原位 y=${back.y}`);
  assert.notDeepEqual({ x: to.x, y: to.y }, { x: back.x, y: back.y });
});

test('2 人局 + degenerateTo1v1：不开任何窗口，直接返回空事件', async () => {
  const h = makeHost();
  const events = await runBrawl(h.host, roster(2), { degenerateTo1v1: true });
  assert.deepEqual(events, []);
  assert.equal(h.wins.length, 0);
  assert.ok(h.logs.some((line) => line.includes('1v1')));
});

test('记分板页面：只用 textContent / style，不拼 HTML', () => {
  assert.match(brawlArenaPage, /window\.brawlArena = \{/);
  assert.equal(brawlArenaPage.includes('innerHTML'), false);
  assert.equal(brawlArenaPage.includes('insertAdjacentHTML'), false);
  assert.equal(brawlArenaPage.includes('require('), false);
  assert.ok(brawlArenaPage.includes('row.children[1].textContent = String(data.label'));
  assert.ok(brawlArenaPage.includes('fill.style.width = percent + '));
});
