/**
 * 历练的对手窗口（历练 Y2）：秘境里的对手站在宠物旁边打。
 *
 * 窗口照客人窗口（`visit-windows.ts` 的 `openGuestWindow`）：透明、置顶、不可聚焦、鼠标穿透、跟着宠物走，
 * 等大贴身（`{ scale: 1, tight: true }`）。页面走本机服务的 `GET /app/foe`（见 app-routes.ts），
 * 数据由这里经 `executeJavaScript` 送进页面，一律 `JSON.stringify` 成字面量，页面只用 `textContent` 显示。
 *
 * 平时显示立绘；`play` 先试 `/thumb/main/<前缀>-<动作>.webm`。视频加载失败就在页面里退回 CSS 动作
 * （出手扑一下、受击抖一下闪红、闪避侧移、倒地倾倒淡出），主进程不查文件——素材缺了不报错（任务书 §2.1）。
 * 「倒地」素材只给首帧、结尾倒在地上：视频播完停在最后一帧再淡出，不回到立绘。
 */
import { GUEST_BUBBLE_OVERLAP_RATIO, followGuest, guestBounds, guestSide } from './visit-windows';
import type { PetBox, Rect, WindowElectron, WindowLike } from './visit-windows';

/** 跟着自家宠物走的间隔（同客人窗口） */
const FOLLOW_MS = 50;
/** 对手窗口宽度占自家宠物宽度的比例：默认等大，精英由调用方传 1.2 */
const FOE_SCALE = 1;

/**
 * 动作名 → CSS 兜底动作：`出手` / `绝招` 往前扑，`受击` 抖一下闪红，`闪避` 侧移，
 * `倒地` 倾倒淡出，`起手` / `胜利` 轻轻跳一下。
 *
 * **自包含**：本函数经 `toString()` 内联进 foe 页面（和 `pinkPixels` 同一口径），
 * 不能引用模块作用域里的任何东西，否则页面里第一次播兜底动作就 ReferenceError。
 */
export function foeActionClass(action: string): 'lunge' | 'hit' | 'dodge' | 'fall' | 'jump' {
  const name = action.slice(action.lastIndexOf('-') + 1);
  if (name === '受击') return 'hit';
  if (name === '闪避') return 'dodge';
  if (name === '倒地') return 'fall';
  if (name === '起手' || name === '胜利') return 'jump';
  return 'lunge';
}

/** 开对手窗口的参数：名字、立绘地址、动画前缀，以及熔岩鳄 / 他派蛊师换色和精英的画法 */
export interface FoeWindowOptions {
  /** 对手名（名牌与台词气泡都挂在它头上） */
  name: string;
  /** 立绘地址（本机服务的 `/pic/adventure/…`，调用方拼好、编码好） */
  portrait: string;
  /** 动画前缀（`对手-白凝冰`；熔岩鳄、他派蛊师传被复用的狮獒 / 韩不留） */
  prefix: string;
  /** CSS 滤镜（熔岩鳄、他派蛊师换色用） */
  filter?: string;
  /** 窗口宽相对自家宠物的比例：默认 1（等大），`elite` 时默认 1.2；显式给值时以它为准 */
  scale?: number;
  /** 精英的画法：放大 1.2 倍（没给 scale 时）+ 立绘加一圈金边 */
  elite?: boolean;
  /** 待机动画（群架里没有立绘的影子用）：没在演动作时循环播这一段，缺素材就退回剪影 */
  idle?: string;
  /**
   * 倒地后留在原地（群架）：`战斗-倒地` 素材结尾会再站起来，所以停在倒下的那一段、
   * 淡到 30% 躺在环上；不给就照 1v1 的老样子：播完淡出。
   */
  holdDown?: boolean;
}

/** 和 `GuestWindow` 同形（`BattleShow`、擂台、特效层不用改） */
export interface FoeWindow {
  /** 对手站在自家宠物哪一边 */
  side: 'left' | 'right';
  /** 窗口现在的位置与大小（擂台窗口按它把两条血排左右） */
  bounds(): Rect;
  /** 对手说一句（气泡默认显示 10 秒） */
  say(text: string, durationMs?: number): void;
  /** 播一段对手动画（`<前缀>-<动作>`；页面先试视频，失败退回 CSS） */
  play(anim: string, rate?: number): void;
  /** 转身（群架围圈用）：'left' 朝左、'right' 朝右；平常跟着站在宠物哪边自动转 */
  face(facing: 'left' | 'right'): void;
  /** 开演前把要播的动画取到页面里（同客人窗口的预热） */
  preload(anims: string[]): void;
  /** 淡出（客串说完台词用；Y5） */
  fade(): void;
  /** 钉住 / 放开跟随（X16 冲刺）：钉住时窗口停在原地，由演出自己按帧挪 */
  pin(on: boolean): void;
  /** 直接挪到某个位置（X16 对手冲刺：主进程按帧算好，只改左上角与大小） */
  moveTo(rect: Rect): void;
  /** 过一会儿关掉（先让倒地淡出） */
  close(afterMs: number): void;
}

/**
 * 开对手窗口。
 * @param electron 只用到 BrowserWindow / screen
 * @param pageUrl 本机服务的 /app/foe
 * @param options 名字、立绘、动画前缀、滤镜、放大与金边
 * @param home 取自家宠物现在的位置（watchHomePet 的 box）；对手跟着它走
 */
export function openFoeWindow(
  electron: WindowElectron,
  pageUrl: string,
  options: FoeWindowOptions,
  home: () => PetBox | null,
): FoeWindow {
  // 精英默认放大 1.2 倍（任务书 §2.3）；调用方另给 scale 时以它为准
  const layout = { scale: options.scale ?? (options.elite ? 1.2 : FOE_SCALE), tight: true };
  const homeNow = home();
  const point = homeNow
    ? { x: homeNow.left + homeNow.size / 2, y: homeNow.top + homeNow.size / 4 }
    : electron.screen.getCursorScreenPoint();
  let bounds = guestBounds(homeNow, electron.screen.getDisplayNearestPoint(point).workArea, undefined, layout);
  let side = guestSide(bounds, homeNow);
  const win: WindowLike = new electron.BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 玩家盯着宠物看时，对手的动画也不能因为窗口被挡住而停
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 对手只是个演员：整窗鼠标穿透，点它跟点桌面一样
  win.setIgnoreMouseEvents(true);
  let ready = false;
  let pinned = false;
  const queued: string[] = [];
  const run = (code: string): void => {
    if (win.isDestroyed()) return;
    if (!ready) queued.push(code);
    else void win.webContents.executeJavaScript(code).catch(() => undefined);
  };
  void win
    .loadURL(pageUrl)
    .then(() => {
      if (win.isDestroyed()) return;
      win.showInactive();
      ready = true;
      for (const code of queued.splice(0)) run(code);
    })
    .catch(() => win.destroy());
  // 跟着自家宠物走：每拍取一次位置，位置变了就挪窗口；没收到位置（null）就不动。
  // workArea 取自家宠物中心所在的那块屏，宠物被拖到另一块屏时对手跟过去。
  const follow = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(follow);
      return;
    }
    // 冲刺期间钉住：对手自己冲过来时由演出按帧挪，别让跟随把它拖回去
    if (pinned) return;
    const box = home();
    if (!box) return;
    const workArea = electron.screen.getDisplayNearestPoint({
      x: box.left + box.size / 2,
      y: box.top + box.size / 2,
    }).workArea;
    const next = followGuest(bounds, side, box, workArea, layout);
    if (!next) return;
    const turned = next.side !== side;
    bounds = next.bounds;
    side = next.side;
    win.setBounds(bounds);
    if (turned) run(`foe.face(${JSON.stringify(side === 'left' ? 'right' : 'left')})`);
  }, FOLLOW_MS);
  // 名字、立绘、前缀、滤镜、精英金边都只当 JSON 字面量进页面（页面用 textContent / src / style 显示）
  run(
    `foe.setup(${JSON.stringify({
      name: options.name,
      portrait: options.portrait,
      prefix: options.prefix,
      filter: options.filter ?? '',
      elite: options.elite === true,
      facing: side === 'left' ? 'right' : 'left',
      idle: options.idle ?? '',
      holdDown: options.holdDown === true,
    })})`,
  );
  return {
    get side() {
      return side;
    },
    bounds: () => bounds,
    say: (text, durationMs) => run(`foe.say(${JSON.stringify(text)}, ${Number(durationMs) || 10000})`),
    play: (anim, rate) => run(`foe.play(${JSON.stringify(anim)}, ${Number.isFinite(Number(rate)) ? Number(rate) : 1})`),
    face: (facing) => run(`foe.face(${JSON.stringify(facing)})`),
    preload: (anims) => run(`foe.preload(${JSON.stringify(anims)})`),
    fade: () => run('foe.fade()'),
    pin(on) {
      pinned = on;
    },
    moveTo(rect) {
      if (win.isDestroyed()) return;
      bounds = { ...rect };
      win.setBounds(bounds);
    },
    close(afterMs) {
      setTimeout(() => {
        clearInterval(follow);
        if (!win.isDestroyed()) win.destroy();
      }, afterMs);
    },
  };
}

/** 对手窗口的页面（静态；名字、立绘、前缀、滤镜由 openFoeWindow 经 executeJavaScript 送进来） */
export const foePage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>对手</title>
<style>
@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/${encodeURIComponent('上首软糖体')}.ttf") format("truetype");font-display:swap}
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
body{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;font-family:"ShangshouSoftCandy","PingFang SC",sans-serif}
#bubble{position:relative;z-index:1;pointer-events:none;max-width:88%;box-sizing:border-box;padding:7px 12px;margin-bottom:calc(-100vw * ${GUEST_BUBBLE_OVERLAP_RATIO});background:#fff;color:#22313f;border:2px solid #4a5b6c;border-radius:14px;font-size:14px;line-height:1.45;word-break:break-all;opacity:0;transition:opacity .25s}
#bubble.on{opacity:1}
#stage{position:relative;width:100%;aspect-ratio:16/9;display:block;transition:opacity .6s}
#stage.gone{opacity:0}
/* 淘汰（群架）：停在倒地的最后一帧、淡到 30%，留在环上不消失（围成一圈的构图不塌） */
#stage.out{opacity:.3}
/* 朝向：素材原样朝左，朝右时整段镜像。翻转放在外层，动作动画放在 #media 里，两者不抢 transform */
#flip{position:absolute;inset:0}
#flip.right{transform:scaleX(-1)}
#media{position:absolute;inset:0;transform-origin:50% 92%;filter:var(--tint,none)}
#portrait,#video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block}
#portrait{opacity:0}
#portrait.on{opacity:1}
#video{opacity:0;background:transparent}
#video.on{opacity:1}
/* 立绘缺了（§2.1 的兜底）：一个带名字的剪影色块，只为不崩；名字在下面的名牌里 */
#media.silhouette::before{content:"";position:absolute;left:24%;bottom:4%;width:52%;height:82%;border-radius:48% 48% 18% 18%;background:linear-gradient(160deg,rgba(74,91,108,.85),rgba(34,49,63,.72));box-shadow:0 6px 18px rgba(0,0,0,.25)}
#tag{height:20px;margin:calc(-100vw * 9 / 16 * 30 / 360) 0 0;padding:0 9px;border-radius:10px;background:rgba(34,49,63,.72);color:#fff;font-size:12px;line-height:20px;white-space:nowrap}
@keyframes lunge{0%{transform:translateX(0)}38%{transform:translateX(-5%)}100%{transform:translateX(0)}}
@keyframes hit{0%,100%{transform:translateX(0);filter:var(--tint,none)}22%{transform:translateX(-3%);filter:var(--tint,none) brightness(1.45) sepia(1) saturate(5) hue-rotate(-35deg)}55%{transform:translateX(3%)}78%{transform:translateX(-2%)}}
@keyframes dodge{0%,100%{transform:translateX(0)}50%{transform:translateX(7%)}}
@keyframes fall{0%{transform:translateY(0) rotate(0)}100%{transform:translateY(16%) rotate(-18deg)}}
@keyframes jump{0%,100%{transform:translateY(0)}45%{transform:translateY(-4%)}}
#media.lunge{animation:lunge .65s ease}
#media.hit{animation:hit .55s ease}
#media.dodge{animation:dodge .6s ease}
#media.fall{animation:fall 1s ease forwards}
#media.jump{animation:jump .6s ease}
</style></head>
<body><div id="bubble"></div><div id="stage"><div id="flip"><div id="media"><img id="portrait" alt=""><video id="video" muted playsinline autoplay></video></div></div></div><div id="tag"></div>
<script>
'use strict';
const ANIM = '/dsh-pet-7340/thumb/main/';
const actionClass = ${foeActionClass.toString()};
const video = document.getElementById('video');
const portrait = document.getElementById('portrait');
const media = document.getElementById('media');
const stage = document.getElementById('stage');
const flip = document.getElementById('flip');
const bubble = document.getElementById('bubble');
// 预取好的动画（完整名字 → 本地 blob 地址）：开演前取一遍，换源时不用再等网络
const cached = {};
let prefix = '';
let current = '';
let idleName = '';
let hasPortrait = false;
// 倒地后留在原地（群架）：素材结尾会再站起来，所以停在倒下的那一段（见 timeupdate）
let holdDown = false;
let token = 0;
let hideTimer = null;
let fadeTimer = null;
function fullName(name) {
  const text = String(name);
  return prefix && text.indexOf(prefix + '-') !== 0 ? prefix + '-' + text : text;
}
function showPortrait() {
  video.classList.remove('on');
  portrait.classList.add('on');
}
// 没在演动作时：有立绘就显示立绘；群架里的影子没有立绘，循环播待机动画，免得只剩一块剪影
function showIdle() {
  if (!idleName) {
    showPortrait();
    return;
  }
  showPortrait();
  current = idleName;
  clearTimeout(fadeTimer);
  clearAction();
  stage.classList.remove('gone');
  stage.classList.remove('out');
  video.loop = true;
  video.src = cached[idleName] || ANIM + encodeURIComponent(idleName) + '.webm';
  video.playbackRate = 1;
  video.classList.add('on');
  portrait.classList.remove('on');
  // 待机视频顶替剪影：剪影只在既没立绘也没画面时兜底，别让它留在背后当一块色块（还会被换色滤镜染上色）
  media.classList.remove('silhouette');
  video.play().catch(() => fallback(idleName));
}
function clearAction() {
  media.classList.remove('lunge', 'hit', 'dodge', 'fall', 'jump');
}
function fallback(name) {
  showPortrait();
  // 没有立绘时才退回剪影色块（有待机 / 动作画面时上面那一步已经撤掉了）
  if (!hasPortrait) media.classList.add('silhouette');
  clearAction();
  // 待机动画取不到素材：留立绘或剪影站着，不播兜底动作（「待机呼吸休闲」不是出手）
  if (name === idleName) return;
  // 重排一次，保证同一个兜底动作连续播也能从头开始
  void media.offsetWidth;
  const kind = actionClass(name);
  media.classList.add(kind);
  if (kind === 'fall') {
    // CSS 兜底倒地：群架停在倒下的样子（30% 留在环上），1v1 照老样子淡出
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => stage.classList.add(holdDown ? 'out' : 'gone'), 1_000);
  }
}
function play(name, rate) {
  const gen = ++token;
  current = String(name);
  clearTimeout(fadeTimer);
  clearAction();
  stage.classList.remove('gone');
  stage.classList.remove('out');
  const full = fullName(current);
  showPortrait();
  video.classList.add('on');
  portrait.classList.remove('on');
  media.classList.remove('silhouette');
  video.loop = false;
  video.src = cached[full] || ANIM + encodeURIComponent(full) + '.webm';
  // 倍速要在换源之后写：改 src 会走一遍媒体的 load 算法，把 playbackRate 打回默认值
  video.playbackRate = Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 1;
  video.play().catch(() => {
    if (gen === token) fallback(current);
  });
}
// 视频加载失败：退回立绘加 CSS 动作，不报错、不查文件
video.addEventListener('error', () => {
  if (video.classList.contains('on')) fallback(current);
});
// 立绘也缺失：退回一个剪影色块，名字由名牌显示（素材缺了不崩，§2.1）
portrait.addEventListener('error', () => {
  portrait.style.visibility = 'hidden';
  hasPortrait = false;
  media.classList.add('silhouette');
});
// 群架的倒地：素材 5 秒、结尾会再站起来——播到一半（已经倒地）就停住，淡到 30% 留在环上
video.addEventListener('timeupdate', () => {
  if (!holdDown || video.loop || actionClass(current) !== 'fall') return;
  const total = video.duration;
  if (!Number.isFinite(total) || total <= 0) return;
  if (video.currentTime / total < 0.5) return;
  video.pause();
  stage.classList.add('out');
});
video.addEventListener('ended', () => {
  if (actionClass(current) === 'fall') {
    if (holdDown) {
      // 没赶上 timeupdate（例如倍速播放一帧跨过）：停在这一帧、淡到 30%
      stage.classList.add('out');
      return;
    }
    // 1v1 的老样子：停在最后一帧，过一会儿淡出
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => stage.classList.add('gone'), 400);
  } else {
    showIdle();
  }
});
window.foe = {
  setup(data) {
    document.getElementById('tag').textContent = String(data.name ?? '');
    prefix = String(data.prefix ?? '');
    idleName = String(data.idle ?? '');
    holdDown = data.holdDown === true;
    const filter = String(data.filter ?? '').trim();
    const glow = data.elite ? 'drop-shadow(0 0 5px #f5c542) drop-shadow(0 0 11px #f5c542)' : '';
    media.style.setProperty('--tint', [filter, glow].filter(Boolean).join(' ') || 'none');
    portrait.style.visibility = '';
    media.classList.remove('silhouette');
    hasPortrait = Boolean(data.portrait);
    if (data.portrait) portrait.src = String(data.portrait);
    else media.classList.add('silhouette');
    flip.classList.toggle('right', data.facing === 'right');
    showIdle();
  },
  face(facing) {
    flip.classList.toggle('right', facing === 'right');
  },
  say(text, duration) {
    bubble.textContent = String(text);
    bubble.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bubble.classList.remove('on'), Number(duration) || 10000);
  },
  play(name, rate) {
    play(name, rate);
  },
  preload(names) {
    for (const raw of Array.isArray(names) ? names : []) {
      const name = fullName(raw);
      if (cached[name]) continue;
      fetch(ANIM + encodeURIComponent(name) + '.webm')
        .then((res) => (res.ok ? res.blob() : null))
        .then((blob) => {
          if (blob) cached[name] = URL.createObjectURL(blob);
        })
        .catch(() => undefined);
    }
  },
  fade() {
    stage.classList.add('gone');
  },
};
</script></body></html>
`;
