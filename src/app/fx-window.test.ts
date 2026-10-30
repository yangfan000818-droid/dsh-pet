/**
 * 特效窗口的单测（X7）：两只的舞台换算、窗口位置、每一发的几何（起点 / 终点 / 镜像 / 大小，
 * 闪避掠过、泡泡挡下、天雷），页面脚本自包含且朝向对，窗口的显示属性与「没开成只警告一次」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import type { Shot } from './battle-show.ts';
import { shadowPixels } from './visit-windows.ts';
import {
  bodyPoint,
  feetPoint,
  foeStage,
  fxBounds,
  fxPage,
  fxSpec,
  handPoint,
  homeStage,
  openFxWindow,
  SHADOW_MATRIX,
  type FxElectron,
  type FxSpec,
  type FxWindowLike,
  type Stage,
} from './fx-window.ts';

/** 640 宽的舞台：舞台坐标和屏幕像素 1:1，好核 */
const self = homeStage({ left: 100, top: 280, size: 640, bottomPad: 20 }, 'right');
const foe = foeStage({ x: 800, y: 200, width: 640, height: 460 }, 'left');
const stages: [Stage, Stage] = [self, foe];
const everywhere = { x: 0, y: 0, width: 4000, height: 2000 };
const shot = (over: Partial<Shot> = {}): Shot => ({
  kind: '拳风',
  track: 'line',
  flightMs: 380,
  count: 1,
  gapMs: 0,
  hitFx: '命中-星',
  hand: [180, 222],
  ...over,
});

test('homeStage / foeStage：自家舞台顶 = 包围盒顶 + 脚底垫高；对手画布贴窗口底，高 = 宽 × 9/16', () => {
  assert.deepEqual(self, { x: 100, y: 300, width: 640, height: 360, facing: 'right' });
  assert.deepEqual(foe, { x: 800, y: 300, width: 640, height: 360, facing: 'left' });
  // 小一号的客人窗口：舞台跟着缩
  assert.deepEqual(foeStage({ x: 0, y: 0, width: 320, height: 300 }, 'left'), {
    x: 0,
    y: 120,
    width: 320,
    height: 180,
    facing: 'left',
  });
});

test('handPoint / bodyPoint / feetPoint：舞台坐标按画布缩放，朝右时 x 镜像', () => {
  assert.deepEqual(handPoint(self, [180, 222]), [100 + 460, 300 + 222], '自家朝右：手的 x 按舞台镜像');
  assert.deepEqual(handPoint(foe, [180, 222]), [800 + 180, 300 + 222], '对手朝左：素材原样');
  assert.deepEqual(bodyPoint(foe), [800 + 319, 300 + 197], '站姿包围盒 x 212–426、y 62–332 的中心');
  assert.equal(feetPoint(foe), 300 + 330);
  const half = foeStage({ x: 0, y: 0, width: 320, height: 180 }, 'left');
  assert.deepEqual(handPoint(half, [180, 222]), [90, 111], '舞台缩一半，手的位置跟着缩');
});

test('fxBounds：两只舞台的并集，上方让出 3/4 个舞台高、左右各让 24，夹进工作区；只有一只按那一只排', () => {
  assert.deepEqual(fxBounds(self, foe, everywhere), { x: 76, y: 30, width: 1388, height: 654 });
  const tight = fxBounds(self, foe, { x: 0, y: 25, width: 1440, height: 900 });
  assert.ok(tight && tight.x >= 0 && tight.y >= 25, `夹进工作区：${JSON.stringify(tight)}`);
  assert.deepEqual(fxBounds(self, null, everywhere), { x: 76, y: 30, width: 688, height: 654 }, '渡劫只有自家');
  assert.equal(fxBounds(null, null, everywhere), null, '谁都不知道在哪：这一场不放特效');
});

test('fxSpec 静止贴图（X24）：白袍铺在自己身上、门立在两只中间、符纹贴在对方身上', () => {
  const robe = fxSpec(shot({ kind: '逆流袍', hold: { ms: 2_600, anchor: 'self' } }), 0, stages, everywhere) as FxSpec;
  assert.deepEqual(robe.from, robe.to, '不飞：起点就是终点');
  assert.deepEqual(robe.from, [421, 497], '自家身体中心（朝右时 x 镜像）');
  assert.equal(robe.size, Math.round(0.72 * 360));
  assert.deepEqual(robe.hold, { ms: 2_600, shake: 0, spin: 0, squash: 1 });
  assert.equal(robe.hitSize, 0, '静止贴图不画命中特效');

  // X25：俯视符阵要竖向压扁、往下挪到地上，才不会立成一堵圆墙
  const field = fxSpec(
    shot({ kind: '深渊符阵', hold: { ms: 5_000, anchor: 'mid', dy: 0.3, squash: 0.36 } }),
    0,
    stages,
    everywhere,
  ) as FxSpec;
  assert.equal(field.hold?.squash, 0.36);
  assert.equal(field.from[1], 497 + Math.round(0.3 * 360), 'dy 按舞台高往下挪');

  const door = fxSpec(
    shot({ kind: '门', hold: { ms: 2_200, anchor: 'mid', shake: 3 } }),
    0,
    stages,
    everywhere,
  ) as FxSpec;
  assert.deepEqual(door.from, [770, 497], '门立在两只身体中心的中点');
  assert.equal(door.hold?.shake, 3, '跟着敲门声抖');

  const talisman = fxSpec(
    shot({ kind: '符画', hold: { ms: 700, anchor: 'foe', spin: 30 } }),
    0,
    stages,
    everywhere,
  ) as FxSpec;
  assert.deepEqual(talisman.from, [1119, 497], '符纹贴在对方身上');
  assert.equal(talisman.hold?.spin, 30);
});

test('fxSpec 直飞：从出手方那只手飞到对方身体中心，往右飞就镜像，大小按目标舞台高', () => {
  const spec = fxSpec(shot(), 0, stages, everywhere) as FxSpec;
  assert.deepEqual(spec.from, [560, 522]);
  assert.deepEqual(spec.to, [1119, 497]);
  assert.deepEqual(spec.hitAt, spec.to, '命中特效画在终点');
  assert.equal(spec.mirror, true, '贴图画成朝左飞：往右飞要镜像');
  assert.equal(spec.size, Math.round(0.18 * 360));
  assert.equal(spec.grow, 0.7, '拳风边飞边放大');
  // 对手往回打：从它那只手（素材原样朝左）飞到自家身体中心，不镜像
  const back = fxSpec(shot(), 1, stages, everywhere) as FxSpec;
  assert.deepEqual(back.from, [980, 522]);
  assert.deepEqual(back.to, [100 + 640 - 319, 497]);
  assert.equal(back.mirror, false);
  // 送进页面的是窗口内坐标
  const local = fxSpec(shot(), 0, stages, { x: 500, y: 100, width: 1000, height: 800 }) as FxSpec;
  assert.deepEqual(local.from, [60, 422]);
});

test('fxSpec 轨迹终点：贴地两头落在脚底线、命中特效底边贴地；抛物线砸在头顶', () => {
  const ground = fxSpec(shot({ kind: '陀螺', track: 'ground', hitFx: '命中-旋风' }), 0, stages, everywhere) as FxSpec;
  assert.deepEqual(ground.from, [560, 630]);
  assert.deepEqual(ground.to, [1119, 630]);
  assert.ok(ground.hitAt[1] < ground.to[1], '旋风往上冒，不埋进地里');
  const arc = fxSpec(shot({ kind: '毽子', track: 'arc', hitFx: '命中-羽毛' }), 0, stages, everywhere) as FxSpec;
  assert.deepEqual(arc.to, [1119, 300 + 86], '毽子砸头顶（受击是捂头鼓包）');
});

test('fxSpec 顶点高度：按两点距离算，再夹进窗口里剩下的上方空间（宠物贴屏幕顶时蓝鲸不飞出窗口）', () => {
  const whale = shot({ kind: '蓝鲸', track: 'slam', hitFx: '命中-巨浪' });
  const roomy = fxSpec(whale, 0, stages, everywhere) as FxSpec;
  const dist = Math.hypot(roomy.to[0] - roomy.from[0], roomy.to[1] - roomy.from[1]);
  assert.equal(roomy.lift, Math.round(Math.min(dist * 0.6, (roomy.from[1] + roomy.to[1]) / 2 - roomy.size * 0.6)));
  // 窗口顶就在两只头顶上方不远（工作区把窗口截住了）：顶点压到贴图刚好整个露在窗口里
  const cramped = fxSpec(whale, 0, stages, { x: 0, y: 250, width: 4000, height: 2000 }) as FxSpec;
  const mid = (cramped.from[1] + cramped.to[1]) / 2;
  assert.ok(cramped.lift > 0 && cramped.lift < dist * 0.6, `被夹过：${cramped.lift}`);
  assert.ok(
    mid - cramped.lift >= cramped.size * 0.6 - 1,
    `顶点 ${mid - cramped.lift} 留得下半个贴图 ${cramped.size * 0.6}`,
  );
  // 连直线都快贴顶了：不再往上抛（lift 0），不会是负数
  assert.equal((fxSpec(whale, 0, stages, { x: 0, y: 380, width: 4000, height: 2000 }) as FxSpec).lift, 0);
  // 直飞没有顶点
  assert.equal((fxSpec(shot(), 0, stages, everywhere) as FxSpec).lift, 0);
});

test('fxSpec 闪避与挡下：躲开的从头顶掠过 / 落到身后（不穿身而过），挡下的打在泡泡朝着来路那一侧', () => {
  const missed = fxSpec(shot({ miss: true }), 0, stages, everywhere) as FxSpec;
  assert.equal(missed.miss, true);
  assert.equal(missed.to[1], Math.round(497 - 0.32 * 360), '直飞的从头顶上方掠过');
  const lob = fxSpec(shot({ track: 'arc', miss: true }), 0, stages, everywhere) as FxSpec;
  assert.equal(lob.to[0], Math.round(1119 + 0.3 * 640), '抛物线落到她身后');
  const blocked = fxSpec(shot({ blocked: true }), 0, stages, everywhere) as FxSpec;
  assert.equal(blocked.to[0], 1119 - 115, '泡泡左沿（从左边打过来）');
  const fromRight = fxSpec(shot({ blocked: true }), 1, stages, everywhere) as FxSpec;
  assert.equal(fromRight.to[0], 421 + 115, '从右边打过来就是泡泡右沿');
});

test('fxSpec X8：鲸吞从对方身体中心吸回出手方嘴边；分身那一下终点不偏、换成泡泡命中并带水母；打歪的远远飞过头顶', () => {
  const suck = fxSpec(
    shot({ kind: '灵光', hitFx: '灵光', reverse: true, hand: [258, 200] }),
    0,
    stages,
    everywhere,
  ) as FxSpec;
  assert.deepEqual(suck.from, [1119, 497], '起点是对方身体中心');
  assert.deepEqual(suck.to, [100 + 640 - 258, 300 + 200], '终点是自家宠物的嘴（朝右时镜像）');
  const decoy = fxSpec(shot({ decoy: true }), 0, stages, everywhere) as FxSpec;
  assert.deepEqual(decoy.to, [1119, 497], '水母站在原来的位置挨打');
  assert.equal(decoy.hitFx, '命中-泡泡');
  assert.equal(decoy.decoy, Math.round(0.42 * 360));
  const wild = fxSpec(shot({ wild: true }), 0, stages, everywhere) as FxSpec;
  assert.deepEqual(wild.to, [Math.round(1119 + 0.5 * 640), Math.round(497 - 0.55 * 360)]);
  assert.equal(wild.miss, true, '打歪的不画命中特效');
});

test('fxSpec X8 银托盘：回旋带上绕到背后那一点、第二段的时刻与结果，最后飞回出手方的手', () => {
  const tray = shot({
    kind: '托盘',
    track: 'boomerang',
    flightMs: 340,
    hand: [180, 210],
    boomerang: { secondMs: 720, totalMs: 1160, second: 'hit' },
  });
  const spec = fxSpec(tray, 0, stages, everywhere) as FxSpec;
  assert.deepEqual(spec.to, [1119, 497], '第一段擦过正面');
  assert.deepEqual(spec.boomerang, {
    secondMs: 720,
    totalMs: 1160,
    behind: [Math.round(1119 + 0.3 * 640), Math.round(497 - 0.06 * 360)],
    second: 'hit',
  });
  assert.deepEqual(spec.from, [100 + 640 - 180, 300 + 210], '飞回来落在出手的那只手');
  // 页面能把整条回旋跑完：两个命中点各放一次特效，最后托盘摘掉
  const { fx, nodes, advance } = runPage();
  fx.init({ base: '/x/', names: ['托盘', '命中-星'] });
  fx.fire(spec);
  advance(0);
  for (let t = 0; t < 1300; t += 50) advance(50);
  const hits = nodes.filter((node) => node.src.endsWith(encodeURIComponent('命中-星') + '.png'));
  assert.equal(hits.length, 2, '擦过正面一下、背后一下');
  assert.equal(nodes[0].removed, true, '回到手里就摘掉');
});

test('fxSpec 天雷：乌云悬在渡劫者头顶上方、闪电劈到头顶；挡下劈在泡泡顶，躲开劈在身后的地上', () => {
  const bolt = shot({ kind: '闪电', track: 'bolt', hitFx: '命中-电光', sky: true, flightMs: 720 });
  const spec = fxSpec(bolt, 0, [self, null], everywhere) as FxSpec;
  assert.deepEqual(spec.to, [421, 386]);
  assert.deepEqual(spec.from, [421, Math.round(300 - 0.45 * 360)]);
  assert.equal(spec.cloud, Math.round(0.45 * 360), '天雷那一发带乌云的大小');
  assert.equal((fxSpec({ ...bolt, blocked: true }, 0, [self, null], everywhere) as FxSpec).to[1], 340);
  const dodged = fxSpec({ ...bolt, miss: true }, 0, [self, null], everywhere) as FxSpec;
  assert.deepEqual(dodged.to, [100 + 640 - 456, 630], '劈在她身后的地上');
  assert.deepEqual(dodged.from, spec.from, '乌云还是在头顶');
});

test('fxSpec 齐发与兜底：几个物件逐个错开、带上色相；拿不到出手方或对方就不放', () => {
  const volley = fxSpec(shot({ kind: '水弹', count: 3, gapMs: 225, hue: 120 }), 0, stages, everywhere) as FxSpec;
  assert.deepEqual(volley.pieces, [
    { delay: 0, hue: 120 },
    { delay: 225, hue: 120 },
    { delay: 450, hue: 120 },
  ]);
  assert.equal(fxSpec(shot(), 0, [self, null], everywhere), null);
  assert.equal(fxSpec(shot(), 1, [null, foe], everywhere), null);
});

test('心魔配色：SHADOW_MATRIX 和心魔窗口的 shadowPixels 是同一套数（暗气球出手不变鲜红）', () => {
  for (const [r, g, b] of [
    [220, 40, 40],
    [30, 160, 230],
    [255, 255, 255],
    [12, 200, 90],
  ]) {
    const data = new Uint8ClampedArray([r, g, b, 255]);
    shadowPixels(data);
    const viaMatrix = [0, 1, 2].map((row) =>
      Math.min(255, SHADOW_MATRIX[row * 5] * r + SHADOW_MATRIX[row * 5 + 1] * g + SHADOW_MATRIX[row * 5 + 2] * b),
    );
    viaMatrix.forEach((value, i) =>
      assert.ok(Math.abs(value - data[i]) <= 1, `${[r, g, b]} 第 ${i} 通道：${value} vs ${data[i]}`),
    );
  }
  assert.ok(fxPage.includes('<feColorMatrix type="matrix" values="' + SHADOW_MATRIX.join(' ') + ' 0 0 0 1 0"/>'));
  assert.ok(fxPage.includes('color-interpolation-filters="sRGB"'), '按 sRGB 算（和画布上逐像素算的口径一样）');
  // 带 shadow 的那一发：飞行物和命中特效都套上
  assert.equal((fxSpec(shot(), 1, stages, everywhere, true) as FxSpec).shadow, true);
  assert.equal((fxSpec(shot(), 0, stages, everywhere) as FxSpec).shadow, undefined);
});

/** 把页面脚本放进一个只有最少几样 DOM 的沙箱里跑（没有模块作用域可依赖），拨时钟逐帧推 */
function runPage() {
  const script = fxPage.slice(fxPage.indexOf('<script>') + '<script>'.length, fxPage.indexOf('</script>'));
  const nodes: Array<{ className: string; src: string; style: Record<string, string>; removed: boolean }> = [];
  let clock = 0;
  let frames: Array<(now: number) => void> = [];
  const sandbox: Record<string, unknown> = {
    document: {
      createElement: () => {
        const node = { className: '', src: '', alt: '', draggable: true, style: {}, removed: false, remove() {} };
        node.remove = () => void (node.removed = true);
        nodes.push(node);
        return node;
      },
      body: { appendChild: (node: unknown) => node },
    },
    requestAnimationFrame: (callback: (now: number) => void) => frames.push(callback),
    performance: { now: () => clock },
    setTimeout: () => 0,
    Image: class {
      src = '';
      decode = () => Promise.resolve();
    },
  };
  sandbox.window = sandbox;
  runInNewContext(script, sandbox);
  const fx = sandbox.fx as { init(assets: unknown): void; fire(spec: unknown): void };
  const advance = (ms: number) => {
    clock += ms;
    const due = frames;
    frames = [];
    for (const frame of due) frame(clock);
  };
  return { fx, nodes, advance };
}

test('fxPage：页面脚本自包含（沙箱里跑得起来），朝向对、到达后换成命中特效', () => {
  const { fx, nodes, advance } = runPage();
  fx.init({ base: '/dsh-pet-7340/pic/fx/', names: ['拳风', '命中-星'] });
  const base: FxSpec = {
    kind: '拳风',
    hitFx: '命中-星',
    track: 'line',
    flightMs: 400,
    mirror: false,
    from: [300, 100],
    to: [100, 100],
    size: 40,
    hitSize: 80,
    hitAt: [100, 100],
    spin: 0,
    lift: 0,
    grow: 1,
    miss: false,
    pieces: [{ delay: 0, hue: 0 }],
  };
  // 往正左飞：贴图本来就朝左，不转
  fx.fire(base);
  advance(0);
  advance(200);
  const flying = nodes[0];
  assert.match(flying.src, /%E6%8B%B3%E9%A3%8E\.png$/, '贴图名进 URL 前编码');
  assert.match(flying.style.transform, /^translate\(180\.0px,80\.0px\) scale\(1,1\) rotate\(0\.0000rad\)/);
  // 到达：飞行物摘掉，终点换成命中特效
  advance(250);
  assert.equal(flying.removed, true);
  assert.match(nodes[1].src, /%E5%91%BD%E4%B8%AD-%E6%98%9F\.png$/);
  // 往正右飞（镜像）：同样不转——镜像后贴图朝右
  fx.fire({ ...base, mirror: true, from: [100, 100], to: [300, 100] });
  advance(0);
  advance(100);
  assert.match(nodes[2].style.transform, /scale\(-1,1\) rotate\(0\.0000rad\)/);
});

/** 假窗口：记录构造参数、层级与调用 */
function fakeElectron(load: () => Promise<void> = () => Promise.resolve()) {
  const created: Record<string, unknown>[] = [];
  const executed: string[] = [];
  const levels: string[] = [];
  const bounds: Array<{ x: number; y: number; width: number; height: number }> = [];
  const state = { destroyed: false, ignore: false };
  const win: FxWindowLike = {
    isDestroyed: () => state.destroyed,
    setBounds: (rect) => void bounds.push(rect),
    setIgnoreMouseEvents: (ignore) => void (state.ignore = ignore),
    setAlwaysOnTop: (_flag, level) => void levels.push(level),
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: load,
    showInactive: () => undefined,
    destroy: () => void (state.destroyed = true),
    webContents: {
      executeJavaScript: (code) => {
        executed.push(code);
        return Promise.resolve(undefined);
      },
    },
  };
  const electron = {
    BrowserWindow: function FakeBrowserWindow(options: Record<string, unknown>) {
      created.push(options);
      return win;
    },
  } as unknown as FxElectron;
  return { electron, created, executed, levels, bounds, state };
}

const assets = { base: '/dsh-pet-7340/pic/fx/', names: ['拳风' as const, '命中-星' as const] };

test('openFxWindow：透明 / 不可聚焦 / 整窗穿透 / 层级高过宠物窗口；加载前放的那一发排队补上', async () => {
  const fake = fakeElectron();
  const warns: string[] = [];
  const fx = openFxWindow(
    fake.electron,
    'http://127.0.0.1:1/app/fx',
    assets,
    () => stages,
    () => everywhere,
    (message) => void warns.push(message),
  );
  const options = fake.created[0];
  assert.equal(options.transparent, true);
  assert.equal(options.focusable, false);
  assert.equal(options.show, false, '加载完再 showInactive，不抢焦点');
  assert.equal((options.webPreferences as Record<string, unknown>).sandbox, true);
  assert.equal((options.webPreferences as Record<string, unknown>).backgroundThrottling, false);
  assert.deepEqual(fake.levels, ['pop-up-menu'], '宠物窗口是 floating：要高过它，飞行物才从两只身上飞过去');
  assert.equal(fake.state.ignore, true, '整窗鼠标穿透');
  fx.fire(shot(), 0);
  assert.equal(fake.executed.length, 0, '还没加载好：排队');
  await new Promise((done) => setImmediate(done));
  assert.match(fake.executed[0], /^fx\.init\(\{"base":"\/dsh-pet-7340\/pic\/fx\/"/, '先预加载贴图');
  assert.match(fake.executed[1], /^fx\.fire\(\{"kind":"拳风"/);
  assert.equal(fake.executed[1].includes('"shadow"'), false, '不是心魔那一场：照原色画');
  assert.deepEqual(warns, []);
});

test('openFxWindow foeShadow：心魔那一场，只有心魔放出来的（who = 1）用暗紫配色', async () => {
  const fake = fakeElectron();
  const fx = openFxWindow(
    fake.electron,
    'http://127.0.0.1:1/app/fx',
    assets,
    () => stages,
    () => everywhere,
    () => undefined,
    { foeShadow: true },
  );
  await new Promise((done) => setImmediate(done));
  fx.fire(shot(), 1);
  fx.fire(shot(), 0);
  const fires = fake.executed.filter((code) => code.startsWith('fx.fire('));
  assert.equal(fires.length, 2);
  assert.ok(fires[0].includes('"shadow":true'), '心魔那一发');
  assert.equal(fires[1].includes('"shadow"'), false, '自家宠物那一发照原色');
});

test('openFxWindow：窗口没开成只警告一次、之后什么都不做；不知道宠物在哪就干脆不开窗', async () => {
  const broken = fakeElectron(() => Promise.reject(new Error('boom')));
  const warns: string[] = [];
  const fx = openFxWindow(
    broken.electron,
    'http://127.0.0.1:1/app/fx',
    assets,
    () => stages,
    () => everywhere,
    (message) => void warns.push(message),
  );
  fx.fire(shot(), 0);
  await new Promise((done) => setImmediate(done));
  fx.fire(shot(), 0);
  assert.equal(warns.length, 1, `只打一行：${warns}`);
  assert.equal(broken.state.destroyed, true);
  assert.deepEqual(broken.executed, []);

  const blind = fakeElectron();
  const quiet: string[] = [];
  const none = openFxWindow(
    blind.electron,
    'http://127.0.0.1:1/app/fx',
    assets,
    () => [null, null],
    () => everywhere,
    (message) => void quiet.push(message),
  );
  none.fire(shot(), 0);
  none.close(0);
  assert.equal(blind.created.length, 0, '摆不了就不开窗');
  assert.equal(quiet.length, 1);
});

test('close(afterMs)：先让最后那一下的命中特效放完，到点才销毁窗口', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const fake = fakeElectron(() => new Promise(() => undefined));
  const fx = openFxWindow(
    fake.electron,
    'http://127.0.0.1:1/app/fx',
    assets,
    () => stages,
    () => everywhere,
    () => undefined,
  );
  fx.close(3_000);
  t.mock.timers.tick(2_999);
  assert.equal(fake.state.destroyed, false, '还没到点');
  t.mock.timers.tick(1);
  assert.equal(fake.state.destroyed, true);
});

test('X16 冲刺：pin 钉住特效层的位置（飞行物照实时舞台算）；surge 带进 FxSpec', () => {
  const fake = fakeElectron();
  let current: [Stage, Stage] = [self, foe];
  const fx = openFxWindow(
    fake.electron,
    'http://127.0.0.1:1/app/fx',
    assets,
    () => current,
    () => everywhere,
    () => undefined,
  );
  fx.pin(true);
  current = [{ ...self, x: self.x + 600 }, foe];
  fx.place();
  assert.equal(fake.bounds.length, 0, '钉住时窗口不跟着挪');
  fx.pin(false);
  fx.place();
  assert.equal(fake.bounds.length, 1, '放开后恢复跟随');
  const surge = fxSpec(
    shot({ kind: '金龙', track: 'surge', hitFx: '命中-龙吟', flightMs: 200, surge: true }),
    0,
    [self, foe],
    everywhere,
  );
  assert.equal(surge?.surge, true);
  assert.equal(surge?.surgeSize, Math.round(0.56 * 360 * 0.6), '后劲那一发是小一号的命中-龙吟');
  assert.equal(surge?.track, 'surge');
  assert.equal(surge?.hitFx, '命中-龙吟');
  // 切磋里客人小一号：金龙按两只里大的那只算，不能比出手方还小
  const smallFoe = foeStage({ x: 800, y: 300, width: 320, height: 300 }, 'left');
  const small = fxSpec(
    shot({ kind: '金龙', track: 'surge', hitFx: '命中-龙吟', flightMs: 200 }),
    0,
    [self, smallFoe],
    everywhere,
  );
  assert.equal(small?.size, Math.round(0.9 * 360), '按自家舞台高算龙的大小');
  // 页面收到 surge：命中时多打一发小一号的龙吟（固定贴图，不跟这一手的命中贴图）
  assert.ok(fxPage.includes("burst('命中-龙吟'"), '后劲那一发用龙吟');
});
