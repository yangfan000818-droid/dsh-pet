/**
 * dsh-pet 宿主半侧（host half）—— 独立应用的"后端"部分
 *
 * 职责：提供 `/dsh-pet-7340/` 前缀的**业务能力**（handlePetRoute 纯函数）。
 * 全部配置（内置默认 + 用户主配置 + 文件宠物）由 ./config 的 readAllConfig 统一读取合并，
 * 本文件只消费它的返回值（绝对正确、零校验），不再接触任何配置文件。
 *
 * 唯一入口：`createPetHost(deps)` 返回一个 `/dsh-pet-7340` 前缀的 HTTP handler，
 * 由 src/app/main.ts 挂在本进程的 node:http 服务上（不再 spawn helper、也没有 bridge 管道）。
 *
 * 路由：
 *   /dsh-pet-7340/config             → 合并后的**成品配置**（{ main:{...}, test1:{...}, ... }，
 *                                每条目字段已填满；桌面/设置页的唯一配置入口）
 *                                GET 读取成品；PUT 保存用户层（白名单重建 main-config.jsonc）、
 *                                POST 同步用户层（把内置默认 config.jsonc **原文**整份写入，
 *                                含注释与全部高级字段；合并结果与「没有用户层」等价）——
 *                                两个写接口的**响应体都是保存后的成品聚合**，设置页即时生效
 *                                直接拍平这份响应，客户端不再有第二份"补吹条目级字段"的实现
 *   /dsh-pet-7340/reload              → 桌面端「重载配置」（右键菜单，POST）：通知应用按最新配置
 *                                整体重启（改配置文件后不必回设置页点保存）；与保存走
 *                                **同一条**重启路径（syncDesktop），宠物数量/size 变化同样生效
 *   /dsh-pet-7340/config/meta         → 配置文件与素材目录路径 + 全部存储位置清单
 *                                       （设置页「高级配置」「卸载与存储」展示用）
 *   /dsh-pet-7340/models              → 可选「服务商 + 模型」清单（设置页「AI 模型」下拉框数据源；
 *                                       取独立 AI 服务的 listProviders/listModels）
 *   /dsh-pet-7340/thumb/<素材根>/<动画名>.webm|.mov  → 素材按宠物归属（.mov 为 macOS 定制，扩展名取决于
 *       客户端播放常量 ANIMATION_EXT；本路由固定双扩展名兜底）：
 *       文件宠物 = $DSH_HOME/dsh-pet/pet/<素材根>-animation/（只查自己的，绝不回落）；
 *       主宠物   = $DSH_HOME/dsh-pet/main-animation/<webm|mov>（用户目录，优先）→ 包内 assets/<webm|mov>
 *       <素材根> 是**标识符**（pet/ 下文件名前缀），含分隔符/保留字符即 400（见 ID_FORBIDDEN）
 *   /dsh-pet-7340/state               → **轮询统一状态 S**（GET，前端 1s 轮询的唯一数据源）：
 *                                       { sections: { workStatus, notify }, pets: { <id>: { say } } }，
 *                                       每个叶子 = { counter, data }；counter 变了前端才渲染。
 *                                       只读、纯内存、零副作用（绝不在这里触发外部调用/模型生成）。
 *   /dsh-pet-7340/work-status          → 外部写入工作状态（POST = 设置固定外部槽的档位/文案；
 *                                       DELETE = 清空回空闲。不做多写者仲裁/租约/会话管理）
 *   /dsh-pet-7340/whisper              → 让某只宠物立即说一句（POST 动作端点，写 S 的 pets.<id>.say；
 *                                       响应带生成的 text，配图时带 image）
 *   /dsh-pet-7340/broadcast            → 第三方投喂：把外部给定的文本写进气泡（POST 动作端点，写 S 的
 *                                       pets.<id>.say；不生成、只搬运，供宿主侧其他插件集成）。
 *                                       配图给 `image`（池内名）或 `url`（第三方自带的完整地址）二选一
 *   /dsh-pet-7340/anim                 → 点播动画：让桌宠播一段动画（POST 动作端点，写 S 的
 *                                       pets.<id>.anim；供其他插件调用）。`name`（池内名，效果与右键
 *                                       「动作」菜单一致）或 `url`（第三方自带的完整地址，不查池、
 *                                       不走菜单语义）二选一。
 *                                       响应带 playbackId，供 /playback 查**真实回执**
 *   /dsh-pet-7340/lock                 → **占用锁**（issue #122 第 4 项，POST 动作端点）：联动演出
 *                                       期间独占这只宠物，除持锁者外全静音。`lockId` 给了 = 续期、
 *                                       没给 = 新建；回 { lockId, expiresAt }。内存态 + TTL。
 *                                       没带 lock 时行为与改造前逐字一致；带了但查不到锁 → lock-lost
 *   /dsh-pet-7340/lock/release         → 释放占用（POST 动作端点）：`lockId` = 持锁者收工 /
 *                                       `force` = **渲染端**报告用户接管（拖拽、点击、隐藏、关闭）。
 *                                       占用期间 5 个动作端点必须带 `?lock=<lockId>`，否则
 *                                       lock-required（没带）/ lock-lost（带了不匹配，附 cause）
 *   /dsh-pet-7340/playback/<id>        → **播放回执**（GET）：返回那一次点播的真实状态
 *                                       （accepted/playing/ended/failed/cancelled）。带
 *                                       `?wait=<状态[,状态]>` + `?timeout=<ms>`（**成对必填**）时挂起等待：
 *                                       状态进入 wait 集合立刻返回（matched:true），到点返回当时状态
 *                                       （matched:false）；两者都不传则立刻返回
 *   /dsh-pet-7340/playback/<id>/report → 渲染端上报播放状态（POST，**内部通道**：浏览器/桌面
 *                                       渲染进程 → host）。这是回执的**地基**——没有它，记录永远停在
 *                                       accepted（host 只知道"受理了"，不知道播没播完）。见 ./playback
 *   /dsh-pet-7340/chat                 → 对话与记忆（GET 最近窗口 / POST 对话并写 memory.json；
 *                                       POST 回 {ok,text,image?}，回复同样写 S 的 pets.<id>.say）
 *   /dsh-pet-7340/font|pic             → 字体 / 通知图标素材
 *
 * 系统通知依赖 DSH 会话事件，独立应用没有这项能力：S 里保留 notify 叶子（形状与 shared/state
 * 一致），但没有任何写入方。
 *
 * 桌面模式（Electron 透明窗）：配置里的每只宠物都显示在桌面上（没有独立配置文件，也没有
 * 「显示位置」开关）。
 *
 * 安全性：resolveAsset 做"防穿越"校验，保证路径仍在对应根目录内；
 *         PUT 保存经 saveUserConfig 白名单重建，id 过滤文件名非法字符。
 *
 */
import { createReadStream, existsSync, fstatSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateWhisper } from './whisper';
import { chatGapLine, composeChatSystem, generateChat, recentChatImages, type ChatMemoryMessage } from './chat';
import { type ModelService } from './model-selection';
import { limitPool, pickMeme, readMemePool } from './memes';
import {
  decideBroadcast,
  decideBubbleClear,
  normalizeBroadcastAnim,
  normalizeBroadcastDuration,
  normalizeBroadcastText,
} from './broadcast';
import { decideAnim } from './anim';
import { LockStore } from './lock';
import { MENU_WAIT_MAX_MS, MenuRegistry } from './menu';
import { decidePosition, decideThrow, positionLeafData } from './motion-cue';
import { parsePlaybackPath, parseWaitQuery, PlaybackStore } from './playback';
import { PoseStore, normalizePoseInput } from './pose';
import {
  findPetInstance,
  ID_FORBIDDEN,
  migrateUserConfig,
  readAllConfig,
  readUserConfig,
  saveUserConfig,
  sliceMemoryRounds,
  syncUserConfigFromDefault,
  userConfigUnparsable,
  type ConfigPaths,
} from './config';
import { HOST_WORK_STATUS_STATES, TASK_TEXT_MAX, WorkStatusStore, type HostWorkStatusState } from './work-status';
import { profileNameFrom, storageEntries } from './storage-paths';
import { parseStateWaitQuery, PollStateStore } from './state';
import { composeSystemPrompt, petPersona } from './persona';
import { dshHomeDir, electronLandingDir } from './paths';
import type { StandaloneLogger } from '../standalone/logger';

/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 包内 assets 根 */
const PACKAGE_ROOT_ASSETS = join(PACKAGE_ROOT, 'assets');

/** 包内表情包目录（表情包池的最后一环：assets/memes/<名称>.png） */
const PACKAGE_MEMES_DIR = join(PACKAGE_ROOT_ASSETS, 'memes');

/** 路由前缀 */
export const ROUTE_PREFIX = '/dsh-pet-7340';

/** 不同扩展名对应的 Content-Type 映射 */
const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
 * @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
 */
function resolveAsset(root: string, rel: string): string | undefined {
  if (rel.length === 0) return undefined;
  const candidate = normalize(join(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root: string, rel: string): string | undefined {
  const candidate = resolveAsset(root, rel);
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/**
 * 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。
 *
 * Content-Length 必须取自**正在读的那个 fd**（open 事件里 fstat），不能先 stat 再另开流：用户往
 * $DSH_HOME/dsh-pet/main-animation/webm/ 复制或同名覆盖素材时，stat 与真正开始读之间文件会被截断/
 * 改写，一旦实际字节数少于声明的长度，这个响应就**永远不结束、也不报错**（浏览器表现为 stalled、
 * 视频 loadeddata 永不触发且无 error）——正是 issue #62 现场"数据断供"的一种成因。同一个 fd 的
 * fstat 拿到的大小与随后读出的字节天然一致。
 */
function sendFile(res: ServerResponse, file: string, contentType: string): void {
  const stream = createReadStream(file);
  stream.once('open', (fd) => {
    if (res.destroyed || res.writableEnded) {
      stream.destroy(); // 客户端在开流前就放弃了
      return;
    }
    try {
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': fstatSync(fd).size,
        'cache-control': 'public, max-age=3600',
      });
    } catch {
      // 极端情况下 fstat 拿不到：不发长度头，交给 Node 用 chunked 收尾（长度天然一致，只是没声明）
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'public, max-age=3600' });
    }
    stream.pipe(res);
  });
  // 读失败（文件被删/权限/被占用）：直接断连，让客户端立刻看到失败，而不是无限等待
  stream.on('error', () => res.destroy());
  // 客户端提前断开（快速切动画时高频发生）→ 停读，别把整个文件读完
  res.on('close', () => stream.destroy());
}

// 配置的读取/校验/合并/保存全部收敛在 ./config（readAllConfig / saveUserConfig，host 自包含实现，
// 不 import src/shared —— DSH 单文件加载约束）。本文件不再保留任何配置逻辑，只消费成品返回值。

/** 发送 JSON 响应（headers 可选：如 no-cache 触发计数） */
function sendJson(res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** 发送纯文本响应（素材 404/400 等显式错误文案） */
function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** 单次业务路由的应答（HTTP 路由与独立应用同进程调用共用的同一契约；消费方各自落盘） */
type RouteResult =
  | { kind: 'json'; status: number; obj: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'file'; file: string; contentType: string }
  /** 无需应答：调用方在挂起等待期间已断开（见 /playback 的等待分支）——消费方直接收尾，不写 */
  | { kind: 'none' };

/** 收集请求体（文本） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve2, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve2(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 额外宠物（pet pack）说明：校验/扫描已收敛到 ./config（readAllConfig 内部逐字段合并），
// 这里不再有 host 侧拷贝——文件宠物与主宠物一样，统一从 readAllConfig 的成品读取。
// ---------------------------------------------------------------------------

/** 独立应用可注入的模型服务（`StandaloneAiService` 满足它；路由测试可传最小替身） */
export interface PetHostAi extends ModelService {
  listProviders(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
}

/** 独立应用要注入的依赖（窗口/托盘与配置页在应用侧，宿主只提供路由与业务状态） */
export interface PetHostDeps {
  logger: StandaloneLogger;
  ai: PetHostAi;
  /** 拼人设时追加的「主人此刻」背景（应用 ready 前为空） */
  appContext?: () => string;
  /** 对话专用的生活上下文（最近的事 / 称呼 / 上次日记；应用 ready 前为空） */
  chatContext?: () => string;
  /** 一次成功对话的回调（羁绊记好感用；抛错只记日志，不影响回复） */
  onChat?: (petId: string, text: string) => void;
  /** 宠物数量 / size / 托盘配置变化后，由应用决定是否整体重启 */
  desktopChanged?: () => void;
}

/** 独立应用里的宠物宿主：一条 `/dsh-pet-7340` 路由 + 生命周期收尾 */
export interface PetHost {
  /** 处理 `/dsh-pet-7340` 前缀下的请求（路径匹配由本函数完成） */
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  dispose(): Promise<void>;
}

/** 宿主主体：处理 `/dsh-pet-7340` 前缀下的全部业务路由。 */
export function createPetHost(deps: PetHostDeps): PetHost {
  const { logger, ai, appContext, chatContext, onChat, desktopChanged } = deps;
  // 用户数据根：配置与用户素材统一收敛于此（扩展包按 <插件id> 各自建目录）
  const dshHome = dshHomeDir();
  const userRoot = join(dshHome, 'dsh-pet');
  // 用户主配置（可编辑层）与文件宠物目录；配置读取/合并统一走 readAllConfig（./config）。
  // 主配置是 **JSONC**（main-config.jsonc）——与包内默认 config.jsonc 同名同格式：
  // 「同步」写进去的就是带注释的原文，扩展名如实反映内容（旧版 main-config.json 只读回落 + 启动迁移）
  const userConfigPath = join(userRoot, 'main-config.jsonc');
  const legacyUserConfigPath = join(userRoot, 'main-config.json');
  const petConfigDir = join(userRoot, 'pet');
  // 配置路径集（readAllConfig 的唯一输入：内置默认 + 用户主配置 + 文件宠物目录）
  const configPaths: ConfigPaths = {
    defaultFile: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
    userFile: userConfigPath,
    legacyUserFile: legacyUserConfigPath,
    petDir: petConfigDir,
  };
  // 老用户一次性迁移：main-config.json → main-config.jsonc（重命名，内容一字不动；
  // 新文件已存在则不动旧文件）。失败不影响运行——读取侧对旧路径有回落。
  migrateUserConfig(configPaths, (msg) => console.log('[dsh-pet] ' + msg));
  // 用户动画目录（thumb 播放时优先于包内素材；webm 放 main-animation/webm/，mov（macOS 定制）放 main-animation/mov/）
  const thumbUserRoot = join(userRoot, 'main-animation');
  // 用户表情包目录（碎碎念/对话配图的图片：优先于包内 assets/memes，加图不必改包）
  const memesUserRoot = join(userRoot, 'memes');
  /**
   * 表情包目录链 —— 与动画素材（/thumb）**同一套素材归属语义**：
   *   - `pet/<素材根>-memes/` 存在（种类自带表情包）：**只查它**，池与路由都不回落——
   *     查不到即 404 / 该条目剔除（与 `pet/<素材根>-animation/` 的独占规则逐字一致）；
   *   - 否则：用户目录 `$DSH_HOME/dsh-pet/memes/` 优先，其次包内 `assets/memes/`（逐文件合并，
   *     与「main-animation/<ext> → 包内 assets/<ext>」的主素材链同构）。
   * 池（readMemePool）与路由（/pic/memes）必须走**同一个函数**：池里能选的名字，
   * 路由必须取得到，否则气泡配图会图裂。
   * 素材根一律先过 resolveAsset：它来自 URL 段，Windows 上 %5C 解出的反斜杠不会被
   * rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘（与 /thumb 同一道防线）。
   */
  const memeDirsFor = (assetRoot: string): string[] => {
    const own = resolveAsset(petConfigDir, assetRoot + '-memes');
    if (own !== undefined && existsSync(own)) return [own];
    return [memesUserRoot, PACKAGE_MEMES_DIR];
  };
  // 轮询统一状态（S）：前端 1s 轮询的**唯一**数据源（工作状态 / 通知 / 宠物说话）。
  // 所有写入走 state.writeSection / writePet（由它统一更新 counter），见 ./state 的说明。
  const state = new PollStateStore();
  // 第三方右键菜单注册表（issue：第三方菜单项）：**进程内存态**，不落盘，重启即空。
  // 与 S 的关系：注册表本身写进 S 的 sections.menu（两端据此拼「更多」）；点击事件**不进 S**——
  // 它是触发不是状态，走 /menu/events 的读取即消费，只给注册它的那个 owner 看。见 ./menu 的说明。
  const menuRegistry = new MenuRegistry();
  // 播放记录表（issue #122 第 3 项「播放与完成回执」）：**由渲染端上报驱动**的状态机 + 等待者。
  // 与 S 无关：播放记录是 per-caller 资源（只有发起那次点播的调用方关心、有生命周期、数量随
  // 第三方调用方增长），塞进 1s 全局广播会让每个窗口为每个功能付流量。见 ./playback 的说明。
  const playback = new PlaybackStore();
  // 工作状态联动快照（/work-status 端点响应，浏览器 1s 轮询）：state=当前活动状态（null=空闲）、
  // task=当前任务详情、ts=最近变化时间（轮询侧检测变化用）。气泡文案不在此：浏览器读配置
  // events.workStatusTexts（host 不内置文案）。
  // 聚合与展示选择都在 WorkStatusStore（host/work-status.ts，纯逻辑可单测）：**state 与 task 都按
  // 会话存**——task 曾是全局单值，写过一次就跟着此后所有会话活动一直显示（issue #59）。
  // 进程内内存态：重启回空闲；每次会话事件有实际状态变化才更新（签名比对防刷屏）。
  const workStatus = new WorkStatusStore();
  /** 外部写入槽：固定会话 id，最后写入者生效；不做多写者仲裁/租约/会话管理 */
  const EXTERNAL_WORK_SESSION = 'api';
  let externalWorkSeq = 0;
  // 工作状态快照 → 写进 S（前端 1s 轮询 /state 后按 counter 变化渲染）。
  // **只在内容真的变了时才写**：每次写都会推进 counter，前端据此重播档位动画——
  // 会话事件很密（每个 tool/call 都来），无条件写会把动画刷成幻灯片。
  // 判据用**内容**（state + task）而不是 store 的 ts：ts 是 Date.now()（毫秒分辨率），
  // 同一毫秒内连改两次会被误判成"没变化"而漏写（测试里连发事件就会踩到）。
  // data 里不再带 ts：「变了没有」已由叶子 counter 承担，少一个会漂移的第二信号。
  //
  // **忙碌档抖动抑制（滞回）**：工具秒回时 `tool/call` 报 working、`tool/result` 报 result，
  // 一次回复里能来回切十几次；每切一次前端就把 10s 的片段从第 0 帧重播，观感即"一秒一刀"
  // （实测 6 次快工具调用 → 13 次换片，working 每次只活 1~2 秒）。
  // 判据**只看档位与时间**：距上次写入不足 WORK_STATE_GAP_MS 的 working ↔ result 互切
  // **整条不写**（档位与文案一起压住），挂一个 trailing 定时器到点重新取快照补写，
  // 所以最终状态一定落地，只是最多晚 GAP。
  // 不把「文案没变」当条件：现在每个 tool/call 都会换文案，那个条件会恒为假、一次都压不住；
  // 文案随这次写入一起被压住，是这条规则的必然结果（不是遗漏）。
  //
  // 刻意**不压**的对象（"写完立刻可见"是既有契约，动它会把一串宿主回归测试打翻）：
  //   - 回空闲 / 终态（success、error）：反馈不能迟到；
  //   - 任何进/出忙碌档以外的变化（thinking、waiting、…）；
  //   - **同档位内**的文案更新（working 期间换一句工具详情）：那不是档位切换，不参与节流。
  // 为什么压在这里而不是两个前端：网页 overlay 与桌面 helper 消费的是同一个叶子，
  // 一处压住两端同时生效，也不必在前端各维护一份状态机。
  const WORK_STATE_GAP_MS = 5000;
  /** 忙碌档：只有这两个档位之间的互切算"抖动"，其余档位变化一律立即写 */
  const isBusyTier = (s: string | null): boolean => s === 'working' || s === 'result';
  let publishedWork = '\u0000';
  let publishedState: string | null = null;
  let publishedWorkAt = 0;
  let workFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const publishWorkStatus = (): void => {
    const snap = workStatus.snapshot();
    const key = String(snap.state) + '\u0000' + String(snap.task);
    if (key === publishedWork) return;
    // 抖动判定：前后都在忙碌档、且档位确实换了（同档只换文案不算抖动，照常立即写）
    const busyFlip = isBusyTier(publishedState) && isBusyTier(snap.state) && snap.state !== publishedState;
    const wait = WORK_STATE_GAP_MS - (Date.now() - publishedWorkAt);
    if (busyFlip && wait > 0) {
      // 整条不写（档位与文案一起压住）：到点再取**最新**快照补写
      // （不要在这里缓存 snap——期间可能又变了）
      workFlushTimer ??= setTimeout(() => {
        workFlushTimer = null;
        publishWorkStatus();
      }, wait);
      return;
    }
    if (workFlushTimer !== null) {
      clearTimeout(workFlushTimer);
      workFlushTimer = null;
    }
    publishedWork = key;
    publishedState = snap.state;
    publishedWorkAt = Date.now();
    state.writeSection('workStatus', { state: snap.state, task: snap.task });
  };
  // 占用锁（issue #122 第 4 项「独立动作/气泡占用」）：**内存态**一把锁 + TTL，第三方联动期间
  // 独占这只宠物——除持锁者外谁都动不了它（随机链、碎碎念、工作状态一概让路）。
  //
  // 它自己**不带定时器**：过期是懒判的，叶子里的 `expiresAt` 是唯一真相，渲染端据此**自己**
  // 解除静止；这里只负责把状态变化同步进 S 的 `pets.<id>.lock`。见 ./lock 的四条边界
  // （无锁 = 现状零变化 / 有界 / 续期即心跳 / 无定时器）。
  const lock = new LockStore({
    onChange: (petId, data) => state.writePet(petId, 'lock', data),
  });

  // 实况快照（issue #122 第 1 条）：桌面渲染端变化时上报，第三方用 GET /pose 读。
  const pose = new PoseStore();

  /**
   * 路由层的 pet 参数解析（`/lock`、`/lock/release`、`/whisper`、`/chat` 用——这四条没有独立决策层；
   * `/anim`、`/broadcast`、`/bubble/clear`、`/position`、`/throw` 的同一套校验住在各自的决策模块里，
   * 口径与这里逐字一致）：**必填**且必须真实存在。
   *
   * 两种失败分开报（issue #122 第 1 条「绝不默认退到列表第一只」）：
   * 没给 / 空串 → `pet-required`；给了但配置里没有 → `unknown-pet`。
   *
   * 收紧前这四条是 `get('pet') || 当前桌宠 || 'main'`：缺省会落到"当前桌宠"
   * = **有效宠物列表第一只**（`/whisper`、`/chat` 更彻底——`?? ''` 直接空串：人设按 main 条目取、
   * 生成结果写进没人消费的 `pets[""].say`，还回 ok:true——钱花了、话丢了、调用方以为成功）。
   * 落点随用户 /pet 操作而变、失败也不报，第三方无从预期，故整条缺省链已删除：pet 必填。
   *
   * `cfg` 传**惰性读取**：pet 空串时不必碰磁盘（与 /broadcast 的 text/duration 同一处境，
   * routes.test.ts 里"配置不可达"那一组断言正是靠这个顺序钉住的）。
   */
  const requirePet = (
    params: URLSearchParams,
    cfg: () => Record<string, Record<string, unknown>>,
  ):
    | { ok: true; petId: string; entry: string; conf: Record<string, unknown>; pet: Record<string, unknown> }
    | { ok: false; res: RouteResult } => {
    const fail = (reason: 'pet-required' | 'unknown-pet', message: string): { ok: false; res: RouteResult } => ({
      ok: false,
      res: { kind: 'json', status: 200, obj: { ok: false, reason, message } },
    });
    const petId = String(params.get('pet') ?? '').trim();
    if (!petId) return fail('pet-required', 'pet 必填：要指定操作哪只桌宠');
    // 一次查找同时给出"存在性"与"所属条目"（entry 即素材根，/chat 读记忆分桶要用）+ 条目配置
    // （/chat 取 chatMemoryRounds 要用）——调用方拿到的就是校验时那份快照里的值，不必再查一次。
    const found = findPetInstance(cfg(), petId);
    if (!found) return fail('unknown-pet', '没有这只桌宠：' + petId);
    return { ok: true, petId, entry: found.entry, conf: found.conf, pet: found.pet };
  };

  /**
   * 动作端点的占用门禁（`/anim`、`/broadcast`、`/position`、`/throw`、`/bubble/clear` 共用）：
   * 放行回 null，否则直接给出路由应答。抽成一个函数，是为了让"哪些接口受占用约束"只有一处可查。
   *
   * **无锁时按「有没有带 `lock`」分流**：没带 → 返回 null（既有调用方一个字都不用改）；
   * 带了但查不到锁 → `lock-lost`，旧租约不能继续执行迟到请求。
   * 没带这一支就是「不传 lock = 现状零变化」（issue #122 最重要的边界）的落点。
   *
   * 位置放在决策函数**之后**：`petId` 要先解析出来才知道问哪只宠物的锁，而这时还没有任何副作用
   * （没写叶子、没建播放记录、没调模型）。所以"先判锁再干活"这个意图是满足的，只是与
   * body 校验的先后为「body → pet → 锁」——两者都不合法时报的是 body 的错。
   */
  const lockBlocked = (petId: string, params: URLSearchParams): RouteResult | null => {
    const g = lock.gate(petId, String(params.get('lock') ?? ''));
    if (g.ok) return null;
    return {
      kind: 'json',
      status: 200,
      obj:
        g.reason === 'lock-lost'
          ? { ok: false, reason: g.reason, cause: g.cause, message: g.message }
          : { ok: false, reason: g.reason, message: g.message },
    };
  };
  // 对话记忆文件（唯一读写方 = 本进程；浏览器/桌面两端都只是客户端 → 同一实例天然共享同一份记忆）。
  // 结构双层：{ <种类桶 assetRoot ?? petId>: { <实例 id>: { messages: ChatMemoryMessage[] } } }
  const memoryPath = join(userRoot, 'memory.json');
  // 对话写操作串行队列：read-modify-write 排队执行，防两端同时对话时交错写盘
  let chatQueue: Promise<void> = Promise.resolve();

  /** 读记忆文件：不存在 → 空；损坏 → 显式报错 + 备份原始文件（绝不静默丢数据）+ 重建空记忆 */
  const readMemory = async (): Promise<Record<string, Record<string, { messages: ChatMemoryMessage[] }>>> => {
    let raw: string;
    try {
      raw = await readFile(memoryPath, 'utf8');
    } catch {
      return {}; // 文件不存在 = 尚无记忆
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      return parsed as Record<string, Record<string, { messages: ChatMemoryMessage[] }>>;
    } catch (e) {
      console.error(
        `dsh-pet: 记忆文件损坏已备份（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`,
      );
      try {
        await mkdir(userRoot, { recursive: true });
        await writeFile(`${memoryPath}.bak-${Date.now()}`, raw, 'utf8');
      } catch {
        /* 备份失败仅告警，不阻断 */
      }
      return {};
    }
  };

  const writeMemory = async (mem: Record<string, Record<string, { messages: ChatMemoryMessage[] }>>): Promise<void> => {
    await mkdir(userRoot, { recursive: true });
    await writeFile(memoryPath, JSON.stringify(mem, null, 2), 'utf8');
  };

  /** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
  const withMemoryLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chatQueue.then(fn, fn);
    chatQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // ---- 配置消费：唯一入口 readAllConfig（./config）——返回值绝对正确，这里只读字段，零校验 ----

  /** 某宠物的最终人设 system：**实例级** `pets[].whisperPrompt` 优先，没写回落到所属条目
   *  （写在该条目 `pets` 里的实例 → 那个条目；主配置的实例 → `main`）的 whisperPrompt（合并器已填默认）。
   *  拼装本身在 ./persona（纯函数、有单测）：人设正文 + 一句名字声明（name，缺失已按 id）+ 一行时间背景
   *  （日期/星期/时刻/时段/工作日或周末/节日）——碎碎念与对话共用同一份拼装。
   *  时间每次现算（这里传 new Date()），所以拿到的永远是**当前**时刻，不需要额外的刷新机制。
   *
   *  收 `findPetInstance` 的**命中结果**而不是 `(petId, cfg)`：两个调用方都已经解析过了，这里再查一次
   *  只会多出一处"查不到就兜底 main"的不可达分支。 */
  const petSystemPrompt = (found: { conf: Record<string, unknown>; pet: Record<string, unknown> }): string => {
    const base = composeSystemPrompt({
      prompt: petPersona(found.conf, found.pet),
      name: String(found.pet.name ?? ''),
      id: String(found.pet.id ?? ''),
      now: new Date(),
    });
    // 独立应用的「主人此刻」背景（前台应用 / 连续使用 / 离开多久，见 src/app/activity.ts）
    const activity = appContext?.() ?? '';
    return activity ? base + '\n' + activity : base;
  };

  /** 对话记忆轮数（1 轮 = 1 问 1 答）：该宠物**所属条目**的 chatMemoryRounds（合并器已填默认非负数字）。
   *  同样收**已解析的条目配置**：两个调用方都已经拿到 `findPetInstance` 的结果。 */
  const memoryRounds = (conf: Record<string, unknown>): number => {
    const v = Number(conf.chatMemoryRounds);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
  };

  /** 生成/返回某宠物的一句碎碎念（手动 POST /whisper 与看屏幕降级共用的同一逻辑）：
   *  每只宠物独立生成（人设 = 它自己的 whisperPrompt，没写回落到所属条目）。生成成功就写进 S 的 pets.<id>.say——
   *  碎碎念 / 命令气泡 / 对话回复在前端本来就是**同一条展示链路**（同一个 triggerWhisper、
   *  同一个气泡槽、同一批 events.whisper 动画），所以合并成同一个叶子。
   *  配图（whisperImageEnabled 开启时）：从表情包池**随机抽 1 张**，把描述注入指令并随文本一起写。
   *
   *  失败**带回真实 reason**（含 `unknown-pet`：目标宠物在"校验那次读"与这里之间被删掉了）。
   *  成功**带回生成的文本**（与同时写进叶子的那份完全相同）——调用方拿到就不必再拉一拍 /state。 */
  const publishWhisper = async (
    petId: string,
  ): Promise<
    | { ok: true; text: string; image?: string }
    | { ok: false; reason: 'provider-missing' | 'generate-error' | 'unknown-pet'; message?: string }
  > => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    // 宠物在"校验那次读"（requirePet / 周期调度各自读的那一份）与这里之间被删了
    // ——配置随时可能被设置页 / 右键菜单 / 手改文件改动，两次读之间就是窗口。
    // **明确失败：不生成、不写 S**。写下去就是一只已不存在宠物的幽灵叶子（/state 里常驻到进程重启）。
    if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
    const system = petSystemPrompt(found);
    // 配图：全局开关关闭 / 池为空 / 池内图片全缺失 → 纯文本（不报错，退化为原行为）
    const meme =
      found.conf.whisperImageEnabled === true
        ? pickMeme(readMemePool(found.conf.memes, memeDirsFor(found.entry)))
        : undefined;
    // 模型：跟随当前对话的模型（独立模式只有设置页配的那一个）
    const result = await generateWhisper(ai, system, meme);
    if (!result.ok) {
      // 失败**不写 S**（与改造前一致：静默跳过 + console.warn，不伪造文案、不弹错误气泡）
      console.warn(
        '[dsh-pet] 碎碎念生成失败 pet=' +
          petId +
          ' reason=' +
          result.reason +
          (result.message ? ' ' + result.message : ''),
      );
      // 真实 reason **原样带回**给调用方。改造前这里只回布尔值，路由只能把失败硬编码成
      // `generate-error`——独立模式下 `generateWhisper` 明明算出了 `provider-missing`，
      // 却在边界被吞掉。
      return result;
    }
    state.writePet(petId, 'say', result.image ? { text: result.text, image: result.image } : { text: result.text });
    // 文本随返回值带出，且与刚写进叶子的**是同一个变量**：两条出口给同一份文本，不是一个真相两个版本
    return { ok: true, text: result.text, ...(result.image ? { image: result.image } : {}) };
  };

  /** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 把回复写进 S 的 pets.<id>.say。
   *  供 POST /chat（动作端点）与 /chat 命令共用同一条路径（锁内读写，防两端交错写盘）。
   *  配图（chatImageEnabled 开启时）：把表情包清单交给模型按语境选一张，命中池内才随回复写回。
   *  成功**带回回复文本**（与同时写进叶子的那份完全相同）——调用方拿到就不必再拉一拍 /state。 */
  const chatWithPet = async (
    petId: string,
    text: string,
  ): Promise<
    | { ok: true; text: string; image?: string }
    | { ok: false; reason: 'provider-missing' | 'generate-error' | 'unknown-pet'; message?: string }
  > =>
    withMemoryLock(async () => {
      const cfg = readAllConfig(configPaths);
      const found = findPetInstance(cfg, petId);
      // 宠物在"校验那次读"与这里之间被删了——本函数还要先排 withMemoryLock 的串行队列（等前一次生成
      // 跑完，窗口可能是**秒级**），所以这一支是真会命中的。
      // **明确失败：不生成、不写记忆也不写叶子**。否则会在 memory.json 里**永久**留下一个已删宠物的
      // 分桶，外加一只幽灵叶子（/state 里常驻到进程重启）。
      if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
      const rounds = memoryRounds(found.conf);
      // 配图：开关关闭 → 空池（指令与解析都不介入，与旧行为逐字一致）；目录链按所属条目取。
      // 张数上限（chatImageLimit，0 = 不限制）：整张清单每条消息都要附，截断后费用上限可控。
      const pool =
        found.conf.chatImageEnabled === true
          ? limitPool(readMemePool(found.conf.memes, memeDirsFor(found.entry)), Number(found.conf.chatImageLimit))
          : [];
      const mem = await readMemory();
      const bucket = (mem[found.entry] ??= {});
      const entry = (bucket[petId] ??= { messages: [] });
      // rounds = 0（用户关掉历史）→ 空历史；否则截尾部 rounds 轮（1 轮 = 1 问 1 答）。
      // 不能写 slice(-rounds * 2)：-0 在 JS 里 === 0，slice(-0) 返回整个数组而不是空。
      const list = sliceMemoryRounds(entry.messages, rounds);
      // system：人设（含名字/时间/主人此刻）+ 上次对话间隔 + 生活上下文 + 对话专用规则。
      // 人设仍与碎碎念共用；对话规则只在 chat 路径追加（persona.ts 的三段拼装不动）。
      const system = composeChatSystem(
        petSystemPrompt(found),
        [chatGapLine(list[list.length - 1]?.ts, Date.now()), chatContext?.() ?? '']
          .filter((part) => part !== '')
          .join('\n'),
      );
      // 配图去重：最近几轮用过的图随指令带给模型（只提醒，不强制）
      const recentImages = recentChatImages(list);
      // 模型：设置页配的那一个（独立应用没有第二条模型来源）
      const generated = await generateChat(ai, system, list, text, pool, recentImages);
      if (!generated.ok) return generated;
      const now = Date.now();
      entry.messages.push({ role: 'user', content: text, ts: now });
      // 记忆存正文 + 实际配图名（配图标记本身不存，下一轮靠 image 字段去重）
      entry.messages.push({
        role: 'assistant',
        content: generated.text,
        ts: now,
        ...(generated.image ? { image: generated.image } : {}),
      });
      await writeMemory(mem);
      // 回复写进 S（与碎碎念同一个叶子：前端本来就是同一条展示链路）
      state.writePet(
        petId,
        'say',
        generated.image ? { text: generated.text, image: generated.image } : { text: generated.text },
      );
      // 对话已经完整落地（记忆 + 气泡）再通知功能层：羁绊记好感，失败只记日志
      try {
        onChat?.(petId, text);
      } catch (error) {
        logger.warn(`[dsh-pet] 对话回调失败：${error instanceof Error ? error.message : String(error)}`);
      }
      // 同一份文本随返回值带出（叶子照写，不是二选一）
      return { ok: true as const, text: generated.text, ...(generated.image ? { image: generated.image } : {}) };
    });

  /**
   * 宠物配置（数量 / size / 托盘开关等）变更后：交给独立应用整体重启。
   *
   * 没有 Helper 可重启：窗口与托盘是应用启动时建的，由 src/app/main.ts 传进来的回调
   * 决定是否整体重启。连续保存会触发多次，所以用队列串起来；队列自身绝不留下 rejected 状态，
   * 否则后续保存再也不会触发重启。
   */
  let desktopSyncQueue: Promise<void> = Promise.resolve();
  const syncDesktop = (): Promise<void> => {
    desktopSyncQueue = desktopSyncQueue
      .then(() => desktopChanged?.())
      .catch((e: unknown) => {
        logger.warn(`[dsh-pet] 应用桌面配置变更处理失败：${e instanceof Error ? e.message : String(e)}`);
      });
    return desktopSyncQueue;
  };

  /** 扩展名 → 素材子目录名（webm → webm/，mov → mov/；其余落在动画目录平级放行） */
  const animSubdirFor = (ext: string): string => (ext === '.mov' ? 'mov' : 'webm');

  /** 包内动画素材根：按扩展名取子目录（webm/ 随包发布；mov/ 不存在时为 404 兜底，仅 macOS 自维护）。 */
  const assetRootFor = (ext: string): string => join(PACKAGE_ROOT, 'assets', animSubdirFor(ext));

  /** 用户动画根：按扩展名取子目录（main-animation/webm 或 main-animation/mov）。 */
  const userRootFor = (ext: string): string => join(thumbUserRoot, animSubdirFor(ext));

  /** 单次业务路由(WebServer 注册 → HTTP 落盘 / 应用内直接调用,共用同一份实现):
   *  输入只需 rawUrl(/dsh-pet-7340/... + 查询) + method + body 文本;返回 RouteResult(JSON/文本/文件),
   *  消费方各自落盘——业务逻辑只有一份,两端天然一致(硬契约:桌面/设置页行为严格对齐)。
   *  signal（可选）：调用方断开时**中止挂起等待**（只有 /playback 的 wait 分支会用到）。
   *  HTTP 侧由注册处按 res 的 close 触发。 */
  const handlePetRoute = async (
    rawUrl: string,
    method: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<RouteResult> => {
    const url = new URL(rawUrl, 'http://localhost');
    const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));

    // 成品配置：/dsh-pet-7340/config（GET 读取合并成品 / PUT 保存用户层 / POST 同步内置默认）
    if (rest === 'config') {
      if (method === 'GET') {
        // 唯一配置入口：readAllConfig 返回绝对正确的完成品聚合（{ main:{...}, test1:{...} }），
        // 浏览器/桌面/设置页直接消费，无需任何校验/兜底
        try {
          // 动态配置必须杀缓存（与 /state 同口径）：消费端会「发现配置版本变化 → 重拉 /config」，
          // 这一次 GET 若命中缓存就会拿回旧配置，那套机制直接失效。
          return {
            kind: 'json',
            status: 200,
            obj: readAllConfig(configPaths),
            headers: { 'cache-control': 'no-cache, no-store' },
          };
        } catch (e) {
          return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
        }
      }
      if (method === 'PUT') {
        try {
          const parsed = JSON.parse(body ?? '');
          // 透传保留：读当前磁盘上的用户文件原对象，把非白名单顶层字段（physics/whisperPrompt/
          // chatMemoryRounds/...）带回给 saveUserConfig——设置页保存不再抹掉用户手改的精调配置。
          // **必须走 JSONC 容忍解析器**（readUserConfig）：用户层可能是「同步」写入的带 // 注释
          // 的 config.jsonc 原文，用严格 JSON.parse 会在这里抛错并被吞掉 → existing 变 undefined
          // → 白名单重建 → 用户的高级字段全丢（老 bug 的复发路径，已由守卫测试钉住）。
          const existing = readUserConfig(configPaths);
          const clean = saveUserConfig(parsed, existing);
          if (!clean) {
            return {
              kind: 'json',
              status: 400,
              obj: {
                error:
                  'invalid pet config: expected { pets:[{name?,id,size,position:{corner,marginX,marginY}}] }（可选顶层 notificationsEnabled / whisperImageEnabled / chatImageEnabled / trayEnabled 布尔；可选宠物布尔 workStatusEnabled / fixedEnabled）',
              },
            };
          }
          // 损坏预检：用户层存在但连 JSONC 都解析不了（真损坏）→ **先不写盘**。
          // 保存是白名单重建，existing 读不出来就等于把文件里剩下的内容整份丢掉，而且静默——
          // 所以回 409 让设置页弹窗（取消 = 不动文件；确认 = 带 ?force=1 强行重建）。
          if (url.searchParams.get('force') !== '1' && userConfigUnparsable(configPaths)) {
            return {
              kind: 'json',
              status: 409,
              obj: { error: 'user config is unparsable', needConfirm: true, userFile: userConfigPath },
            };
          }
          await mkdir(userRoot, { recursive: true });
          await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
          void syncDesktop(); // 宠物数量/size 等可能变化：通知应用整体重启（异步，不阻塞保存响应）
          // 响应体 = 保存后的**成品聚合**（与 GET /config 同一份，字段已填满）：
          // 设置页把它直接交给容器的 flattenConfigPets 拍平渲染——客户端的条目级字段
          // （动画池/权重/物理参数/工作状态文案）只有这一处填充，不再有第二份补吹实现。
          return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
      }
      if (method === 'POST') {
        // 同步：把内置默认配置（assets/config.jsonc 原文，含注释）整份写入用户配置——
        // 既是「恢复默认」（合并结果 = 内置默认），又给用户留下一份可直接编辑的完整配置，
        // 不必再自己从包内复制一份（见 config.ts 的 syncUserConfigFromDefault）。
        try {
          syncUserConfigFromDefault(configPaths);
        } catch (e) {
          // 默认文件缺失 / 用户目录不可写：显式 500，绝不静默留下半个配置文件
          return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
        }
        void syncDesktop(); // 配置变了：通知应用整体重启（异步，不阻塞响应）
        return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
      }
      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }

    // 桌面端「重载配置」（右键菜单 → POST /reload）：通知应用按最新配置整体重启。
    // 与保存走**同一条**重启路径（syncDesktop），所以宠物数量 / size 的变化同样生效——
    // 渲染端就地重拉配置做不到这几项（每只宠物一个窗口，是应用启动时按 DSH_PET_PETS 建的）。
    // 注意：响应发出后应用才重启，这里不 await 重启、立刻回 200。
    if (rest === 'reload') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      void syncDesktop();
      return { kind: 'json', status: 200, obj: { reloading: true } };
    }

    // 配置文件路径 + 存储位置清单（设置页「高级配置」与「卸载与存储」展示用）
    if (rest === 'config/meta') {
      return {
        kind: 'json',
        status: 200,
        obj: {
          user: userConfigPath,
          default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
          animations: thumbUserRoot,
          memes: memesUserRoot,
          // 全部落盘位置（本包用户数据 / Electron 运行时 / 桌面端缓存 / 下载缓存 / 插件本体）：
          // 前两条直接传真实写入方的路径，不在这里重拼目录名
          storage: storageEntries({
            userDataRoot: userRoot,
            electronDir: electronLandingDir(),
            home: homedir(),
            packageRoot: PACKAGE_ROOT,
          }),
          // profile 名（拼卸载命令 dsh plugin --profile <名> remove dsh-pet；反推不出时为空串）
          profile: profileNameFrom(PACKAGE_ROOT) ?? '',
        },
      };
    }

    // 第三方右键菜单（供别的插件注册自己的菜单项）。四个方法：
    //   POST   /menu/item    注册（该 owner 的菜单项**整体覆盖**）
    //   DELETE /menu/item    清除该 owner 的全部菜单项（幂等）
    //   GET    /menu/events  查询触发（读取即消费；?wait= 长轮询）
    //   POST   /menu/click   渲染端点击上报（内部通道，第三方不调）
    // 业务失败一律 200 + { ok:false, reason, message }（与 /anim、/lock 等同口径）；
    // 400 只留给「JSON 坏了」，405 只留给方法错。
    // 注册表在进程内存（./menu），快照写进 S 的 sections.menu：两端右键菜单据此拼「更多」，
    // 因此注册后**不用重启应用**，下一拍 /state 就到了（长轮询下几乎是立即）。
    if (rest === 'menu/item') {
      if (method === 'DELETE') {
        const result = menuRegistry.clear(url.searchParams.get('owner') ?? '');
        if (!result.ok) {
          return { kind: 'json', status: 200, obj: { ok: false, reason: result.reason, message: result.message } };
        }
        state.writeSection('menu', { items: menuRegistry.snapshot() });
        return { kind: 'json', status: 200, obj: { ok: true, removed: result.removed } };
      }
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? '');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const result = menuRegistry.register(parsed);
      if (!result.ok) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: result.reason, message: result.message } };
      }
      // 写入会唤醒所有挂起的长轮询；两端拿到新 counter 就重拼菜单（下一次右键即生效）
      state.writeSection('menu', { items: menuRegistry.snapshot() });
      return { kind: 'json', status: 200, obj: { ok: true } };
    }

    if (rest === 'menu/events') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const owner = url.searchParams.get('owner') ?? '';
      const rawWait = Number(url.searchParams.get('wait') ?? '0');
      const waitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(rawWait, MENU_WAIT_MAX_MS) : 0;
      // 挂起等待期间调用方断开：不额外处理（最多白挂 MENU_WAIT_MAX_MS，无状态残留）
      const events = await menuRegistry.poll(owner, waitMs);
      // owner 不存在（没注册过 / 被清除了 / 宿主重启过）：业务失败，仍是 200
      if (events === null) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'unknown-owner', message: '这个 owner 没有注册，重新注册即可' },
        };
      }
      return { kind: 'json', status: 200, obj: { ok: true, events } };
    }

    if (rest === 'menu/click') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? '');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      // delivered=false（项已不在）= 正常竞态：渲染端拿的是上一拍快照，仍回 200
      return { kind: 'json', status: 200, obj: menuRegistry.click(parsed) };
    }

    // 可选模型清单：独立应用只有设置页配的那一个模型（StandaloneAiService 提供）。
    // 只读、无副作用；列模型失败只让它空着，不拖垮整张清单。
    if (rest === 'models') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const named = (id: unknown, name: unknown): { id: string; name: string } => {
          const pid = String(id ?? '');
          return { id: pid, name: String(name ?? '') || pid };
        };
        const providers = ai
          .listProviders()
          .map((p) => named(p?.id, p?.name))
          .filter((p) => p.id);
        const catalog = await Promise.all(
          providers.map(async (p) => {
            let models: Array<{ id: string; name: string }> = [];
            try {
              const list = await ai.listModels(p.id);
              models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id);
            } catch {
              /* 列不出模型：留空即可（下拉框里该服务商没有可选项） */
            }
            return { ...p, models };
          }),
        );
        return { kind: 'json', status: 200, obj: { providers: catalog } };
      } catch (e) {
        return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
      }
    }

    // 轮询统一状态（S）：/dsh-pet-7340/state（GET，no-cache）——前端轮询的**唯一**数据源
    // （工作状态 / 通知 / 配置变更信号 / 宠物说话，形状见 ./state）。
    // 只读、纯内存、**零副作用**：绝不在这里触发外部调用或模型生成——那会把所有人的轮询拖死；
    // 也**不在这里碰磁盘**（早先这里现算配置文件的 mtime 指纹，等于每拍读一次盘，
    // 桌面端一窗一宠各自轮询 → N 倍；配置变更信号已改走 sections.config 叶子）。
    //
    // **长轮询**：带 `?since=&timeout=`（成对必填）时，若调用方手里的版本与当前相同就**挂起**，
    // 直到任意叶子被写过（立刻返回）或超时。不带这两个参数 = 立刻返回全量（改造前的语义）。
    // 等待语义与 GET /playback/{id} 的 wait 是同一套：上限同值、断线走同一个 signal 收尸、
    // 卸载走 cancelAll()。区别只有一个——那边的唤醒条件是"某条记录进入某个状态"，
    // 这边是"任意叶子被写过"，所以等待者是全局集合，一次写入唤醒所有人。
    if (rest === 'state') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const headers = { 'cache-control': 'no-cache, no-store' };
      const parsed = parseStateWaitQuery(url.searchParams.get('since'), url.searchParams.get('timeout'));
      if (parsed.kind === 'error') return { kind: 'json', status: 400, obj: { error: parsed.error } };
      const current = state.read();
      // 两者都没传 → 立刻返回；已经有新东西 → 也立刻返回（别白等一整个 timeout）。
      // timeout=0 走挂起分支，下一拍就醒，等价"立刻返回"，这里不特判。
      if (parsed.kind === 'none' || current.counter !== parsed.since) {
        return { kind: 'json', status: 200, obj: current, headers };
      }
      const since = parsed.since;
      return await new Promise<RouteResult>((resolveWait) => {
        let settled = false;
        /** 收尾：只认第一次（唤醒 / 超时 / 取消 / 调用方断开 都可能先后到达） */
        const settle = (result: RouteResult): void => {
          if (settled) return;
          settled = true;
          resolveWait(result);
        };
        // 唤醒时**才** read()：store 保证"叶子已写定"之后才叫醒，所以这里拿到的一定是新状态
        const cancel = state.wait({
          since,
          timeoutMs: parsed.timeoutMs,
          onWake: () => settle({ kind: 'json', status: 200, obj: state.read(), headers }),
        });
        // 调用方断开：取消等待者（清掉它的超时定时器），以"无需应答"收尾。
        const onAbort = (): void => {
          cancel();
          settle({ kind: 'none' });
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    // 外部写入工作状态：/dsh-pet-7340/work-status
    //   POST   = 设置固定外部槽 `api` 的档位（可选任务文案）；任务文案省略 = 保留原值，null = 清空
    //   DELETE = 清空外部槽回空闲（幂等）
    // 只解决"外部程序把状态告诉桌宠"，不做多写者仲裁/租约/会话管理；
    // 外部槽与 DSH 会话一起参与现有优先级（waiting > error > working > thinking > result > success）。
    if (rest === 'work-status') {
      if (method === 'DELETE') {
        if (workStatus.clear(EXTERNAL_WORK_SESSION)) publishWorkStatus();
        return { kind: 'text', status: 204, body: '' };
      }
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      if (Buffer.byteLength(body ?? '', 'utf8') > 8 * 1024)
        return { kind: 'json', status: 413, obj: { error: 'body too large' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? '');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      const payload = parsed as { state?: unknown; task?: unknown };
      const state = payload.state;
      if (typeof state !== 'string' || !(HOST_WORK_STATUS_STATES as readonly string[]).includes(state))
        return { kind: 'json', status: 400, obj: { error: 'invalid state' } };
      let task: string | null | undefined;
      if (Object.prototype.hasOwnProperty.call(payload, 'task')) {
        if (payload.task === null) {
          task = null;
        } else if (typeof payload.task === 'string') {
          const trimmed = payload.task.trim();
          if (trimmed === '') {
            task = null;
          } else if (Array.from(trimmed).length > TASK_TEXT_MAX) {
            return {
              kind: 'json',
              status: 400,
              obj: { error: `task too long (max ${TASK_TEXT_MAX} code points)` },
            };
          } else {
            task = trimmed;
          }
        } else {
          return { kind: 'json', status: 400, obj: { error: 'invalid task' } };
        }
      }
      externalWorkSeq += 1;
      workStatus.setState(EXTERNAL_WORK_SESSION, state as HostWorkStatusState, externalWorkSeq);
      if (task !== undefined) workStatus.setTask(EXTERNAL_WORK_SESSION, task);
      publishWorkStatus();
      return {
        kind: 'json',
        status: 200,
        obj: {
          state: workStatus.stateOf(EXTERNAL_WORK_SESSION) ?? state,
          task: workStatus.taskOf(EXTERNAL_WORK_SESSION),
        },
      };
    }

    // 占用锁：/dsh-pet-7340/lock?pet=<id>          （POST = 取锁 / 续期，二合一）
    //         /dsh-pet-7340/lock/release?pet=<id>  （POST = 释放）
    //
    // issue #122 第 4 项「独立动作/气泡占用」。一把锁、**全有全无**：拿锁 → 回 lockId；占用期间
    // 除持锁者外全静音（5 个动作端点要带 `?lock=`，内部自动来源各自让路）；释放 → 一切复原。
    //
    // 与 /playback 的分工：那个是"这一次点播播完没有"的**回执**，这个是"这段时间归谁控制"的**租约**。
    // 锁自己占一个叶子（`pets.<id>.lock`）：渲染端必须能读到它才能冻结自己——宿主停不掉一段
    // 正在播的视频，"完全静止"最终是渲染端执行的。
    //
    // 取锁 / 续期**二合一**（`lockId` 给了 = 续期）：续期是持锁者每隔几秒就要做一次的**心跳**，
    // 而这一次调用同时就是"我的锁还在吗"的探测器——丢了会回 lock-lost + cause，所以不需要
    // 单独的"查锁"端点。真值表与墓碑语义见 ./lock 的 acquire。
    //
    // 失败一律 HTTP 200 + ok:false（与其他动作端点口径一致）；只有 405 / 400 不是 200。
    if (rest === 'lock' || rest === 'lock/release') {
      const isRelease = rest === 'lock/release';
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      try {
        // pet **必填**且必须真实存在（与 /anim、/broadcast 同一口径，见 requirePet）
        const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
        if (!who.ok) return who.res;
        const petId = who.petId;
        if (isRelease) {
          const d = lock.release({ petId, lockId: o.lockId, force: o.force });
          if (!d.ok) {
            const obj: Record<string, unknown> = { ok: false, reason: d.reason, message: d.message };
            if (d.reason === 'lock-lost') obj.cause = d.cause;
            return { kind: 'json', status: 200, obj };
          }
          // 幂等：当前没有锁同样回 ok（"让锁消失"这个意图在空状态下已经成立）
          return { kind: 'json', status: 200, obj: { ok: true } };
        }
        const d = lock.acquire({ petId, lockId: o.lockId, ttl: o.ttl });
        if (!d.ok) {
          const obj: Record<string, unknown> = { ok: false, reason: d.reason, message: d.message };
          if (d.reason === 'locked') obj.expiresAt = d.expiresAt; // 让对方知道何时能重试
          if (d.reason === 'lock-lost') obj.cause = d.cause;
          return { kind: 'json', status: 200, obj };
        }
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, lockId: d.lockId, petId: d.petId, expiresAt: d.expiresAt },
        };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默（与其他动作端点同一口径）
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 碎碎念：/dsh-pet-7340/whisper?pet=<id>（POST = 立即让桌宠新说一句，返回 {ok,text,image?}）
    // 文本**照旧**写进 S 的 pets.<id>.say（碎碎念/命令气泡/对话回复同一个叶子），同时随响应带回——
    // 两条出口给的是同一份文本；其它消费端（桌面/第三方监听）仍从 /state 读。
    // 看屏幕不支持看图 / 自动触发没授权时，应用就是调这条路由降级成原来碎碎念的效果。
    if (rest === 'whisper') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        // pet **必填**且必须真实存在：收紧前这里是 `?? ''`——空串会让人设/配图按 main 条目取、
        // 生成结果写进没人消费的 `pets[""].say`，还回 ok:true（钱花了、话丢了、调用方以为成功）。
        const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
        if (!who.ok) return who.res;
        const r = await publishWhisper(who.petId);
        if (r.ok) {
          return {
            kind: 'json',
            status: 200,
            obj: { ok: true, text: r.text, ...(r.image ? { image: r.image } : {}) },
          };
        }
        // 真实 reason 原样透出（独立模式是 `provider-missing`，见 ./whisper 的联合体）——
        // 不再把一切失败糊成 generate-error，调用方据此能分清"没配模型"与"生成炸了"。
        const obj: Record<string, unknown> = { ok: false, reason: r.reason };
        if (r.message) obj.message = r.message;
        return { kind: 'json', status: 200, obj };
      } catch (e) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 第三方投喂：/dsh-pet-7340/broadcast?pet=<id>（POST = 把一段**外部给定的**文本写进桌宠气泡）
    // 与 /whisper 的区别：这个**不生成**，调用方自己给文本——宿主侧其他插件（女仆巡检等）
    // 想说自己的话时用它，桌宠就成了那套人格的"实体"（见 issue #76）。
    // 写入 S 的 pets.<id>.say —— 与碎碎念/对话回复**同一个叶子**，两端 1s 内自动显示，前端零改动。
    // 动作端点，只回 {ok}；文本本身从 /state 读。
    // 校验（不通过一律 HTTP 200 + ok:false，与 /chat 的失败口径一致）：
    //   text 必填、trim 后非空（**不设长度限制，也不限频**：内容与频率由调用方自己负责）；
    //   pet **必填**（空串 → pet-required），且须真实存在（否则 unknown-pet）；
    //   image / url **配图的两种形态，二选一**（两个都给 = bad-request）：
    //     image 只认**该条目表情包池内的名称**（池内命中即用其规范名）；
    //     url 是第三方自带的完整地址，不查池（issue #122 第 1 条：素材由第三方自己托管），
    //     scheme 由宿主卡在 http/https。**宿主不做代理**：跨域由浏览器强制，插件绕不过去。
    //   duration 可选，气泡显示时长（ms）；缺省 10s，`0` = 字面意思「不显示」，负数/非有限数拒绝；
    //   anim 可选，是否联动 events.whisper 动画；只有严格 false 才关闭（宽松口径）。
    if (rest === 'broadcast') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      // 空文本不需要读配置就能判定：先短路，别为一个必然失败的请求去碰磁盘
      if (!normalizeBroadcastText(o.text)) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: 'text 为空' } };
      }
      // duration 同理：判定不需要配置，先短路（anim 没有非法值，宽松口径下永远有结论）
      const duration = normalizeBroadcastDuration(o.duration);
      if (duration === null) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'bad-request', message: 'duration 必须是 ≥0 的有限数字（毫秒）' },
        };
      }
      const anim = normalizeBroadcastAnim(o.anim);
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideBroadcast({
          cfg,
          requested: String(url.searchParams.get('pet') ?? ''),
          text: o.text,
          image: o.image,
          url: o.url,
          duration,
          anim,
          memeDirs: memeDirsFor,
        });
        if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        // 占用门禁：有锁时只有持锁者能投喂（无锁恒放行，见 lockBlocked）
        const blocked = lockBlocked(d.petId, url.searchParams);
        if (blocked) return blocked;
        // duration / anim 写**解析后的生效值**（缺省也已填成显式值）：/state 里因此能看到
        // 实际生效的时长与联动开关，调用方不用自己猜缺省是多少。
        // 配图两种形态二选一（判定层保证）：url 形态写 url，名称形态写池内规范名，都没有则纯文本。
        const pic = d.url !== undefined ? { url: d.url } : d.image !== undefined ? { image: d.image } : {};
        state.writePet(d.petId, 'say', { text: d.text, ...pic, duration: d.duration, anim: d.anim });
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 清空气泡：/dsh-pet-7340/bubble/clear?pet=<id>（POST = 收起该宠物**当前正显示的说话气泡**）
    // 与 /broadcast 的关系：投喂写气泡，这个收气泡；两者共用同一个叶子（pets.<id>.say）。
    // 清空靠叶子里的 `{ clear: true }` 标记——**空文本表达不了这个动作**：消费端的 readSay
    // 会把空文本判成非法、整拍跳过，所以必须有一个独立的形态（见 src/shared/state.ts 的 SayCue）。
    // 只收说话气泡：工作状态气泡、以及 anim/position/throw 三个叶子**都不动**
    // （气泡与动作是两把锁，分别释放——issue #122 第 5 条）。
    // 幂等：当前没有气泡也回 { ok: true }（"让气泡消失"这个意图在空状态下已经成立）。
    // 无请求体；动作端点，只回 {ok}。
    if (rest === 'bubble/clear') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideBubbleClear({
          cfg,
          requested: String(url.searchParams.get('pet') ?? ''),
        });
        if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        const blocked = lockBlocked(d.petId, url.searchParams);
        if (blocked) return blocked;
        state.writePet(d.petId, 'say', { clear: true });
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (e) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 点播动画：/dsh-pet-7340/anim?pet=<id>（POST = 让桌宠播一段动画）
    // 两种形态**二选一**（issue #122 第 1 条）：
    //   name = 池内的动画名。效果与右键菜单点「动作」树**完全一致**——两端都复用同一个菜单动作
    //     处理函数（浏览器 handleMenuAction / 桌面 sprite.onMenuAction），宿主只负责把名字送到。
    //     写入 S 的 pets.<id>.anim，前端发现 counter 变化后换源播放（**名字即文件名**）。
    //   url = 第三方自带的素材完整地址。**不查动画池**（素材在别人手里，池里当然没有这个名字），
    //     前端拿到后**直接换源播一次，不走菜单语义**——裸地址没有"文字类要镜像修正 /
    //     移动类走真实位移"这些属性。scheme 由宿主卡在 http/https。
    // 动作端点，只回 {ok}（成功时另带回执编号 playbackId）。
    // 校验（不通过一律 HTTP 200 + ok:false，与其他动作端点口径一致）：
    //   name / url 必须**恰好给一个**：两个都给或都不给 = 意图不明 → bad-request；
    //   name 必须在该宠物 animations 配置能点到的集合内
    //   （播放端对不存在的动画没有兜底：名字即文件名 → 404 → 加载失败 → 表现为"点了没反应"，
    //    所以必须在这里拦住，而不是写进 S 让前端白跑一趟）；
    //   url 必须是 http/https 的完整地址（`file:` 会让桌面端渲染进程能读本地任意文件）；
    //   pet **必填**（空串 → pet-required），且须真实存在（否则 unknown-pet）；
    //   facing **可选**（left / right）：给了就必须合法（非法 → bad-request），**没给就不动朝向**
    //     ——叶子里连字段都不写，渲染端保持宠物当前朝向（不是"回落 left"）。显式值优先于渲染端
    //     "文字类动画点播前强制朝左"那条镜像修正（调用方明确要哪个朝向就给哪个）；
    //   rate **可选**（0.5–3）：给了就写进叶子，渲染端播这一段时设 video.playbackRate，
    //     这一段结束或被打断就恢复常速；没给时行为一字不变（叶子里不写字段）。
    //   target **可选**（`{ x, y }`，宠物中心的归一化坐标）：只跟 name 形态的移动动作一起用，
    //     渲染端按这个终点走/飞（不再随机距离），位移与素材的 lead/tail 仍由渲染端自己算。
    if (rest === 'anim') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideAnim({
          cfg,
          requested: String(url.searchParams.get('pet') ?? ''),
          name: o.name,
          url: o.url,
          facing: o.facing,
          rate: o.rate,
          target: o.target,
        });
        if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        // 占用门禁：持锁者自己的点播照放行（那是它的演出），别人一律拒
        const blocked = lockBlocked(d.petId, url.searchParams);
        if (blocked) return blocked;
        // 播放回执：受理时建记录（accepted），并把编号随叶子一起下发——渲染端据此上报。
        // 记录里的标识：name 形态是动画名，url 形态就是那个地址（纯记录，不参与任何判定）。
        // 叶子形状：name 与 url **恰好一个**（判定层保证），消费端按字段名决定走不走菜单语义
        // ——url 是裸地址，没有"文字类要镜像修正 / 移动类走真实位移"这些属性。
        // `facing` / `rate` 只在调用方**显式给了**时才进叶子：没给 = 不动朝向 / 常速，
        // 叶子里连字段都没有（消费端据此区分"没要求"和"要求 left / 要求倍速"）。
        const record = playback.create(d.petId, d.url ?? d.name ?? '');
        state.writePet(d.petId, 'anim', {
          ...(d.url !== undefined ? { url: d.url } : { name: d.name }),
          playbackId: record.playbackId,
          ...(d.facing === undefined ? {} : { facing: d.facing }),
          ...(d.rate === undefined ? {} : { rate: d.rate }),
          ...(d.target === undefined ? {} : { target: d.target }),
        });
        return { kind: 'json', status: 200, obj: { ok: true, playbackId: record.playbackId } };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 位置与抛掷：/dsh-pet-7340/position 与 /dsh-pet-7340/throw（POST）——两条**运动指令**。
    //
    // 与 /anim 同族：受理后写进 S 的宠物叶子（pets.<id>.position / pets.<id>.throw），由渲染端消费。
    // 位置**不引入任何新运动学**：`mode` 三选一（instant 一帧到位 / spring 拖拽那套过阻尼弹簧 /
    // line 按 duration 毫秒直线走到），三条路都是渲染端已经有的；抛掷复用已有的 startThrow
    // （角度/力度换算成初速度），下游的重力/反弹/摩擦/落地 Q 弹/宠物间碰撞一概照旧。
    // 所以这里只做校验与夹取（纯逻辑在 ./motion-cue，可离线单测）。
    //
    // 位置：x/y 是宠物**中心**的归一化坐标（0~1），越界**夹取**并把实际生效值回给调用方。
    // 抛掷：angle 单位度（0 = 正右，逆时针为正）；power 是力度倍率（1.0 = 1200 px/s 软钳速前）。
    //
    // 与用户拖拽撞车时**静默丢弃**：渲染端发现手指正按在宠物身上就丢掉这一拍，但仍然回 ok:true
    // （动作端点只表示"受理了"，不表示"生效了"，与 /anim 同一契约）。宿主判不了拖拽状态——
    // 那只有渲染端知道（见两端的 active 标志），所以这里不做拒绝。
    if (rest === 'position' || rest === 'throw') {
      const isPosition = rest === 'position';
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      try {
        const cfg = readAllConfig(configPaths);
        const requested = String(url.searchParams.get('pet') ?? '');
        if (isPosition) {
          const d = decidePosition({
            cfg,
            requested,
            x: o.x,
            y: o.y,
            mode: o.mode,
            duration: o.duration,
          });
          if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
          const blocked = lockBlocked(d.petId, url.searchParams);
          if (blocked) return blocked;
          // 叶子按模式收敛成最小形状：非 line 模式不带 duration（见 positionLeafData）
          state.writePet(d.petId, 'position', positionLeafData(d));
          // 回**夹取后**的实际生效值：调用方不必自己算边界，也不会误以为越界值被照单全收
          return { kind: 'json', status: 200, obj: { ok: true, x: d.x, y: d.y } };
        }
        const d = decideThrow({ cfg, requested, angle: o.angle, power: o.power });
        if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        const blocked = lockBlocked(d.petId, url.searchParams);
        if (blocked) return blocked;
        state.writePet(d.petId, 'throw', { angle: d.angle, power: d.power });
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默（与 /anim 同一口径）
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 实况：/dsh-pet-7340/pose?pet=<id>        （GET  = 第三方读**桌面端**的实况快照）
    //       /dsh-pet-7340/pose/report?pet=<id> （POST = **桌面渲染端**上报，内部通道）
    //
    // 桌面宠物**一窗一只**，位置全局唯一一份 → 宿主快照语义干净。
    //
    // 上报是**变化时推 + 节流**（拖拽 / 走位 / 抛掷 / position 指令 / turn 转身），不是轮询。
    if (rest === 'pose' || rest === 'pose/report') {
      const isReport = rest === 'pose/report';
      if (isReport && method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      if (!isReport && method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      // 协议层错误（非法 JSON）先报：与 /anim 同一顺序
      let parsedPose: unknown;
      if (isReport) {
        try {
          parsedPose = JSON.parse(body ?? 'null');
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
      }
      try {
        const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
        if (!who.ok) return who.res;
        if (isReport) {
          const p = normalizePoseInput(parsedPose);
          if (!p.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: p.reason, message: p.message } };
          pose.set(who.petId, p.pose);
          return { kind: 'json', status: 200, obj: { ok: true } };
        }
        const snap = pose.get(who.petId);
        if (snap === undefined) {
          return {
            kind: 'json',
            status: 200,
            obj: {
              ok: false,
              reason: 'pose-unavailable',
              message: '还没收到过这只宠物的桌面端实况（桌面端没起来，或刚重启还没来得及上报）',
            },
          };
        }
        return { kind: 'json', status: 200, obj: { ok: true, petId: who.petId, ...snap } };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默（与其他端点同一口径）
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 表情包池（只读）：GET /dsh-pet-7340/memes?pet=<id> → { ok, memes: [{ name, desc }] }。
    // 与碎碎念 / 对话配图、POST /broadcast 的 image 校验是**同一个池**（readMemePool + memeDirsFor），
    // 调用方先挑图、按图的描述写好话，再 /broadcast { text, image }，图文才对得上（独立应用看屏幕就这么配图）。
    if (rest === 'memes') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
        if (!who.ok) return who.res;
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, memes: readMemePool(who.conf.memes, memeDirsFor(who.entry)) },
        };
      } catch (e) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 播放回执：/dsh-pet-7340/playback/<id>        （GET 查询，可挂起等待）
    //           /dsh-pet-7340/playback/<id>/report （POST，**渲染端上报**）
    //
    // 记录由**渲染端上报驱动**（见 ./playback）：host 只知道"受理了"，不知道播没播完——
    // 所以没有 /report 就没有真实回执，查询永远停在 accepted。
    // 与 S 无关：播放记录是 per-caller 资源（只有发起那次点播的调用方关心、有生命周期、
    // 数量随第三方调用方增长），放进 1s 全局广播会让每个窗口为每个功能付流量。
    // 前缀守卫写成**字面量比较**：把正则尝试限定在 playback 段（更快、边界更明确）。
    const playbackPath = rest === 'playback' || rest.startsWith('playback/') ? parsePlaybackPath(rest) : undefined;
    if (playbackPath) {
      const playbackId = playbackPath.playbackId;
      // ---- 上报（渲染端 → host）：开始播 / 播完 / 失败 / 被打断时各来一次 ----
      if (playbackPath.isReport) {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        let reported: unknown;
        try {
          reported = JSON.parse(body ?? 'null');
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
        const o = reported && typeof reported === 'object' ? (reported as Record<string, unknown>) : {};
        const outcome = playback.report(playbackId, o.status, o.reason);
        if (outcome === 'unknown') return { kind: 'json', status: 404, obj: { error: 'unknown playback' } };
        if (outcome === 'invalid') return { kind: 'json', status: 400, obj: { error: 'invalid status' } };
        // ok / ignored 都回 200：上报是幂等的，"已经这样了"对上报方就是成功
        // （迟到的 ended 不许覆盖 cancelled——终态保护在 ./playback 里）
        return { kind: 'json', status: 200, obj: { ok: true } };
      }
      // ---- 查询（第三方调用方）----
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const record = playback.get(playbackId);
      if (!record) return { kind: 'json', status: 404, obj: { error: 'unknown playback' } };
      const parsed = parseWaitQuery(url.searchParams.get('wait'), url.searchParams.get('timeout'));
      if (parsed.kind === 'error') return { kind: 'json', status: 400, obj: { error: parsed.error } };
      // 两者都没传 = 立刻返回（兜底 / 调试 / 只想知道当下状态的调用方）
      if (parsed.kind === 'none') {
        return { kind: 'json', status: 200, obj: { ...record, matched: false } };
      }
      const { wait: waitList, timeoutMs } = parsed;
      // 已经是等的状态之一 → 立刻返回，别白等一整个 timeout
      if (waitList.includes(record.status)) {
        return { kind: 'json', status: 200, obj: { ...record, matched: true } };
      }
      // 挂起等待：状态进入 wait 集合立刻唤醒（matched:true）；到点回当时的记录（matched:false）。
      // timeout=0 时 playback.wait 下一拍就唤醒，等价"立刻返回"，这里不特判。
      return await new Promise<RouteResult>((resolveWait) => {
        let settled = false;
        /** 收尾：只认第一次（唤醒 / 超时 / 取消 / 调用方断开 都可能先后到达） */
        const settle = (result: RouteResult): void => {
          if (settled) return;
          settled = true;
          resolveWait(result);
        };
        const cancel = playback.wait({
          playbackId,
          wait: waitList,
          timeoutMs,
          // 唤醒时**不需要**再取消：store 在回调前已把等待者摘掉（超时定时器也清了）
          onWake: (r, matched) => settle({ kind: 'json', status: 200, obj: { ...r, matched } }),
        });
        // get 之后记录被清理（极端竞态）→ 立刻 404，不挂
        if (cancel === undefined) {
          settle({ kind: 'json', status: 404, obj: { error: 'unknown playback' } });
          return;
        }
        // 调用方断开：取消等待者（清掉它的超时定时器），以"无需应答"收尾。
        // 监听不摘也无妨：signal 只被这次请求持有，请求结束后整条引用链一起回收。
        const onAbort = (): void => {
          cancel();
          settle({ kind: 'none' });
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    // 对话：/dsh-pet-7340/chat?pet=<id>
    //   GET  —— 最近记忆窗口（截尾 chatMemoryRounds 轮），弹窗打开时展示（一次性读，不是轮询）
    //   POST —— 携带历史生成回复并写入记忆；回 {ok,text,image?}，回复同样写 S 的 pets.<id>.say
    // 记忆唯一读写方 = host（memory.json；浏览器/桌面两端都只是客户端）→
    // 同一实例的浏览器与桌面天然共享同一份记忆；文件全存不删，
    // 请求只截尾部 chatMemoryRounds 轮（1 轮 = 1 问 1 答；合并器已按条目填默认）。
    if (rest === 'chat') {
      if (method !== 'GET' && method !== 'POST') {
        return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      }
      try {
        // `?rounds=`：GET 专属的查看参数——只决定这次读多少轮（不写记忆，也不改变后续对话
        // 往上下文里带多少，所以 POST 不认它）。参数级校验放在读盘之前。
        const roundsRaw = method === 'GET' ? url.searchParams.get('rounds') : null;
        let roundsOverride: number | null = null;
        if (roundsRaw !== null && roundsRaw.trim() !== '') {
          const n = Number(roundsRaw);
          if (!Number.isInteger(n) || n < 0 || n > 200) {
            return {
              kind: 'json',
              status: 200,
              obj: { ok: false, reason: 'bad-request', message: 'rounds 必须是 0–200 的整数（不传则用配置）' },
            };
          }
          roundsOverride = n;
        }
        // pet **必填**且必须真实存在：收紧前这里是 `?? ''`——人设/配图按 main 条目取，记忆会以那个
        // （不存在的）id 新建一个分桶，回复写进没人消费的 `pets[""].say`，还回 ok:true。
        // 惰性 + 记忆化：pet 空串时完全不读配置；GET 分支复用同一次读取。
        let cfgCache: Record<string, Record<string, unknown>> | undefined;
        const cfg = (): Record<string, Record<string, unknown>> => (cfgCache ??= readAllConfig(configPaths));
        const who = requirePet(url.searchParams, cfg);
        if (!who.ok) return who.res;
        const petId = who.petId;
        if (method === 'GET') {
          const mem = await readMemory();
          const bucket = mem[who.entry] ?? {};
          const list = (bucket[petId]?.messages ?? []).slice();
          // 传了 ?rounds= 就用传的（含 0 = 空历史），没传才回落到配置
          const rounds = roundsOverride ?? memoryRounds(who.conf);
          // 与 chatWithPet 同一语义：rounds = 0 → 空历史（slice(-0) 会返回整个数组，见上）
          const messages = sliceMemoryRounds(list, rounds);
          return { kind: 'json', status: 200, obj: { ok: true, messages, rounds } };
        }
        if (method === 'POST') {
          const parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
          const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
          if (!text) {
            return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: '消息为空' } };
          }
          if (text.length > 2000) {
            return {
              kind: 'json',
              status: 200,
              obj: { ok: false, reason: 'bad-request', message: '消息过长（限 2000 字）' },
            };
          }
          const result = await chatWithPet(petId, text);
          return { kind: 'json', status: 200, obj: result };
        }
      } catch (e) {
        // 配置已由 readAllConfig 保证正确（不再有 config-error 分支）；其余（IO/LLM）→ generate-error
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 动画文件：/dsh-pet-7340/thumb/<素材根>/<file>，扩展名 webm（默认）/ mov（macOS 定制）。
    // 素材归属按「是否存在该宠物的独立素材目录 `pet/<petId>-animation/`」判定：
    //   - 存在（pet pack 宠物）：只查自己的目录，查不到即 404 显式报错——绝不混用
    //   - 不存在（**所有主配置宠物**，main 与用户添加的任意多只）：主素材链
    //     main-animation/<webm|mov> 优先 → 包内 assets/<webm|mov>（与宠物数量无关，多只共用）
    // mov（HEVC-with-Alpha）为 macOS Safari/WKWebView 定制格式：默认不随包发布，
    // 用户从 GitHub Release（assets-mov）下载后放 main-animation/mov/，并把客户端播放
    // 扩展名常量（src/shared/constants.ts 的 ANIMATION_EXT / 产物 lib/client.js）改为 .mov。
    // 注意：font / pic 是扁平的 /<scope>/<file>，只有 thumb 是 /<scope>/<petId>/<file>——
    // 这里先拆 scope，再按 scope 各自拆剩余段，避免 font/pic 被误当作 petId 吞掉文件段。
    const [scope, ...restParts] = rest.split('/');
    if (scope === 'font') {
      const fontRoot = join(PACKAGE_ROOT, 'assets', 'fonts');
      const fontFile = resolveExisting(fontRoot, restParts.join('/'));
      if (fontFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: font not found' };
      const ext = fontFile.slice(fontFile.lastIndexOf('.')).toLowerCase();
      return { kind: 'file', file: fontFile, contentType: MIME[ext] ?? 'application/octet-stream' };
    }

    // 通知图标：/dsh-pet-7340/pic/<file> → 包内 assets/pic（方形 png，系统通知 icon 用）
    // 表情包：/dsh-pet-7340/pic/memes/<素材根>/<名称>.png → 按素材根走 memeDirsFor 的目录链
    // （种类独占目录 → 用户目录 → 包内），与 /thumb 同一套素材归属语义；名称含中文，URL 段已在上方解码。
    // 旧的两段形式 /pic/memes/<名称>.png 保留：等价于素材根 main 的目录链（未升级的客户端照常取到包内图）。
    if (scope === 'pic') {
      if (restParts[0] === 'memes') {
        const segs = restParts.slice(1);
        // 段数 ≥ 2 = <素材根>/<名称…>；恰好 1 段 = 旧扁平形式。表情包名称即文件名（不含子目录），
        // 所以两种形式不歧义；素材根与 /thumb 的 petId 同规矩：含分隔符 / 保留字符即显式 400。
        const scoped = segs.length >= 2;
        const assetRoot = scoped ? segs[0] : 'main';
        if (scoped && (assetRoot.length > 64 || ID_FORBIDDEN.test(assetRoot))) {
          return { kind: 'text', status: 400, body: 'dsh-pet: invalid asset root' };
        }
        const rel = (scoped ? segs.slice(1) : segs).join('/');
        let picFile: string | undefined;
        for (const dir of memeDirsFor(assetRoot)) {
          picFile = resolveExisting(dir, rel);
          if (picFile !== undefined) break;
        }
        if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: pic not found' };
        const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
        return { kind: 'file', file: picFile, contentType: MIME[ext] ?? 'application/octet-stream' };
      }
      const picRoot = join(PACKAGE_ROOT, 'assets', 'pic');
      const picFile = resolveExisting(picRoot, restParts.join('/'));
      if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: pic not found' };
      const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
      return { kind: 'file', file: picFile, contentType: MIME[ext] ?? 'application/octet-stream' };
    }

    if (scope !== 'thumb') {
      return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
    }
    // thumb 是三段式：/<scope>/<petId>/<file>——从这里再拆宠物 id 与文件名
    const [petId, ...nameParts] = restParts;
    if (!petId || nameParts.length === 0) {
      return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
    }
    // petId 是**标识符**（= pet/<名>-animation/ 的 <名>，来源是 pet/ 下的文件名前缀），不是路径片段：
    // 含分隔符/保留字符即显式 400，早于任何路径拼接判定。合法名（含中文）照常——
    // 用非法字符类而不是 ASCII 白名单。非法输入不再静默回落到主素材池（攻击尝试与"没有独立素材"可区分），
    // 也给下面的 resolveAsset 之外再留一道结构性防线。
    if (ID_FORBIDDEN.test(petId)) {
      return { kind: 'text', status: 400, body: 'dsh-pet: invalid pet id' };
    }
    const fileName = nameParts.join('/');
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    if (ext !== '.webm' && ext !== '.mov') {
      return { kind: 'text', status: 400, body: 'dsh-pet: unsupported animation format (expected .webm or .mov)' };
    }
    // 素材归属（按是否存在该宠物的独立素材目录判定，绝不静默混用）：
    //   - 存在 `pet/<petId>-animation/`（pet pack 宠物，URL 段 = 素材根 assetRoot）：
    //     只查自己的目录，查不到即 404 显式报错——绝不回落**别的素材**
    //     （唯一例外：同名的 webm/mov 互换，即下方 mov 缺失时退回 webm）
    //   - 不存在（**所有主配置宠物**：main 及用户添加的任意多只，共用全局动画池）：
    //     主素材链——用户 main-animation/<ext 子目录> 优先，其次包内 assets/<ext 子目录>
    // extraAnimDir 必须先过 resolveAsset：petId 是解码后的 URL 段，Windows 上 %5C 解出的
    // 反斜杠不会被 rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘。
    const extraAnimDir = resolveAsset(petConfigDir, petId + '-animation');
    /** 按扩展名查同名素材（专属目录优先；否则用户根 → 包内根） */
    const findAnim = (e: string): string | undefined => {
      const name = fileName.replace(/\.(webm|mov)$/i, '') + e;
      return extraAnimDir !== undefined && existsSync(extraAnimDir)
        ? resolveExisting(extraAnimDir, name)
        : (resolveExisting(userRootFor(e), name) ?? resolveExisting(assetRootFor(e), name));
    };
    let file = findAnim(ext);
    let servedExt = ext;
    // mov（HEVC-with-Alpha，macOS 定制）不随包发布：缺失时退回同名 webm。
    // 宿主是唯一知道素材在不在的一方——宁可让 Safari 播黑底（webm 的 alpha 被丢弃），
    // 也不能让整段动画 404（表现就是宠物完全不显示）。
    if (file === undefined && ext === '.mov') {
      const fb = findAnim('.webm');
      if (fb !== undefined) {
        file = fb;
        servedExt = '.webm';
      }
    }
    if (file === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: asset not found' };
    return { kind: 'file', file, contentType: MIME[servedExt] ?? 'application/octet-stream' };
  };

  /** `/dsh-pet-7340` 前缀的 Node HTTP handler（应用的本机服务直接调用） */
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    // 挂起等待（/playback?wait=）期间调用方可能提前断开：据此中止等待，
    // 否则那个等待者要一直留到超时才回收。'close' 在正常应答后也会触发，但那时监听已摘掉。
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.on('close', onClose);
    try {
      const body = req.method === 'PUT' || req.method === 'POST' ? await readBody(req) : undefined;
      const result = await handlePetRoute(req.url ?? '/', req.method ?? 'GET', body, abort.signal);
      res.off('close', onClose);
      if (result.kind === 'json') sendJson(res, result.status, result.obj, result.headers);
      else if (result.kind === 'text') sendText(res, result.status, result.body);
      else if (result.kind === 'none') {
        /* 调用方已断开：不再写（写了会抛） */
      } else sendFile(res, result.file, result.contentType); // 非 async：流在 open 后自己 pipe，错误内部收口
    } catch (e) {
      res.off('close', onClose);
      // 连接已断（挂起等待被中止后也可能撞上）→ 不再写，避免二次抛错
      if (!res.destroyed && !res.writableEnded) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  };

  let disposed = false;
  return {
    handler,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // 工作状态的补写定时器：卸载后它到点已经没有意义（叶子连同长轮询一起收尾），清掉免得挂着
      if (workFlushTimer !== null) {
        clearTimeout(workFlushTimer);
        workFlushTimer = null;
      }
      // 占用锁：卸载时把锁全撤掉并写一次叶子——不写的话渲染端要等 TTL 到点才解除静止
      // （写叶子必须在 state.cancelAll() **之前**：那之后挂起的等待者已经收尾了）。
      lock.releaseAll();
      playback.cancelAll();
      state.cancelAll();
    },
  };
}
