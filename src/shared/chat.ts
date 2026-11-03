// 对话输入面板（src/shared，浏览器 bundle 与桌面 shared-core 共用）：
//  - 纯逻辑：类型 / 发送 / 历史归一化（走 host /dsh-pet-7340/chat，host 是 memory.json 唯一读写方
//    ——浏览器与桌面同一实例天然共享同一份记忆，两端只是不同显示方式）；
//  - CHAT_CSS + mountChatDialog：自 menu.ts 之后第二个「两端共用同一份 DOM」例外
//    （菜单组件证明可行的模式：浏览器页面与桌面透明窗渲染完全一致的对话框）。
// 交互语义：
//    右键菜单「对话」→ 带最近几轮历史的输入面板 → 回车发送 → 面板里立即出现「你」和
//    「……」，生成完成后替换成回复；面板保持打开，可以接着聊。
//    桌宠仍会用碎碎念同款气泡展示同一句回复（回复由 host 写进 S 的 pets.<id>.say）。
//    关闭（Esc / 点外）不会中止已发出的请求：回复仍写进 S，气泡照常出现。
// 记忆语义：memory.json 全存不删；host 每次请求只截尾部 chatMemoryRounds 轮进上下文。
// 本面板的历史来自 GET /chat（host 只读 memory.json），最多展示最近 CHAT_LOG_MAX 条。

/** POST /dsh-pet-7340/chat?pet=<id> {text} 的回执：成功时带回正文（与写进 S 的是同一份） */
export type ChatSendState =
  | { ok: true; text: string; image?: string }
  | { ok: false; reason: 'provider-missing' | 'generate-error' | 'config-error' | 'bad-request'; message?: string };

/** 面板里展示的一条历史消息（GET /chat 的 messages 归一化后） */
export interface ChatLogItem {
  role: 'user' | 'assistant';
  text: string;
}

/** 历史面板最多展示多少条（GET 可能返回很多轮，面板只保留最近这些） */
export const CHAT_LOG_MAX = 20;

const SEND_TIMEOUT_MS = 60_000; // 对话要等 LLM 生成回复，比碎碎念（30s）放宽一倍

/** 发送一句对话（携带记忆去 host 生成回复并写入记忆）。
 *  网络/解析失败显式抛错（调用方决定报错方式，绝不静默伪造）。 */
export async function sendChat(baseUrl: string, text: string): Promise<ChatSendState> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const raw: unknown = await res.json().catch(() => null);
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: 对话响应非法');
  const o = raw as Record<string, unknown>;
  if (o.ok !== true) {
    return {
      ok: false,
      reason:
        o.reason === 'provider-missing' || o.reason === 'generate-error' || o.reason === 'config-error'
          ? o.reason
          : 'bad-request',
      message: typeof o.message === 'string' ? o.message : undefined,
    };
  }
  return {
    ok: true,
    text: typeof o.text === 'string' ? o.text : '',
    ...(typeof o.image === 'string' ? { image: o.image } : {}),
  };
}

/** GET /chat 的回执归一化：只保留角色/正文合法的消息，空正文与非对象条目直接跳过。 */
export function normalizeHistory(raw: unknown): ChatLogItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as { ok?: unknown; messages?: unknown };
  if (o.ok !== true || !Array.isArray(o.messages)) return [];
  const out: ChatLogItem[] = [];
  for (const item of o.messages) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim() !== '') {
      out.push({ role, text: content });
    }
  }
  return out.slice(-CHAT_LOG_MAX);
}

/** 弹窗样式 —— 两端注入同一份（与菜单 MENU_CSS 同理；视觉对齐浏览器/桌面）。
 *  面板 = 最近几轮历史（可滚动）+ 自适应输入框（初始小宽度，随输入自动增宽，封顶 340px）；
 *  回车发送，Shift+回车换行，Esc 或点外关闭。宽度由 JS 按文本测量覆盖根元素宽度。 */
export const CHAT_CSS = [
  '.dsh-pet-chat{position:fixed;z-index:2147483001;width:200px;max-width:80vw;display:flex;flex-direction:column;',
  'background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:10px;',
  'box-shadow:0 10px 32px rgba(0,0,0,.22);color:#2b2b2b;font-size:14px;line-height:1.5;',
  // 字体与桌宠气泡同款（上首软糖体，两端均已注入 @font-face），风格一致不显正式。
  // 字体族走全局配置变量 --dsh-pet-font-family：弹窗挂在 body 下、继承不到宠物根容器，
  // 所以由两端注入在 documentElement（回退参数 = 改造前的原栈）。
  // 字号保持固定 14px：配置里的 font.size 只作用于气泡与悬浮提示，不改变本弹窗。
  "font-family:var(--dsh-pet-font-family,'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);",
  'user-select:none}',
  '.dsh-pet-chat *{box-sizing:border-box}',
  '.dsh-pet-chat-log{display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;',
  'padding:9px 11px 0;scrollbar-width:thin}',
  '.dsh-pet-chat-log:empty{display:none}',
  '.dsh-pet-chat-msg{font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}',
  '.dsh-pet-chat-msg[data-role="user"]{align-self:flex-end;max-width:85%;padding:4px 8px;border-radius:8px;',
  'background:rgba(80,140,255,.12)}',
  '.dsh-pet-chat-msg[data-role="assistant"]{align-self:flex-start;max-width:92%;color:#2b2b2b}',
  '.dsh-pet-chat-msg[data-pending="true"]{opacity:.55}',
  '.dsh-pet-chat-input{display:block;width:100%;border:none;outline:none;background:transparent;',
  'padding:8px 11px 9px;font-size:14px;line-height:1.45;color:#2b2b2b;font-family:inherit;',
  'resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-pet-chat-input::placeholder{color:rgba(43,43,43,.45)}',
  '.dsh-pet-chat-input:disabled{opacity:.55}',
  '.dsh-pet-chat-err{color:#d94f3d;font-size:12px;padding:0 12px 8px;white-space:pre-wrap;overflow-wrap:anywhere}',
].join('');

/** 输入框宽度自适应参数：初始小宽 → 随文本增宽 → 封顶后折行增高 */
const CHAT_MIN_W = 200;
const CHAT_MAX_W = 340;
const CHAT_H_PAD = 22; // 输入框水平 padding（11×2），宽度测量补偿

let chatCssInjected = false;
function injectChatCss(): void {
  if (chatCssInjected || typeof document === 'undefined') return;
  chatCssInjected = true;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = 'dsh-pet/chat';
  tag.textContent = CHAT_CSS;
  document.head.appendChild(tag);
}

/** mountChatDialog 返回值 */
export interface ChatDialogMount {
  /** 根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
}

/** 挂载一个对话面板（两端共用；位置为视口坐标，超出 clamp 矩形自动夹回）。
 *  面板打开时 GET /chat 拉最近几轮历史；回车发送后保持打开，回复直接追加到面板里
 *  （同时 host 仍写 pets.<id>.say，气泡照常出现）；Esc / 点弹窗外关闭。
 *
 *  clamp（可选，#41）：弹窗允许占用的矩形（视口局部坐标，默认整个视口）。
 *  桌面模式传「窗口 ∩ 工作区」——宠物贴屏幕底/右时窗口外扩余量伸出屏幕，
 *  约束到该矩形内即可完整显示，**窗口/宠物零移动零闪帧**。 */
export function mountChatDialog(opts: {
  petId: string;
  /** 端点基址：浏览器默认相对 /dsh-pet-7340/chat；桌面传绝对 URL（file:// 页面需绝对） */
  baseUrl?: string;
  x: number;
  y: number;
  /** 发送成功后调用：调用方叫醒一拍 /state 让气泡 0 延迟出现。
   *  回复正文由本面板自己从 POST 回执显示；气泡仍走 S（动作端点不回数据，数据只有一个出口）。 */
  onSent?: () => void;
  onClose?: () => void;
  /** 弹窗允许占用的矩形（视口局部坐标）；缺省 = 整个视口 */
  clamp?: { x: number; y: number; w: number; h: number };
}): ChatDialogMount {
  injectChatCss();
  const { petId, x, y, onSent, onClose, clamp } = opts;
  const baseUrl = opts.baseUrl ?? '/dsh-pet-7340/chat';
  const withPet = baseUrl + '?pet=' + encodeURIComponent(petId);
  const c =
    clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h)
      ? clamp
      : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  // 面板不能超出允许矩形（桌面窗口 = 宠物 + 外扩余量；贴屏边时余量会收缩）。
  // 宽度按文本测量后再封顶到这里；高度超出时由日志区让位（见 reposition）。
  // 窗口会随宠物移动而收缩（桌面 setContentBounds），所以上限每次落位时按**当前视口**重算。
  let maxW = Math.max(0, c.w - 8);
  let maxH = Math.max(0, c.h - 8);
  /** clamp 矩形与当前视口的交集（窗口收缩后 c 可能已超出视口） */
  const liveRect = (): { x: number; y: number; w: number; h: number } => {
    const x0 = Math.max(c.x, 0);
    const y0 = Math.max(c.y, 0);
    return {
      x: x0,
      y: y0,
      w: Math.max(0, Math.min(c.x + c.w, window.innerWidth) - x0),
      h: Math.max(0, Math.min(c.y + c.h, window.innerHeight) - y0),
    };
  };

  const root = document.createElement('div');
  root.className = 'dsh-pet-chat';

  const log = document.createElement('div');
  log.className = 'dsh-pet-chat-log';

  const input = document.createElement('textarea');
  input.className = 'dsh-pet-chat-input';
  input.placeholder = '说点什么…';
  input.maxLength = 2000;
  input.rows = 1;

  const err = document.createElement('div');
  err.className = 'dsh-pet-chat-err';
  err.style.display = 'none';

  root.appendChild(log);
  root.appendChild(input);
  root.appendChild(err);
  document.body.appendChild(root);

  // 宽度/高度自适应：宽度按文本测量（≤CHAT_MAX_W），封顶后高度随折行增长
  let measureCtx: CanvasRenderingContext2D | null = null;
  const measureText = (text: string): number => {
    const ctx =
      measureCtx ?? (measureCtx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D);
    ctx.font = getComputedStyle(input).font; // 每次取当前计算样式（挂载前后都准）
    return ctx.measureText(text).width;
  };
  const resizeInput = (): void => {
    const textW = measureText(input.value || ' ');
    const minW = Math.min(CHAT_MIN_W, maxW);
    const w = Math.max(minW, Math.min(Math.ceil(textW + CHAT_H_PAD), CHAT_MAX_W, maxW));
    root.style.width = w + 'px'; // 根宽度跟随（含历史/err 行）→ 夹回仍按实际宽
    input.style.height = 'auto';
    input.style.height = Math.max(input.scrollHeight, 22) + 'px';
  };
  input.addEventListener('input', resizeInput);
  resizeInput(); // 以占位符为初始宽度

  // 位置：以 (x,y) 落点，超出 clamp 矩形夹回；历史渲染后高度变化时重新夹一次。
  // 高度放不下时先压历史区：输入框永远完整可见（正在输入的东西不能被窗口裁掉）。
  const reposition = (): void => {
    const r = liveRect();
    maxH = Math.max(0, r.h - 8);
    log.style.maxHeight = ''; // 先恢复 CSS 上限，再按可用高度收紧
    const first = root.getBoundingClientRect();
    const overflow = first.height - maxH;
    if (overflow > 0) {
      const logH = log.getBoundingClientRect().height;
      if (logH > 0) log.style.maxHeight = Math.max(0, logH - overflow) + 'px';
    }
    const rr = root.getBoundingClientRect();
    root.style.left = Math.max(r.x + 4, Math.min(x, r.x + r.w - rr.width - 4)) + 'px';
    root.style.top = Math.max(r.y + 4, Math.min(y, r.y + r.h - rr.height - 4)) + 'px';
  };
  resizeInput(); // append 后再量一次（此时样式已生效）
  reposition();
  // 输入变长 → 面板变高：重新夹回（否则贴窗口底边时会被裁掉）
  input.addEventListener('input', () => reposition());
  // 桌面窗口随宠物贴屏边而收缩：按新视口重算宽度上限并重新落位（否则右侧被窗口裁掉）
  const onWindowResize = (): void => {
    maxW = Math.max(0, liveRect().w - 8);
    resizeInput();
    reposition();
  };
  window.addEventListener('resize', onWindowResize);

  let closed = false;
  let sending = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    window.removeEventListener('resize', onWindowResize);
    root.remove();
    if (onClose) onClose();
  };
  const onDocPointerDown = (e: MouseEvent): void => {
    if (closed) return;
    if (root.contains(e.target as Node)) return;
    close();
  };
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (closed) return;
    if (e.key === 'Escape') close();
  };
  document.addEventListener('mousedown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);

  const appendMessage = (role: ChatLogItem['role'], text: string, pending = false): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'dsh-pet-chat-msg';
    el.dataset.role = role;
    if (pending) el.dataset.pending = 'true';
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };

  // 历史：GET /chat（host 只读 memory.json，按轮数截尾）。读不到就不显示，不挡发送。
  // 面板展示 20 条（CHAT_LOG_MAX）→ 向 host 要 10 轮（1 轮 = 1 问 1 答）。
  const readUrl = withPet + '&rounds=' + Math.ceil(CHAT_LOG_MAX / 2);
  fetch(readUrl, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error' })
    .then((response) => response.json())
    .then((raw: unknown) => {
      if (closed || log.childElementCount > 0) return; // 用户已经先发了：不把历史插到后面
      const items = normalizeHistory(raw);
      if (items.length === 0) return;
      for (const item of items) appendMessage(item.role, item.text);
      reposition();
    })
    .catch(() => {
      /* 历史读不到不影响发送 */
    });

  const doSend = (): void => {
    if (closed || sending) return;
    const text = input.value.trim();
    if (!text) return;
    sending = true;
    input.disabled = true;
    err.style.display = 'none';
    input.value = '';
    resizeInput();
    const userEl = appendMessage('user', text);
    const pendingEl = appendMessage('assistant', '……', true);
    reposition();
    sendChat(withPet, text)
      .then((state) => {
        if (state.ok) {
          // 成功：替换占位，面板保持打开；气泡仍由 S 带出（onSent 叫醒一拍）
          if (pendingEl.isConnected) {
            delete pendingEl.dataset.pending;
            pendingEl.textContent = state.text || '（没有回复）';
          }
          log.scrollTop = log.scrollHeight;
          reposition();
          if (onSent) onSent();
        } else {
          // 失败：host 没写记忆，撤掉本地这两条，把文本放回输入框方便重试
          userEl.remove();
          pendingEl.remove();
          input.value = text;
          resizeInput();
          err.textContent = '对话失败：' + (state.message ?? state.reason);
          err.style.display = 'block';
          reposition();
        }
      })
      .catch((e) => {
        userEl.remove();
        pendingEl.remove();
        input.value = text;
        resizeInput();
        err.textContent = '对话异常：' + String(e && e.message ? e.message : e);
        err.style.display = 'block';
        reposition();
      })
      .finally(() => {
        sending = false;
        input.disabled = false;
        if (!closed) input.focus();
      });
  };

  input.addEventListener('keydown', (e) => {
    // Enter 发送；Shift+Enter 换行；输入法正在上屏时不抢 Enter
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  });

  input.focus();
  return { el: root, close };
}
