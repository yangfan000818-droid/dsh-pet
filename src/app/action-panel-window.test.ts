/**
 * 出招面板（X17）的窗口单测：位置、送进页面的 JSON、三种方式的按钮与超时。
 * 不真开 Electron 窗口：假 BrowserWindow 记下 executeJavaScript 的代码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_HEIGHT,
  PANEL_MAX_HEIGHT,
  openActionPanel,
  panelBounds,
  panelHeight,
  panelPage,
} from './action-panel-window.ts';
import type { PanelView } from './action-panel-window.ts';
import type { Rect, WindowElectron, WindowLike } from './visit-windows.ts';

function fakeWindow(): WindowLike & { calls: string[]; destroyed: boolean; hidden: boolean } {
  const win = {
    calls: [] as string[],
    destroyed: false,
    hidden: false,
    isDestroyed: () => win.destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    setBounds: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: () => Promise.resolve(),
    showInactive: () => {
      win.hidden = false;
    },
    show: () => undefined,
    focus: () => undefined,
    hide: () => {
      win.hidden = true;
    },
    once: () => undefined,
    destroy: () => {
      win.destroyed = true;
    },
    webContents: {
      getURL: () => 'http://127.0.0.1:1/app/panel',
      executeJavaScript: (code: string) => {
        win.calls.push(code);
        return Promise.resolve(undefined);
      },
    },
  };
  return win;
}

function fakeElectron(win: WindowLike, created: Record<string, unknown>[] = []): WindowElectron {
  return {
    BrowserWindow: Object.assign(
      function (options: Record<string, unknown>) {
        created.push(options);
        return win;
      },
      { getAllWindows: () => [] },
    ) as unknown as WindowElectron['BrowserWindow'],
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    ipcMain: { on: () => undefined, removeListener: () => undefined },
  };
}

const arena: Rect = { x: 100, y: 200, width: 300, height: 62 };

test('X17 出招面板：挂在擂台下面，下面放不下就夹在工作区里', () => {
  assert.deepEqual(panelBounds(arena, { x: 0, y: 0, width: 1440, height: 900 }), {
    x: 100,
    y: 266,
    width: 300,
    height: PANEL_HEIGHT,
  });
  // 擂台贴着屏幕底：面板被夹在工作区底边，不飞出去
  const bottom = panelBounds({ x: 100, y: 830, width: 300, height: 62 }, { x: 0, y: 0, width: 1440, height: 900 });
  assert.equal(bottom.y, 900 - PANEL_HEIGHT);
  // 没有擂台：工作区上方居中
  const alone = panelBounds(null, { x: 0, y: 0, width: 1440, height: 900 });
  assert.equal(alone.width, 320);
  assert.equal(alone.x, (1440 - 320) / 2);
});

test('X17 出招面板：高度跟着按钮数走——三选一一行，21 招分组全露出来，再多才在窗内滚动', () => {
  const tones: Record<string, NonNullable<PanelView['options'][number]['tone']>> = {
    毽子: 'damage',
    扑克牌: 'damage',
    水枪: 'damage',
    雪球: 'control',
    三球: 'damage',
    鲸尾: 'damage',
    烟花: 'damage',
    鸡毛掸子: 'control',
    银托盘: 'damage',
    陀螺: 'control',
    弹弓: 'damage',
    空手: 'damage',
    凭空生花: 'sustain',
    狮子吼: 'control',
    蓝鲸现世: 'damage',
    鲸歌: 'control',
    墨汁喷射: 'control',
    鲸吞: 'sustain',
    万我: 'sustain',
    魂牵梦绕: 'control',
    五指拳心剑: 'damage',
  };
  const view = (labels: string[]): PanelView => ({
    kind: 'action',
    title: '轮到你了，出一手',
    seconds: 20,
    options: labels.map((label, index) => ({
      pick: index + 1,
      label,
      ...(tones[label] ? { tone: tones[label] } : {}),
    })),
  });
  assert.equal(panelHeight(null, 519), PANEL_HEIGHT);
  assert.equal(panelHeight({ ...view(['自动', 'AI 出招', '手动']), kind: 'mode' }, 324), PANEL_HEIGHT);
  // 519 宽三列：伤害 11 项四行、控制 7 项三行、回复 3 项一行，另加三个组标题。
  const many = [
    '毽子',
    '扑克牌',
    '水枪',
    '雪球',
    '三球',
    '鲸尾',
    '烟花',
    '鸡毛掸子',
    '银托盘',
    '陀螺',
    '弹弓',
    '空手',
    '凭空生花',
    '狮子吼',
    '蓝鲸现世',
    '鲸歌',
    '墨汁喷射',
    '鲸吞',
    '万我',
    '魂牵梦绕',
    '五指拳心剑',
  ];
  const tall = panelHeight(view(many), 519);
  assert.equal(tall, 411, '21 招和三个组标题完整落在上限内');
  assert.ok(tall < PANEL_MAX_HEIGHT);
  // 窄一点就得更多行
  assert.ok(panelHeight(view(many), 324) > tall);
  // 再多也不超过上限（剩下的在窗内滚动）
  assert.equal(panelHeight(view([...many, ...many, ...many, ...many]), 324), PANEL_MAX_HEIGHT);
});

test('X17 出招面板：挂在擂台下面会压到宠物时，挪到两只宠物下面；那里也放不下就放擂台上面', () => {
  const work = { x: 0, y: 33, width: 1470, height: 923 };
  // 宠物在屏幕顶上（真机：擂台也只能贴顶，面板正好盖住两只）
  const top = { x: 12, y: 33, width: 519, height: 62 };
  const pets = [
    { x: 120, y: 80, width: 300, height: 300 },
    { x: 330, y: 60, width: 150, height: 200 },
  ];
  const moved = panelBounds(top, work, 150, pets);
  assert.equal(moved.y, 380 + 4, '放到两只宠物的下沿下面');
  assert.equal(moved.height, 150);
  // 不压宠物时照旧挂在擂台下面
  assert.equal(panelBounds(top, work, 150, [{ x: 900, y: 500, width: 100, height: 100 }]).y, 33 + 62 + 4);
  // 宠物在屏幕底：下面放不下，擂台在宠物上方 → 放擂台上面
  const low = { x: 12, y: 600, width: 519, height: 62 };
  const lowPets = [{ x: 120, y: 660, width: 300, height: 290 }];
  assert.equal(panelBounds(low, work, 150, lowPets).y, 600 - 4 - 150);
});

test('X17 出招面板：亮出来以后按页面量到的实际高度校正窗口（字号以页面为准，估算只当初值）', async () => {
  const win = fakeWindow();
  const sizes: Rect[] = [];
  win.setBounds = (rect: Rect) => void sizes.push(rect);
  win.webContents.executeJavaScript = (code: string) => {
    win.calls.push(code);
    return Promise.resolve(code.startsWith('panel.contentHeight(') ? 151.4 : undefined);
  };
  const panel = openActionPanel(
    fakeElectron(win),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => ({ left: 100, top: 300, size: 200, bottomPad: 20 }),
  );
  const picking = panel.chooseAction(
    ['毽子', '扑克牌', '水枪'].map((label) => ({ label })),
    1_000,
  );
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
  assert.ok(win.calls.includes(`panel.contentHeight(${arena.width})`), '亮出来以后按面板的宽度量了一次');
  assert.equal(sizes[sizes.length - 1]?.height, 152, '按量到的高度（向上取整）校正');
  assert.equal(panel.choose(1), true);
  assert.equal(await picking, 0);
  panel.close();
});

test('X17 出招面板：不拿焦点但点第一下就算数（macOS 上没有 acceptFirstMouse 按钮点不上）', () => {
  const win = fakeWindow();
  const created: Record<string, unknown>[] = [];
  const panel = openActionPanel(
    fakeElectron(win, created),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => ({ left: 100, top: 300, size: 200, bottomPad: 20 }),
  );
  assert.equal(created[0].focusable, false);
  assert.equal(created[0].acceptFirstMouse, true);
  panel.close();
});

test('X17 出招面板：三选一送成 JSON 字面量，模型没配好时 AI 灰掉，点了回方式', async () => {
  const win = fakeWindow();
  const panel = openActionPanel(
    fakeElectron(win),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => ({ left: 100, top: 300, size: 200, bottomPad: 20 }),
  );
  const deciding = panel.chooseMode(false, 1_000);
  // loadURL 是异步的：等它 resolve 后 queued 的 panel.show 才执行
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(panel.state()?.kind, 'mode');
  const shown = win.calls.find((code) => code.startsWith('panel.show('))!;
  assert.match(shown, /^panel\.show\(\{"kind":"mode"/);
  assert.match(shown, /"disabled":true/);
  assert.equal(panel.choose(2), false, 'AI 灰掉：点不上');
  assert.equal(panel.choose(1), true, '自动可选');
  assert.equal(await deciding, 'auto');
  assert.equal(panel.state(), null);
  assert.equal(win.hidden, true, '选完面板收起');
  panel.close();
  assert.ok(win.destroyed);
});

test('X17 出招面板：应战确认多一个「不应战」，选它回 null；4 项排两行', async () => {
  const win = fakeWindow();
  const panel = openActionPanel(
    fakeElectron(win),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => ({ left: 100, top: 300, size: 200, bottomPad: 20 }),
  );
  const deciding = panel.chooseMode(true, 1_000, {
    title: '阿花 想跟你切磋：怎么出招？',
    declineLabel: '不应战',
  });
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(panel.state()?.title, '阿花 想跟你切磋：怎么出招？');
  assert.deepEqual(
    panel.state()?.options.map((option) => option.label),
    ['自动', 'AI 出招', '手动', '不应战'],
  );
  assert.ok(panelHeight(panel.state(), 324) > PANEL_HEIGHT, '4 项要两行');
  assert.equal(panel.choose(4), true);
  assert.equal(await deciding, null, '点了不应战，按没应战收');
  panel.close();
});

test('X17 出招面板：两项纯确认回 pick（从 1 数），超时回 null', async () => {
  const win = fakeWindow();
  const panel = openActionPanel(
    fakeElectron(win),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => ({ left: 100, top: 300, size: 200, bottomPad: 20 }),
  );
  const deciding = panel.choosePrompt('阿花 想跟你切磋，要应战吗？', ['应战', '不应战'], 1_000);
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(
    panel.state()?.options.map((option) => option.label),
    ['应战', '不应战'],
  );
  assert.equal(panel.choose(2), true);
  assert.equal(await deciding, 2);
  panel.close();
});

test('X17 出招面板：手动出招的按钮带剩余次数，点了回 0 起的下标；超时回 null', async () => {
  const win = fakeWindow();
  const panel = openActionPanel(
    fakeElectron(win),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => null,
  );
  const deciding = panel.chooseAction([{ label: '水枪' }, { label: '陀螺', note: '剩 2 次' }], 1_000);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(panel.state()?.kind, 'action');
  assert.deepEqual(panel.state()?.options[1], { pick: 2, label: '陀螺', note: '剩 2 次' });
  assert.equal(panel.choose(2), true);
  assert.equal(await deciding, 1, 'pick 2 → 下标 1');
  // 超时：回 null（外层按后备挑法出）
  assert.equal(await panel.chooseAction([{ label: '空手' }], 20), null);
  assert.equal(panel.state(), null);
  panel.close();
});

test('X17 出招面板：按伤害、控制、回复稳定分组，原始 pick 不随展示顺序改变', async () => {
  const win = fakeWindow();
  const panel = openActionPanel(
    fakeElectron(win),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => null,
  );
  const deciding = panel.chooseAction(
    [
      { label: '凭空生花', effect: '回复气血', tone: 'sustain' },
      { label: '水枪', effect: '伤害 6–10，远程', tone: 'damage' },
      { label: '狮子吼', effect: '可能震晕', tone: 'control' },
      { label: '蓝鲸现世', effect: '大伤害', tone: 'damage' },
    ],
    1_000,
  );
  assert.deepEqual(
    panel.state()?.options.map(({ pick, label }) => ({ pick, label })),
    [
      { pick: 2, label: '水枪' },
      { pick: 4, label: '蓝鲸现世' },
      { pick: 3, label: '狮子吼' },
      { pick: 1, label: '凭空生花' },
    ],
  );
  assert.equal(panel.choose(4), true);
  assert.equal(await deciding, 3, '展示位置变了，仍回原始动作下标');
  panel.close();
});

test('X26 出招面板：技能说明自然换行，不用省略号藏效果；卡片按内容撑高', () => {
  const effect = panelPage.match(/\.action \.effect\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(effect.includes('white-space:normal'), '说明允许换行');
  assert.equal(effect.includes('nowrap'), false, '不再强制单行');
  assert.equal(effect.includes('ellipsis'), false, '不再用省略号藏效果');
  assert.equal(effect.includes('overflow:hidden'), false, '说明不被裁掉');
  assert.ok(effect.includes('overflow-wrap:anywhere'), '长英文 id 也能断行');
  // 卡片只留最小高度：长说明把它撑高，同一行由 grid 拉伸对齐
  const card = panelPage.match(/button\.action\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(card.includes('min-height:34px'), '34px 只是下限');
  assert.equal(/(^|;)height:34px/.test(card.replace(/\s/g, '')), false, '不再固定 34px 高');
  assert.match(panelPage, /\.action \.label\{[^}]*white-space:nowrap/, '名称仍保持单行');
  // 超过最大高度才在窗内滚动
  assert.match(panelPage, /#buttons\{[^}]*overflow-y:auto/);
});

test('X26 出招面板：长说明按页面实测高度撑开，超过 420 才夹到最大高度滚动', async () => {
  const win = fakeWindow();
  const sizes: Rect[] = [];
  win.setBounds = (rect: Rect) => void sizes.push(rect);
  win.webContents.executeJavaScript = (code: string) => {
    win.calls.push(code);
    // 模拟一行长说明被折成很多行：页面量回来的高度远大于 34px × 卡片数
    return Promise.resolve(code.startsWith('panel.contentHeight(') ? 260.2 : undefined);
  };
  const panel = openActionPanel(
    fakeElectron(win),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => null,
  );
  void panel.chooseAction(
    [{ label: '狮子吼', effect: '一声吼出，声浪扫过全场，可能震晕，且后续两回合伤害提高。' }],
    1_000,
  );
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(sizes[sizes.length - 1]?.height, 261, '按实测高度校正，不按固定 34px 估算裁掉底部');
  panel.close();

  const clamped = fakeWindow();
  const clampedSizes: Rect[] = [];
  clamped.setBounds = (rect: Rect) => void clampedSizes.push(rect);
  clamped.webContents.executeJavaScript = (code: string) => {
    clamped.calls.push(code);
    return Promise.resolve(code.startsWith('panel.contentHeight(') ? 900 : undefined);
  };
  const tall = openActionPanel(
    fakeElectron(clamped),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => null,
  );
  void tall.chooseAction([{ label: '狮子吼', effect: '很长很长的说明' }], 1_000);
  await new Promise((done) => setTimeout(done, 0));
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(clampedSizes[clampedSizes.length - 1]?.height, PANEL_MAX_HEIGHT, '再高也夹在 420，剩下的窗内滚动');
  tall.close();
});

test('X26 出招面板：chooseAction 可传标题（对象或字符串），旧调用仍用默认标题', async () => {
  const win = fakeWindow();
  const panel = openActionPanel(
    fakeElectron(win),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => null,
  );
  void panel.chooseAction([{ label: '水枪' }], 1_000, { title: '主动技剩 2 次' });
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(panel.state()?.title, '主动技剩 2 次');
  panel.close();

  const direct = fakeWindow();
  const directPanel = openActionPanel(
    fakeElectron(direct),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => null,
  );
  void directPanel.chooseAction([{ label: '水枪' }], 1_000, '主动技剩 1 次');
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(directPanel.state()?.title, '主动技剩 1 次');
  directPanel.close();

  const legacy = fakeWindow();
  const legacyPanel = openActionPanel(
    fakeElectron(legacy),
    'http://127.0.0.1:1/app/panel',
    () => arena,
    () => null,
  );
  void legacyPanel.chooseAction([{ label: '水枪' }], 1_000);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(legacyPanel.state()?.title, '轮到你了，出一手', '不传第三参保持旧标题');
  legacyPanel.close();
});
