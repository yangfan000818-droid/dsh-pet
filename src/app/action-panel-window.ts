/**
 * 出招面板（修炼路线 X17）：擂台下面一只透明、置顶、不抢焦点但**能点**的小窗。
 *
 * 只在两个时候出现，其余时间关掉：
 *   - 开打前选方式：「自动 / AI 出招 / 手动」，10 秒不点按自动；
 *   - 手动出招轮到自家：「法宝名 / 招式名（有次数的标剩几次）」，20 秒不点按后备挑法出。
 *
 * 页面走本机服务的 `GET /app/panel`（同 /app/arena 的做法，见 app-routes.ts），数据由这里经
 * `executeJavaScript` 送进页面，一律 `JSON.stringify` 成字面量，页面只用 textContent 建按钮。
 * 页面里的点击 POST 本机接口 `/app/battle/choose` —— 同一个接口也能用 curl 驱动（真机核验用），
 * 所以这里不开 preload、不开 IPC。
 *
 * 可点但不抢焦点：`focusable: false` + `acceptFirstMouse: true` + `showInactive()`；鼠标点按钮不会把主人正在打字的输入框顶掉。
 */
import type { PetBox, Rect, WindowElectron, WindowLike } from './visit-windows';
import type { ActionTone } from './battle-live';

/** 出招方式（X17）：自动照旧整场算好；AI / 手动逐手出招 */
export type TurnMode = 'auto' | 'ai' | 'manual';

/** 卡片的最小高度（真实高度按说明文字撑开，这里只用来估一个不会太小的初值） */
const CARD_HEIGHT = 34;
const GROUP_HEIGHT = 12;
const GRID_GAP = 6;
const CARD_MIN_WIDTH = 140;
/** 按钮之外的部分：上下内边距 7 + 标题 16 + 两处间距 5 + 3px 倒计时条 */
const CHROME_HEIGHT = 7 + 16 + 5 + 3 + 5 + 7;
/** 无选项和选方式都只留一行卡片的位置 */
export const PANEL_HEIGHT = CHROME_HEIGHT + CARD_HEIGHT;
/** 招多的时候最多这么高，再多就在窗内滚动 */
export const PANEL_MAX_HEIGHT = 420;
/** 面板和擂台之间留一点缝 */
const GAP = 4;
const TONE_ORDER: readonly ActionTone[] = ['damage', 'control', 'sustain'];

/**
 * 按分组标题和卡片行数估一个**下限高度**（每张卡至少 34px）：长说明会把卡片撑高，估算只是初值，
 * 真正高度以页面 `contentHeight()` 实测为准，最终仍夹在 `PANEL_MAX_HEIGHT` 内、超出才滚动。
 * 每组单独起行。
 */
export function panelHeight(view: PanelView | null, width: number): number {
  if (!view || view.options.length === 0) return PANEL_HEIGHT;
  // 选方式 / 应战确认也走同一套网格：4 个选项（自动 / AI / 手动 / 不应战）要排两行
  if (view.kind === 'mode') {
    const columns = Math.max(1, Math.floor((Math.max(1, width - 18) + GRID_GAP) / (90 + GRID_GAP)));
    const rows = Math.ceil(view.options.length / columns);
    const height = CHROME_HEIGHT + rows * CARD_HEIGHT + Math.max(0, rows - 1) * GRID_GAP;
    return Math.min(Math.max(height, PANEL_HEIGHT), PANEL_MAX_HEIGHT);
  }
  const usable = Math.max(1, width - 18);
  const columns = Math.max(1, Math.floor((usable + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP)));
  const sections = [
    { options: view.options.filter((option) => option.tone === undefined), grouped: false },
    ...TONE_ORDER.map((tone) => ({
      options: view.options.filter((option) => option.tone === tone),
      grouped: true,
    })),
  ].filter((section) => section.options.length > 0);
  const rows = sections.reduce((total, section) => total + Math.ceil(section.options.length / columns), 0);
  const groups = sections.filter((section) => section.grouped).length;
  const tracks = rows + groups;
  const height = CHROME_HEIGHT + rows * CARD_HEIGHT + groups * GROUP_HEIGHT + Math.max(0, tracks - 1) * GRID_GAP;
  return Math.min(Math.max(height, PANEL_HEIGHT), PANEL_MAX_HEIGHT);
}

/** 两个矩形有没有重叠 */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 一个按钮：`pick` 从 1 数（和 AI 回的 JSON、curl 的 pick 同一口径） */
export interface PanelOption {
  pick: number;
  label: string;
  /** 有次数的招式标剩几次 */
  note?: string;
  effect?: string;
  tone?: ActionTone;
  /** 模型没配好时「AI 出招」灰掉 */
  disabled?: boolean;
}

/** 送进页面的整份状态 */
export interface PanelView {
  kind: 'mode' | 'action';
  title: string;
  seconds: number;
  options: PanelOption[];
}

/** 手动出招时的一项（面板按钮与 AI 的编号清单共用一份） */
export interface PanelAction {
  label: string;
  note?: string;
  effect?: string;
  tone?: ActionTone;
}

/** 手动出招面板的可选项：标题给调用方标「主动技剩 X 次」之类的口径 */
export interface ChooseActionOptions {
  title?: string;
}

/** 选方式面板的文案 / 超时：应战类还要一个「不应战」，超时也按不应战算 */
export interface TurnModePrompt {
  title?: string;
  declineLabel?: string;
  /** 超时按第几项算；缺省「不应战」= 4，否则自动 = 1；null = 不选 */
  timeoutPick?: number | null;
}

interface Question {
  kind: 'mode' | 'action';
  view: PanelView;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 点了 / 超时 / 关窗时结算；`null` = 没选（关窗） */
  resolve: (pick: number | null) => void;
}

export interface ActionPanelWindow {
  /** 重摆位置（擂台跟着宠物挪了）：算出来没变就什么都不发 */
  place(arena: Rect): void;
  /** 开打前选方式；10 秒（`timeoutMs`）不点回 `'auto'`，面板被关掉回 `null`。
   *  应战确认传 `declineLabel`：多一个「不应战」，超时也按不应战。 */
  chooseMode(aiReady: boolean, timeoutMs: number, prompt?: TurnModePrompt): Promise<TurnMode | null>;
  /** 两三项的纯确认（如「应战 / 不应战」）：回 pick（从 1 数），超时 / 关窗回 null */
  choosePrompt(title: string, labels: string[], timeoutMs: number): Promise<number | null>;
  /** 手动出招：等到点了回 `pick - 1`（0 起的下标），超时（`timeoutMs`）/ 关窗回 `null`。
   *  第三参可传标题（或 `{ title }`），给「主动技剩 X 次」这类口径；缺省「轮到你了，出一手」。 */
  chooseAction(
    actions: PanelAction[],
    timeoutMs: number,
    options?: ChooseActionOptions | string,
  ): Promise<number | null>;
  /** 模拟一次点击（curl 与本机接口用）：`pick` 从 1 数；现在没有等待的选择回 false */
  choose(pick: number): boolean;
  /** 当前等待的选择（GET /app/battle 调试用）；没有就 null */
  state(): PanelView | null;
  /** 收摊 / 退出：关窗，等着的选择按「没选」结算 */
  close(): void;
}

/**
 * 面板的位置：横向跟擂台一样宽，纵向挂在擂台下面；下面放不下就贴着工作区底边。
 * 不知道擂台在哪（还没开）时放在工作区上方居中。
 * 这样放会压到宠物（宠物在屏幕顶上时擂台也只能贴顶，面板正好盖住两只）：改放到两只宠物下面，
 * 再不行放到擂台上面；都放不下才照原样（`pets` 是两只宠物现在的位置）。
 */
export function panelBounds(
  arena: Rect | null,
  workArea: Rect,
  height: number = PANEL_HEIGHT,
  pets: readonly Rect[] = [],
): Rect {
  const width = Math.min(arena?.width ?? 320, workArea.width);
  const x = Math.round(
    Math.min(
      Math.max(arena ? arena.x + (arena.width - width) / 2 : workArea.x + workArea.width / 2 - width / 2, workArea.x),
      workArea.x + workArea.width - width,
    ),
  );
  const below = arena ? arena.y + arena.height + GAP : workArea.y + 120;
  const y = Math.round(Math.min(Math.max(below, workArea.y), workArea.y + workArea.height - height));
  const at = (top: number): Rect => ({ x, y: Math.round(top), width, height });
  const clear = (rect: Rect): boolean => pets.every((pet) => !overlaps(rect, pet));
  const fits = (rect: Rect): boolean => rect.y >= workArea.y && rect.y + rect.height <= workArea.y + workArea.height;
  if (clear(at(y))) return at(y);
  const alternatives = [
    ...(pets.length > 0 ? [Math.max(...pets.map((pet) => pet.y + pet.height)) + GAP] : []),
    ...(arena ? [arena.y - GAP - height] : []),
  ].map(at);
  return alternatives.find((rect) => fits(rect) && clear(rect)) ?? at(y);
}

/** 建面板窗口；`arena` 取擂台现在的位置（还没开时回 null） */
export function openActionPanel(
  electron: WindowElectron,
  pageUrl: string,
  arena: () => Rect | null,
  home: () => PetBox | null,
  foe: () => Rect | null = () => null,
): ActionPanelWindow {
  const workAreaOf = (): Rect => {
    const box = home();
    const point = box
      ? { x: box.left + box.size / 2, y: box.top + box.size / 4 }
      : electron.screen.getCursorScreenPoint();
    return electron.screen.getDisplayNearestPoint(point).workArea;
  };
  /** 两只宠物现在的位置：面板别压在它们身上 */
  const pets = (): Rect[] => {
    const box = home();
    const rects: Rect[] = box ? [{ x: box.left, y: box.top, width: box.size, height: box.size }] : [];
    const other = foe();
    if (other) rects.push(other);
    return rects;
  };
  /** 面板现在该多高（跟着这一问的按钮数），以及最近一次擂台的位置 */
  let height = PANEL_HEIGHT;
  let lastArena = arena();
  let bounds = panelBounds(lastArena, workAreaOf(), height, pets());
  const win: WindowLike = new electron.BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // 可点，但不拿焦点：主人正在打字时弹出来也不抢输入框
    focusable: false,
    // 窗口拿不到焦点，macOS 上点下去只当「激活窗口」、不传给页面：没有这项按钮永远点不上（选方式超时落回自动）
    acceptFirstMouse: true,
    enableLargerThanScreen: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  let ready = false;
  const queued: string[] = [];
  const run = (code: string): void => {
    if (win.isDestroyed()) return;
    if (!ready) queued.push(code);
    else void win.webContents.executeJavaScript(code).catch(() => undefined);
  };
  let current: Question | null = null;
  const settle = (pick: number | null): void => {
    const question = current;
    if (!question) return;
    current = null;
    if (question.timer !== null) clearTimeout(question.timer);
    run('panel.hide()');
    if (!win.isDestroyed()) win.hide?.();
    question.resolve(pick);
  };
  /**
   * 按页面实际排出来的高度校正：按钮的字体、字号以页面为准，`panelHeight` 的估算只当初值。
   * 量回来时这一问已经换了（点了 / 超时）就不动。
   */
  const measure = (): void => {
    const view = current?.view;
    if (!view || !ready || win.isDestroyed()) return;
    void win.webContents
      // 宽度直接传进去：刚 setBounds 时页面可能还没收到新尺寸，按旧宽度排出来的高度不对（真机踩过）
      .executeJavaScript(`panel.contentHeight(${bounds.width})`)
      .then((value) => {
        if (current?.view !== view || win.isDestroyed() || typeof value !== 'number' || !Number.isFinite(value)) return;
        const next = Math.min(Math.max(Math.ceil(value), PANEL_HEIGHT), PANEL_MAX_HEIGHT);
        if (next === height) return;
        height = next;
        bounds = panelBounds(lastArena, workAreaOf(), height, pets());
        win.setBounds(bounds);
      })
      .catch(() => undefined);
  };
  const ask = (
    view: PanelView,
    timeoutMs: number,
    missing: number | null,
    timeoutPick: number | null,
  ): Promise<number | null> => {
    settle(null); // 上一问还没收尾（正常不会）：先按没选结算，免得两个 Promise 都挂着
    // 宽跟着擂台走；高先按这一问的按钮数估，避开两只宠物摆好位置再亮出来，亮出来以后再量实际高度
    const work = workAreaOf();
    height = panelHeight(view, panelBounds(lastArena, work).width);
    bounds = panelBounds(lastArena, work, height, pets());
    if (!win.isDestroyed()) win.setBounds(bounds);
    const wait = Math.max(1, timeoutMs);
    return new Promise<number | null>((resolve) => {
      const question: Question = {
        kind: view.kind,
        view,
        deadline: Date.now() + wait,
        timer: null,
        resolve: (pick) => resolve(pick ?? missing),
      };
      current = question;
      question.timer = setTimeout(() => {
        if (current !== question) return;
        current = null;
        run('panel.hide()');
        resolve(timeoutPick);
      }, wait);
      run(`panel.show(${JSON.stringify(view)})`);
      if (ready && !win.isDestroyed()) win.showInactive();
      measure();
    });
  };
  void win
    .loadURL(pageUrl)
    .then(() => {
      if (win.isDestroyed()) return;
      win.showInactive();
      ready = true;
      for (const code of queued.splice(0)) run(code);
      measure();
    })
    .catch(() => win.destroy());
  return {
    place(nextArena) {
      lastArena = nextArena;
      const next = panelBounds(nextArena, workAreaOf(), height, pets());
      if (next.x === bounds.x && next.y === bounds.y && next.width === bounds.width && next.height === bounds.height)
        return;
      const widened = next.width !== bounds.width;
      bounds = next;
      if (!win.isDestroyed()) win.setBounds(bounds);
      // 擂台变宽 / 变窄了：按钮会重新换行，再量一次
      if (widened) measure();
    },
    chooseMode(aiReady, timeoutMs, prompt = {}) {
      const options: PanelOption[] = [
        { pick: 1, label: '自动' },
        { pick: 2, label: 'AI 出招', ...(aiReady ? {} : { disabled: true, note: '模型没配好' }) },
        { pick: 3, label: '手动' },
      ];
      if (prompt.declineLabel) options.push({ pick: 4, label: prompt.declineLabel });
      const view: PanelView = {
        kind: 'mode',
        title: prompt.title ?? (aiReady ? '这一场怎么出招？' : '这一场怎么出招？（模型没配好）'),
        seconds: Math.max(1, Math.ceil(timeoutMs / 1_000)),
        options,
      };
      const timeoutPick = prompt.timeoutPick !== undefined ? prompt.timeoutPick : prompt.declineLabel ? 4 : 1;
      return ask(view, timeoutMs, null, timeoutPick).then((pick) =>
        pick === 1 ? 'auto' : pick === 2 ? 'ai' : pick === 3 ? 'manual' : null,
      );
    },
    choosePrompt(title, labels, timeoutMs) {
      const view: PanelView = {
        kind: 'mode',
        title,
        seconds: Math.max(1, Math.ceil(timeoutMs / 1_000)),
        options: labels.map((label, index) => ({ pick: index + 1, label })),
      };
      return ask(view, timeoutMs, null, null);
    },
    chooseAction(actions, timeoutMs, options = {}) {
      const rank = (tone: ActionTone | undefined): number => (tone === undefined ? -1 : TONE_ORDER.indexOf(tone));
      const title = (typeof options === 'string' ? options : options.title) ?? '轮到你了，出一手';
      const view: PanelView = {
        kind: 'action',
        title,
        seconds: Math.max(1, Math.ceil(timeoutMs / 1_000)),
        options: actions
          .map((action, index) => ({
            pick: index + 1,
            label: action.label,
            ...(action.note === undefined ? {} : { note: action.note }),
            ...(action.effect === undefined ? {} : { effect: action.effect }),
            ...(action.tone === undefined ? {} : { tone: action.tone }),
          }))
          .sort((a, b) => rank(a.tone) - rank(b.tone)),
      };
      return ask(view, timeoutMs, null, null).then((pick) => (pick === null ? null : pick - 1));
    },
    choose(pick) {
      const question = current;
      if (!question) return false;
      const option = question.view.options.find((item) => item.pick === pick);
      if (!option || option.disabled) return false;
      settle(pick);
      return true;
    },
    state: () => current?.view ?? null,
    close() {
      settle(null);
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

/** 出招面板的页面（静态；选项与倒计时由 openActionPanel 经 executeJavaScript 送进来） */
export const panelPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>出招</title>
<style>
@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/${encodeURIComponent('上首软糖体')}.ttf") format("truetype");font-display:swap}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;font-family:"ShangshouSoftCandy","PingFang SC",sans-serif}
body{padding:7px 9px;border-radius:12px;background:#f7f2e7;box-shadow:0 3px 10px rgba(43,42,38,.24);display:flex;flex-direction:column;gap:5px;color:#2b2a26}
#titleRow{display:flex;align-items:center;gap:8px;height:16px;flex:none}
#title{flex:1;min-width:0;font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#timer{flex:none;font-size:11px;line-height:16px;color:#6b6254;font-variant-numeric:tabular-nums}
#progress{height:3px;border-radius:2px;background:#e3d8c4;overflow:hidden;flex:none}
#progressFill{width:100%;height:100%;background:#3f7d5a;transform-origin:left}
#buttons{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px;overflow-y:auto;overflow-x:hidden;min-height:0}
#buttons.mode{grid-template-columns:repeat(auto-fit,minmax(90px,1fr))}
.group{grid-column:1 / -1;display:flex;align-items:center;gap:5px;height:12px;min-width:0;font-size:11px;line-height:12px;color:#6b6254;white-space:nowrap}
.group::before{content:"";width:6px;height:6px;border-radius:50%;flex:none}
.group.damage::before{background:#b23b32}
.group.control::before{background:#4a5f9e}
.group.sustain::before{background:#3f7d5a}
button{font-family:inherit;color:#2b2a26;background:#fffaf0;border:1px solid #cdbfa6;border-radius:12px;cursor:pointer}
button:hover{border-color:#3f7d5a;background:#fff}
button:disabled{color:#9a9384;background:#e9e1d2;border-color:#d8cbb4;cursor:default}
/* 卡片按内容撑高（34px 只是下限）：同一网格行由 grid 拉伸对齐，说明再长也不截 */
button.action{position:relative;display:flex;flex-direction:column;justify-content:center;min-height:34px;min-width:0;padding:3px 7px;text-align:left;overflow:hidden}
.action .label{display:block;font-size:13px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.action.has-note .label{padding-right:42px}
/* 技能说明自然换行；长的英文 id 也能断开，不再用 nowrap + 省略号藏效果 */
.action .effect{display:block;font-size:10.5px;line-height:12px;color:#7b7466;white-space:normal;overflow-wrap:anywhere}
button.mode{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;height:34px;min-width:0;padding:2px 4px;font-size:12px;line-height:16px;text-align:center;overflow:hidden}
button.mode .note{position:static;padding:0;background:none;color:#9a9384;font-size:9.5px;line-height:11px;max-width:100%;overflow:hidden;text-overflow:ellipsis}
button .note{position:absolute;top:3px;right:3px;padding:0 4px;border-radius:7px;background:#efe6d4;color:#6b6254;font-size:9px;line-height:12px;white-space:nowrap}
</style></head>
<body>
<div id="titleRow"><div id="title"></div><div id="timer"></div></div>
<div id="progress"><div id="progressFill"></div></div>
<div id="buttons"></div>
<script>
'use strict';
const titleRow = document.getElementById('titleRow');
const title = document.getElementById('title');
const buttons = document.getElementById('buttons');
const timer = document.getElementById('timer');
const progress = document.getElementById('progress');
const progressFill = document.getElementById('progressFill');
const toneNames = { damage: '伤害', control: '控制', sustain: '回复 · 保命' };
let deadline = 0;
let tick = null;
// 点击只发一个编号给本机接口：同一个接口 curl 也能调（真机核验不点鼠标）
function send(pick) {
  return fetch('/app/battle/choose', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pick }),
  }).catch(() => undefined);
}
function updateTimer(seconds) {
  const left = deadline > 0 ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : seconds;
  const ratio = Math.max(0, Math.min(1, left / Math.max(1, seconds)));
  timer.textContent = left + 's';
  progressFill.style.transform = 'scaleX(' + ratio + ')';
  progressFill.style.background = ratio > 0.5 ? '#3f7d5a' : ratio > 0.25 ? '#e9c46a' : '#b23b32';
}
window.panel = {
  show(state) {
    title.textContent = String(state.title || '');
    buttons.textContent = '';
    buttons.classList.toggle('mode', state.kind === 'mode');
    const options = Array.isArray(state.options) ? state.options : [];
    const counts = { damage: 0, control: 0, sustain: 0 };
    if (state.kind === 'action') {
      for (const option of options) {
        if (Object.prototype.hasOwnProperty.call(counts, option.tone)) counts[option.tone] += 1;
      }
    }
    let previousTone = '';
    for (const option of options) {
      const tone = state.kind === 'action' && Object.prototype.hasOwnProperty.call(counts, option.tone) ? option.tone : '';
      if (tone && tone !== previousTone) {
        const group = document.createElement('div');
        group.className = 'group ' + tone;
        group.textContent = toneNames[tone] + ' · ' + counts[tone];
        buttons.appendChild(group);
      }
      previousTone = tone;
      const button = document.createElement('button');
      button.className = state.kind === 'mode' ? 'mode' : 'action';
      if (state.kind === 'mode') {
        button.textContent = String(option.label || '');
      } else {
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = String(option.label || '');
        const effect = document.createElement('span');
        effect.className = 'effect';
        effect.textContent = String(option.effect || '');
        button.append(label, effect);
      }
      if (option.note) {
        if (state.kind !== 'mode') button.classList.add('has-note');
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = String(option.note);
        button.appendChild(note);
      }
      button.disabled = option.disabled === true;
      if (!button.disabled) button.addEventListener('click', () => void send(Number(option.pick)));
      buttons.appendChild(button);
    }
    deadline = Date.now() + Math.max(1, Number(state.seconds) || 0) * 1000;
    if (tick) clearInterval(tick);
    updateTimer(Number(state.seconds) || 0);
    tick = setInterval(() => updateTimer(Number(state.seconds) || 0), 250);
  },
  // 按传入宽度量标题、进度条和完整网格（含组标题）；不依赖窗口新尺寸有没有传到页面。
  contentHeight(width) {
    const previous = document.body.style.width;
    if (Number(width) > 0) document.body.style.width = Number(width) + 'px';
    const style = getComputedStyle(document.body);
    const gap = parseFloat(style.rowGap) || 0;
    const height = Math.ceil(
      titleRow.offsetHeight + progress.offsetHeight + buttons.scrollHeight +
        parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 2 * gap,
    );
    document.body.style.width = previous;
    return height;
  },
  hide() {
    buttons.textContent = '';
    buttons.classList.remove('mode');
    title.textContent = '';
    timer.textContent = '';
    progressFill.style.transform = 'scaleX(0)';
    deadline = 0;
    if (tick) clearInterval(tick);
    tick = null;
  },
};
</script></body></html>
`;
