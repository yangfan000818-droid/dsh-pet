import { flattenPetList, readAllConfig } from '../host/config';
import type { StandaloneAiService } from '../standalone/ai-provider';
import { configPathsFor } from '../standalone/options';
import { DEFAULT_APP_CONFIG } from './app-config';
import type { AppConfig } from './app-config';
import { SKILLS } from './battle';
import type { SkillId, Fighter } from './battle';
import { startAppFeatures } from './features';
import type { FeatureElectron, AppFeatures, FeatureDeps } from './features';
import { loadVisitIdentity, generateVisitIdentity } from './visit-identity';
import { knockOn, sparCardOf, VisitHost } from './visit';
import type { SparCard, DuelAnswer } from './visit';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 假环境里可调的：键鼠空闲秒数、模型是否就绪 / 能否看图、屏幕录制授权、挑表情包时模型的回答、看屏幕时模型磨蹭多久（测试改完要还原） */
export const env = {
  idleSec: 0,
  ready: true,
  canSeeScreen: true,
  permission: 'granted',
  visionCalls: 0,
  getSourcesCalls: 0,
  /** 非 null 时 streamVision 抛这个错（测「识别出不支持看图」那一拍） */
  visionError: null as Error | null,
  memeAnswer: '无',
  /** 按调用顺序吐给 compose 的回答（用完后回落到 memeAnswer） */
  memeReplies: [] as string[],
  /** 非 null 时 compose 的模型调用卡在这里不返回（§X14 测「收摊不等感言」） */
  memeHold: null as Promise<void> | null,
  visionDelayMs: 0,
  visionDone: 0,
  /** 逐手出招（X17）：按调用顺序吐给 streamBattle 的回答 */
  battleReplies: [] as string[],
  /** 非 null 时 streamBattle 卡在这里不返回（测 15 秒超时） */
  battleHold: null as Promise<void> | null,
  /** streamBattle 被调用了几次 */
  battleCalls: 0,
};

/** 假窗口（客人 / 心魔 / 擂台）：记下页面调用与销毁 */
export interface FakeWin {
  isDestroyed(): boolean;
  getBounds(): { x: number; y: number; width: number; height: number };
  setBounds(rect: { x: number; y: number; width: number; height: number }): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  setAlwaysOnTop(flag: boolean, level: 'floating'): void;
  setVisibleOnAllWorkspaces(visible: boolean, options: { visibleOnFullScreen: boolean }): void;
  loadURL(url: string): Promise<void>;
  showInactive(): void;
  show(): void;
  hide(): void;
  focus(): void;
  once(event: 'closed', listener: () => void): void;
  destroy(): void;
  answerAdv(value: unknown): void;
  webContents: { getURL(): string; executeJavaScript(code: string): Promise<unknown> };
  url: string;
  calls: string[];
  destroyed: boolean;
  hidden: boolean;
  /** 被 `showInactive()` 亮出来的次数（擂台选方式前不亮、开打才亮，靠它断言） */
  inactiveShown: number;
}

/** 建窗与页面调用记录（心魔试炼那场用；其他测试不开窗口，看到的一直是空） */
export const windows: FakeWin[] = [];

export function fakeWindow(url: string): FakeWin {
  let advWaiter: ((value: unknown) => void) | null = null;
  const closedListeners: Array<() => void> = [];
  const win: FakeWin = {
    calls: [],
    destroyed: false,
    hidden: false,
    inactiveShown: 0,
    url,
    isDestroyed: () => win.destroyed,
    getBounds: () => ({ x: 0, y: 0, width: 200, height: 200 }),
    setBounds: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: (target) => {
      win.url = target;
      return Promise.resolve();
    },
    showInactive: () => {
      win.hidden = false;
      win.inactiveShown += 1;
    },
    show: () => {
      win.hidden = false;
    },
    hide: () => {
      win.hidden = true;
    },
    focus: () => undefined,
    once: (_event, listener) => {
      closedListeners.push(listener);
    },
    destroy: () => {
      win.destroyed = true;
      for (const listener of closedListeners.splice(0)) listener();
    },
    answerAdv: (value) => {
      const done = advWaiter;
      advWaiter = null;
      done?.(value);
    },
    webContents: {
      getURL: () => win.url,
      executeJavaScript: (code) => {
        win.calls.push(code);
        if (code === 'adv.wait()') return new Promise((resolve) => (advWaiter = resolve));
        if (code === 'adv.cancel()') {
          advWaiter = null;
          return Promise.resolve(undefined);
        }
        return Promise.resolve(undefined);
      },
    },
  };
  windows.push(win);
  return win;
}

/** 假 helper 报自家宠物位置：特效层要拿它的舞台矩形才开得了窗（真机上 helper 会一直报） */
export const petBoundsListeners: Array<(event: unknown, payload: unknown) => void> = [];
export function emitPetBounds(payload: Record<string, number>): void {
  for (const listener of [...petBoundsListeners]) listener({}, payload);
}

/** 测试配置里这只宠物的名字（`timeline` 的台词要按真实名字算，和 app 里 `petName()` 同一口径） */
export function petNameIn(home: string): string {
  try {
    const pets = flattenPetList(readAllConfig(configPathsFor(packageRoot, home)));
    const target = pets.find((pet) => String(pet.id) === 'main') ?? pets[0];
    return String(target?.name ?? '') || '桌宠';
  } catch {
    return '桌宠';
  }
}

export const electron: FeatureElectron = {
  powerMonitor: { getSystemIdleTime: () => env.idleSec, getSystemIdleState: () => 'active' },
  desktopCapturer: {
    getSources: () => {
      env.getSourcesCalls += 1;
      return Promise.resolve([
        { display_id: '1', thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('jpeg') } },
      ]);
    },
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
  systemPreferences: { getMediaAccessStatus: () => env.permission },
  shell: { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve('') },
  // 只有心魔试炼 / 切磋那几项会开窗口（客人、擂台、特效层），其余测试一个都不建
  BrowserWindow: Object.assign(
    function () {
      return fakeWindow('');
    },
    { getAllWindows: () => [] },
  ) as unknown as FeatureElectron['BrowserWindow'],
  ipcMain: {
    on: (channel, listener) => {
      if (channel === 'pet:set-bounds') petBoundsListeners.push(listener);
    },
    removeListener: (channel, listener) => {
      if (channel !== 'pet:set-bounds') return;
      const at = petBoundsListeners.indexOf(listener);
      if (at >= 0) petBoundsListeners.splice(at, 1);
    },
  },
};

/** 看屏幕发给模型的指令、挑表情包时发给模型的话（按调用顺序） */
export const visionPrompts: string[] = [];
export const memeAsks: string[] = [];

export const ai = {
  canSeeScreen: () => env.canSeeScreen,
  isReady: () => env.ready,
  currentSelection: () => ({ provider: 'local', model: 'qwen' }),
  stream: async function* (options: { messages: Array<{ content: Array<{ text: string }> }> }) {
    memeAsks.push(options.messages[0].content[0].text);
    if (env.memeHold) await env.memeHold;
    const reply = env.memeReplies.length > 0 ? env.memeReplies.shift()! : env.memeAnswer;
    yield { type: 'text', text: reply };
  },
  streamBattle: async function* () {
    env.battleCalls += 1;
    if (env.battleHold) await env.battleHold;
    const reply = env.battleReplies.length > 0 ? env.battleReplies.shift()! : env.memeAnswer;
    yield { type: 'text', text: reply };
  },
  streamVision: async function* (input: { prompt: string }) {
    visionPrompts.push(input.prompt);
    env.visionCalls += 1;
    if (env.visionError) {
      const error = env.visionError;
      env.canSeeScreen = false;
      throw error;
    }
    if (env.visionDelayMs > 0) await new Promise((done) => setTimeout(done, env.visionDelayMs));
    yield { type: 'text', text: '主人在写代码呀' };
    env.visionDone += 1;
  },
} as unknown as StandaloneAiService;

/** 修炼存档里能用的最小一份（炼气九层修满 = 圆满，等突破） */
export function cultivationSeed(): Record<string, unknown> {
  return {
    version: 1,
    stage: 8,
    progress: 150,
    stats: { hp: 104, power: 8, agility: 8, speed: 8 },
    weapons: ['water-gun'],
    skills: [],
    pills: 0,
    offer: null,
    today: { date: '2000-01-01', presence: 0, presenceMs: 0, rests: 0, pills: 0, trial: 0, spars: [] },
    record: { wins: 0, losses: 0 },
  };
}

/** withFeatures 顺带记下来的：最近一次注册的菜单 labels、播过的 /anim 请求体、应用的日志、按先后记的全部请求（带的占用锁） */
export interface FeaturesExtras {
  menus: string[][];
  anims: Array<Record<string, unknown>>;
  logs: string[];
  requests: Array<{ path: string; lock: string | null; body: Record<string, unknown>; at?: number }>;
}

/**
 * 测试用的应用配置：默认配置里下班提醒是开着的，它按真实钟点触发（工作日 17:50 起），
 * 晚上跑测试时会插进来说一句、占住模型（被 memeHold 卡住时后面的 compose 全排在它后头）。
 * 这里的用例都不测下班提醒（它在 reminders.test.ts 里单测），一律关掉，结果才不随钟点变。
 */
export const TEST_APP_CONFIG: AppConfig = {
  ...DEFAULT_APP_CONFIG,
  offWork: { ...DEFAULT_APP_CONFIG.offWork, enabled: false },
};

/**
 * 起一套功能编排跑 fn：插件路由由假服务应答（/broadcast 回 broadcast 并记下说的话与整个请求体，
 * /memes 回 memes 池，其余一律成功），应用配置取 config 的当前值（测试里可以改）。
 * fn 的 home 是这套编排的临时数据目录（宠物日记在 home/diary）。
 */
export async function withFeatures(
  options: {
    broadcast?: Record<string, unknown>;
    config?: AppConfig;
    memes?: Array<{ name: string; desc: string }>;
    /** 依次吐给 /menu/events 的菜单点击（label 一项；用完照旧回空） */
    clicks?: string[];
    /** 修炼用注入的随机数（丹药等） */
    rng?: () => number;
    /** 启动前写进 cultivation.json 的存档（比如造一个快圆满的） */
    cultivation?: Record<string, unknown>;
    /** 启动前写进 neighbors.json 的邻居簿（隔空切磋要按 id 记账） */
    neighbors?: Record<string, unknown>;
    /** 切磋等应战 / 亮随机数的时限（默认 30 秒；测试调短） */
    sparWaitMs?: number;
    /** 逐手出招（X17）：选方式 / AI 一手 / 手动一手的时限；测试调短 */
    modeTimeoutMs?: number;
    aiTurnTimeoutMs?: number;
    actionTimeoutMs?: number;
    /** 逐手对传（X19）：等对面一手多久算掉线；测试调短 */
    turnWaitMs?: number;
    /** 信标的端口、发往地址与手动邻居的发往端口（测试注入：绑随机端口、不往真实广播地址发） */
    beacon?: {
      port?: number;
      targets?: () => Array<{ address: string; port: number }>;
      peerPort?: number;
    };
    /** 占用锁已经被用户撤掉：带锁的 /anim、/broadcast 一律回 lock-lost（不带锁的照常成功） */
    lockLost?: boolean;
    /** /lock 的应答晚多久（模拟占锁的往返：测第一段演出有没有抢在锁前面） */
    lockDelayMs?: number;
    /** /whisper 的响应（降级成碎碎念时用） */
    whisper?: Record<string, unknown>;
  },
  fn: (
    features: AppFeatures,
    said: string[],
    bodies: Array<Record<string, unknown>>,
    home: string,
    extras: FeaturesExtras,
  ) => Promise<void>,
): Promise<void> {
  const said: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const menus: string[][] = [];
  const anims: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const requests: FeaturesExtras['requests'] = [];
  const server = createServer((req, res) => {
    const { pathname: path, searchParams } = new URL(req.url ?? '/', 'http://127.0.0.1');
    const lock = searchParams.get('lock');
    const reply = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.once('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      // 只给调了 /lock 延迟的测试记时刻：拿它比「第一段动画有没有等到锁到手」
      const at = options.lockDelayMs ? Date.now() : undefined;
      requests.push({ path: path.replace(/^\/dsh-pet-7340/, ''), lock, body, ...(at === undefined ? {} : { at }) });
      if (options.lockLost && lock !== null && (path.endsWith('/anim') || path.endsWith('/broadcast'))) {
        reply({ ok: false, reason: 'lock-lost', cause: 'preempted' });
      } else if (path.endsWith('/lock')) {
        const granted = { ok: true, lockId: typeof body.lockId === 'string' ? body.lockId : 'show-lock', expiresAt: 0 };
        if (options.lockDelayMs) setTimeout(() => reply(granted), options.lockDelayMs);
        else reply(granted);
      } else if (path.endsWith('/broadcast')) {
        bodies.push(body);
        said.push(String(body.text));
        reply(options.broadcast ?? { ok: true });
      } else if (path.endsWith('/whisper')) reply(options.whisper ?? { ok: true });
      else if (path.endsWith('/memes')) reply({ ok: true, memes: options.memes ?? [] });
      else if (path.endsWith('/anim')) {
        anims.push(body);
        reply({ ok: true });
      } else if (path.endsWith('/menu/item')) {
        if (Array.isArray(body.labels)) menus.push(body.labels as string[]);
        reply({ ok: true });
      } else if (path.endsWith('/menu/events')) {
        const click = options.clicks?.shift();
        if (click) reply({ ok: true, events: { [click]: 'main' } });
        else setTimeout(() => reply({ ok: true, events: {} }), 50);
      } else reply({ ok: true });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-features-'));
  if (options.cultivation) writeFileSync(join(home, 'cultivation.json'), JSON.stringify(options.cultivation));
  if (options.neighbors) writeFileSync(join(home, 'neighbors.json'), JSON.stringify(options.neighbors));
  const config = options.config ?? TEST_APP_CONFIG;
  const deps: FeatureDeps = {
    electron,
    ai,
    configPaths: configPathsFor(packageRoot, home),
    appConfig: () => config,
    diaryDir: join(home, 'diary'),
    snackPath: join(home, 'snacks.json'),
    identityPath: join(home, 'visit-identity.json'),
    neighborsPath: join(home, 'neighbors.json'),
    cultivationPath: join(home, 'cultivation.json'),
    cultivationRng: options.rng,
    sparWaitMs: options.sparWaitMs,
    modeTimeoutMs: options.modeTimeoutMs,
    aiTurnTimeoutMs: options.aiTurnTimeoutMs,
    actionTimeoutMs: options.actionTimeoutMs,
    turnWaitMs: options.turnWaitMs,
    beacon: options.beacon,
    petBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dsh-pet-7340`,
    log: (message) => logs.push(message),
  };
  const features = startAppFeatures(deps);
  try {
    await fn(features, said, bodies, home, { menus, anims, logs, requests });
  } finally {
    features.dispose();
    // 等挂着的菜单长轮询回来、看到 disposed 再关服务，免得它进入失败重试的 5 秒等待
    await new Promise((done) => setTimeout(done, 200));
    server.closeAllConnections();
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/** 数组最后一项（tsconfig 的 lib 不含 Array.prototype.at） */
export const last = <T>(list: T[]): T | undefined => list[list.length - 1];

/** 手动放行的闸：让 compose 的模型调用挂在这里不返回（§X14 测「收摊不等感言」） */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 某一页还活着的假窗口（同一页可能开了两场：上一场销毁后仍留在 windows 里） */
export const liveWindowsOn = (page: string): FakeWin[] =>
  windows.filter((win) => !win.destroyed && win.url.endsWith(page));

/** 等条件成立（首拍采样是异步的：要先跑完 lsappinfo） */
/** 等条件成立（首拍采样是异步的；演出的台词按时间线走，第一条在 2.4 秒那一刻，tries 要给够） */
export async function until(check: () => boolean, what = '', tries = 100): Promise<void> {
  for (let i = 0; i < tries && !check(); i += 1) await new Promise((done) => setTimeout(done, 20));
  assert.ok(check(), `等待超时 ${what}`);
}

/** 读修炼存档（后面几个修炼的测试用） */
export function cultivationSave(home: string): Record<string, unknown> | null {
  const path = join(home, 'cultivation.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null;
}

/** 招式编号 → 中文名（菜单「领悟：X」的标签用它拼，测试不重复一份表） */
export const SKILL_NAMES: Record<string, string> = Object.fromEntries(
  Object.values(SKILLS).map((def) => [def.id as SkillId, def.name]),
);

/** 圆满档（炼气九层修满）：X4 换成渡劫，这一档加丹数与属性，造必赢 / 必输两种局面用 */
export function cultivationFull(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...cultivationSeed(), ...over };
}

/** 找某一页的假窗口（按 URL 结尾） */
export const windowOn = (page: string): FakeWin | undefined => windows.find((win) => win.url.endsWith(page));

/** 一层炼气的存档（心魔试炼 / 切磋那几项用：从第一层开始，进账看得清）；属性照建档口径（气血 50、三维合计 11），不能越 statCap(0) */
export function cultivationEarly(): Record<string, unknown> {
  return { ...cultivationSeed(), stage: 0, progress: 0, stats: { hp: 50, power: 4, agility: 4, speed: 3 } };
}

/** 出招面板（X17）等在等选择时，按 `pick` 选（1 = 自动 / 2 = AI / 3 = 手动；手动出招时是编号） */
export async function pickPanel(features: AppFeatures, pick: number, what: string): Promise<void> {
  await until(() => features.battle.state() !== null, `${what}面板`);
  assert.ok(features.battle.choose(pick), `${what}点了 ${pick}`);
}

/** 点开一场心魔试炼、选出招方式并等它开演（§X14 那几条用；菜单看**最新**一帧，历史快照不算） */
export async function startTrial(
  features: AppFeatures,
  clicks: string[],
  menus: string[][],
  what: string,
  pick = 1,
): Promise<void> {
  await until(() => (menus[menus.length - 1] ?? []).includes('修炼/心魔试炼'), `${what}菜单`);
  clicks.push('修炼/心魔试炼');
  await pickPanel(features, pick, what);
  await until(() => (menus[menus.length - 1] ?? []).includes('修炼/快进'), `${what}开打`);
}

/** 心魔 / 切磋的记账条数（赢 + 负） */
export function fightCount(home: string): number {
  const record = cultivationSave(home)?.record as { wins: number; losses: number } | undefined;
  return record ? record.wins + record.losses : 0;
}

/** 空着的 UDP 端口（先占住再让出来：信标要用它，不能碰真 app 的 47340，也不能往真实广播地址发） */
export async function freeUdpPort(): Promise<number> {
  const socket = createSocket('udp4');
  await new Promise<void>((done) => socket.bind(0, '127.0.0.1', done));
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((done) => socket.close(() => done()));
  return port;
}

/** 开着接待的 features 里，替一位带身份的客人敲门、点菜单让进；返回接待端口与令牌 */
export async function knockIn(
  home: string,
  clicks: string[],
  extras: FeaturesExtras,
): Promise<{ port: number; token: string }> {
  const { menus, logs } = extras;
  await until(() => logs.some((line) => /接待开了，端口 (\d+)/.test(line)), '接待开了');
  const port = Number(/接待开了，端口 (\d+)/.exec(logs.find((line) => /接待开了，端口/.test(line))!)![1]);
  // 身份文件里只有私钥：id 要真的把它加载出来（照 visit-identity 的口径）
  const hostId = loadVisitIdentity(join(home, 'visit-identity.json'), () => undefined).id;
  const knocking = knockOn(
    { address: '127.0.0.1', port },
    { owner: '小李', pet: '阿花' },
    generateVisitIdentity(),
    hostId,
  );
  await until(() => menus.some((labels) => labels.includes('让 阿花 进来')), '敲门进了菜单');
  clicks.push('让 阿花 进来');
  const answer = await knocking;
  assert.ok(answer.ok, '敲开了门');
  assert.ok(answer.ok && answer.verified, '主人家的签名对上了');
  return { port, token: answer.ok ? answer.token : '' };
}

/** 开着接待的 features 里，等接待端口开出来，返回端口与本机身份 id（隔空切磋要按 id 签名） */
export async function hostedApp(home: string, extras: FeaturesExtras): Promise<{ port: number; hostId: string }> {
  await until(() => extras.logs.some((line) => /接待开了，端口 (\d+)/.test(line)), '接待开了');
  const port = Number(/接待开了，端口 (\d+)/.exec(extras.logs.find((line) => /接待开了，端口/.test(line))!)![1]);
  const hostId = loadVisitIdentity(join(home, 'visit-identity.json'), () => undefined).id;
  return { port, hostId };
}

/** 一条邻居簿记录（隔空切磋的账要按 id 记；旧文件缺的字段照 zod 默认补上） */
export function neighborRecord(
  id: string,
  owner: string,
  pet: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    owner,
    pet,
    friend: false,
    hosted: 0,
    visited: 0,
    firstMet: Date.now(),
    lastMet: Date.now(),
    summary: '',
    sparWins: 0,
    sparLosses: 0,
    lastSparWon: null,
    ...over,
  };
}

/** 客人（阿花）的名帖：炼气二层、扑克牌、化鸽遁（都在 statCap(1) 之内） */
export function guestCard(): SparCard {
  return sparCardOf({ name: '阿花', hp: 56, power: 5, agility: 5, speed: 5, weapons: ['poker'], skills: ['dove'] }, 1);
}

/** 主人家这边的战斗档案：照 cultivationEarly 的档造的（气血 50、灵力 4 / 身法 4 / 遁速 3、一件水枪、没有招式） */
export const hostFighter: Fighter = {
  name: '桌宠',
  hp: 50,
  power: 4,
  agility: 4,
  speed: 3,
  weapons: ['water-gun'],
  skills: [],
};

/** 开接待那套配置（信标绑测试自己的端口、哪儿都不发） */
export function visitConfig(): AppConfig {
  const config = structuredClone(TEST_APP_CONFIG);
  config.visit.enabled = true;
  config.visit.hosting = true;
  return config;
}

/** 假邻居（隔空切磋的挑战方用）：应战 / 不应战、reveal 都按测试给的口径答 */
export async function fakeDuelHost(options: {
  duel: (card: SparCard, commit: string) => Promise<DuelAnswer>;
  duelReveal?: (nonce: string, line: string) => void;
  duelConceded?: (reason: 'mismatch' | 'late') => void;
}): Promise<{ host: VisitHost; id: string; port: number }> {
  const identity = generateVisitIdentity();
  const host = new VisitHost(
    {
      canHost: () => true,
      knocked: () => undefined,
      knockEnded: () => undefined,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async () => ({ ok: false, reason: 'off' as const }),
      reveal: async () => ({ ok: false, reason: 'late' as const }),
      duel: (_visitor, card, commit) => options.duel(card, commit),
      duelReveal: (_visitor, nonce, line) => options.duelReveal?.(nonce, line),
      duelConceded: (_visitor, reason) => options.duelConceded?.(reason),
      left: () => undefined,
    },
    { log: () => undefined, identity },
  );
  const port = await host.listen('127.0.0.1');
  return { host, id: identity.id, port };
}
