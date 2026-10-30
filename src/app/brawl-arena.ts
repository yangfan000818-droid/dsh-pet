/**
 * X27 群架的环心记分板：围成一圈的 N 只，中间一块透明小窗按编号列名字、气血条和「存活 / 出手」标记。
 *
 * 窗口口径照 `arena-window.ts` / `foe-window.ts`：透明、置顶、不可聚焦、整窗鼠标穿透，页面走本机服务的
 * `GET /app/brawl-arena`（路由由调用方加，本文件只导出页面字符串）；数据经 `executeJavaScript` 送进页面，
 * 一律 `JSON.stringify` 成字面量，页面只写 `textContent` 与 `style`，不拼 HTML。
 *
 * 尺寸跟着行数和最长名字走；工作区放不下时整窗收缩（名字省略号、行溢出裁掉），不缩小字号、不改布局。
 */
import { hpPercent } from './arena-window';
import type { Rect, WindowElectron, WindowLike } from './visit-windows';

/** 窗口四周的内边距 */
const PAD = 8;
/** 一行的高度 */
const ROW_H = 20;
/** 行与行之间的缝 */
const ROW_GAP = 4;
/** 出手标记那一格的宽度 */
const MARK_W = 12;
/** 名字与血条之间的缝 */
const NAME_GAP = 6;
/** 血条宽度 */
const BAR_W = 56;
/** 右侧「倒下」字样的宽度 */
const STATE_W = 28;
/** 名字按 12px 字号估算：中文一个字约 12px */
const FONT_W = 12;
/** 名字最多按这么多字算宽（再长就省略号） */
const MAX_NAME_CHARS = 10;
/** 窗口最小 / 最大宽度 */
const MIN_WIDTH = 150;
const MAX_WIDTH = 360;

/** 一行显示什么：名字、气血，加上淘汰 / 当前出手标记 */
export interface BrawlArenaRow {
  label: string;
  hp: number;
  maxHp: number;
  dead?: boolean;
  active?: boolean;
}

/** 送进页面的载荷（百分比在主进程算好，页面不重复一套数学） */
interface ArenaRowPayload {
  label: string;
  percent: number;
  dead: boolean;
  active: boolean;
}

export interface BrawlArena {
  /** 刷新 N 行；行数、最长名字变了就重算窗口大小 */
  update(rows: BrawlArenaRow[]): void;
  /** 重摆位置：给了 rect 就用它当锚点区域，否则再问一次开窗时注入的 place() */
  place(rect?: Rect): void;
  /** 现在的窗口矩形 */
  bounds(): Rect;
  setVisible(on: boolean): void;
  close(): void;
}

/** 夹一个左上角坐标：装得下就夹进区间，装不下就贴住起点 */
function clampStart(value: number, start: number, extent: number, size: number): number {
  if (size >= extent) return start;
  return Math.min(Math.max(value, start), start + extent - size);
}

/** 按这份载荷算窗口矩形：以锚点区域的中心为中心，夹进工作区 */
function measure(rows: readonly ArenaRowPayload[], anchor: Rect, workArea: Rect): Rect {
  let chars = 2;
  for (const row of rows) chars = Math.max(chars, [...row.label].length);
  chars = Math.min(MAX_NAME_CHARS, chars);
  const wantedWidth = PAD * 2 + MARK_W + NAME_GAP + chars * FONT_W + NAME_GAP + BAR_W + NAME_GAP + STATE_W;
  const wantedHeight = PAD * 2 + Math.max(1, rows.length) * ROW_H + Math.max(0, rows.length - 1) * ROW_GAP;
  const width = Math.max(1, Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, wantedWidth), workArea.width));
  const height = Math.max(1, Math.min(wantedHeight, workArea.height));
  const cx = anchor.x + anchor.width / 2;
  const cy = anchor.y + anchor.height / 2;
  return {
    x: Math.round(clampStart(cx - width / 2, workArea.x, workArea.width, width)),
    y: Math.round(clampStart(cy - height / 2, workArea.y, workArea.height, height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function payloadOf(rows: readonly BrawlArenaRow[]): ArenaRowPayload[] {
  return rows.map((row) => ({
    label: String(row.label),
    percent: hpPercent(row.hp, row.maxHp),
    dead: row.dead === true,
    active: row.active === true,
  }));
}

/**
 * 开环心记分板。
 * @param electron 只用到 BrowserWindow / screen
 * @param pageUrl 本机服务的 `/app/brawl-arena`
 * @param place 取当前锚点区域（一般是环心：`{ x: 环心x, y: 环心y, width: 0, height: 0 }`）
 */
export function openBrawlArena(electron: WindowElectron, pageUrl: string, place: () => Rect): BrawlArena {
  const workAreaOf = (anchor: Rect): Rect =>
    electron.screen.getDisplayNearestPoint({
      x: anchor.x + anchor.width / 2,
      y: anchor.y + anchor.height / 2,
    }).workArea;
  let anchor = place();
  let rows: ArenaRowPayload[] = [];
  let bounds = measure(rows, anchor, workAreaOf(anchor));
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
      // 被宠物窗口挡住时也不能停：气血条要跟着演出跳
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 纯显示：整窗鼠标穿透，点它跟点桌面一样
  win.setIgnoreMouseEvents(true);
  let ready = false;
  let visible = true;
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
      if (visible) win.showInactive();
      ready = true;
      for (const code of queued.splice(0)) run(code);
    })
    .catch(() => win.destroy());
  return {
    update(next) {
      rows = payloadOf(next);
      const area = workAreaOf(anchor);
      const rect = measure(rows, anchor, area);
      if (!sameRect(rect, bounds)) {
        bounds = rect;
        if (!win.isDestroyed()) win.setBounds(bounds);
      }
      run(`brawlArena.update(${JSON.stringify({ rows })})`);
    },
    place(rect) {
      if (rect) anchor = rect;
      else anchor = place();
      const area = workAreaOf(anchor);
      const next = measure(rows, anchor, area);
      if (sameRect(next, bounds)) return;
      bounds = next;
      if (!win.isDestroyed()) win.setBounds(bounds);
    },
    bounds: () => ({ ...bounds }),
    setVisible(on) {
      visible = on;
      if (!ready || win.isDestroyed()) return;
      if (on) win.showInactive();
      else win.hide?.();
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

/** 环心记分板的页面（静态；各行由 openBrawlArena 经 executeJavaScript 送进来） */
export const brawlArenaPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>群架记分板</title>
<style>
@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/${encodeURIComponent('上首软糖体')}.ttf") format("truetype");font-display:swap}
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
body{box-sizing:border-box;padding:${PAD}px;font-family:"ShangshouSoftCandy","PingFang SC",sans-serif;color:#fff}
#list{display:flex;flex-direction:column;gap:${ROW_GAP}px}
.row{display:flex;align-items:center;gap:${NAME_GAP}px;height:${ROW_H}px;font-size:12px;line-height:${ROW_H}px;text-shadow:0 1px 2px rgba(20,24,32,.9)}
.mark{width:${MARK_W}px;flex:0 0 auto;text-align:center;color:#7a8694}
.row.active .mark{color:#ffd75e}
.name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{flex:0 0 ${BAR_W}px;height:9px;box-sizing:border-box;border:1px solid rgba(255,255,255,.85);border-radius:5px;background:rgba(20,24,32,.45);overflow:hidden}
.fill{height:100%;width:100%;background:linear-gradient(#7fe08a,#2f9e4b);transition:width .3s}
.fill.low{background:linear-gradient(#ff9a8a,#dd3333)}
.state{flex:0 0 ${STATE_W}px;text-align:right;color:#ff9a8a;font-size:11px}
.row.dead .name,.row.dead .mark,.row.dead .state{opacity:.45}
.row.dead .fill{opacity:.35}
</style></head>
<body><div id="list"></div>
<script>
'use strict';
function makeRow() {
  const row = document.createElement('div');
  row.className = 'row';
  const mark = document.createElement('div');
  mark.className = 'mark';
  row.appendChild(mark);
  const name = document.createElement('div');
  name.className = 'name';
  row.appendChild(name);
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.className = 'fill';
  bar.appendChild(fill);
  row.appendChild(bar);
  const state = document.createElement('div');
  state.className = 'state';
  row.appendChild(state);
  return row;
}
window.brawlArena = {
  // 只认 textContent 与 style：送进来的名字和数字都当数据，绝不拼进 HTML
  update(payload) {
    const list = document.getElementById('list');
    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    while (list.children.length > rows.length) list.removeChild(list.lastChild);
    while (list.children.length < rows.length) list.appendChild(makeRow());
    for (let i = 0; i < rows.length; i++) {
      const data = rows[i] || {};
      const row = list.children[i];
      const percent = Math.max(0, Math.min(100, Number(data.percent)));
      row.classList.toggle('dead', !!data.dead);
      row.classList.toggle('active', !!data.active);
      row.children[0].textContent = data.active ? '▸' : '·';
      row.children[1].textContent = String(data.label == null ? '' : data.label);
      const fill = row.children[2].firstChild;
      fill.style.width = percent + '%';
      fill.classList.toggle('low', percent < 20);
      row.children[3].textContent = data.dead ? '倒下' : '';
    }
  },
};
</script></body></html>
`;
