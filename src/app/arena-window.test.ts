/**
 * 擂台小窗的单测（X3）：位置算法、血条百分比、页面契约（只用 textContent / style.width，
 * 数据经 JSON.stringify 成字面量）与窗口的显示属性（透明、置顶、不可聚焦、鼠标穿透）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARENA_COLUMN_WIDTH,
  ARENA_HEIGHT,
  ARENA_ROW_HEIGHT,
  arenaBounds,
  arenaPage,
  arenaPlaceCode,
  arenaPlacement,
  arenaRows,
  arenaUpdate,
  arenaUpdateCode,
  hpPercent,
  openArenaWindow,
} from './arena-window.ts';
import type { Rect, WindowElectron, WindowLike } from './visit-windows.ts';

const workArea = { x: 0, y: 25, width: 1440, height: 1200 };
/** 500 宽的宠物：舞台 500 × 281.25 */
const home = { left: 1000, top: 400, size: 500, bottomPad: 23 };
const foeWindow = { x: 500, y: 420, width: 350, height: 220 };

test('arenaBounds：居中在两只宠物中间，落在它们头顶，宽度夹在 200–520', () => {
  const bounds = arenaBounds(home, foeWindow, workArea);
  // 两只的外沿跨 488–1512（约 1024），夹到上限 520 并居中在中间
  assert.equal(bounds.width, 520);
  assert.equal(bounds.height, ARENA_HEIGHT);
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - 1000) <= 1, `居中在两只中间：x=${bounds.x}`);
  assert.ok(bounds.y + bounds.height <= home.top, '整窗在两只宠物头顶上方');
  assert.ok(bounds.y >= workArea.y && bounds.y + bounds.height <= workArea.y + workArea.height, '留在屏内');
  // 只有自家宠物（对手窗口还没开）：居中在它上方（放不下就夹回屏内）
  const alone = arenaBounds({ ...home, left: 500 }, null, workArea);
  assert.ok(Math.abs(alone.x + alone.width / 2 - 750) <= 1, `居中在宠物上方：x=${alone.x}`);
  const atRight = arenaBounds({ ...home, left: 1200 }, null, workArea);
  assert.ok(atRight.x + atRight.width <= workArea.x + workArea.width, '放不下就夹回屏内');
  // 挨得很近的两只：不小于 200
  const near = arenaBounds({ ...home, left: 500 }, { x: 600, y: 0, width: 100, height: 100 }, workArea);
  assert.ok(near.width >= 200, `至少 200 宽：${near.width}`);
  // 宠物贴着屏幕左边、对手在屏外：夹回屏内
  const atEdge = arenaBounds({ ...home, left: 0 }, { x: -300, y: 0, width: 400, height: 200 }, workArea);
  assert.ok(atEdge.x >= workArea.x, `不越出屏幕左沿：x=${atEdge.x}`);
  assert.ok(atEdge.x + atEdge.width <= workArea.x + workArea.width);
  // 谁都不知道在哪：屏幕上方中间
  const blind = arenaBounds(null, null, workArea);
  assert.equal(blind.width, 324, '假定 300 宽的一侧 + 两边让开 12');
  assert.ok(Math.abs(blind.x + blind.width / 2 - (workArea.x + workArea.width / 2)) <= 1);
});

test('arenaRows：两条血各自贴在自己宠物正头顶，窗口只包住这两小段', () => {
  // 自家宠物头顶 = 包围盒顶 + bottomPad + 舞台 62/360（看得见的发梢顶）；客人同理，舞台贴窗口底
  const homeHead = home.top + home.bottomPad + ((home.size * 9) / 16) * (62 / 360);
  const foeHead =
    foeWindow.y + foeWindow.height - 6 - (foeWindow.width * 9) / 16 + ((foeWindow.width * 9) / 16) * (62 / 360);
  const rows = arenaRows(home, foeWindow, workArea);
  const homeRow = rows.right;
  const foeRow = rows.left;
  assert.equal(homeRow.x + homeRow.width / 2, home.left + home.size / 2, '横向对准自家宠物舞台中心');
  assert.equal(foeRow.x + foeRow.width / 2, foeWindow.x + foeWindow.width / 2, '横向对准客人舞台中心');
  assert.equal(homeRow.width, ARENA_COLUMN_WIDTH);
  assert.equal(homeRow.height, ARENA_ROW_HEIGHT);
  // 血条在名字下面，底边离头顶 2px
  assert.ok(Math.abs(homeRow.y + homeRow.height - (homeHead - 2)) <= 1, `底边离头顶 2px：${homeRow.y}`);
  assert.ok(Math.abs(foeRow.y + foeRow.height - (foeHead - 2)) <= 1, `底边离头顶 2px：${foeRow.y}`);
  // 窗口是两小段的并集 + 四周 8px：中间整段是透的
  assert.equal(rows.bounds.x, foeRow.x - 8);
  assert.equal(rows.bounds.y, Math.min(foeRow.y, homeRow.y) - 8);
  assert.equal(rows.bounds.width, homeRow.x + homeRow.width - foeRow.x + 16);
  assert.equal(
    rows.bounds.height,
    Math.max(foeRow.y + foeRow.height, homeRow.y + homeRow.height) - Math.min(foeRow.y, homeRow.y) + 16,
  );
  // 页面里两条相对窗口的位置
  assert.deepEqual(arenaPlacement(rows), {
    left: { x: foeRow.x - rows.bounds.x, y: foeRow.y - rows.bounds.y },
    right: { x: homeRow.x - rows.bounds.x, y: homeRow.y - rows.bounds.y },
  });
  // 客人站到自家宠物右边：两条血跟着换边（不是按谁是自家固定左右）
  const swapped = arenaRows({ ...home, left: 100 }, foeWindow, workArea);
  assert.equal(swapped.left.x + swapped.left.width / 2, 100 + home.size / 2);
  // 对手窗口还没开：两条并排放在自家宠物正头顶，不跑到屏幕中间去
  const alone = arenaRows(home, null, workArea);
  assert.ok(
    Math.abs(alone.left.x + alone.left.width / 2 + (ARENA_COLUMN_WIDTH + 16) / 2 - (home.left + home.size / 2)) <= 1,
  );
  assert.ok(
    Math.abs(alone.right.x + alone.right.width / 2 - (ARENA_COLUMN_WIDTH + 16) / 2 - (home.left + home.size / 2)) <= 1,
  );
  assert.ok(Math.abs(alone.left.y + alone.left.height - (homeHead - 2)) <= 1, '并排也在正头顶');
  // 贴边：夹回工作区
  const edge = arenaRows({ ...home, left: -200 }, foeWindow, workArea);
  assert.ok(edge.bounds.x >= workArea.x - 8, `不越出屏幕左沿：${edge.bounds.x}`);
  // 谁都不知道在哪：屏幕上方中间也有两条（等位置到了再摆）
  const blind = arenaRows(null, null, workArea);
  assert.ok(blind.left.width === ARENA_COLUMN_WIDTH && blind.right.width === ARENA_COLUMN_WIDTH);
  assert.ok(blind.bounds.width >= ARENA_COLUMN_WIDTH * 2, `中间留空：${blind.bounds.width}`);
});

test('hpPercent：四舍五入、夹在 0–100，非法值当空血（绝不画成满的）', () => {
  assert.equal(hpPercent(90, 100), 90);
  assert.equal(hpPercent(1, 100), 1);
  assert.equal(hpPercent(0, 100), 0);
  assert.equal(hpPercent(-5, 100), 0);
  assert.equal(hpPercent(150, 100), 100);
  assert.equal(hpPercent(50, 0), 0, '上限 0');
  assert.equal(hpPercent(Number.NaN, 100), 0);
  assert.equal(hpPercent(10, Number.NaN), 0);
});

test('arenaUpdate：把两条血算成百分比再送进页面（页面不重复一套数学）', () => {
  const update = arenaUpdate({ label: '小鱼 · 筑基初期', hp: 124, maxHp: 124 }, { label: '心魔', hp: 31, maxHp: 112 });
  assert.deepEqual(update, {
    left: { label: '小鱼 · 筑基初期', percent: 100 },
    right: { label: '心魔', percent: 28 },
  });
});

test('arenaUpdateCode：数据经 JSON.stringify 成字面量，字符串里的括号引号都当数据', () => {
  const code = arenaUpdateCode(
    arenaUpdate({ label: `'); alert(1); //`, hp: 1, maxHp: 2 }, { label: 'x', hp: 1, maxHp: 2 }),
  );
  assert.ok(code.startsWith('arena.update({'), code);
  // 恶意文本被引号包成字符串字面量，页面里再走 textContent
  assert.ok(code.includes('"label":"\'); alert(1); //"') || code.includes('\\'), '引号被转义');
  assert.equal(code.includes('alert(1); //"),'), false, '不会被截成一段可执行代码');
});

test('arenaPage 页面契约：只用 textContent 与 style.width，没有 innerHTML / 拼接 HTML', () => {
  assert.match(arenaPage, /'use strict';/);
  assert.ok(arenaPage.includes("document.getElementById('l' + i).textContent = String(side.label);"));
  assert.ok(arenaPage.includes('fill.style.width = percent + '));
  // 一条都不能有：把送进来的名字当 HTML 拼
  assert.equal(arenaPage.includes('innerHTML'), false);
  assert.equal(arenaPage.includes('insertAdjacentHTML'), false);
  assert.equal(arenaPage.includes('outerHTML'), false);
  // 页面里没有别的通道（没开 preload、不开 IPC）
  assert.equal(arenaPage.includes('require('), false);
  assert.equal(arenaPage.includes('ipcRenderer'), false);
  // 挂出 window.arena，主进程只调 update / place
  assert.ok(arenaPage.includes('window.arena = {'));
  assert.ok(arenaPage.includes('place(pos)'), '两条血的位置由主进程送进来');
  assert.ok(arenaPage.includes("document.getElementById('row-' + side)"));
  // 两条血一条在左一条在右（右边那条从右边涨）
  assert.match(arenaPage, /\.row\.right\{align-items:flex-end\}/);
  assert.match(arenaPage, /\.row\.right \.fill\{margin-left:auto\}/);
  // 两条是各自贴在自己宠物正头顶的一小段：绝对定位摆，不再一条长血横穿屏幕挡字
  assert.match(arenaPage, /\.row\{position:absolute;left:0;top:0;/);
  assert.ok(arenaPage.includes(`width:${ARENA_COLUMN_WIDTH}px`), '两条血各自的宽度');
  assert.ok(ARENA_COLUMN_WIDTH * 2 < 520, `两条加起来 ${ARENA_COLUMN_WIDTH * 2} 小于最宽窗，中间必须留空`);
  // 位置也是 JSON 字面量送进来
  assert.ok(arenaPlaceCode({ left: { x: 1, y: 2 }, right: { x: 3, y: 4 } }).startsWith('arena.place({'));
  // 血少于两成变红
  assert.match(arenaPage, /\.fill\.low\{/);
  assert.ok(arenaPage.includes('percent < 20'));
});

/** 假窗口：记录构造参数与调用 */
function fakeElectron() {
  const created: Record<string, unknown>[] = [];
  const executed: string[] = [];
  const bounds: Rect[] = [];
  const shown: number[] = [];
  const hidden: number[] = [];
  let destroyed = false;
  const win: WindowLike = {
    isDestroyed: () => destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    setBounds: (rect) => void bounds.push(rect),
    setIgnoreMouseEvents: (ignore) => void created.push({ ignoreMouseEvents: ignore }),
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: () => Promise.resolve(),
    showInactive: () => void shown.push(1),
    show: () => undefined,
    hide: () => void hidden.push(1),
    focus: () => undefined,
    once: () => undefined,
    destroy: () => {
      destroyed = true;
    },
    webContents: {
      getURL: () => '',
      executeJavaScript: (code) => {
        executed.push(code);
        return Promise.resolve(undefined);
      },
    },
  };
  return {
    electron: {
      BrowserWindow: function FakeBrowserWindow(options: Record<string, unknown>) {
        created.push(options);
        return win;
      },
      screen: {
        getCursorScreenPoint: () => ({ x: 100, y: 100 }),
        getDisplayNearestPoint: () => ({ workArea }),
      },
    } as unknown as WindowElectron,
    created,
    executed,
    bounds,
    shown,
    hidden,
    get destroyed() {
      return destroyed;
    },
  };
}

test('openArenaWindow：透明 / 置顶 / 不可聚焦 / 整窗穿透，加载前的调用排队补发', async () => {
  const fake = fakeElectron();
  const arena = openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => home,
    () => foeWindow,
  );
  const options = fake.created[0];
  assert.equal(options.transparent, true);
  assert.equal(options.alwaysOnTop, true);
  assert.equal(options.focusable, false);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.frame, false);
  assert.equal(options.show, false, '加载完再 showInactive，不抢焦点');
  assert.equal((options.webPreferences as Record<string, unknown>).sandbox, true);
  assert.equal((options.webPreferences as Record<string, unknown>).nodeIntegration, false);
  assert.equal((options.webPreferences as Record<string, unknown>).backgroundThrottling, false);
  // 初位置就是两条血的并集（只包住两小段，不是 520 宽的整条）
  const opening = arenaRows(home, foeWindow, workArea).bounds;
  assert.equal(options.x, opening.x);
  assert.equal(options.y, opening.y);
  assert.equal(options.width, opening.width);
  assert.equal(options.height, opening.height);
  assert.ok(options.width > ARENA_COLUMN_WIDTH * 2, '窗口横跨两只宠物的头顶（中间透）');
  // 整窗鼠标穿透（没有 hover 检查去解禁它）
  assert.ok(fake.created.some((entry) => entry.ignoreMouseEvents === true));

  // 还没 ready：place / update 排队，加载完按顺序补上
  arena.update(arenaUpdate({ label: '小鱼', hp: 10, maxHp: 10 }, { label: '心魔', hp: 0, maxHp: 10 }));
  assert.equal(fake.executed.length, 0);
  await new Promise((done) => setImmediate(done));
  assert.equal(fake.executed.length, 2);
  assert.match(fake.executed[0], /^arena\.place\(\{/);
  assert.match(fake.executed[1], /^arena\.update\(\{.*"percent":100/);
  assert.equal(fake.executed[1].includes('innerHTML'), false);
});

test('X26 血条：默认加载完才显示，旧调用方（历练）行为不变', async () => {
  const fake = fakeElectron();
  openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => home,
    () => foeWindow,
  );
  assert.equal(fake.shown.length, 0, '加载前不亮');
  await new Promise((done) => setImmediate(done));
  assert.equal(fake.shown.length, 1, '加载完显示一次');
});

test('X26 血条：initiallyVisible:false 加载完也不亮，正式开演的 setVisible(true) 才显示', async () => {
  const fake = fakeElectron();
  const arena = openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => home,
    () => foeWindow,
    { initiallyVisible: false },
  );
  await new Promise((done) => setImmediate(done));
  assert.equal(fake.shown.length, 0, '选出招方式时没有血条');
  arena.setVisible(true);
  assert.equal(fake.shown.length, 1);
  arena.setVisible(false);
  assert.equal(fake.hidden.length, 1);
  arena.setVisible(true);
  assert.equal(fake.shown.length, 2, '收起后还能再亮');
});

test('X26 血条：load 前调 setVisible 只记目标状态，加载完按目标显示、不抢先闪现', async () => {
  const fake = fakeElectron();
  const arena = openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => home,
    () => foeWindow,
    { initiallyVisible: false },
  );
  arena.setVisible(true);
  assert.equal(fake.shown.length, 0, 'load 之前绝不显示');
  arena.setVisible(false);
  assert.equal(fake.hidden.length, 0, 'load 前不调用 hide，只记状态');
  arena.setVisible(true);
  await new Promise((done) => setImmediate(done));
  assert.equal(fake.shown.length, 1, '加载完按最后一次目标状态显示');
});

test('血条让位：加载完把宠物 / 对手窗口提到前面，别的窗口不动', async () => {
  const fake = fakeElectron();
  const moved: string[] = [];
  const other = (url: string): WindowLike => ({
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    setBounds: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    setAlwaysOnTop: () => undefined,
    moveTop: () => void moved.push(url),
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: () => Promise.resolve(),
    showInactive: () => undefined,
    show: () => undefined,
    focus: () => undefined,
    once: () => undefined,
    destroy: () => undefined,
    webContents: { getURL: () => url, executeJavaScript: () => Promise.resolve(undefined) },
  });
  const pets = [
    'file:///helper/index.html?configUrl=file%3A%2F%2Fx&petIndex=0',
    'http://127.0.0.1:1/app/guest',
    'http://127.0.0.1:1/app/foe',
  ];
  const bystanders = ['http://127.0.0.1:1/app/panel', 'http://127.0.0.1:1/app/adventure'];
  const windows = [...pets, ...bystanders].map(other);
  (fake.electron.BrowserWindow as unknown as { getAllWindows: () => WindowLike[] }).getAllWindows = () => windows;
  openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => home,
    () => foeWindow,
  );
  assert.deepEqual(moved, [], '还没加载完不动');
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(moved, pets, '气泡能压住血条；面板 / 历练窗不动（血条盖在它们上面照旧看得见）');
});

test('place：宠物挪了跟着挪，位置没变一个字都不发', async () => {
  const fake = fakeElectron();
  const arena = openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => home,
    () => foeWindow,
  );
  await new Promise((done) => setImmediate(done));
  const executed = fake.executed.length;
  arena.place(home, foeWindow);
  assert.equal(fake.bounds.length, 0, '没变就不挪窗口');
  assert.equal(fake.executed.length, executed, '没变就不重发两条血的位置');
  arena.place({ ...home, left: 200 }, foeWindow);
  assert.equal(fake.bounds.length, 1);
  assert.deepEqual(fake.bounds[0], arenaRows({ ...home, left: 200 }, foeWindow, workArea).bounds, '窗口跟着两条血');
  assert.ok(fake.executed.length > executed, '两条血的新位置送进页面');
  assert.match(fake.executed[fake.executed.length - 1] ?? '', /^arena\.place\(\{/);
  // bounds() 仍是面板锚点（整场不动的那种，不是血条窗的实时包围盒）
  assert.deepEqual(arena.bounds(), arenaBounds({ ...home, left: 200 }, foeWindow, workArea));
});

test('close(afterMs)：先让结果那几步放完，到点才销毁窗口', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const fake = fakeElectron();
  const arena = openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => null,
    () => null,
  );
  arena.close(3_000);
  t.mock.timers.tick(2_999);
  assert.equal(fake.destroyed, false, '还没到点');
  t.mock.timers.tick(1);
  assert.equal(fake.destroyed, true);
});

test('pin（X16 冲刺）：钉住时按开场站位摆，不跟着两只的实时位置走；放开后照旧', () => {
  const fake = fakeElectron();
  const arena = openArenaWindow(
    fake.electron,
    'http://127.0.0.1:1/app/arena',
    () => home,
    () => foeWindow,
  );
  const opening = arena.bounds();
  arena.pin(true);
  arena.place({ ...home, left: 200 }, { ...foeWindow, x: 100 });
  assert.deepEqual(arena.bounds(), opening, '钉住时一步都不挪');
  assert.equal(fake.bounds.length, 0);
  arena.pin(false);
  arena.place({ ...home, left: 200 }, { ...foeWindow, x: 100 });
  assert.equal(fake.bounds.length, 1, '放开后恢复跟随');
});
