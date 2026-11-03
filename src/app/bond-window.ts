/**
 * 羁绊小窗（bond 的界面）：一个能拿焦点的小窗，左边是关系状态 / 小剧场，右边是按钮。
 *
 * 页面走本机服务的 `GET /app/bond`（同 /app/note、/app/adventure 的做法，见 app-routes.ts）。
 * 主进程把一份 BondView 经 `executeJavaScript('bond.render(...)')` 推进页面，再等页面里的
 * 一次按钮点击（`bond.wait()` 返回 Promise）。页面只做显示和收集点击，不自己做任何判断：
 * 所有状态变更都在主进程的 Bond 里，页面用 textContent 建按钮，远程内容不会进 innerHTML。
 *
 * 位置照捎话窗（note-window.ts）：优先放在宠物左边，放不下换右边，再不行居中。
 * 窗口能拿焦点（要改跟班名字、中文输入法要用），这是用户主动点「羁绊」打开的，和客人窗口相反。
 */
import type { PetBox, Rect, WindowElectron, WindowLike } from './visit-windows';

/** 小窗尺寸：16:9 的 CG + 状态 + 三行按钮，刚好放得下 */
export const BOND_WIDTH = 420;
export const BOND_HEIGHT = 620;

export interface BondButton {
  /** 点击后回给主进程的动作 id（`choose:xxx` 这类带参数的动作由调用方拆） */
  id: string;
  label: string;
  primary?: boolean;
  disabled?: boolean;
}

/** 送进页面的一份视图 */
export interface BondView {
  kind: 'status' | 'scene' | 'result';
  title: string;
  subtitle?: string;
  /** 0–100；null / 不传 = 不显示进度条 */
  progress?: number | null;
  /** CG 的完整地址；不传 = 不显示图 */
  image?: string;
  /** 正文（逐行） */
  lines: string[];
  /** 跟班改名输入框（只在状态页出现） */
  input?: { value: string; placeholder: string; maxLength: number };
  buttons: BondButton[];
}

/** 页面回给主进程的一次操作 */
export interface BondAction {
  action: string;
  /** 改名时输入框里的原文 */
  value?: string;
}

export interface BondWindow {
  render(view: BondView): void;
  /** 等下一次点击；窗口被关掉时 reject（调用方当作用户取消） */
  wait(): Promise<BondAction>;
  focus(): void;
  close(): void;
  bounds(): Rect;
}

/**
 * 小窗该放哪：优先宠物左边，放不下换右边，再不行居中；上下夹在工作区里。
 * 抽成纯函数方便单测（不碰窗口）。
 */
export function bondBounds(home: PetBox | null, workArea: Rect): Rect {
  const clampX = (x: number): number =>
    Math.min(Math.max(x, workArea.x + 4), workArea.x + workArea.width - BOND_WIDTH - 4);
  const clampY = (y: number): number =>
    Math.min(Math.max(y, workArea.y + 4), workArea.y + workArea.height - BOND_HEIGHT - 4);
  if (!home) {
    return {
      x: clampX(workArea.x + (workArea.width - BOND_WIDTH) / 2),
      y: clampY(workArea.y + (workArea.height - BOND_HEIGHT) / 2),
      width: BOND_WIDTH,
      height: BOND_HEIGHT,
    };
  }
  const left = home.left - BOND_WIDTH - 16;
  const right = home.left + home.size + 16;
  const x = left >= workArea.x + 4 ? left : right;
  return {
    x: clampX(x),
    y: clampY(home.top + home.size / 2 - BOND_HEIGHT / 2),
    width: BOND_WIDTH,
    height: BOND_HEIGHT,
  };
}

/** 开小窗；页面加载好之前 render / wait 都排队 */
export function openBondWindow(electron: WindowElectron, pageUrl: string, home: () => PetBox | null): BondWindow {
  const box = home();
  const point = box
    ? { x: box.left + box.size / 2, y: box.top + box.size / 2 }
    : electron.screen.getCursorScreenPoint();
  const bounds = bondBounds(box, electron.screen.getDisplayNearestPoint(point).workArea);
  const win: WindowLike = new electron.BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // 要改名字 / 接中文输入法，所以能拿焦点；用户是主动点「羁绊」打开的
    focusable: true,
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
  const loaded = win
    .loadURL(pageUrl)
    .then(() => {
      if (win.isDestroyed()) return;
      win.show();
      ready = true;
      for (const code of queued.splice(0)) run(code);
    })
    .catch(() => win.destroy());

  return {
    render(view) {
      run(`bond.render(${JSON.stringify(view)})`);
    },
    wait() {
      return loaded
        .then(() => {
          if (win.isDestroyed()) throw new Error('bond window closed');
          return win.webContents.executeJavaScript('bond.wait()');
        })
        .then((raw: unknown) => {
          const action = raw as { action?: unknown; value?: unknown } | null;
          if (!action || typeof action !== 'object' || typeof action.action !== 'string') {
            return { action: 'close' };
          }
          return {
            action: action.action,
            ...(typeof action.value === 'string' ? { value: action.value } : {}),
          };
        });
    },
    focus() {
      if (!win.isDestroyed()) win.focus();
    },
    close() {
      if (!win.isDestroyed()) win.destroy();
    },
    bounds: () => bounds,
  };
}

/** 羁绊小窗的页面（静态；内容全部由 openBondWindow 经 executeJavaScript 送进来） */
export const bondPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>羁绊</title>
<style>
@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/${encodeURIComponent('上首软糖体')}.ttf") format("truetype");font-display:swap}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none}
body{font-family:"ShangshouSoftCandy","PingFang SC","Microsoft YaHei",sans-serif;color:#2b2b2b}
#card{position:absolute;inset:6px;display:flex;flex-direction:column;background:rgba(255,255,255,.985);border:1px solid rgba(0,0,0,.12);border-radius:14px;box-shadow:0 12px 34px rgba(0,0,0,.22);overflow:hidden}
#head{padding:12px 16px 0;flex:none}
#title{font-size:18px;line-height:1.3;font-weight:600}
#subtitle{margin-top:2px;font-size:12px;color:#6b7a86;min-height:16px}
#bar{height:6px;margin:8px 0 0;border-radius:3px;background:rgba(80,140,255,.14);overflow:hidden}
#bar.hide{display:none}
#fill{height:100%;width:0;border-radius:3px;background:linear-gradient(90deg,#7fb2ff,#508cff);transition:width .3s}
#cg{display:none;width:100%;aspect-ratio:16/9;object-fit:cover;flex:none;background:#eef4fb;border-bottom:1px solid rgba(0,0,0,.06)}
#cg.on{display:block}
#body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px 4px;scrollbar-width:thin}
#line{font-size:14px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 8px}
#line:last-child{margin-bottom:0}
#rename{display:none;gap:8px;align-items:center;margin-top:10px}
#rename.on{display:flex}
#rename label{font-size:12px;color:#6b7a86;white-space:nowrap}
#name{flex:1;min-width:0;border:1px solid #a5bdcb;border-radius:7px;padding:6px 9px;font:14px/1.4 inherit;color:#203b50;background:#fff}
#name:focus{outline:2px solid #3a94c4;outline-offset:1px}
#buttons{flex:none;display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 16px 14px}
button{appearance:none;border:1px solid #b9cbd8;border-radius:9px;background:#fff;color:#203b50;font:14px/1.4 inherit;padding:9px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button:hover:not(:disabled){background:#f2f8fd;border-color:#7faecb}
button:active:not(:disabled){transform:translateY(1px)}
button.primary{background:linear-gradient(180deg,#6aa7e8,#4b8bd7);border-color:#3f7fc8;color:#fff}
button.primary:hover:not(:disabled){background:linear-gradient(180deg,#78b2ee,#5494de)}
button:disabled{opacity:.42;cursor:default}
button.wide{grid-column:1 / -1}
</style></head>
<body><div id="card">
  <div id="head"><div id="title"></div><div id="subtitle"></div><div id="bar"><div id="fill"></div></div></div>
  <img id="cg" alt="">
  <div id="body"><div id="line"></div><div id="rename"><label>跟班名字</label><input id="name" type="text" spellcheck="false" autocomplete="off"></div></div>
  <div id="buttons"></div>
</div>
<script>
'use strict';
const title = document.getElementById('title');
const subtitle = document.getElementById('subtitle');
const bar = document.getElementById('bar');
const fill = document.getElementById('fill');
const cg = document.getElementById('cg');
const body = document.getElementById('body');
const line = document.getElementById('line');
const rename = document.getElementById('rename');
const name = document.getElementById('name');
const buttons = document.getElementById('buttons');
let settle = null;
function finish(action) {
  if (!settle) return;
  const done = settle;
  settle = null;
  done(action);
}
window.bond = {
  render(view) {
    title.textContent = String(view.title ?? '');
    subtitle.textContent = String(view.subtitle ?? '');
    if (typeof view.progress === 'number' && Number.isFinite(view.progress)) {
      bar.classList.remove('hide');
      fill.style.width = Math.max(0, Math.min(100, view.progress)) + '%';
    } else {
      bar.classList.add('hide');
    }
    if (view.image) {
      if (cg.getAttribute('src') !== view.image) cg.src = String(view.image);
      cg.classList.add('on');
    } else {
      cg.classList.remove('on');
      cg.removeAttribute('src');
    }
    line.textContent = (Array.isArray(view.lines) ? view.lines : []).join('\\n');
    if (view.input) {
      rename.classList.add('on');
      name.value = String(view.input.value ?? '');
      name.placeholder = String(view.input.placeholder ?? '');
      name.maxLength = Number(view.input.maxLength) || 8;
    } else {
      rename.classList.remove('on');
    }
    buttons.textContent = '';
    for (const item of Array.isArray(view.buttons) ? view.buttons : []) {
      const button = document.createElement('button');
      button.textContent = String(item.label ?? '');
      button.dataset.action = String(item.id ?? '');
      if (item.primary) button.classList.add('primary');
      if (item.disabled) button.disabled = true;
      buttons.appendChild(button);
    }
    body.scrollTop = 0;
  },
  wait() {
    return new Promise((resolve) => {
      settle = resolve;
    });
  },
};
buttons.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  finish({ action: button.dataset.action || 'close', value: name.value });
});
name.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    finish({ action: 'rename', value: name.value });
  }
});
document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') finish({ action: 'close' });
});
</script></body></html>
`;
