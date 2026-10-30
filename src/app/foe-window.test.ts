import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { foeActionClass, foePage, openFoeWindow } from './foe-window.ts';
import type { WindowElectron, WindowLike } from './visit-windows.ts';

const workArea = { x: 0, y: 25, width: 1440, height: 1200 };
const home = { left: 1000, top: 400, size: 500, bottomPad: (500 * 9) / 16 / 12 };

test('对手的 CSS 兜底动作：出手往前扑、受击抖闪红、闪避侧移、倒地倾倒、起手/胜利跳一下', () => {
  assert.equal(foeActionClass('对手-野狗-出手'), 'lunge');
  assert.equal(foeActionClass('对手-白凝冰-绝招'), 'lunge');
  assert.equal(foeActionClass('对手-白凝冰-受击'), 'hit');
  assert.equal(foeActionClass('对手-白凝冰-闪避'), 'dodge');
  assert.equal(foeActionClass('对手-白凝冰-倒地'), 'fall');
  assert.equal(foeActionClass('对手-白凝冰-起手'), 'jump');
  assert.equal(foeActionClass('对手-白凝冰-胜利'), 'jump');
  // 没见过的动作按出手演，不报错
  assert.equal(foeActionClass('对手-白凝冰'), 'lunge');
});

test('CSS 兜底动作是自包含的：toString 内联进 foe 页面后没有模块作用域可依赖', () => {
  // 页面里只有标准内建对象（没有本模块的任何常量）：函数体引用了外面就会 ReferenceError
  const sandbox = {};
  const inPage = runInNewContext(`(${foeActionClass.toString()})`, sandbox) as (action: string) => string;
  assert.equal(inPage('对手-野狗-倒地'), 'fall');
  assert.equal(inPage('对手-野狗-受击'), 'hit');
});

test('foePage：名字只走 textContent，数据经 JSON 字面量；视频失败退回 CSS，倒地停在最后一帧淡到 30%', () => {
  assert.equal(foePage.includes('innerHTML'), false, '页面里不拼 HTML');
  assert.ok(foePage.includes("document.getElementById('tag').textContent = String(data.name ?? '');"));
  assert.ok(foePage.includes('const actionClass = '), '兜底动作函数原样嵌进页面');
  assert.ok(foePage.includes("video.src = cached[full] || ANIM + encodeURIComponent(full) + '.webm';"));
  // 视频加载失败 / play 被拒：页面自己退回 CSS，不报错
  assert.ok(foePage.includes("video.addEventListener('error'"));
  assert.ok(foePage.includes('if (gen === token) fallback(current);'));
  assert.ok(foePage.includes('media.classList.add(kind);'));
  // 倒地（群架）：素材结尾会再站起来，所以播到一半就停住、淡到 30% 躺在环上，不只剩一块名牌
  assert.ok(foePage.includes("if (actionClass(current) === 'fall')"));
  assert.ok(foePage.includes("video.addEventListener('timeupdate'"));
  assert.ok(foePage.includes("stage.classList.add('out');"));
  assert.ok(foePage.includes('#stage.out{opacity:.3}'));
  assert.ok(foePage.includes('holdDown = data.holdDown === true'));
  // 1v1 照老样子：播完停一会儿再淡出
  assert.ok(foePage.includes("fadeTimer = setTimeout(() => stage.classList.add('gone'), 400);"));
  // 立绘缺了：剪影色块兜底，名字照旧由名牌显示
  assert.ok(foePage.includes("portrait.addEventListener('error'"));
  assert.ok(foePage.includes("media.classList.add('silhouette')"));
  // 群架影子没有立绘：给待机动画时没在演动作就循环播它，播完也回到待机
  assert.ok(foePage.includes('function showIdle()'));
  assert.ok(foePage.includes('idleName = String(data.idle'));
  // 剪影只是兜底：有立绘 / 视频画面时撤掉，别留在背后当一块色块
  assert.ok(foePage.includes('hasPortrait = Boolean(data.portrait)'));
  assert.ok(foePage.includes("if (!hasPortrait) media.classList.add('silhouette')"));
  // 精英金边、换色滤镜都走 CSS filter
  assert.ok(foePage.includes('drop-shadow(0 0 5px #f5c542)'));
  assert.ok(foePage.includes("media.style.setProperty('--tint'"));
  // 客串说完淡出（Y5）
  assert.ok(foePage.includes('fade() {'));
  assert.ok(foePage.includes("stage.classList.add('gone');"));
});

/** 假对手窗口：记录构造参数与 executeJavaScript 的调用 */
function fakeWindows() {
  const created: Record<string, unknown>[] = [];
  const executed: string[] = [];
  const ignored: boolean[] = [];
  const boundsCalls: Array<{ x: number; y: number; width: number; height: number }> = [];
  let destroyed = false;
  const win: WindowLike = {
    isDestroyed: () => destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    setBounds: (rect) => void boundsCalls.push(rect),
    setIgnoreMouseEvents: (value) => void ignored.push(value),
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: () => Promise.resolve(),
    showInactive: () => undefined,
    show: () => undefined,
    focus: () => undefined,
    once: () => undefined,
    destroy: () => {
      destroyed = true;
    },
    webContents: {
      getURL: () => '',
      executeJavaScript: (code) => {
        executed.push(code);
        return Promise.resolve(0);
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
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ workArea }),
      },
    } as unknown as WindowElectron,
    created,
    executed,
    ignored,
    boundsCalls,
    get destroyed() {
      return destroyed;
    },
  };
}

test('openFoeWindow：等大贴身（可放大）、鼠标穿透、不抢焦点；名字/立绘/前缀/滤镜经 JSON 字面量进页面', async () => {
  const fake = fakeWindows();
  const foe = openFoeWindow(
    fake.electron,
    'http://127.0.0.1:1/app/foe',
    {
      name: '白凝冰"); alert(1); ("',
      portrait: '/dsh-pet-7340/pic/adventure/三王传承/对手-白凝冰.png',
      prefix: '对手-白凝冰',
      filter: 'hue-rotate(-25deg) saturate(1.7)',
      scale: 1.2,
      elite: true,
      idle: '待机呼吸休闲',
      holdDown: true,
    },
    () => home,
  );
  await new Promise((done) => setImmediate(done));
  assert.equal(fake.created[0].focusable, false);
  assert.equal(fake.created[0].transparent, true);
  assert.deepEqual(fake.ignored, [true], '整窗鼠标穿透');
  // 1.2 倍：窗口宽 = 500 × 1.2
  assert.equal(foe.bounds().width, 600);
  const setup = fake.executed.find((code) => code.startsWith('foe.setup('));
  assert.ok(setup, fake.executed.join('\n'));
  const payload = JSON.parse(setup.slice('foe.setup('.length, -1)) as Record<string, unknown>;
  assert.equal(payload.name, '白凝冰"); alert(1); ("');
  assert.equal(payload.prefix, '对手-白凝冰');
  assert.equal(payload.filter, 'hue-rotate(-25deg) saturate(1.7)');
  assert.equal(payload.elite, true);
  assert.equal(payload.idle, '待机呼吸休闲');
  assert.equal(payload.holdDown, true);
  assert.equal(payload.portrait, '/dsh-pet-7340/pic/adventure/三王传承/对手-白凝冰.png');
  // play / say / preload 也一律 JSON 字面量
  foe.play('对手-白凝冰-绝招', 2.5);
  foe.say('你演够了吗？');
  foe.preload(['对手-白凝冰-出手', '对手-白凝冰-受击']);
  foe.fade();
  assert.ok(fake.executed.includes('foe.play("对手-白凝冰-绝招", 2.5)'));
  assert.ok(fake.executed.includes('foe.say("你演够了吗？", 10000)'));
  assert.ok(fake.executed.includes('foe.preload(["对手-白凝冰-出手","对手-白凝冰-受击"])'));
  assert.ok(fake.executed.includes('foe.fade()'));
  foe.close(0);
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(fake.destroyed, true);
});

test('openFoeWindow 冲刺（X16）：pin 停住跟随、moveTo 按帧挪窗口', async () => {
  const fake = fakeWindows();
  let box = { ...home };
  const foe = openFoeWindow(
    fake.electron,
    'http://127.0.0.1:1/app/foe',
    { name: '白凝冰', portrait: '/x.png', prefix: '对手-白凝冰' },
    () => box,
  );
  await new Promise((done) => setImmediate(done));
  const before = fake.boundsCalls.length;
  foe.pin(true);
  box = { ...box, left: box.left + 200 };
  await new Promise((done) => setTimeout(done, 140));
  assert.equal(fake.boundsCalls.length, before, '钉住时跟随不动窗口');
  const now = foe.bounds();
  foe.moveTo({ ...now, x: now.x - 123 });
  assert.equal(foe.bounds().x, now.x - 123, 'moveTo 立刻改窗口位置');
  assert.equal(fake.boundsCalls[fake.boundsCalls.length - 1]?.x, now.x - 123);
  foe.close(0);
});
