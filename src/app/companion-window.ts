/**
 * 小跟班（羁绊的小猫咪）：一只透明、置顶、鼠标穿透的小窗，跟在自家宠物脚边。
 *
 * 不用 pet pack：跟班不是一只完整的桌宠，没有 AI、没有菜单、不参与碰撞，只是一段跟着走的
 * 小动画。窗口照对手窗口（foe-window.ts）的做法——每 50ms 取一次自家宠物的包围盒，位置变了
 * 就挪过去；战斗 / 历练 / 串门时整扇窗藏起来，结束再出来（`busy` 由 features/bond.ts 给）。
 *
 * 页面走本机服务的 `GET /app/companion`（见 app-routes.ts）；立绘地址由调用方传进来。
 * 素材只有一张透明 PNG，情绪靠 CSS（漂浮、开心地弹一下、被吓到发抖），不额外烧视频。
 */
import type { PetBox, Rect, WindowElectron, WindowLike } from './visit-windows';

/** 跟班宽度占自家宠物宽度的比例 */
export const COMPANION_RATIO = 0.32;
/** 跟着走的间隔（同客人 / 对手窗口） */
const FOLLOW_MS = 50;
/** 宠物一次位移超过「自身尺寸 × 这个比例」就当作被拖起来甩了 */
const STARTLE_RATIO = 0.18;
/** 被吓到以后回到平时的冷静时间 */
const STARTLE_MS = 900;

/** 跟班的边长（按自家宠物大小缩放，夹一个下限免得小到看不清） */
export function companionSize(petSize: number): number {
  return Math.max(48, Math.round(petSize * COMPANION_RATIO));
}

/**
 * 跟班该待在哪：优先挂在宠物左下角外侧，左边放不下换右下角；上下夹在工作区里。
 * 纯函数，方便单测。
 */
export function companionBounds(home: PetBox, workArea: Rect): Rect {
  const size = companionSize(home.size);
  let x = home.left - size * 0.55;
  if (x < workArea.x + 4) x = home.left + home.size - size * 0.45;
  const y = home.top + home.size * 0.7;
  x = Math.min(Math.max(x, workArea.x + 4), workArea.x + workArea.width - size - 4);
  const clampedY = Math.min(Math.max(y, workArea.y + 4), workArea.y + workArea.height - size - 4);
  return { x: Math.round(x), y: Math.round(clampedY), width: size, height: size };
}

export interface CompanionWindow {
  /** 换情绪：漂浮 / 开心 / 被吓到 */
  setMood(mood: 'idle' | 'happy' | 'scared'): void;
  /** 冒一句话（几秒后自动收起） */
  say(text: string, durationMs?: number): void;
  /** 现在窗口在哪（调试 / 测试用） */
  bounds(): Rect | null;
  /** 关掉并停掉跟随 */
  close(): void;
}

/**
 * 开跟班窗。
 * @param pageUrl 本机服务的 /app/companion
 * @param imageUrl 跟班透明立绘的完整地址（由调用方拼好）
 * @param home 取自家宠物现在的位置（watchHomePet 的 box）
 * @param busy 现在该躲起来吗（战斗 / 历练 / 串门 / 退出）
 */
export function openCompanionWindow(
  electron: WindowElectron,
  pageUrl: string,
  imageUrl: string,
  home: () => PetBox | null,
  busy: () => boolean,
): CompanionWindow {
  const first = home();
  const point = first
    ? { x: first.left + first.size / 2, y: first.top + first.size / 2 }
    : electron.screen.getCursorScreenPoint();
  let bounds = first ? companionBounds(first, electron.screen.getDisplayNearestPoint(point).workArea) : null;
  const win: WindowLike = new electron.BrowserWindow({
    ...(bounds ?? { x: -10_000, y: -10_000, width: companionSize(0), height: companionSize(0) }),
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
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  let ready = false;
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
      ready = true;
      for (const code of queued.splice(0)) run(code);
      if (!busy()) win.showInactive();
    })
    .catch(() => win.destroy());
  run(`companion.setup(${JSON.stringify({ image: imageUrl })})`);

  let lastHome: PetBox | null = first;
  let startledUntil = 0;
  let visible = false;
  const follow = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(follow);
      return;
    }
    if (busy()) {
      if (visible) {
        win.hide?.();
        visible = false;
      }
      return;
    }
    const box = home();
    if (!box) {
      if (visible) {
        win.hide?.();
        visible = false;
      }
      return;
    }
    const workArea = electron.screen.getDisplayNearestPoint({
      x: box.left + box.size / 2,
      y: box.top + box.size / 2,
    }).workArea;
    const next = companionBounds(box, workArea);
    if (!bounds || next.x !== bounds.x || next.y !== bounds.y || next.width !== bounds.width) {
      bounds = next;
      win.setBounds(bounds);
    }
    if (!visible && ready) {
      win.showInactive();
      visible = true;
    }
    // 宠物被拖起来甩：窗口位置在一拍里跳了一大截 → 跟班被吓到
    if (lastHome) {
      const jumped = Math.hypot(box.left - lastHome.left, box.top - lastHome.top);
      if (jumped > Math.max(24, box.size * STARTLE_RATIO) && Date.now() > startledUntil) {
        startledUntil = Date.now() + STARTLE_MS;
        run(`companion.setMood('scared')`);
      }
    }
    lastHome = box;
  }, FOLLOW_MS);

  return {
    setMood: (mood) => run(`companion.setMood(${JSON.stringify(mood)})`),
    say: (text, durationMs) => run(`companion.say(${JSON.stringify(String(text))}, ${Number(durationMs) || 6000})`),
    bounds: () => bounds,
    close() {
      clearInterval(follow);
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

/** 跟班窗口的页面（静态；立绘地址由 openCompanionWindow 送进来） */
export const companionPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>小跟班</title>
<style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none}
body{display:flex;align-items:flex-end;justify-content:center}
#stage{position:relative;width:100%;height:100%;display:flex;align-items:flex-end;justify-content:center;filter:drop-shadow(0 6px 10px rgba(0,0,0,.16))}
#pet{width:100%;height:100%;object-fit:contain;transform-origin:50% 92%;animation:float 2.8s ease-in-out infinite}
@keyframes float{0%,100%{transform:translateY(0) rotate(-1.5deg)}50%{transform:translateY(-6%) rotate(1.5deg)}}
#pet.happy{animation:hop .8s ease}
@keyframes hop{0%,100%{transform:translateY(0) scale(1)}35%{transform:translateY(-18%) scale(1.06,.96)}65%{transform:translateY(-4%) scale(.98,1.02)}}
#pet.scared{animation:shake .18s linear 5}
@keyframes shake{0%,100%{transform:translateX(-3%) rotate(-3deg)}50%{transform:translateX(3%) rotate(3deg)}}
#bubble{position:absolute;left:50%;bottom:86%;transform:translateX(-50%);max-width:92%;box-sizing:border-box;padding:4px 9px;border-radius:11px;background:#fff;border:2px solid #4a5b6c;color:#22313f;font:13px/1.4 "ShangshouSoftCandy","PingFang SC",sans-serif;white-space:nowrap;opacity:0;transition:opacity .2s;pointer-events:none}
#bubble.on{opacity:1}
</style></head>
<body><div id="stage"><img id="pet" alt=""><div id="bubble"></div></div>
<script>
'use strict';
const pet = document.getElementById('pet');
const bubble = document.getElementById('bubble');
let hideTimer = null;
let moodTimer = null;
function setMood(mood) {
  pet.classList.remove('happy', 'scared');
  if (mood === 'happy' || mood === 'scared') {
    void pet.offsetWidth;
    pet.classList.add(mood);
    clearTimeout(moodTimer);
    moodTimer = setTimeout(() => pet.classList.remove(mood), mood === 'scared' ? 900 : 800);
  }
}
window.companion = {
  setup(data) {
    if (data && data.image) pet.src = String(data.image);
  },
  setMood,
  say(text, duration) {
    bubble.textContent = String(text);
    bubble.classList.add('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bubble.classList.remove('on'), Number(duration) || 6000);
  },
};
</script></body></html>
`;
