/**
 * 拆开后的 features 共享同一份上下文：依赖（deps）、日志、服务与状态对象。
 * 各块只读写这里的东西，块与块之间经 `fns` 调，不互相 import（免得循环）。
 */
import type { ConfigPaths } from '../../host/config';
import type { StandaloneAiService } from '../../standalone/ai-provider';
import type { ActivitySnapshot, ActivityTracker } from '../activity';
import type { AdventureFlow, AdventureTurnQuestion } from '../adventure-flow';
import type { AppConfig } from '../app-config';
import type { ActionPanelWindow, PanelView, TurnMode } from '../action-panel-window';
import type { ArenaWindow } from '../arena-window';
import type { Action, BattleEvent, Fighter } from '../battle';
import type { LiveBattle } from '../battle-live';
import type { BattleShow } from '../battle-show';
import type { Step } from '../battle-show';
import type { ClaudeHookPayload, ClaudeSessions } from '../claude-hooks';
import type { Cultivation, CultivationEvent, CultivationView } from '../cultivation';
import type { Diary } from '../diary';
import type { FxWindow } from '../fx-window';
import type { LastGuest, NeighborBook, NeighborRecord } from '../neighbors';
import type { NoteOpener } from '../note-window';
import type { HealthReminders, OffWorkReminder } from '../reminders';
import type { Snack, SnackPouch } from '../snacks';
import type { WorkStatus } from '../status';
import type {
  DuelAnswer,
  Neighbor,
  Neighborhood,
  SparCard,
  SparReply,
  SparRevealReply,
  SparTurnReply,
  VisitHost,
  Visitor,
} from '../visit';
import type { PlayThing } from '../visit-talk';
import type { VisitIdentity } from '../visit-identity';
import type { GuestWindow, PetBox, Rect, WindowElectron } from '../visit-windows';

/** 本模块用到的 Electron 能力（只声明用到的成员：静态 import 'electron' 会让 tsc 整仓找不到类型） */
export interface FeatureElectron {
  powerMonitor: {
    getSystemIdleTime(): number;
    getSystemIdleState(idleThreshold: number): string;
  };
  desktopCapturer: {
    getSources(options: {
      types: Array<'screen'>;
      thumbnailSize: { width: number; height: number };
    }): Promise<Array<{ display_id: string; thumbnail: { isEmpty(): boolean; toJPEG(quality: number): Buffer } }>>;
  };
  screen: {
    getCursorScreenPoint(): { x: number; y: number };
    getDisplayNearestPoint(point: { x: number; y: number }): { id: number; workArea: Rect };
    /** 全部显示器（X16 冲刺的归一化基准：工作区并集）；测试里的假 screen 可以不给 */
    getAllDisplays?(): Array<{ id: number; workArea: Rect; bounds?: Rect }>;
  };
  systemPreferences: { getMediaAccessStatus(mediaType: 'screen'): string };
  shell: { openExternal(url: string): Promise<void>; openPath(path: string): Promise<string> };
  BrowserWindow: WindowElectron['BrowserWindow'];
  ipcMain: WindowElectron['ipcMain'];
}

export interface AppFeatures {
  /** 给插件人设拼装用的「主人此刻」一行（ctx.dshPetAppContext） */
  activityContext(): string;
  activity(): ActivitySnapshot | null;
  handleClaudeHook(payload: ClaudeHookPayload): Promise<void>;
  /** 让桌宠直接说一句给定的话 */
  say(text: string): Promise<boolean>;
  /** 按人设碎碎念一句（插件的 /whisper，结果原样返回） */
  whisper(): Promise<Record<string, unknown>>;
  /** 看一眼屏幕并吐槽；模型不支持看图 / 自动触发没授权时降级成按人设说一句（返回结果说明；image = 配的表情包名） */
  lookAtScreen(manual: boolean): Promise<{ ok: boolean; text?: string; image?: string; reason?: string }>;
  /** 邻居簿与串门身份（设置页「邻居」一节用，见 app-routes.ts 的 appNeighborsHandler） */
  neighbors: {
    /** 本机身份 id（GET 时只回前 8 位） */
    identityId(): string;
    list(): NeighborRecord[];
    setFriend(id: string, friend: boolean): void;
    forget(id: string): void;
    clear(): void;
    /** 重置串门身份：串门进行中（家里有客、自己在外、正在敲门）时不重置、返回 false（接口回 409） */
    resetIdentity(): boolean;
  };
  /** 修炼的只读视图（设置页「修炼」一节用，X6）；开关关着时 null */
  cultivation: { view(): CultivationView | null };
  /** 逐手出招面板（X17）：curl / 本机接口选方式、点招，也给 GET 看当前在等什么 */
  battle: { choose(pick: number): boolean; state(): PanelView | null };
  dispose(): void;
}

export interface FeatureDeps {
  electron: FeatureElectron;
  ai: StandaloneAiService;
  configPaths: ConfigPaths;
  appConfig: () => AppConfig;
  /** 宠物日记目录（$DSH_HOME/dsh-pet/diary） */
  diaryDir: string;
  /** 零食袋文件（$DSH_HOME/dsh-pet/snacks.json） */
  snackPath: string;
  /** 串门身份文件（$DSH_HOME/dsh-pet/visit-identity.json） */
  identityPath: string;
  /** 邻居簿文件（$DSH_HOME/dsh-pet/neighbors.json） */
  neighborsPath: string;
  /** 修炼存档（$DSH_HOME/dsh-pet/cultivation.json）；开关关着时不碰它 */
  cultivationPath: string;
  /** 修炼用的随机数（丹药、成长随机项）；只给测试注入固定序列用，平时不传 */
  cultivationRng?: () => number;
  /** 切磋等客人应战 / 亮随机数的时限（默认 30 秒，超时按客人认输）；只给测试调短用 */
  sparWaitMs?: number;
  /** 逐手出招（X17）：选方式 10 秒不点按自动；只给测试调短用 */
  modeTimeoutMs?: number;
  /** 逐手出招：AI 一手 15 秒超时；只给测试调短用 */
  aiTurnTimeoutMs?: number;
  /** 逐手出招：手动一手 20 秒不点按后备；只给测试调短用 */
  actionTimeoutMs?: number;
  /** 逐手对传（X19）：等对面一手 35 秒没来就当掉线；只给测试调短用 */
  turnWaitMs?: number;
  /** 信标的端口与发往地址（默认 BEACON_PORT + 每块网卡的广播地址）；只给测试注入用，不往真实网络发 */
  beacon?: {
    port?: number;
    targets?: () => Array<{ address: string; port: number }>;
    /** 手动填的邻居发往哪个端口（默认 BEACON_PORT）；只给测试用 */
    peerPort?: number;
  };
  /** 插件路由前缀的完整地址，如 http://127.0.0.1:53624/dsh-pet-7340 */
  petBase: string;
  log: (message: string) => void;
}

/** 自家宠物正在别人家做客 */
export interface Trip {
  host: Neighbor;
  token: string;
  /** 进门时验上了主人家的身份（旧对端不带签名时 false：只当串了个门，不当熟人） */
  verified: boolean;
  since: number;
  /** 聊过的话（「你：…」「小鱼：…」「（一起吃西瓜）」），接着聊、回家讲见闻用 */
  lines: string[];
  /** 最近一句（谁说的都算）的时间：刚有人说过话就先不开口 */
  lastLineAt: number;
  /** 自己开口说过几句（送没送到都算） */
  rounds: number;
  /** 回过几次对方捎来的事（GUEST_ANSWERS 封顶） */
  answers: number;
  /** 在对方家吃到的零食（回家记日记） */
  treats: string[];
  /** 这趟已经捎了几句话给对方主人、上一条是什么时候（NOTE_MAX / NOTE_GAP_MS 限额） */
  notesSent: number;
  lastNoteAt: number;
  /** 进门时记好的上次见面备忘（neighbors.meet；整趟用它，不每句现读记录）；没记录 null */
  memory: string | null;
  /** 说话按趟串行：上一句的回话到了再说下一句 */
  queue: Promise<void>;
  /** 连着几次报平安没送到 */
  failures: number;
  pinging: boolean;
  /** 下一句的定时器 */
  talkTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval>;
  /** 主人家请回时自家还在演送走那一拍（X16）：先记下，演到了再回家 */
  pendingHome?: 'sent-home' | null;
  /** 这一场以送友风收场（X16）：等 sent-home 的时候按 `farewell` 记，不按普通请回 */
  farewell?: boolean;
  /** 送友风是自己放的（X16）：回家日记照实说「把对方送得飘起来」 */
  farewellBySelf?: boolean;
  /** 演完送友风以后等 sent-home 的兜底定时器（15 秒没等到就自己 /v1/leave） */
  farewellTimer?: ReturnType<typeof setTimeout> | null;
}

/** 来自家做客的客人 */
export interface Hosting {
  visitor: Visitor;
  window: GuestWindow;
  since: number;
  /** 聊过的话（「你：…」是自家宠物，「小鱼：…」是客人），回话接前文用 */
  lines: string[];
  /** 最近一句（谁说的都算）的时间：刚有人说过话就先不起新话题 */
  lastLineAt: number;
  /** 主动起过几次话题（HOST_OPENERS 封顶） */
  openers: number;
  /** 进门时记好的上次见面备忘（neighbors.meet；整趟用它，不每句现读记录）；没记录 null */
  memory: string | null;
  /** 上次把摸一下 / 一起玩捎给客人的时间（NUDGE_GAP_MS） */
  lastNudgeAt: number;
  /** 这趟已经托客人捎了几句话给它主人、上一条是什么时候（NOTE_MAX / NOTE_GAP_MS 限额） */
  notesSent: number;
  lastNoteAt: number;
  openerTimer: ReturnType<typeof setTimeout> | null;
}

/** 回家的原因：到点 / 主人叫回（含家里有话要说、关了串门、退出）/ 被对方请回 / 失联 / 被送友风送走（X16） */
export type HomeReason = 'time-up' | 'called' | 'sent-home' | 'lost' | 'farewell';

/** 说一句话的选项：配图（表情包池里的名称，插件按池校验）；要不要联动播一段说话动画；气泡显示多久 */
export interface SayOptions {
  image?: string;
  /** false = 只冒气泡不打断正在播的动画（突破这类演出期间的台词用） */
  anim?: boolean;
  /** 气泡显示时长（毫秒）：演出的台词给成一步那么长，下一句自然顶替上一句 */
  durationMs?: number;
}

/** 一场心魔试炼的三扇窗（每场记自己的一份引用，收摊只关自己那组） */
export interface TrialWindows {
  guest: GuestWindow;
  arena: ArenaWindow;
  fx: FxWindow;
  panel: ActionPanelWindow;
}

/**
 * 正在进行的切磋（两边各自记自己这一侧；一台电脑要么在家接待、要么出门做客，不会两边都有）：
 *   - host：invited = 已把 spar-invite 捎给客人，等它发 /v1/spar 来；card = 已回了名帖与随机数，
 *     等客人 reveal（对不上或超时都按客人认输）；showing = 开打了（演出在 battle 里跑）。
 *   - guest：asking = 已发了 /v1/spar（带着随机数的承诺）；showing = 在转播那一场（也在 battle 里跑）。
 * 战绩与奖励都在「开打」那一步记（两边同时记各自的账），演出只是回放：快进、客人走、退出都不会把账弄乱。
 */
export interface SparState {
  role: 'host' | 'guest';
  stage: 'invited' | 'card' | 'asking' | 'showing';
  since: number;
  /** 等客人应战 / 亮随机数的定时器（超时按客人认输）；客人这一侧没有 */
  timer: ReturnType<typeof setTimeout> | null;
  /** host：客人的承诺与名帖、自己亮出去的随机数 */
  commit?: string;
  guestCard?: SparCard;
  hostNonce?: string;
  /** X19 逐手局：这一场是不是逐手、自己这一侧选的方式（auto 也走逐手对传） */
  live?: boolean;
  mode?: TurnMode;
}

/**
 * 这一场切磋开着的窗口：对手窗口（主人家那边是客人窗口、客人这边是「主人家的宠物」窗口；心魔试炼没有）、
 * 擂台、特效层。每一场记自己的一份引用——上一场演完到 `CLOSE_HOLD_MS` 收摊之间又开了下一场时，收摊只关自己那份，
 * 不会把下一场的窗口误关掉，也不会把上一场的窗口丢下没人关（§X11「顺手发现」第 1 条就是漏关的教训）。
 */
export interface SparWindows {
  foe: GuestWindow | null;
  arena: ArenaWindow;
  fx: FxWindow;
  /** 逐手局手动出招时的出招面板（X19）；自动 / AI 局没有 */
  panel?: ActionPanelWindow | null;
}

/** 挑战方这一侧的一场隔空切磋（发出邀约到演出结束） */
export interface DuelChallenge {
  neighbor: Neighbor;
  stage: 'asking' | 'showing';
  since: number;
  /** 自己出的随机数（承诺先发出去） */
  nonce: string;
}

/** 应战方这一侧：等主人答复的挑战 */
export interface DuelWait {
  visitor: Visitor;
  card: SparCard;
  commit: string;
  hostNonce: string;
  /** X19 逐手局：挑战方选了逐手 */
  live: boolean;
  resolve: (answer: DuelAnswer) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 应战方这一侧：已经应战、等挑战方亮随机数的那一场 */
export interface DuelAccepted {
  visitor: Visitor;
  card: SparCard;
  hostNonce: string;
  live?: boolean;
  mode?: TurnMode;
}

/**
 * 一场共用演出的参数（X12 客人这一侧、X15 隔空切磋两边共用）：
 * 本地是引擎 0 号还是 1 号（1 号要 swapSides）、自家宠物的台词走哪条、
 * 做客时的亮度、对手随 reveal 带来的赛后感言。
 */
export interface SparShow {
  /** 引擎视角：0 号 = 被挑战方（主人家 / 应战方），1 号 = 挑战方（客人 / 隔空挑战方） */
  zero: Fighter;
  one: Fighter;
  zeroStage: string;
  oneStage: string;
  events: BattleEvent[];
  lineRng: () => number;
  /** 本地是 0 号还是 1 号（1 号换边成本地视角） */
  local: 0 | 1;
  /** 对手窗口的名牌（「X 家的 Y」） */
  foeLabel: string;
  /** 已经开着的对手窗口（主人家这一侧复用串门的客人窗口）；不给就新开一个 /app/guest */
  foeWindow?: GuestWindow;
  /** 自家宠物的台词出口（做客时是 showRelay，在家是 say(anim:false)） */
  selfSay: (line: string, durationMs: number) => void;
  /** 演完一段、本地这一手还没定：宠物头上「想一想…」（AI 出招；没有就不说） */
  think?: () => void;
  /** X19 逐手局：给了就按每一手对传一段一段演，不走整场 `events` 时间线 */
  live?: {
    /** 发起方 / 客人是 client（发 HTTP），应战方 / 主人家是 server（等请求） */
    role: 'client' | 'server';
    /** 本地这一侧选的方式：auto 每手按后备挑法，ai / manual 每手定 */
    mode: TurnMode;
    /** 这一场的种子：`客人 / 挑战方随机数:主人家 / 应战方随机数` */
    seed: string;
    /** 串门切磋的逐手局传 true（X16）：送友风打中时按 `:farewell` 那一路抽送走；隔空切磋不传 */
    farewell?: boolean;
    /** client：把这一手发给对面（轮到自家带 action，轮到对面不带）；认输（X26）带 forfeit */
    sendTurn?: (
      body: { index: number; action?: Action; forfeit?: boolean },
      signal: AbortSignal,
    ) => Promise<SparTurnReply>;
  };
  /** 对手随 reveal 带来的赛后感言（演完上对手窗口；没有就不说） */
  foeLine?: string;
  /** 开演前 / 收摊后（做客时用来亮回原色、退回半透明） */
  beforeShow?: () => void;
  afterShow?: () => void;
  /** 这一场已经取消（回家了 / 被请回 / 换了一场）：收完摊就别再说话、别再动菜单 */
  cancelled?: () => boolean;
}

/** 闭包里原来那些会变的 `let`：全部放这一份，各块经 ctx.state 读写，不复制 */
export interface FeatureState {
  /** 这一天（日记口径）已经查过要不要补写日记：一天只查一次，补写失败也不每拍重试 */
  diaryCheckedFor: string | null;
  disposed: boolean;
  lastStatus: WorkStatus | null;
  /** 历练小窗与流程（Y3）：修炼开着才有；菜单、敲门、出门、退出都看它 */
  adventure: AdventureFlow | null;
  lastScreenAt: number;
  menuLabels: string[];
  /** 菜单注册的队列（见 refreshMenu）：放在这里，免得初始化时还没走到声明那一行就被调用 */
  menuQueue: Promise<void>;
  tickTimer: ReturnType<typeof setTimeout> | null;
  /** 说话串行：上一句发出去再生成下一句，免得两个气泡互相顶掉 */
  speaking: Promise<unknown>;
  /** 正在生成要说的话（speak 里），此时碎碎念会撞上模型单飞 */
  generating: boolean;
  screenBusy: boolean;
  /** 上次成功说话的时间（SPOKE_HOLD_MS 用） */
  lastSpokeAt: number;
  /** 上一条看屏幕日记的时间：日记一天最多 200 条，看屏幕太频繁时不每条都记 */
  lastScreenDiaryAt: number;
  /** 串门身份（每台电脑一对密钥，重启不变）：信标 id、敲门签名、应答签名都用它；设置页可以重置成新的一对 */
  visitIdentity: VisitIdentity;
  /** 串门网络：信标（总开关开着、接待或出门开了任一项时有）与接待端口（允许别人来时有） */
  neighborhood: Neighborhood | null;
  visitHost: VisitHost | null;
  hostPort: number;
  /** 串门网络正在开 / 关（异步），这期间不重复开关 */
  visitSwitching: boolean;
  /** 开串门网络失败过（端口被占等）：关掉再打开串门之前不再每拍重试、刷日志 */
  visitBroken: boolean;
  /** 正在敲谁家的门（等对方主人答复） */
  knockingOn: Neighbor | null;
  /** 自家宠物正在别人家做客 */
  trip: Trip | null;
  /** 来自家做客的客人 */
  hosting: Hosting | null;
  /** 最近一位来家里做过客的客人（只记验证过身份的）：走了 2 小时内「串门」子菜单里放一项「回访」 */
  lastGuest: LastGuest | null;
  /** 转播结束后把自家宠物调回半透明的定时器 */
  relayTimer: ReturnType<typeof setTimeout> | null;
  /** 下一条转播最早什么时候能顶掉上一条（RELAY_MIN_MS） */
  relayFreeAt: number;
  /**
   * 演出期间占着自家宠物的占用锁（`/lock` 的 lockId）：持锁时渲染端的随机链（堆雪人这类随机活动、
   * 自己走开、转身）和自动来源的工作状态表现都停下，两段演出动画之间宠物停在站姿上。
   * 应用自己的请求统一带着它（petRequest），所以提醒、串门这些照常能说话、播动画。
   */
  showLock: string | null;
  /** 演完挂着的放锁定时器（下一场赶在放锁前开演就取消它、续上同一把锁） */
  showLockRelease: ReturnType<typeof setTimeout> | null;
  /** 修炼（X2）：开关开着才建档；状态、修为来源都在 Cultivation 里，这里只接线 */
  cultivation: Cultivation | null;
  /**
   * 正在演的一场（心魔试炼；X5 的切磋复用同一套）。非 null 时：菜单换成「快进」、
   * 碎碎念与自动看屏幕让一让、平时打坐不播、有人来敲门先把这场快进结束、修炼冒泡不联动动画。
   */
  battle: BattleShow | null;
  /**
   * 还没收完的每一场心魔试炼：上一场演完等 `CLOSE_HOLD_MS` 收摊时又开了下一场，
   * 两组都要能各自关掉；敲门、退出时全部立刻关（§X14，照切磋的 `sparWindows` 那套）。
   */
  trialWindowGroups: Set<TrialWindows>;
  /** 这场渡劫的特效层（X7 第二步：乌云与闪电；演完 `CLOSE_HOLD_MS` 后关掉） */
  tribulationFx: FxWindow | null;
  /** 逐手出招（X17）：正在逐手演的心魔；跟 `battle` 一样算「正在打」，快进 / 收摊都看它 */
  liveBattle: LiveBattle | null;
  /**
   * 这一场认输怎么收（X26）：心魔 / 切磋开打时注册，演完 / 收摊时清掉。
   * `null` = 现在没有可认输的对局（历练、渡劫、还没开打都不注册）。
   */
  forfeitNow: (() => void) | null;
  /** 出招面板（X17）：开打前选方式 / 手动出招时等一手；收摊、退出一起关 */
  actionPanel: ActionPanelWindow | null;
  /** 隔空切磋的应战面板（X15）：和出招面板同一套窗口，但不占 `actionPanel`（右键应战仍可兜底） */
  duelPrompt: ActionPanelWindow | null;
  /** 历练里的选方式 / 手动出招（X18）：按钮在历练小窗里，本机接口和出招面板同一口径 */
  adventureTurn: AdventureTurnQuestion | null;
  /**
   * 逐手对传（X19）应战方那一侧的入口：协议层收到 /v1/spar/turn、/v1/duel/turn 时递一手进来；
   * 只有一场，收摊时清掉。发起方（发 HTTP）那边没有。
   */
  liveTurn: ((index: number, action?: Action, forfeit?: boolean) => Promise<SparTurnReply>) | null;
  /** 下次平时打坐最早什么时候（40–60 分钟一次） */
  meditateAt: number;
  /** 正在进行的那一场切磋（见 SparState） */
  spar: SparState | null;
  /** 还没收完的每一场切磋（上一场演完等 `CLOSE_HOLD_MS` 收摊时又开了下一场，两组都要在退出 / 回家时立刻关掉） */
  sparWindows: Set<SparWindows>;
  duel: DuelChallenge | null;
  /** 有人来挑战、等主人答复（菜单里是「应战 / 不应战」） */
  duelWait: DuelWait | null;
  /** 已应战、等挑战方亮随机数（协议层超时会调 duelConceded 收掉） */
  duelAccepted: DuelAccepted | null;
}

/**
 * 送客（X16 串门里送走也走这一条）：
 *   - `farewell` 给告别的话（空串 = 不说）；
 *   - `wave` 要不要挥手；
 *   - `floatAway` 客人窗口整扇往上飘、淡出（被送友风送走）；
 *   - `closeMs` 多久以后关窗（飘走的给 1.5 秒，普通送客 5 秒）。
 */
export interface GuestOffOptions {
  farewell?: string;
  wave?: boolean;
  floatAway?: boolean;
  closeMs?: number;
}

/** 各块之间经上下文调的这些函数：入口全部挂好以后才会被调用（挂之前只建对象、存回调） */
export interface FeatureFunctions {
  petId(): string;
  petRequest(method: string, path: string, body?: unknown): Promise<Record<string, unknown>>;
  holdPet(steps: Step[], durationMs?: number): Promise<void>;
  releasePet(afterMs: number): void;
  say(text: string, options?: SayOptions): Promise<boolean>;
  personaPrompt(): string;
  systemPrompt(): string;
  collect(stream: AsyncIterable<{ text: string }>): Promise<string>;
  generate(instruction: string, rule?: string, system?: string): Promise<string | null>;
  compose(instruction: string, fallback: string): Promise<string>;
  speak(instruction: string, fallback: string, options?: SayOptions): Promise<void>;
  sayLine(text: string, options?: SayOptions): Promise<void>;
  lookAtScreen(manual: boolean): Promise<{ ok: boolean; text?: string; image?: string; reason?: string }>;
  activityContext(): string;
  tick(): Promise<void>;
  schedule(): void;
  catchUpDiary(date: string): Promise<void>;
  openDiary(now: number): Promise<void>;
  refreshStatus(now: number): Promise<void>;
  nickname(): string;
  petName(): string;
  syncVisit(): Promise<void>;
  closeHost(): Promise<void>;
  visitActions(): Map<string, () => unknown>;
  letIn(accept: boolean): void;
  sendGuestHome(options?: GuestOffOptions): void;
  goVisit(id: string): Promise<void>;
  visitLine(instruction: string, fallback: string): Promise<string>;
  notesOn(): boolean;
  openTopic(current: Hosting): Promise<void>;
  pokeGuest(current: Hosting): void;
  playTogether(thing: PlayThing): Promise<void>;
  treatGuest(snack: Snack): void;
  talk(current: Trip): Promise<void>;
  pingTrip(current: Trip): Promise<void>;
  relay(text: string, durationMs?: number, holdMs?: number): void;
  showRelay(text: string, durationMs: number): void;
  comeHome(reason: HomeReason): Promise<void>;
  cultivationOn(): Cultivation | null;
  onCultivation(now: number, events: CultivationEvent[], options?: SayOptions): void;
  playExtra(name: string, options?: { facing?: 'left' | 'right'; rate?: number }): Promise<void>;
  playPooled(name: string, rate: number): Promise<void>;
  openShowFx(foeBounds: () => Rect | null, foeOnLeft: () => boolean, foeShadow?: boolean): FxWindow;
  cultivationActions(): Map<string, () => unknown>;
  ensureAdventure(): AdventureFlow | null;
  runAdventure(): Promise<void>;
  closeAdventureShows(afterMs: number): void;
  runTrial(): Promise<void>;
  closeTrial(afterMs: number): void;
  skipTrial(): void;
  /** 菜单「认输」（X26）：二次确认后停演、按负场记；没有可认输的对局时什么都不做 */
  forfeitBattle(): Promise<void>;
  runTribulation(wantPill: boolean): Promise<void>;
  closeTribulationFx(afterMs: number): void;
  tribulationActions(practice: Cultivation, actions: Map<string, () => unknown>): void;
  cancelSpar(): void;
  cancelDuels(): void;
  runSparShow(show: SparShow): Promise<BattleEvent[] | null>;
  inviteSpar(): void;
  hostSpar(visitor: Visitor, card: SparCard, commit: string, live?: boolean): Promise<SparReply>;
  hostReveal(visitor: Visitor, nonce: string, line: string): Promise<SparRevealReply>;
  sparTurn(visitor: Visitor, index: number, action?: Action, forfeit?: boolean): Promise<SparTurnReply>;
  hostDuel(visitor: Visitor, card: SparCard, commit: string, live?: boolean): Promise<DuelAnswer>;
  hostDuelReveal(visitor: Visitor, nonce: string, line: string): void;
  duelTurn(visitor: Visitor, index: number, action?: Action, forfeit?: boolean): Promise<SparTurnReply>;
  hostDuelConceded(visitor: Visitor, why: 'mismatch' | 'late'): void;
  startGuestSpar(invite?: { live: boolean }): Promise<void>;
  runHostSparShow(visitor: Visitor, state: SparState, guestNonce: string, guestLine: string): Promise<void>;
  duelChallengeActions(): Map<string, () => unknown>;
  answerDuel(accept: boolean): Promise<void>;
  wantedLabels(): string[];
  refreshMenu(force?: boolean): Promise<void>;
  pollMenu(): Promise<void>;
}

/** 各文件共用的上下文：deps、日志、服务、状态对象，以及挂好的跨块函数 */
export interface FeatureContext {
  deps: FeatureDeps;
  log: (message: string) => void;
  electron: FeatureElectron;
  ai: StandaloneAiService;
  tracker: ActivityTracker;
  claude: ClaudeSessions;
  health: HealthReminders;
  offWork: OffWorkReminder;
  diary: Diary;
  pouch: SnackPouch;
  neighbors: NeighborBook;
  homePet: { box(): PetBox | null; dispose(): void };
  noteOpener: NoteOpener;
  sparWaitMs: number;
  state: FeatureState;
  fns: FeatureFunctions;
}

/** 「串门」子菜单：label 带这个前缀加「/」的项，helper 收成根菜单上的一个子菜单（shared/menu 的 buildAppMenuNodes） */
export const MENU_VISIT_GROUP = '串门';
/** 「修炼」子菜单：和「串门」一样按前缀收成子菜单 */
export const MENU_CULTIVATION_GROUP = '修炼';
/** 打完到关掉心魔窗口 / 擂台之间的停顿（§X14：1 秒——run() 结束时收场动作只剩约 0.6 秒，停这么久正好播完） */
export const CLOSE_HOLD_MS = 1_000;

/**
 * 把跨块函数做成延迟解析的包装：模块里 `const { say } = lazyFns(ctx)`，
 * 调用时才去 ctx.fns 取——入口挂完所有块以后才开定时器、发菜单，不会拿到 undefined。
 */
export function lazyFns(ctx: FeatureContext): FeatureFunctions {
  return new Proxy({} as FeatureFunctions, {
    get(_target, property) {
      return (...args: unknown[]) =>
        (ctx.fns as unknown as Record<string, (...a: unknown[]) => unknown>)[String(property)](...args);
    },
  });
}
