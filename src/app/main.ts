/**
 * dsh-pet 独立应用主进程 —— 「双击就能跑」的桌宠应用入口（单进程）。
 *
 * 它把三件事装进**同一个 Electron 进程**（不再 spawn 第二个 electron.exe）：
 *   1. 本机 HTTP 服务：插件宿主半边注册的路由 + 独立模式那套「配置页 / 状态页」；
 *   2. 插件宿主半边：`createPetHost()` 返回的 `/dsh-pet-7340` 路由直接挂在这个服务上；
 *   3. 桌面窗口：直接 `require` 现成的 `runtime/electron-helper/main.js`，窗口、托盘、拖拽、碰撞、
 *      DPI 补偿全部沿用桌面模式那一套，没有第二份实现。
 *
 * HTTP 面（右键「设置」打开的就是这些地址）：
 *   GET  /                      落地页（版本、配置路径、宠物清单）
 *   GET  /health                JSON 状态
 *   GET  /standalone-ai/        AI 配置页（HTML）
 *   GET/POST /standalone-ai/settings   读写配置（需 X-DSH-Pet-Token，令牌在地址的 #token= 里）
 *   POST /standalone-ai/test    连通性测试
 *   *    /dsh-pet-7340/...      插件路由（桌面窗口用，因此额外放行 CORS）
 *
 * 插件路由要服务 `file://` 页面，浏览器请求不带令牌，所以这一组只按 Origin 判定
 * （允许空 / null，拒绝网页来源），不套令牌；配置页那组仍然严格校验令牌与 Host。
 *
 * 环境变量（应用自身用）：
 *   DSH_PET_CONFIG_URL    交给 helper：本机服务 origin（渲染端 HTTP 直连用）
 *   DSH_PET_SITE_URL      交给 helper：右键「设置」用它（这里指向带令牌的配置页）
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { flattenPetList, readAllConfig } from '../host/config';
import { dshHomeDir } from '../host/paths';
import { createPetHost, ROUTE_PREFIX } from '../host/index';
import { createStandaloneAi } from '../standalone/ai-provider';
import { packageVersion } from './version';
import { createStandaloneLogger } from '../standalone/logger';
import { configPathsFor } from '../standalone/options';
import { createRequestSecurity, rejectRequest } from '../standalone/request-security';
import type { RequestSecurity } from '../standalone/request-security';
import { settingsHandler, testHandler } from '../standalone/server';
import { settingsPage, settingsScript, settingsStyle } from '../standalone/settings-page';
import type { StandaloneAiService } from '../standalone/ai-provider';
import { createAppConfig } from './app-config';
import {
  appCultivationHandler,
  appNeighborsHandler,
  appSettingsHandler,
  createAppRoutes,
  petSettingsHandler,
} from './app-routes';
import { removeDiscovery, writeDiscovery } from './discovery';
import { MENU_OWNER, startAppFeatures } from './features';
import type { AppFeatures, FeatureElectron } from './features';
import { teeOutputToFile } from './log-file';

/**
 * `electron` 由 Electron 运行时提供，**不是本包的依赖**。只声明实际用到的成员：
 * 静态 `import 'electron'` 会让 `tsc --noEmit` 找不到类型而整仓变红。
 */
interface WebContentsLike {
  on(
    event: 'console-message',
    listener: (event: unknown, level: number, message: string, line: number, sourceId: string) => void,
  ): void;
}
interface ElectronApp {
  getPath(name: 'appData' | 'logs'): string;
  setPath(name: 'userData', path: string): void;
  requestSingleInstanceLock(): boolean;
  exit(code?: number): void;
  relaunch(): void;
  quit(): void;
  on(event: 'web-contents-created', listener: (event: unknown, contents: WebContentsLike) => void): void;
  on(event: 'second-instance', listener: () => void): void;
  on(event: 'will-quit', listener: () => void): void;
  whenReady(): Promise<void>;
}
const { app } = createRequire(import.meta.url)('electron') as { app: ElectronApp };

/** lib/app.js → 包根（模块所在目录的上一级） */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const helperMain = join(packageRoot, 'runtime', 'electron-helper', 'main.js');

const log = (message: string): void => console.log(`[dsh-pet-app] ${message}`);

/** 用户显式指定的数据目录（没设时 boot 里补默认值：普通启动行为不变） */
const explicitHome = process.env.DSH_HOME;

/**
 * 显式设了 DSH_HOME（同机开两个实例自测 / 一份数据一个实例）：连同 Chromium 的 userData 一起分开。
 * 单实例锁是按 userData 区分的——不分开的话第二个实例直接被这把锁挡掉。
 * 没设 DSH_HOME 的普通启动照旧：只有一个实例，行为不变。
 */
if (explicitHome) {
  try {
    app.setPath('userData', join(explicitHome, 'electron-user-data'));
  } catch (error) {
    log(`userData 换到 DSH_HOME 失败：${String(error)}`);
  }
}

/** 单实例：第二次双击直接退出（共用 userData 的 Chromium profile 会互踢） */
const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.exit(0);
} else {
  await boot();
}

/**
 * 启动应用。`await` 在最外层：端口必须在 `require(helperMain)` 之前确定，因为 helper 在
 * `app.whenReady()` 里就要用 `DSH_PET_CONFIG_URL` / `DSH_PET_SITE_URL`；而它又必须在 ready
 * 之前被 require（内部有 `app.commandLine.appendSwitch`，ready 后再加不生效）。
 */
async function boot(): Promise<void> {
  // 双击 / 开机自启没有终端：日志另存一份到 ~/Library/Logs/dsh-pet/app.log
  if (!process.stdout.isTTY) teeOutputToFile(join(app.getPath('logs'), 'app.log'));
  // 独立应用用自己的数据目录（与 helper 的 userData 同一处），不和 DSH 的 ~/.dsh 共用配置、记忆与 AI 设置；
  // 显式设了 DSH_HOME 时尊重它。必须赶在下面任何 dshHomeDir() 之前。
  if (!process.env.DSH_HOME) process.env.DSH_HOME = join(app.getPath('appData'), 'dsh-pet');
  const logger = createStandaloneLogger();
  let port = 0;

  // 令牌只经「配置页地址的 #token=」递到浏览器，不进日志
  const security = createRequestSecurity();
  const ai = createStandaloneAi(dshHomeDir(), logger);

  // 扩展功能（src/app/features.ts）要等 app ready 才能用 powerMonitor / desktopCapturer，之前 /app/* 回 503
  let features: AppFeatures | null = null;
  // 应用功能开关：功能编排按 mtime 读它，设置页「陪伴与提醒」一节写它
  const appConfigPath = join(dshHomeDir(), 'dsh-pet', 'app-config.json');
  const appConfig = createAppConfig(appConfigPath, log);

  // 托盘勾选 / 右键关闭桌面显示 / 设置页保存都会走宿主的 syncDesktop：
  // 窗口与托盘就在本进程、只在启动时建一次，所以它们依据的配置变了就整个应用重启
  const launchedLayout = desktopLayout();
  let relaunching = false;
  const petHost = createPetHost({
    logger,
    ai,
    // 拼人设时追加「主人此刻」一行（宿主 petSystemPrompt 读这个钩子）
    appContext: () => features?.activityContext() ?? '',
    chatContext: () => features?.chatContext() ?? '',
    onChat: (petId, text) => features?.onChat(petId, text),
    desktopChanged: () => {
      const layout = desktopLayout();
      if (relaunching || layout === null || layout === launchedLayout) return;
      relaunching = true;
      log('桌面宠物或托盘配置变了，重启应用');
      // 稍等再退：触发这次变更的请求（如设置页保存）还要把响应发回去
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 500);
    },
  });

  const server = await startRouter(petHost.handler, {
    security,
    ai,
    appRoutes: createAppRoutes(() => features, log),
    appSettings: appSettingsHandler(appConfigPath, appConfig),
    appNeighbors: appNeighborsHandler(() => features),
    appCultivation: appCultivationHandler(() => features),
    petSettings: petSettingsHandler(
      () => `http://127.0.0.1:${port}/dsh-pet-7340/config`,
      configPathsFor(packageRoot, dshHomeDir()).userFile,
    ),
  });
  port = server.port;
  const origin = `http://127.0.0.1:${port}`;
  log(`本机服务 ${origin}`);

  process.env.DSH_PET_APP_MENU_OWNER = MENU_OWNER;
  process.env.DSH_PET_CONFIG_URL = `${origin}/dsh-pet-7340/config`;
  // 右键「设置」用它：带令牌的配置页。裸 origin 在应用里没有页面可看。
  process.env.DSH_PET_SITE_URL = security.authenticatedUrl(origin);
  if (!process.env.DSH_PET_SCALE) process.env.DSH_PET_SCALE = '1';

  log('宿主已就绪');

  // helper 读它决定建几个窗口；读不到时它会回落到单个默认窗口，首帧再由渲染端自校正
  process.env.DSH_PET_PETS = JSON.stringify(desktopPets());

  // 同一个进程里跑 helper：建窗、托盘、IPC、碰撞全在它内部完成（CJS，需要 require）
  // 渲染端日志必须转出来：打包后的应用没有控制台，渲染端报错只会表现成「窗口透明」。
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (_e, level, message, line, source) => {
      log(`渲染端[${level}] ${message} (${source}:${line})`);
    });
  });
  createRequire(import.meta.url)(helperMain);
  // helper 加载时把 userData 定到 appData/dsh-pet；显式 DSH_HOME 的多实例自测要沿用上面分开的那份
  if (explicitHome) app.setPath('userData', join(explicitHome, 'electron-user-data'));

  void app.whenReady().then(() => {
    const home = dshHomeDir();
    features = startAppFeatures({
      electron: createRequire(import.meta.url)('electron') as FeatureElectron,
      ai,
      configPaths: configPathsFor(packageRoot, home),
      appConfig,
      diaryDir: join(home, 'dsh-pet', 'diary'),
      snackPath: join(home, 'dsh-pet', 'snacks.json'),
      identityPath: join(home, 'dsh-pet', 'visit-identity.json'),
      neighborsPath: join(home, 'dsh-pet', 'neighbors.json'),
      cultivationPath: join(home, 'dsh-pet', 'cultivation.json'),
      bondPath: join(home, 'dsh-pet', 'bond.json'),
      petBase: `${origin}/dsh-pet-7340`,
      log,
    });
    writeDiscovery(home, { port, pid: process.pid, version: packageVersion(packageRoot) });
  });

  app.on('second-instance', () => log('已有一个实例在运行，忽略本次启动'));
  app.on('will-quit', () => {
    features?.dispose();
    removeDiscovery(dshHomeDir(), process.pid);
    void ai.dispose();
    void petHost.dispose().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
}

/**
 * 桌面宠物清单（[{id,size}]）：配置里的每只宠物都显示在桌面上，每只建一个窗口。
 */
function desktopPets(): Array<{ id: string; size: number }> {
  try {
    const pets = flattenPetList(readAllConfig(configPathsFor(packageRoot, dshHomeDir())));
    const desktop = pets.map((pet) => ({ id: String(pet.id), size: Number(pet.size) }));
    log(`桌面宠物 ${JSON.stringify(desktop)}`);
    return desktop;
  } catch (error) {
    log(`读配置失败（回落单窗）：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * 窗口与托盘依据的那部分配置（宠物清单 / size + trayEnabled 开关）。
 * 读不到配置时返回 null：不因为一次读坏就重启应用。
 */
function desktopLayout(): string | null {
  try {
    const merged = readAllConfig(configPathsFor(packageRoot, dshHomeDir()));
    return JSON.stringify({
      tray: merged.main?.trayEnabled !== false,
      pets: flattenPetList(merged).map((pet) => [pet.id, pet.name, pet.size]),
    });
  } catch (error) {
    log(`读配置失败（不重启）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

interface RouterDeps {
  security: RequestSecurity;
  ai: StandaloneAiService;
  /** 应用自己的 /app/* 接口；不是这组路径时返回 false */
  appRoutes: (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean;
  /** 设置页「陪伴与提醒」一节（/standalone-ai/app-settings，与配置页同一套令牌校验） */
  appSettings: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** 设置页「邻居」一节（/standalone-ai/app-neighbors，同上） */
  appNeighbors: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** 设置页「修炼」一节（/standalone-ai/app-cultivation，同上） */
  appCultivation: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** 设置页「宠物」一节（/standalone-ai/pet-settings，同上；转给插件的 /config） */
  petSettings: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

/**
 * 本机 HTTP 面：宿主路由 + 应用自己的「状态 / 配置页」。
 *
 * 桌面窗口是 `file://` 页面（Origin 为 `null`、Sec-Fetch-Site 为 cross-site），配置页那套
 * 「Host 校验 + 同源 Origin」会把它整组拒掉，所以这里按**两类请求分开**处理：
 * 配置页走完整的安全模型，宿主路由只做「拒绝网页来源」这一条
 * （否则本机任意网页都能调 /whisper、/chat 花掉模型额度）。
 */
function startRouter(
  petHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  deps: RouterDeps,
): Promise<{ port: number; close: () => Promise<void> }> {
  const settings = settingsHandler(deps.ai);
  const tester = testHandler(deps.ai);
  /** 监听后才知道端口：落地页/状态页要显示它 */
  let boundPort = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ---- 配置页：与 CLI 完全一致（静态资源公开，读写接口要令牌）----
    if (url.pathname === '/standalone-ai/') {
      sendText(res, 200, 'text/html', settingsPage);
      return;
    }
    if (url.pathname === '/standalone-ai/settings.js') {
      sendText(res, 200, 'text/javascript', settingsScript);
      return;
    }
    if (url.pathname === '/standalone-ai/settings.css') {
      sendText(res, 200, 'text/css', settingsStyle);
      return;
    }
    if (
      url.pathname === '/standalone-ai/settings' ||
      url.pathname === '/standalone-ai/test' ||
      url.pathname === '/standalone-ai/app-settings' ||
      url.pathname === '/standalone-ai/app-neighbors' ||
      url.pathname === '/standalone-ai/app-cultivation' ||
      url.pathname === '/standalone-ai/pet-settings'
    ) {
      if (!deps.security.authorize(req, res)) return;
      const handler =
        url.pathname === '/standalone-ai/test'
          ? tester
          : url.pathname === '/standalone-ai/app-settings'
            ? deps.appSettings
            : url.pathname === '/standalone-ai/app-neighbors'
              ? deps.appNeighbors
              : url.pathname === '/standalone-ai/app-cultivation'
                ? deps.appCultivation
                : url.pathname === '/standalone-ai/pet-settings'
                  ? deps.petSettings
                  : settings;
      void handler(req, res).catch((error: unknown) => {
        log(`配置页接口失败 ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) rejectRequest(res, 500, '配置页暂时无法处理请求');
        else res.end();
      });
      return;
    }

    // ---- 状态与落地页 ----
    if (url.pathname === '/health') {
      sendJson(res, status(boundPort));
      return;
    }
    if (url.pathname === '/') {
      sendText(res, 200, 'text/html', landingPage(boundPort));
      return;
    }

    if (deps.appRoutes(req, res, url.pathname)) return;

    // ---- 插件路由（桌面窗口）----
    if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'null') {
      // 来自网页的跨站请求：本机任意网站都能打这几个端点（含 /chat、/whisper 会花钱）
      rejectRequest(res, 403, '不允许网页来源访问');
      return;
    }
    // 窗口是 file:// 页面，属于跨源请求：插件 handler 不写 CORS，这里统一补
    res.setHeader('access-control-allow-origin', '*');
    petHandler(req, res).catch((error: unknown) => {
      log(`路由失败 ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      boundPort = address.port;
      resolvePromise({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function status(port: number): Record<string, unknown> {
  const paths = configPathsFor(packageRoot, dshHomeDir());
  let pets: Array<Record<string, unknown>> = [];
  try {
    pets = flattenPetList(readAllConfig(paths));
  } catch {
    /* 落地页/状态接口不该因配置坏掉而 500：下面如实显示 0 只 */
  }
  return {
    name: 'dsh-pet-app',
    version: packageVersion(packageRoot),
    pid: process.pid,
    port,
    pluginRoot: packageRoot,
    configFile: paths.userFile,
    pets: pets.map((pet) => ({ id: pet.id, name: pet.name })),
  };
}

/** 落地页：取代以前的 `not found`。配置项只能改文件，真正的可视化配置在 /standalone-ai/。 */
function landingPage(port: number): string {
  const info = status(port);
  const pets = (info.pets as Array<Record<string, unknown>>) ?? [];
  const petLines = pets.length
    ? pets.map((pet) => `<li>${escapeHtml(String(pet.name ?? pet.id))}</li>`).join('')
    : '<li>（未读到宠物，检查配置文件）</li>';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-pet</title>
<style>
  body{font:14px/1.7 "Segoe UI",system-ui,sans-serif;margin:0;padding:32px;background:#f6f8fa;color:#1f2328}
  main{max-width:720px;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:28px 32px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#656d76;margin-bottom:20px}
  h2{font-size:14px;margin:22px 0 6px} code{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:1px 6px;font-size:12px}
  ul{margin:6px 0;padding-left:20px} a{color:#0969da}
</style></head>
<body><main>
  <h1>dsh-pet 桌宠</h1>
  <div class="sub">版本 ${escapeHtml(String(info.version))} · 端口 ${port}</div>
  <h2>宠物</h2><ul>${petLines}</ul>
  <h2>配置文件</h2>
  <p><code>${escapeHtml(String(info.configFile))}</code></p>
  <p>改完配置后从托盘退出、重新打开应用即可生效（本模式没有「重载配置」菜单）。</p>
  <h2>AI 设置</h2>
  <p>AI 模型与密钥的配置页需要令牌，请<strong>右键桌宠 →「打开 AI 设置」</strong>，会直接打开已授权的页面。</p>
  <h2>状态</h2>
  <p><a href="/health">/health</a> · <a href="/standalone-ai/">配置页（未授权时读写会返回 403）</a></p>
</main></body></html>`;
}

function sendText(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}
