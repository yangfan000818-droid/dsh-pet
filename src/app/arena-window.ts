/**
 * 擂台窗口（修炼路线 X3）：一只透明、置顶、不可聚焦、鼠标穿透的小窗，只画两条气血条、名字和境界——
 * 谁打谁、打到多少血，隔着半个屏幕也看得见。
 *
 * 两条血**各自贴在自己宠物的正头顶**（横向对准舞台中心、底边离头顶 2px），窗口只包住这两小段：
 * 中间整段透明，不再一条长血横穿屏幕、把别的窗口里的字挡住。宠物走位时 `place()` 重算两段的位置，
 * 窗口跟着这两个点伸缩。
 *
 * 血条要让位给宠物和对话气泡：窗口显示后把宠物 / 对手窗口提到同一层的前面（见 `raisePetWindows`），
 * 气泡文字压在血条上也不挡字。
 *
 * 页面走本机服务的 `GET /app/arena`（和 /app/note、/app/guest 同法，见 app-routes.ts）；数据由这里经
 * `executeJavaScript` 送进页面，一律 `JSON.stringify` 成字面量，页面只用 textContent 与 style 显示。
 */
import { GUEST_TAG_ROOM, type PetBox, type Rect, type WindowElectron, type WindowLike } from './visit-windows';

/** 面板锚点的高度（`arenaBounds` 用；血条窗本身只包住两条血） */
export const ARENA_HEIGHT = 62;
/** 窗口在两条血四周留的边 */
const PAD = 8;
/** 名字那一行的高度 */
const LABEL = 15;
/** 血条高度 */
const BAR = 9;
/** 名字和血条之间的缝 */
const ROW_GAP = 2;
/** 一条血（连名字）占的宽度：只盖住自己宠物头顶这一小段，两条之间留空 */
export const ARENA_COLUMN_WIDTH = 160;
/** 一条血（名字 + 缝 + 血条）的高度 */
export const ARENA_ROW_HEIGHT = LABEL + ROW_GAP + BAR;
/** 血条底边离头顶的缝 */
const HEAD_GAP = 2;
/** 只有一只宠物时，两条血并排的间隔 */
const PAIR_GAP = 16;
/**
 * 640×360 舞台里**看得见的头顶**的比例（不是 HIT_BOX 的 50/360——那是可点区域，比发梢还高 12px）：
 * 待机呼吸休闲逐帧量下来发梢顶在 59–64，取 62，血条底边正好落在头顶。
 */
const HEAD_TOP_RATIO = 62 / 360;
/** 锚点窗口横向比两只宠物的外沿各多让开这么多（只给面板定位用） */
const SIDE_ROOM = 12;
/** 锚点宽度夹在 200–520：太窄名字放不下，太宽就飞到别的屏上去了 */
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;

/** 一条血显示什么：名字 · 境界，加上还剩几成 */
export interface ArenaBar {
  label: string;
  hp: number;
  maxHp: number;
}

/** `arena.update(...)` 的载荷：左、右两条（谁在左由调用方按两只宠物的实际位置定） */
export interface ArenaUpdate {
  left: { label: string; percent: number };
  right: { label: string; percent: number };
}

/**
 * 血条的百分比：上限非法（0、NaN）或血没了当空血，绝不画成满的。
 * 赢的一方 100，躺下的那位 0。
 */
export function hpPercent(hp: number, maxHp: number): number {
  if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0 || hp <= 0) return 0;
  return Math.min(100, Math.round((hp / maxHp) * 100));
}

/** 两条血 → 页面要的载荷（百分比在这里算好，页面只管画宽度，不重复一套数学） */
export function arenaUpdate(left: ArenaBar, right: ArenaBar): ArenaUpdate {
  return {
    left: { label: left.label, percent: hpPercent(left.hp, left.maxHp) },
    right: { label: right.label, percent: hpPercent(right.hp, right.maxHp) },
  };
}

/**
 * 擂台锚点：横向盖住两只宠物（自家宠物的包围盒 + 对手窗口的位置），纵向在它们头顶上方。
 * 只给面板定位和 `bounds()` 用——真正画血的窗口见 `arenaRows`。对手窗口还没位置（还没开）时按自家宠物排。
 */
export function arenaBounds(home: PetBox | null, foe: Rect | null, workArea: Rect): Rect {
  const span: number[] = [];
  if (home) span.push(home.left, home.left + home.size);
  if (foe) span.push(foe.x, foe.x + foe.width);
  if (span.length === 0) span.push(workArea.x + workArea.width / 2 - 150, workArea.x + workArea.width / 2 + 150);
  const center = (Math.min(...span) + Math.max(...span)) / 2;
  const width = Math.round(
    Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.max(...span) - Math.min(...span) + 2 * SIDE_ROOM)),
  );
  const x = Math.round(Math.min(Math.max(center - width / 2, workArea.x), workArea.x + workArea.width - width));
  const top = home ? home.top : workArea.y + 100;
  const y = Math.round(
    Math.min(Math.max(top - ARENA_HEIGHT - 6, workArea.y), workArea.y + workArea.height - ARENA_HEIGHT),
  );
  return { x, y, width, height: ARENA_HEIGHT };
}

/** 两条血各自的位置（屏幕坐标）和包住它们的窗口 */
export interface ArenaRows {
  left: Rect;
  right: Rect;
  bounds: Rect;
}

/** 页面里两条血的相对位置（相对窗口左上角） */
export interface ArenaPlace {
  left: { x: number; y: number };
  right: { x: number; y: number };
}

/** 一条血在宠物头顶的位置：横向对准舞台中心，血条底边离头顶 HEAD_GAP */
function barRow(centerX: number, headTop: number, workArea: Rect): Rect {
  const width = ARENA_COLUMN_WIDTH;
  const height = ARENA_ROW_HEIGHT;
  const x = Math.round(Math.min(Math.max(centerX - width / 2, workArea.x), workArea.x + workArea.width - width));
  const y = Math.round(
    Math.min(Math.max(headTop - HEAD_GAP - height, workArea.y), workArea.y + workArea.height - height),
  );
  return { x, y, width, height };
}

/** 自家宠物的头顶点：包围盒在舞台里下移了 bottomPad，发梢顶在舞台 HEAD_TOP_RATIO 处 */
function homeHeadTop(home: PetBox): number {
  return home.top + home.bottomPad + ((home.size * 9) / 16) * HEAD_TOP_RATIO;
}

/** 客人窗口里头顶点：舞台贴窗口底（上面留气泡空间），口径同 visit-windows 的 petHitRect */
function foeHeadTop(foe: Rect): number {
  const videoHeight = (foe.width * 9) / 16;
  const stageTop = foe.y + foe.height - GUEST_TAG_ROOM - videoHeight;
  return stageTop + videoHeight * HEAD_TOP_RATIO;
}

/**
 * 两条血的位置：各自贴在自己宠物的正头顶（屏幕左边那条是 left）。
 * 对手窗口还没开时两条并排放在自家宠物头上，等对手出现再分开。
 */
export function arenaRows(home: PetBox | null, foe: Rect | null, workArea: Rect): ArenaRows {
  const homeCenter = home ? home.left + home.size / 2 : null;
  const foeCenter = foe ? foe.x + foe.width / 2 : null;
  const homeRow = home ? barRow(homeCenter ?? 0, homeHeadTop(home), workArea) : null;
  const foeRow = foe ? barRow(foeCenter ?? 0, foeHeadTop(foe), workArea) : null;
  let left: Rect;
  let right: Rect;
  if (homeRow && foeRow && homeCenter != null && foeCenter != null) {
    [left, right] = homeCenter <= foeCenter ? [homeRow, foeRow] : [foeRow, homeRow];
  } else if (homeRow || foeRow) {
    // 只有一边：两条并排，免得第二条跑到没人的地方去
    const one = (homeRow ?? foeRow) as Rect;
    const center = homeCenter ?? foeCenter ?? one.x + one.width / 2;
    const head = home ? homeHeadTop(home) : foeHeadTop(foe as Rect);
    left = barRow(center - (ARENA_COLUMN_WIDTH + PAIR_GAP) / 2, head, workArea);
    right = barRow(center + (ARENA_COLUMN_WIDTH + PAIR_GAP) / 2, head, workArea);
  } else {
    const center = workArea.x + workArea.width / 2;
    const head = workArea.y + 100 + ARENA_ROW_HEIGHT;
    left = barRow(center - (ARENA_COLUMN_WIDTH + PAIR_GAP) / 2, head, workArea);
    right = barRow(center + (ARENA_COLUMN_WIDTH + PAIR_GAP) / 2, head, workArea);
  }
  const x0 = Math.min(left.x, right.x) - PAD;
  const y0 = Math.min(left.y, right.y) - PAD;
  const x1 = Math.max(left.x + left.width, right.x + right.width) + PAD;
  const y1 = Math.max(left.y + left.height, right.y + right.height) + PAD;
  const bounds = { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0) };
  return { left, right, bounds };
}

/** 两条血相对窗口左上角的位置 */
export function arenaPlacement(rows: ArenaRows): ArenaPlace {
  return {
    left: { x: rows.left.x - rows.bounds.x, y: rows.left.y - rows.bounds.y },
    right: { x: rows.right.x - rows.bounds.x, y: rows.right.y - rows.bounds.y },
  };
}

/**
 * 一场的血条：两只的名字、境界与气血上限整场不变，每步只喂引擎的 hp 数组。
 * `foeOnLeft` = 对手（心魔 / 客人）站在自家宠物左边：那它那条血在左边。
 * 百分比和左右排布都在这算，features.ts 只把它接到执行器的 arena 那一只手。
 */
export function arenaScoreboard(info: {
  self: { label: string; maxHp: number };
  foe: { label: string; maxHp: number };
}): (hp: [number, number], foeOnLeft: boolean) => ArenaUpdate {
  return (hp, foeOnLeft) => {
    const self = { label: info.self.label, hp: hp[0], maxHp: info.self.maxHp };
    const foe = { label: info.foe.label, hp: hp[1], maxHp: info.foe.maxHp };
    return foeOnLeft ? arenaUpdate(foe, self) : arenaUpdate(self, foe);
  };
}

/** 送进页面的数据一律 JSON.stringify 成字面量：擂台上的名字只当字符串，页面用 textContent 显示 */
export function arenaUpdateCode(update: ArenaUpdate): string {
  return `arena.update(${JSON.stringify(update)})`;
}

/** 两条血各自摆在哪（相对窗口），同样是 JSON 字面量 */
export function arenaPlaceCode(place: ArenaPlace): string {
  return `arena.place(${JSON.stringify(place)})`;
}

export interface ArenaWindow {
  /** 重摆位置（宠物走位了、对手窗口挪了）；算出来没变就什么都不发 */
  place(home: PetBox | null, foe: Rect | null): void;
  /** 刷新两条血 */
  update(update: ArenaUpdate): void;
  /** 现在的位置与大小（对手窗口按它排血条左右） */
  bounds(): Rect;
  /** 过一会儿关掉（先让结果那几步放完） */
  close(afterMs: number): void;
  /** 钉住 / 放开（X16 冲刺）：钉住时按开场站位摆，不跟着两只的实时位置走 */
  pin(on: boolean): void;
  /** 显示 / 收起两条血（选方式时不亮，正式开演才亮）；页面没加载完时先记下目标状态 */
  setVisible(visible: boolean): void;
}

/** 开擂台窗口的选项：默认加载完就显示，心魔 / 切磋选方式时传 `initiallyVisible: false` */
export interface ArenaWindowOptions {
  initiallyVisible?: boolean;
}

/** 血条要让位：把宠物 / 对手窗口提到同一层的最前面，气泡文字压住血条也不挡字 */
function raisePetWindows(electron: WindowElectron, own: WindowLike): void {
  const all = electron.BrowserWindow.getAllWindows ? electron.BrowserWindow.getAllWindows() : [];
  for (const other of all) {
    if (other === own || other.isDestroyed()) continue;
    const url = other.webContents.getURL();
    // 自家宠物（helper 页面带 petIndex）、串门 / 心魔的客人、历练的对手：都有会盖住血条的气泡
    if (!url.includes('petIndex=') && !url.includes('/app/guest') && !url.includes('/app/foe')) continue;
    other.moveTop?.();
  }
}

/**
 * 开擂台窗口。
 * @param electron 只用到 BrowserWindow / screen
 * @param pageUrl 本机服务的 /app/arena
 * @param home 取自家宠物现在的位置（watchHomePet 的 box）
 * @param foe 取对手窗口现在的位置（没开或不知道就只按自家宠物排）
 * @param options 初始可见性；缺省加载完就显示（历练等旧调用方行为不变）
 */
export function openArenaWindow(
  electron: WindowElectron,
  pageUrl: string,
  home: () => PetBox | null,
  foe: () => Rect | null,
  options: ArenaWindowOptions = {},
): ArenaWindow {
  const workAreaOf = (box: PetBox | null): Rect => {
    const point = box
      ? { x: box.left + box.size / 2, y: box.top + box.size / 4 }
      : electron.screen.getCursorScreenPoint();
    return electron.screen.getDisplayNearestPoint(point).workArea;
  };
  let lastHome = home();
  let lastFoe = foe();
  let area = workAreaOf(lastHome);
  let anchor = arenaBounds(lastHome, lastFoe, area);
  const rows = arenaRows(lastHome, lastFoe, area);
  let bounds = rows.bounds;
  let placementKey = JSON.stringify(arenaPlacement(rows));
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
      // 被宠物窗口挡住时也不能停：血条要跟着动
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 纯显示：整窗鼠标穿透，点它跟点桌面一样（不抢主人干活）
  win.setIgnoreMouseEvents(true);
  let ready = false;
  let pinned = false;
  /** 目标可见性：load 前调 setVisible 只改这里，加载完再按它决定要不要 showInactive */
  let visible = options.initiallyVisible !== false;
  const queued: string[] = [];
  const run = (code: string): void => {
    if (win.isDestroyed()) return;
    if (!ready) queued.push(code);
    else void win.webContents.executeJavaScript(code).catch(() => undefined);
  };
  // 先摆好两条血的位置，页面一加载完就摆上（不用等第一次 place）
  run(arenaPlaceCode(arenaPlacement(rows)));
  void win
    .loadURL(pageUrl)
    .then(() => {
      if (win.isDestroyed()) return;
      // 透明窗口没有可闪的底色，加载完再显示即可（不抢焦点）；
      // initiallyVisible: false 或加载前 setVisible(false) 过的，这里就不亮，等正式开演再 setVisible(true)
      if (visible) win.showInactive();
      ready = true;
      for (const code of queued.splice(0)) run(code);
      // 血条垫在宠物 / 对手窗口下面：气泡文字可以压住它
      raisePetWindows(electron, win);
    })
    .catch(() => win.destroy());
  return {
    place(nextHome, nextFoe) {
      if (pinned) return;
      const nextFoeRect = nextFoe ?? null;
      lastHome = nextHome;
      lastFoe = nextFoeRect;
      area = workAreaOf(nextHome);
      anchor = arenaBounds(nextHome, nextFoeRect, area);
      const next = arenaRows(nextHome, nextFoeRect, area);
      if (
        next.bounds.x !== bounds.x ||
        next.bounds.y !== bounds.y ||
        next.bounds.width !== bounds.width ||
        next.bounds.height !== bounds.height
      ) {
        bounds = next.bounds;
        if (!win.isDestroyed()) win.setBounds(bounds);
      }
      const placement = arenaPlacement(next);
      const key = JSON.stringify(placement);
      if (key === placementKey) return;
      placementKey = key;
      run(arenaPlaceCode(placement));
    },
    update: (update) => run(arenaUpdateCode(update)),
    bounds: () => anchor,
    pin(on) {
      pinned = on;
    },
    setVisible(next) {
      visible = next;
      // 还没加载完：只记目标状态，加载完由 load 的回调按它显示（不能先亮一下再收）
      if (!ready || win.isDestroyed()) return;
      if (next) win.showInactive();
      else win.hide?.();
    },
    close(afterMs) {
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, afterMs);
    },
  };
}

/** 擂台窗口的页面（静态；两条血的名字与百分比由 openArenaWindow 经 executeJavaScript 送进来） */
export const arenaPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>擂台</title>
<style>
@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/${encodeURIComponent('上首软糖体')}.ttf") format("truetype");font-display:swap}
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
body{position:relative;font-family:"ShangshouSoftCandy","PingFang SC",sans-serif}
/* 两条血各自贴在自己宠物头顶（位置由 arena.place 送进来）；右边那条名字靠右、血从右边涨 */
.row{position:absolute;left:0;top:0;display:flex;flex-direction:column;gap:${ROW_GAP}px;width:${ARENA_COLUMN_WIDTH}px}
.row.right{align-items:flex-end}
.label{height:${LABEL}px;font-size:12px;line-height:${LABEL}px;color:#fff;text-shadow:0 1px 2px rgba(20,24,32,.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.bar{width:100%;height:${BAR}px;box-sizing:border-box;border:1px solid rgba(255,255,255,.85);border-radius:5px;background:rgba(20,24,32,.45);overflow:hidden;display:flex}
.fill{height:100%;width:100%;background:linear-gradient(#7fe08a,#2f9e4b);transition:width .3s}
.row.right .fill{margin-left:auto}
/* 血少于两成变红：隔半个屏幕也看得出谁快撑不住了 */
.fill.low{background:linear-gradient(#ff9a8a,#dd3333)}
</style></head>
<body>
<div class="row left" id="row-left"><div class="label" id="l0"></div><div class="bar"><div class="fill" id="f0"></div></div></div>
<div class="row right" id="row-right"><div class="label" id="l1"></div><div class="bar"><div class="fill" id="f1"></div></div></div>
<script>
'use strict';
// 只认 textContent 与 style：送进来的名字和数字都当字符串数据，绝不拼进 HTML
window.arena = {
  update(state) {
    const sides = [state.left, state.right];
    for (let i = 0; i < 2; i++) {
      const side = sides[i] || { label: '', percent: 0 };
      const percent = Math.max(0, Math.min(100, Number(side.percent)));
      document.getElementById('l' + i).textContent = String(side.label);
      const fill = document.getElementById('f' + i);
      fill.style.width = percent + '%';
      fill.classList.toggle('low', percent < 20);
    }
  },
  // 两条血各自摆在哪（相对窗口左上角；主进程算好，页面只写 style.left / top）
  place(pos) {
    for (const side of ['left', 'right']) {
      const at = pos && pos[side];
      const row = document.getElementById('row-' + side);
      if (!at || !row) continue;
      const x = Number(at.x);
      const y = Number(at.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      row.style.left = x + 'px';
      row.style.top = y + 'px';
    }
  },
};
</script></body></html>
`;
