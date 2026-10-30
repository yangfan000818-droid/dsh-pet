/**
 * dev/fx-preview.mjs —— 对战演出逐招预览（开发自测工具，不入 npm 包）：不开 app，把每一招单独排成一小场，
 * 用**正式代码**（battle-show.ts 的 timeline、fx-window.ts 的 fxSpec 与 fxPage）算时间线和坐标，
 * 在无头 Chromium 里把两只宠物（视频）和特效层叠在一起播，录成 webm——逐帧看「出手 → 飞行物 → 命中 → 受击」
 * 衔不衔得上。素材重做、改飞行时间 / 贴图大小 / 前摇之后，跑一遍就知道哪一招不对。
 *
 * 用法（strip-types 与 test-register 的说明见 scripts/test-ts-resolver.mjs）：
 *   node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/fx-preview.mjs [场景…] [--out 目录] [--layout trial|spar]
 *
 * 不给场景就全录；`--list` 列出场景名，`--plan` 只打印时间线不录。每个场景录成 <目录>/<场景>.mp4，逐帧截图在 <目录>/<场景>/<毫秒>.jpg
 * （毫秒 = 距离开打，方便按时间线的时刻挑帧；默认目录是系统临时目录下的 dsh-pet-fx-preview）。
 * 帧来自 Chromium 的屏幕推流（CDP Page.startScreencast），拼视频用系统的 ffmpeg。
 * 布局：trial = 心魔试炼（两只等大、贴身站），spar = 切磋（客人小一号、隔开一段社交距离）。
 * 本机 playwright 对应版本的浏览器没下载时，设 FX_PREVIEW_CHROMIUM 指到已有的 chrome-headless-shell 可执行文件。
 * 预览里的宠物不经过 app 的动画通道，没有真机上的上屏延迟——那一段要真机录屏量（BattleShow 的 animLeadMs）。
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { dashShift } from '../../src/app/battle-dash.ts';
import { timeline } from '../../src/app/battle-show.ts';
import { fxPage, fxSpec } from '../../src/app/fx-window.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const outDir = resolve(option('--out', join(tmpdir(), 'dsh-pet-fx-preview')));
const layoutName = option('--layout', 'trial');
const W = 1100;
const H = 620;

/** 两只的舞台（画布矩形）：自家宠物在左、面朝右（整段镜像），对手在右、面朝左（素材原样） */
const LAYOUTS = {
  trial: { self: { x: 60, y: 300, width: 480 }, foe: { x: 520, y: 300, width: 480 } },
  spar: { self: { x: 40, y: 300, width: 480 }, foe: { x: 640, y: 360, width: 336 } },
};
const layout = LAYOUTS[layoutName];
if (!layout) throw new Error(`没有这种布局：${layoutName}（trial / spar）`);
const stageOf = (rect, facing) => ({ ...rect, height: (rect.width * 9) / 16, facing });
const stages = [stageOf(layout.self, 'right'), stageOf(layout.foe, 'left')];
const bounds = { x: 0, y: 0, width: W, height: H };

const hp = [100, 100];
const start = { actor: 0, kind: 'start', hp };
const decide = (actor, action) => ({ actor, kind: 'decide', action, hp });
const weapon = (id) => ({ kind: 'weapon', weapon: id });
const skill = (id) => ({ kind: 'skill', skill: id });
const hit = (actor, extra = {}) => ({ actor, kind: 'hit', damage: 10, crit: false, blocked: false, hp, ...extra });
/** 法宝打中（带上法宝编号，解说台词才对得上） */
const whit = (actor, id, extra = {}) => hit(actor, { weapon: id, ...extra });
const none = [[], []];

/** 场景：名字 → { events, skillSets, tribulation? }。每招一小场，外加闪避 / 挡下 / 反击 / 假死 / 反方向 / 渡劫 */
const SCENES = {
  空手: { events: [start, decide(0, { kind: 'unarmed' }), hit(0)] },
  水枪: { events: [start, decide(0, weapon('water-gun')), whit(0, 'water-gun')] },
  扑克牌: { events: [start, decide(0, weapon('poker')), whit(0, 'poker'), whit(0, 'poker')] },
  毽子: { events: [start, decide(0, weapon('shuttlecock')), whit(0, 'shuttlecock')] },
  雪球: {
    events: [
      start,
      decide(0, weapon('snowball')),
      whit(0, 'snowball'),
      { actor: 1, kind: 'skip', cause: 'freeze', hp },
    ],
  },
  鸡毛掸子: { events: [start, decide(0, weapon('duster')), whit(0, 'duster', { slowed: true })] },
  银托盘: { events: [start, decide(0, weapon('tray')), whit(0, 'tray'), whit(0, 'tray')] },
  托盘被躲: { events: [start, decide(0, weapon('tray')), { actor: 1, kind: 'dodge', hp }, whit(0, 'tray')] },
  弹弓: { events: [start, decide(0, weapon('slingshot')), whit(0, 'slingshot', { twin: true })] },
  鲸歌: {
    events: [
      start,
      decide(0, skill('whale-song')),
      { actor: 0, kind: 'skill', skill: 'whale-song', hp },
      { actor: 1, kind: 'skip', cause: 'sleep', hp },
    ],
  },
  墨汁: {
    events: [
      start,
      decide(0, skill('ink')),
      { actor: 0, kind: 'skill', skill: 'ink', hp },
      decide(1, weapon('poker')),
      { actor: 1, kind: 'miss', hp },
      whit(1, 'poker'),
    ],
  },
  鲸吞: {
    events: [
      start,
      decide(0, skill('whale-gulp')),
      { actor: 0, kind: 'skill', skill: 'whale-gulp', damage: 20, heal: 10, hp },
    ],
  },
  水母分身: {
    events: [start, decide(0, weapon('firework')), { actor: 1, kind: 'decoy', hp }],
    skillSets: [[], ['jelly-clone']],
  },
  万我: {
    events: [
      start,
      decide(0, skill('myriad-self')),
      { actor: 0, kind: 'skill', skill: 'myriad-self', hp },
      decide(1, { kind: 'unarmed' }),
      { actor: 0, kind: 'mirror', hp },
      decide(1, { kind: 'unarmed' }),
      { actor: 0, kind: 'mirror', hp },
      decide(1, { kind: 'unarmed' }),
      { actor: 0, kind: 'mirror', hp },
    ],
  },
  魂牵梦绕: {
    events: [
      start,
      decide(0, skill('dream-chant')),
      { actor: 0, kind: 'skill', skill: 'dream-chant', damage: 14, hp },
      { actor: 1, kind: 'skip', cause: 'dream', hp },
    ],
  },
  五指拳心剑: {
    events: [
      start,
      decide(0, skill('finger-sword')),
      { actor: 0, kind: 'skill', skill: 'finger-sword', damage: 30, pierce: true, hp },
    ],
  },
  // X21：万我大手印的巨掌压下并封法宝、逆流护身印把伤害弹回、前有古人的古人虚影补一击、
  // 吃苦吃亏吃魂影与咬一口
  万我大手印: {
    events: [
      start,
      decide(0, skill('myriad-palm')),
      { actor: 0, kind: 'skill', skill: 'myriad-palm', damage: 30, sealed: 'weapon', hp },
      decide(1, { kind: 'unarmed' }),
      hit(1),
    ],
  },
  逆流护身印: {
    events: [
      start,
      decide(1, skill('reverse-seal')),
      { actor: 1, kind: 'skill', skill: 'reverse-seal', hp },
      decide(0, weapon('water-gun')),
      { actor: 0, kind: 'reverse', damage: 20, hp: [80, 100] },
      decide(0, { kind: 'unarmed' }),
      hit(0),
    ],
  },
  前有古人: {
    events: [
      start,
      decide(0, skill('ancients')),
      { actor: 0, kind: 'skill', skill: 'ancients', hp },
      decide(0, weapon('water-gun')),
      { actor: 0, kind: 'ancient', damage: 80, hp: [100, 20] },
      whit(0, 'water-gun'),
    ],
  },
  吃苦吃亏吃魂影: {
    events: [
      start,
      decide(0, skill('eat-hardship')),
      { actor: 0, kind: 'skill', skill: 'eat-hardship', hp },
      { actor: 0, kind: 'devour', what: 'mirror', heal: 12, hp: [100, 100] },
    ],
  },
  吃苦吃亏咬一口: {
    events: [
      start,
      decide(0, skill('eat-hardship')),
      { actor: 0, kind: 'skill', skill: 'eat-hardship', hp },
      { actor: 0, kind: 'devour', what: 'bite', damage: 44, heal: 22, hp: [100, 56] },
    ],
  },
  // X22：鬼手掐住并封招式、无头鬼影取首级、鬼敲门反噬、鬼画封被动、鬼血血珠、鬼眼破替身
  鬼手: {
    events: [
      start,
      decide(0, skill('ghost-hand')),
      { actor: 0, kind: 'skill', skill: 'ghost-hand', damage: 26, sealed: 'skill', hp },
      decide(1, { kind: 'unarmed' }),
      hit(1),
    ],
  },
  无头鬼影: {
    events: [
      start,
      decide(0, skill('headless-shadow')),
      { actor: 0, kind: 'skill', skill: 'headless-shadow', damage: 40, behead: true, hp: [100, 0] },
      { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp: [100, 0] },
    ],
  },
  鬼敲门: {
    events: [
      start,
      decide(0, skill('ghost-knock')),
      { actor: 0, kind: 'skill', skill: 'ghost-knock', hp },
      decide(1, { kind: 'unarmed' }),
      { actor: 1, kind: 'knock', damage: 26, hp: [100, 74] },
      hit(1),
    ],
  },
  鬼画封被动: {
    events: [
      start,
      decide(0, skill('ghost-painting')),
      { actor: 0, kind: 'skill', skill: 'ghost-painting', paint: 'bubble', hp },
    ],
  },
  鬼血: {
    events: [start, decide(0, skill('ghost-blood')), { actor: 0, kind: 'skill', skill: 'ghost-blood', damage: 30, hp }],
  },
  鬼眼破替身: {
    events: [start, decide(0, weapon('water-gun')), whit(0, 'water-gun')],
    skillSets: [[], ['jelly-clone']],
  },
  // X25：鲸派气功聚气与自动释放、深渊领域铺开与暗流、瞬影残影
  鲸派气功聚气: {
    events: [
      start,
      decide(0, skill('tide-cannon')),
      { actor: 0, kind: 'skill', skill: 'tide-cannon', charging: true, hp },
    ],
  },
  鲸派气功释放: {
    events: [
      start,
      { actor: 0, kind: 'decide', action: skill('tide-cannon'), autoRelease: true, hp },
      { actor: 0, kind: 'skill', skill: 'tide-cannon', release: true, damage: 86, hp: [100, 14] },
    ],
  },
  深渊领域: {
    events: [
      start,
      decide(0, skill('abyss-field')),
      { actor: 0, kind: 'skill', skill: 'abyss-field', hp },
      { actor: 0, kind: 'field', damage: 15, hp: [100, 85] },
      decide(1, { kind: 'unarmed' }),
      hit(1),
    ],
  },
  瞬影: {
    events: [
      start,
      decide(0, skill('shadow-step')),
      { actor: 0, kind: 'skill', skill: 'shadow-step', hp },
      decide(1, { kind: 'unarmed' }),
      hit(1),
    ],
  },
  // X16：降龙十八掌冲过去打、再退回来；送友风把人吹得飘起来；串门里送走（客人整扇窗飘走）
  降龙十八掌: {
    events: [
      start,
      decide(0, skill('dragon-palm')),
      { actor: 0, kind: 'skill', skill: 'dragon-palm', damage: 30, hp: [100, 70] },
      { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp: [100, 70] },
    ],
  },
  送友风飘起: {
    events: [
      start,
      decide(0, skill('farewell-wind')),
      { actor: 0, kind: 'skill', skill: 'farewell-wind', damage: 18, hp: [100, 82] },
      { actor: 1, kind: 'skip', cause: 'float', hp: [100, 82] },
    ],
  },
  串门里送走: {
    events: [
      start,
      decide(0, skill('farewell-wind')),
      { actor: 0, kind: 'skill', skill: 'farewell-wind', damage: 18, hp: [100, 82] },
      { actor: 0, kind: 'end', winner: 0, reason: 'farewell', hp: [100, 82] },
    ],
    farewell: true,
  },
  三球: { events: [start, decide(0, weapon('juggle')), whit(0, 'juggle'), whit(0, 'juggle'), whit(0, 'juggle')] },
  陀螺: { events: [start, decide(0, weapon('top')), whit(0, 'top')] },
  鲸尾: { events: [start, decide(0, weapon('whale-tail')), whit(0, 'whale-tail')] },
  烟花: { events: [start, decide(0, weapon('firework')), whit(0, 'firework')] },
  狮子吼: {
    events: [start, decide(0, skill('lion-roar')), { actor: 0, kind: 'skill', skill: 'lion-roar', damage: 12, hp }],
  },
  蓝鲸现世: {
    events: [start, decide(0, skill('blue-whale')), { actor: 0, kind: 'skill', skill: 'blue-whale', damage: 20, hp }],
  },
  灵兽助阵: {
    events: [start, decide(0, { kind: 'unarmed' }), hit(0), { actor: 0, kind: 'beast', damage: 5, blocked: false, hp }],
    skillSets: [['spirit-beast'], []],
  },
  无影手: {
    events: [start, decide(0, { kind: 'unarmed' }), hit(0), { ...hit(0), kind: 'combo' }],
    skillSets: [['shadow-fists'], []],
  },
  第六感: {
    events: [
      start,
      decide(0, { kind: 'unarmed' }),
      hit(0),
      { actor: 1, kind: 'counter', damage: 5, blocked: false, hp },
    ],
    skillSets: [[], ['sixth-sense']],
  },
  闪避: { events: [start, decide(0, weapon('poker')), { actor: 1, kind: 'dodge', hp }, whit(0, 'poker')] },
  化鸽遁: {
    events: [start, decide(0, weapon('shuttlecock')), { actor: 1, kind: 'dodge', hp }],
    skillSets: [[], ['dove']],
  },
  泡泡挡下: {
    events: [start, decide(0, weapon('firework')), whit(0, 'firework', { blocked: true })],
    skillSets: [[], ['bubble']],
  },
  假死遁: { events: [start, decide(0, { kind: 'unarmed' }), hit(0), { actor: 1, kind: 'play-dead', hp }] },
  对手出手: {
    events: [
      start,
      decide(1, weapon('water-gun')),
      whit(1, 'water-gun'),
      decide(0, weapon('snowball')),
      whit(0, 'snowball'),
    ],
  },
  渡劫: {
    events: [
      start,
      { actor: 0, kind: 'strike', index: 0, damage: 20, blocked: false, hp },
      { actor: 0, kind: 'strike', index: 1, damage: 0, blocked: true, hp },
      { actor: 0, kind: 'end', winner: 0, reason: 'ko', hp },
    ],
    skillSets: [['bubble'], []],
    tribulation: { pill: false, strikes: 2 },
  },
};

if (args.includes('--list')) {
  console.log(Object.keys(SCENES).join(' '));
  process.exit(0);
}
const wanted = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--layout');
const names = wanted.length > 0 ? wanted : Object.keys(SCENES);
for (const name of names) if (!SCENES[name]) throw new Error(`没有这个场景：${name}（--list 看全部）`);

/** 场景 → 页面要的时间线：动画（谁、哪段、倍速）、飞行物（算好的 FxSpec）、台词 */
function planOf(scene) {
  const solo = !!scene.tribulation;
  const steps = timeline(scene.events, ['自家', '对手'], () => 0, scene.skillSets ?? none, {
    ...(solo ? { tribulation: scene.tribulation } : {}),
  });
  // 预览里的舞台是摆好的：冲刺按 battle-dash 的同一个几何挪这只宠物的舞台，飞行物按挪过以后的掌心算。
  const view = (solo ? [stages[0], null] : stages).map((stage) => (stage ? { ...stage } : null));
  const openingX = view.map((stage) => stage?.x ?? 0);
  const out = [];
  for (const step of steps) {
    if (step.dash) {
      const stage = view[step.who];
      const other = view[step.who ^ 1];
      if (stage && other) {
        const x =
          step.dash.dir === 'back'
            ? openingX[step.who]
            : stage.x + dashShift(stage.x + stage.width / 2, stage.width, other.x + other.width / 2, other.width);
        stage.x = x;
        out.push({
          at: step.at,
          who: step.who,
          dash: { who: step.who, x: Math.round(x), ms: step.dash.ms, dir: step.dash.dir },
        });
      }
    }
    out.push({
      at: step.at,
      who: step.who,
      ...(step.anim ? { anim: step.anim, rate: step.rate ?? 1 } : {}),
      ...(step.line ? { line: step.line } : {}),
      // 心魔布局：对手放出来的那几发用心魔配色（同 app 里的 foeShadow）
      ...(step.shot
        ? { spec: fxSpec(step.shot, step.who, view, bounds, layoutName === 'trial' && step.who === 1) }
        : {}),
    });
  }
  const last = Math.max(...out.map((step) => step.at));
  if (scene.farewell) {
    // 主人家送客：自家宠物是 0 号，被送走的客人是 1 号；演出收场（最后一句台词显示完）以后再整扇窗飘走
    out.push({ at: last + 2_400, floatAway: { who: 1, ms: 1_500 } });
  }
  return {
    solo,
    stages: (solo ? [stages[0], null] : stages).map((stage) => (stage ? { ...stage } : null)),
    end: Math.max(...out.map((step) => step.at)) + 2_600,
    steps: out,
  };
}

/** 预览页：两只宠物的视频按舞台摆、特效层是正式的 fxPage（iframe srcdoc，和主页同源，贴图走 /assets/pic/fx/） */
function pageOf(plan) {
  const pets = plan.stages
    .map((stage, who) =>
      stage
        ? `<video id="pet${who}" muted playsinline style="position:absolute;left:${stage.x}px;top:${stage.y}px;width:${stage.width}px;height:${stage.height}px;${stage.facing === 'right' ? 'transform:scaleX(-1);' : ''}"></video>`
        : '',
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${W}px;height:${H}px;background:#9aa3ad;overflow:hidden;font:16px sans-serif}
#fx{position:absolute;left:0;top:0;width:${W}px;height:${H}px;border:0;background:transparent;pointer-events:none}
.line{position:absolute;top:24px;padding:4px 10px;background:#fff;border-radius:8px}
#clock{position:absolute;right:10px;bottom:8px;color:#222}
</style></head><body>${pets}
<iframe id="fx" srcdoc="${fxPage.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>
<div class="line" id="line0" style="left:${plan.stages[0].x + 40}px"></div>
<div class="line" id="line1" style="left:${(plan.stages[1]?.x ?? 0) + 40}px"></div>
<div id="clock"></div>
<script>
const PLAN = ${JSON.stringify(plan)};
const pets = [document.getElementById('pet0'), document.getElementById('pet1')];
function play(who, name, rate) {
  const video = pets[who];
  if (!video) return;
  video.loop = false;
  video.src = '/assets/webm/' + encodeURIComponent(name) + '.webm';
  video.playbackRate = rate;
  video.play().catch(() => undefined);
}
// 冲刺：和 app 一样按直线挪过去 / 退回来（预览里挪的是视频的 left，app 里挪的是宠物窗口）
function dash(who, x, ms) {
  const video = pets[who];
  if (!video) return;
  video.style.transition = 'left ' + ms + 'ms linear';
  video.style.left = x + 'px';
}
// 串门里送走：整扇窗往上飘、淡出（预览里挪的是视频，app 里挪的是客人窗口）
function floatAway(who, ms) {
  const stage = PLAN.stages[who];
  const video = pets[who];
  if (!stage || !video) return;
  video.style.transition = 'top ' + ms + 'ms ease-in, opacity ' + ms + 'ms ease-in';
  video.style.top = stage.y - stage.height * 0.5 + 'px';
  video.style.opacity = '0';
}
for (const video of pets) {
  if (!video) continue;
  // 开场先待机（app 里宠物本来就在待机；渡劫不吃丹时第一段动画要等到第一道雷）
  video.loop = true;
  video.src = '/assets/webm/' + encodeURIComponent('待机呼吸休闲') + '.webm';
  video.play().catch(() => undefined);
  video.addEventListener('ended', () => {
    video.loop = true;
    video.src = '/assets/webm/' + encodeURIComponent('待机呼吸休闲') + '.webm';
    video.playbackRate = 1;
    video.play().catch(() => undefined);
  });
}
window.go = () => new Promise((resolve) => {
  window.t0 = Date.now();
  const fx = document.getElementById('fx').contentWindow.fx;
  const names = PLAN.steps.filter((s) => s.spec).flatMap((s) => [s.spec.kind, s.spec.hitFx, '乌云']);
  fx.init({ base: '/assets/pic/fx/', names: Array.from(new Set(names)) });
  const t0 = performance.now();
  for (const step of PLAN.steps) {
    setTimeout(() => {
      if (step.anim) play(step.who, step.anim, step.rate);
      if (step.dash) dash(step.dash.who, step.dash.x, step.dash.ms);
      if (step.spec) fx.fire(step.spec);
      if (step.floatAway) floatAway(step.floatAway.who, step.floatAway.ms);
      if (step.line) document.getElementById('line' + step.who).textContent = step.line;
    }, step.at);
  }
  (function tick() {
    document.getElementById('clock').textContent = Math.round(performance.now() - t0) + ' ms';
    if (performance.now() - t0 < PLAN.end) requestAnimationFrame(tick);
    else resolve();
  })();
});
</script></body></html>`;
}

if (args.includes('--plan')) {
  // 只打印时间线（每一步的时刻、谁、动画 / 飞行物 / 台词），不录
  for (const name of names) {
    console.log(`== ${name}`);
    for (const step of planOf(SCENES[name]).steps) {
      const what = [
        step.anim ? `${step.anim} ×${step.rate}` : '',
        step.dash ? `冲 ${step.dash.dir} → x=${step.dash.x}` : '',
        step.spec
          ? `飞 ${step.spec.kind} ${step.spec.track} ${step.spec.flightMs}ms → 命中 ${step.at + step.spec.flightMs}`
          : '',
        step.line ? `「${step.line}」` : '',
      ].filter(Boolean);
      console.log(`  ${String(step.at).padStart(5)}  ${step.who}  ${what.join('  ')}`);
    }
  }
  process.exit(0);
}

const MIME = { '.webm': 'video/webm', '.png': 'image/png', '.html': 'text/html; charset=utf-8' };
let current = '';
const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/') {
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(current);
    return;
  }
  if (!url.startsWith('/assets/')) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = readFileSync(join(ROOT, url));
    res.writeHead(200, { 'content-type': MIME[extname(url)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;
mkdirSync(outDir, { recursive: true });
// 本机 playwright 要的浏览器版本没下载时，可以用 FX_PREVIEW_CHROMIUM 指到已有的 chrome-headless-shell / Chromium
const browser = await chromium.launch(
  process.env.FX_PREVIEW_CHROMIUM ? { executablePath: process.env.FX_PREVIEW_CHROMIUM } : {},
);
try {
  for (const name of names) {
    const plan = planOf(SCENES[name]);
    current = pageOf(plan);
    const frames = join(outDir, name);
    rmSync(frames, { recursive: true, force: true });
    mkdirSync(frames, { recursive: true });
    const context = await browser.newContext({ viewport: { width: W, height: H } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const shots = [];
    cdp.on('Page.screencastFrame', (frame) => {
      shots.push({ wall: frame.metadata.timestamp * 1000, data: frame.data });
      // 收场时还会漏回来一两帧，那时会话已经关了：ack 失败不算错，别让它盖掉真正的异常
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await page.goto(base);
    // 先把这一场的素材都取一遍（预览里没有 app 的预加载，第一次换源要等网络会把节奏拖乱）
    await page.evaluate(async (plan) => {
      const names = [...new Set(plan.steps.filter((s) => s.anim).map((s) => s.anim)), '待机呼吸休闲'];
      await Promise.all(
        names.map((n) => fetch('/assets/webm/' + encodeURIComponent(n) + '.webm').then((r) => r.blob())),
      );
    }, plan);
    await page.waitForTimeout(300);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
    await page.evaluate(() => window.go());
    const t0 = await page.evaluate(() => window.t0);
    await cdp.send('Page.stopScreencast');
    await context.close();
    // 逐帧落盘（文件名 = 距离开打的毫秒），再按真实间隔拼成 30fps 的视频
    const list = [];
    for (const shot of shots) {
      const ms = Math.round(shot.wall - t0);
      if (ms < 0) continue;
      const jpg = join(frames, `${String(ms).padStart(5, '0')}.jpg`);
      writeFileSync(jpg, Buffer.from(shot.data, 'base64'));
      list.push({ jpg, ms });
    }
    const concat = list
      .map(
        (item, i) =>
          `file '${item.jpg}'\nduration ${(((list[i + 1]?.ms ?? item.ms + 33) - item.ms) / 1000).toFixed(3)}`,
      )
      .join('\n');
    writeFileSync(join(frames, 'list.txt'), concat);
    const file = join(outDir, `${name}.mp4`);
    spawnSync('ffmpeg', [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      join(frames, 'list.txt'),
      '-vf',
      'fps=30,format=yuv420p',
      file,
    ]);
    console.log(`[fx-preview] ${name} → ${file}（${list.length} 帧，${(plan.end / 1000).toFixed(1)} 秒）`);
  }
} finally {
  await browser.close();
  server.close();
}
