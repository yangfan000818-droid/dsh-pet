/**
 * 独立应用自己的本机接口（`/app/*`），给 `dsh-pet` 命令行（scripts/pet-cli.mjs）与 Claude Code hook 用：
 *   GET  /app/activity      主人此刻的采样快照与给模型的那行背景（调试用）
 *   POST /app/say           { text }：让桌宠说一句给定的话
 *   POST /app/look          看一眼屏幕并吐槽；看不了时降级成按人设说一句（等同右键「看看我在干嘛」）
 *   POST /app/claude-hook   Claude Code hook 的 stdin JSON 原样转进来
 *   GET  /app/guest         串门客人窗口的页面（visit-windows.ts 开的窗口加载它）
 *   GET  /app/foe           历练对手窗口的页面（foe-window.ts 开的窗口加载它）
 *   GET  /app/adventure     历练小窗的页面（adventure-window.ts 开的窗口加载它）
 *   GET  /app/note          捎话小输入窗的页面（note-window.ts 开的窗口加载它）
 *   GET  /app/arena         擂台小窗的页面（arena-window.ts 开的窗口加载它，对战演出时的两条气血条）
 *   GET  /app/fx            特效层的页面（fx-window.ts 开的窗口加载它，X7 演出时飞在两只中间的飞行物）
 *   GET  /app/panel         出招面板的页面（action-panel-window.ts 开的窗口加载它，X17 选方式 / 手动出招）
 *   GET  /app/battle        现在在等哪一手（逐手出招，curl 调试用；没有就 null）
 *   POST /app/battle/choose { pick }：选方式 / 点招（面板按钮与 curl 共用；pick 从 1 数）
 *
 * 与插件路由同一条安全线：拒绝网页来源（带 Origin 且不是 null 的请求），本机程序直接调用。
 * 端口每次启动随机，写在 `$DSH_HOME/dsh-pet/app.json`（见 discovery.ts）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { saveAppConfig } from './app-config';
import { adventurePage } from './adventure-window';
import { panelPage } from './action-panel-window';
import { arenaPage } from './arena-window';
import { brawlArenaPage } from './brawl-arena';
import type { AppConfig } from './app-config';
import type { AppFeatures } from './features';
import { notePage } from './note-window';
import { fxPage } from './fx-window';
import { foePage } from './foe-window';
import { guestPage } from './visit-windows';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SAY_CHARS = 200;

/** 「邻居」一节 POST 的参数（id 与邻居簿里身份 id 同一口径） */
const NEIGHBOR_ID = z.string().min(8).max(64);
const neighborActionSchema = z.union([
  z.object({ action: z.literal('friend'), id: NEIGHBOR_ID, friend: z.boolean() }),
  z.object({ action: z.literal('forget'), id: NEIGHBOR_ID }),
  z.object({ action: z.literal('clear') }),
  z.object({ action: z.literal('reset-identity') }),
]);

/**
 * @param features 功能编排（app ready 之前为 null：此时一律 503）
 * @returns 处理函数：不是 /app/ 开头的路径返回 false，交回给调用方
 */
export function createAppRoutes(
  features: () => AppFeatures | null,
  log: (message: string) => void,
): (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean {
  return (req, res, pathname) => {
    if (!pathname.startsWith('/app/')) return false;
    const origin = req.headers.origin;
    // 出招面板自己的按钮从同一来源 POST（选方式 / 点招）；只给这一条放行同源，其余网页来源照旧拒绝。
    // Host 还得是本机地址：DNS 重绑定的网页 Origin 和 Host 会一致，但 Host 是它自己的域名
    const host = req.headers.host;
    const port = req.socket.localPort;
    const localHost = port !== undefined && (host === `127.0.0.1:${port}` || host === `localhost:${port}`);
    const sameOrigin = localHost && origin === `http://${host}`;
    if (origin !== undefined && origin !== 'null' && !(pathname === '/app/battle/choose' && sameOrigin)) {
      send(res, 403, { error: '不允许网页来源访问' });
      return true;
    }
    const current = features();
    if (!current) {
      send(res, 503, { error: '桌宠还在启动' });
      return true;
    }
    void handle(current, req, res, pathname).catch((error: unknown) => {
      log(`接口失败 ${pathname}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(res, 500, { error: '内部错误' });
      else res.end();
    });
    return true;
  };
}

async function handle(
  features: AppFeatures,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (pathname === '/app/activity') {
    if (method !== 'GET') return send(res, 405, { error: '仅支持 GET' });
    return send(res, 200, { snapshot: features.activity(), context: features.activityContext() });
  }
  if (pathname === '/app/battle') {
    if (method !== 'GET') return send(res, 405, { error: '仅支持 GET' });
    return send(res, 200, { question: features.battle.state() });
  }
  if (
    pathname === '/app/guest' ||
    pathname === '/app/foe' ||
    pathname === '/app/adventure' ||
    pathname === '/app/note' ||
    pathname === '/app/arena' ||
    pathname === '/app/fx' ||
    pathname === '/app/panel' ||
    pathname === '/app/brawl-arena'
  ) {
    if (method !== 'GET') return send(res, 405, { error: '仅支持 GET' });
    const page =
      pathname === '/app/guest'
        ? guestPage
        : pathname === '/app/foe'
          ? foePage
          : pathname === '/app/adventure'
            ? adventurePage
            : pathname === '/app/note'
              ? notePage
              : pathname === '/app/arena'
                ? arenaPage
                : pathname === '/app/panel'
                  ? panelPage
                  : pathname === '/app/brawl-arena'
                    ? brawlArenaPage
                    : fxPage;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(page),
      'cache-control': 'no-store',
    });
    res.end(page);
    return;
  }
  if (method !== 'POST') return send(res, 405, { error: '仅支持 POST' });
  const body = await readJson(req);
  if (body === undefined) return send(res, 400, { error: '请求体必须是 JSON 对象（≤64KB）' });
  switch (pathname) {
    case '/app/say': {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_SAY_CHARS) return send(res, 400, { error: `text 必填，≤${MAX_SAY_CHARS} 字` });
      return send(res, 200, { ok: await features.say(text) });
    }
    case '/app/look':
      return send(res, 200, await features.lookAtScreen(true));
    case '/app/battle/choose': {
      const pick = body.pick;
      if (typeof pick !== 'number' || !Number.isInteger(pick) || pick < 1)
        return send(res, 400, { error: 'pick 必须是正整数（从 1 数）' });
      if (!features.battle.choose(pick)) return send(res, 409, { error: '现在没有等待的选择' });
      return send(res, 200, { ok: true, question: features.battle.state() });
    }
    case '/app/claude-hook':
      await features.handleClaudeHook(body);
      return send(res, 200, { ok: true });
    default:
      return send(res, 404, { error: 'not found' });
  }
}

/**
 * 设置页「陪伴与提醒」一节的读写（`/standalone-ai/app-settings`，即整份 app-config.json）。挂在配置页那组下，走令牌与同源校验
 * （调用方先过 security.authorize），不走上面 /app/* 的「拒绝网页来源」——设置页本身就是网页。
 * 只有独立应用注册这条路由；CLI 里它是 404，设置页据此不显示这一节。
 */
export function appSettingsHandler(
  path: string,
  appConfig: () => AppConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method === 'GET') return send(res, 200, appConfig());
    if (req.method !== 'POST') return send(res, 405, { error: '仅支持 GET 或 POST' });
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return send(res, 415, { error: '请使用 JSON 保存设置' });
    }
    const body = await readJson(req);
    let next: AppConfig;
    try {
      next = saveAppConfig(path, body);
    } catch {
      return send(res, 400, { error: '陪伴与提醒的设置不在允许范围内' });
    }
    send(res, 200, next);
  };
}

/**
 * 设置页「邻居」一节的读写（`/standalone-ai/app-neighbors`）：邻居簿（见面记录与熟人标记）与串门身份。
 * 同 app-settings，挂在配置页那组令牌校验的路由下；只有独立应用注册这条路由，CLI 里是 404，
 * 设置页据此不显示这一节。邻居数据是对方发来的昵称 / 宠物名，进页面前已在邻居簿里过 cleanName。
 */
export function appNeighborsHandler(
  features: () => AppFeatures | null,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const current = features();
    if (!current) return send(res, 503, { error: '桌宠还在启动' });
    if (req.method === 'GET') {
      // 身份 id 只回前 8 位：够认出「还是这台电脑」，也够当回执显示
      return send(res, 200, { id: current.neighbors.identityId().slice(0, 8), neighbors: current.neighbors.list() });
    }
    if (req.method !== 'POST') return send(res, 405, { error: '仅支持 GET 或 POST' });
    const body = await readJson(req);
    const action = neighborActionSchema.safeParse(body);
    if (!action.success) return send(res, 400, { error: '邻居操作的参数不对' });
    switch (action.data.action) {
      case 'friend':
        current.neighbors.setFriend(action.data.id, action.data.friend);
        break;
      case 'forget':
        current.neighbors.forget(action.data.id);
        break;
      case 'clear':
        current.neighbors.clear();
        break;
      case 'reset-identity':
        // 串门进行中不让换身份：换了，在外做客的宠物和家里的客人就都对不上号了
        if (!current.neighbors.resetIdentity())
          return send(res, 409, { error: '串门进行中，等宠物回家、送走客人再重置' });
        break;
    }
    send(res, 200, { ok: true });
  };
}

/**
 * 设置页「修炼」一节的读（`/standalone-ai/app-cultivation`）：境界的只读视图（CultivationView）。
 * 同 app-neighbors，挂在配置页那组令牌校验的路由下；只有独立应用注册这条路由，CLI 里是 404，
 * 设置页据此不显示这一节。只读：开关走 app-settings 里的 cultivation.enabled，这里不收写。
 * 开关关着（或还没建档）时 view() 是 null，照样 200——设置页只显示开关、不显示状态。
 */
export function appCultivationHandler(
  features: () => AppFeatures | null,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const current = features();
    if (!current) return send(res, 503, { error: '桌宠还在启动' });
    if (req.method !== 'GET') return send(res, 405, { error: '仅支持 GET' });
    send(res, 200, current.cultivation.view());
  };
}

/**
 * 设置页「宠物」一节的读写（`/standalone-ai/pet-settings`）：转给插件自己的 GET / PUT /dsh-pet-7340/config，
 * 不另写一套校验与合并——插件那边只改请求体带了的字段，main-config.jsonc 里手改的其余内容原样保留。
 * 设置页是网页，而插件路由拒绝带 Origin 的请求（防本机网页乱调），所以由这里先过令牌校验、再在本进程里代发。
 * 同 app-settings，只有独立应用注册；CLI 里是 404，设置页据此不显示这一节。
 * @param configUrl 插件配置接口的完整地址（端口启动后才知道，所以每次现取）
 * @param userFile main-config.jsonc 的路径（设置页提示「更多选项改这个文件」）
 */
export function petSettingsHandler(
  configUrl: () => string,
  userFile: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: '仅支持 GET 或 POST' });
    if (
      req.method === 'POST' &&
      req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
    ) {
      return send(res, 415, { error: '请使用 JSON 保存设置' });
    }
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    if (req.method === 'POST' && !body) return send(res, 400, { error: '宠物设置格式不对' });
    const response = await fetch(configUrl(), {
      method: req.method === 'POST' ? 'PUT' : 'GET',
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 409) return send(res, 409, { error: `宠物配置文件解析不了，先修好再保存：${userFile}` });
    if (!response.ok) {
      return send(res, req.method === 'POST' ? 400 : 502, {
        error: req.method === 'POST' ? '宠物设置不在允许范围内' : '宠物设置读取失败',
      });
    }
    send(res, 200, { config: (await response.json()) as unknown, file: userFile });
  };
}

/** 读 JSON 对象体；空体按 {}；超限 / 非对象 → undefined */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  // 事件式读取（与 standalone/server.ts 同法）：tsconfig 的 lib 不认 Readable 的 async iterator
  const chunks: Buffer[] = [];
  let size = 0;
  const complete = await new Promise<boolean>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(false);
      } else chunks.push(Buffer.from(chunk));
    });
    req.once('end', () => resolve(true));
    req.once('error', reject);
  });
  if (!complete) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}
