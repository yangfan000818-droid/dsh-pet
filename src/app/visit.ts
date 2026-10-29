/**
 * 局域网串门（网络这一半）：发现邻居、接待客人、出门做客时发的请求。只管协议与安全，
 * 不碰 Electron、不调模型；窗口与说话在 `features.ts` 里接线。
 *
 * 发现：允许别人来做客的桌宠每 BEACON_MS 往本机每块局域网网卡的广播地址发一条 UDP 信标（端口 BEACON_PORT），
 *   只带身份 id（每台电脑固定一对密钥，见 visit-identity.ts）、主人昵称、宠物名与接待端口；设置里手动填的邻居
 *   （跨网段用）再单播一份，收到别人的信标或探测时也给不在广播覆盖范围内的地址回发。收到别人的信标就记成邻居，
 *   NEIGHBOR_TTL_MS 没再收到就忘掉。不接待客人时只听不发：别人看不到自己，自己照样能出门（只给手动填的
 *   邻居发探测，让对方知道往哪儿回）。
 * 接待：另开一个只处理串门协议的 HTTP 监听——127.0.0.1 上那个本机服务的接口一个也不放到局域网上：
 *   POST /v1/knock { owner, pet, id?, pub?, ts?, sig? }    敲门：挂着等主人在右键菜单里点「让进 / 不让进」，最多 KNOCK_WAIT_MS
 *                                    （带身份的客人另加签名四件套；应答也带上主人家的 id / pub / sig，见 visit-identity.ts）
 *   POST /v1/chat  { token, text }   客人说一句，回 { reply }（这边的宠物回的那句）
 *   POST /v1/note  { token, text }   客人捎话（它家主人写给这边的，只收熟人的，每趟最多 NOTE_MAX 条、
 *                                    两条隔 NOTE_GAP_MS；events 里的 note 事件捎回去是另一个方向）
 *   POST /v1/spar   { token, mode, card, commit }   客人应约（或主动）切磋（X5）：带上名帖与随机数的承诺，
 *                                    回 { card, nonce }（这边自己的名帖与随机数）；模式不认识 / 版本不同 /
 *                                    名帖不对各有原因，切磋关着回 off、正在打回 busy
 *   POST /v1/spar/reveal { token, nonce, line? }    客人亮随机数（line 是它家宠物的赛后感言）；
 *                                    对得上就开打（两边各自算同一场），对不上或超时按客人认输
 *   POST /v1/duel   { owner, pet, id, pub, ts, sig, mode, card, commit }   隔空切磋（X15）：不用先串门，
 *                                    签名里带着承诺；挂着等主人在右键菜单里点「应战 / 不应战」，最多 DUEL_WAIT_MS
 *   POST /v1/duel/reveal { token, nonce, line? }    挑战方亮随机数；对得上就开打，对不上或超时按挑战方认输
 *   POST /v1/ping  { token }         客人每 PING_MS 报一次还在，回 { events }：这边攒下要告诉客人的事
 *                                    （这边宠物主动说的话、主人摸了它一下、一起玩什么、请它吃什么、
 *                                    邀它切磋）；被请回家后回 reason: sent-home
 *   POST /v1/leave { token, text }   客人告辞（text 是告别的话，可空）
 *
 * 安全（对方发来的一律不可信）：
 *   - 只收私有网段 / 链路本地 / 本机来的连接；带 Origin 的一律拒绝（局域网里的网页不能借浏览器打进来）；
 *   - 请求体 ≤ MAX_BODY_BYTES；名字与台词去掉控制字符后截断（cleanText），只当纯文本显示；
 *   - 每次进门都要主人点头；同一时间只接待一位、只挂一个敲门；同一地址 KNOCK_COOLDOWN_MS 内只能敲一次；
 *   - 进门后发一次性令牌，后续请求要带令牌、且来自敲门的那个地址。
 * 主人的上下文（截图、前台应用、Claude 进度）不经过这里：features.ts 生成串门台词只用人设。
 *
 * macOS 15 起，发广播、主动连局域网地址要主人在系统弹框里允许「本地网络」；监听与接收单播不需要（Apple TN3179）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { isIPv4 } from 'node:net';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { z } from 'zod';
import {
  BATTLE_VERSION,
  MOVE_IDS,
  SKILL_IDS,
  SPAR_DAMAGE_SCALE,
  SPAR_MAX_HIT_SHARE,
  WEAPON_IDS,
  fight,
  rngFrom,
  statCap,
} from './battle';
import type { FightOptions } from './battle';
import type { Action, BattleEvent, Fighter, MoveId, SkillId, WeaponId } from './battle';
import { MAX_STAGE } from './cultivation';
import { idOfPub, duelAcceptMessage, duelMessage, knockMessage, verifyWithPub, welcomeMessage } from './visit-identity';
import type { VisitIdentity } from './visit-identity';

/** 信标端口（7340 是插件路由前缀里的那个数） */
export const BEACON_PORT = 47340;
const BEACON_MS = 5_000;
const NEIGHBOR_TTL_MS = 20_000;
/** 回发名单最多记几个：满了丢最久没收到的那位 */
const REPLY_MAX = 32;
/** 设置页手动填的邻居最多几个 */
export const PEER_MAX = 20;
/** 敲门最多等主人这么久 */
export const KNOCK_WAIT_MS = 60_000;
const KNOCK_COOLDOWN_MS = 30_000;
/** 隔空切磋：应战方最多等主人答复 / 挑战方亮随机数这么久（X15） */
export const DUEL_WAIT_MS = 30_000;
/** 客人报平安的间隔 */
export const PING_MS = 5_000;
/** 客人这么久没动静就当它走了 */
const LOST_AFTER_MS = 30_000;
const MAX_BODY_BYTES = 4 * 1024;
const MAX_BEACON_BYTES = 512;
/** 主人昵称、宠物名的长度上限（右键菜单项 ≤ 32 字，要拼进「不让 X 进来」） */
export const NAME_MAX = 12;
/** 一句台词的长度上限 */
export const LINE_MAX = 60;
/** 敲门签名里的时间戳允许和本机差多少（重放也是这个窗口） */
const KNOCK_TS_SKEW_MS = 120_000;
/** 防重放缓存里一条 (id, ts) 记多久、最多存几条 */
const REPLAY_MS = 120_000;
const REPLAY_MAX = 256;
/** 每趟每个方向最多捎几句话 */
export const NOTE_MAX = 5;
/** 捎话两条之间至少隔这么久 */
export const NOTE_GAP_MS = 10_000;

// 控制字符、零宽字符与双向文本控制符：换行会撑坏气泡，双向控制符能把显示顺序倒过来骗人
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** 对方发来的文字：去掉控制字符、压掉多余空白、按字符截断；不是字符串就当空 */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, max).join('');
}

/** 对方的昵称、宠物名：同 cleanText，另把「/」换成全角——名字要拼进右键菜单项，半角「/」会被当成子菜单分隔 */
export function cleanName(value: unknown): string {
  return cleanText(value, NAME_MAX).replace(/\//g, '／');
}

// ---------- 切磋（X5） ----------

/** 切磋模式：auto = 开打前整场算好；live = 逐手对传（X19），收到不认识的回 unsupported-mode */
export const SPAR_MODE = 'auto';
export const SPAR_LIVE_MODE = 'live';

/** 逐手局每一手对方等多久（35 秒没收到就当掉线，§X19） */
export const TURN_WAIT_MS = 35_000;
/** 一手最多几步（只防离谱的 index；一场三十手就结束，留足余量） */
const TURN_INDEX_MAX = 1_000;

/** 名帖：切磋前双方交换的战斗档案（编号会过网，全用引擎图鉴里的 ASCII 编号） */
export interface SparCard {
  /** 引擎版本（BATTLE_VERSION）：两边不同就切不了 */
  v: number;
  /** 境界序号（对方报的，没法验证真伪；擂台名牌与属性上限的口径都用它） */
  stage: number;
  hp: number;
  power: number;
  agility: number;
  speed: number;
  weapons: WeaponId[];
  skills: SkillId[];
}

const sparCardSchema = z.object({
  v: z.number().int().min(1),
  stage: z.number().int().min(0).max(MAX_STAGE),
  hp: z.number().int().min(1),
  power: z.number().int().min(1),
  agility: z.number().int().min(1),
  speed: z.number().int().min(1),
  weapons: z.array(z.enum(WEAPON_IDS)).max(WEAPON_IDS.length),
  skills: z.array(z.enum(SKILL_IDS)).max(SKILL_IDS.length),
});

/**
 * 对方发来的名帖（不可信）：过了给名帖；引擎版本不同回 'version'（菜单好说「两边版本不一样，切磋不了」，
 * 也兜住未来版本名帖里字段对不上的情形）；其余不合法——字段不对、编号不认识、数值超过该境界的
 * 理论上限（statCap）——回 null，当 bad-card 拒掉。
 */
export function parseSparCard(raw: unknown): SparCard | 'version' | null {
  if ((raw as { v?: unknown } | null)?.v !== BATTLE_VERSION) return 'version';
  const card = sparCardSchema.safeParse(raw);
  if (!card.success) return null;
  const cap = statCap(card.data.stage);
  return card.data.hp <= cap.hp &&
    card.data.power <= cap.power &&
    card.data.agility <= cap.agility &&
    card.data.speed <= cap.speed
    ? card.data
    : null;
}

/** 自己的名帖：战斗档案照 fighter 抄、境界另带（features.ts 接线用） */
export function sparCardOf(fighter: Fighter, stage: number): SparCard {
  return {
    v: BATTLE_VERSION,
    stage,
    hp: fighter.hp,
    power: fighter.power,
    agility: fighter.agility,
    speed: fighter.speed,
    weapons: [...fighter.weapons],
    skills: [...fighter.skills],
  };
}

/** 名帖 → 对手的 Fighter（名字用敲门/信标里那位宠物的名字） */
export function cardFighter(name: string, card: SparCard): Fighter {
  return {
    name,
    hp: card.hp,
    power: card.power,
    agility: card.agility,
    speed: card.speed,
    weapons: [...card.weapons],
    skills: [...card.skills],
  };
}

/** 32 字节随机数的十六进制：切磋双方各出一个，合起来当种子（谁也没法一个人挑） */
export function randomSparNonce(): string {
  return randomBytes(32).toString('hex');
}

/** 承诺 = sha256(随机数) 的十六进制：客人先交承诺、主人家后出随机数，两边都做不了手脚 */
export function sparCommit(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

/** 是不是一条 32 字节的十六进制随机数 / 承诺 */
export function isSparNonce(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * 逐手局收到的出手（X19）：只认图鉴里认识的编号，形状不对就当没带。
 * 这只是结构校验；能不能出这一手还要过 `legalActions`（features 那边判，不合法按掉线）。
 */
export function parseSparAction(raw: unknown): Action | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const action = raw as Record<string, unknown>;
  if (action.kind === 'unarmed') return { kind: 'unarmed' };
  if (action.kind === 'weapon' && WEAPON_IDS.includes(action.weapon as WeaponId))
    return { kind: 'weapon', weapon: action.weapon as WeaponId };
  if (action.kind === 'skill' && SKILL_IDS.includes(action.skill as SkillId))
    return { kind: 'skill', skill: action.skill as SkillId };
  if (action.kind === 'move' && MOVE_IDS.includes(action.move as MoveId))
    return { kind: 'move', move: action.move as MoveId };
  return null;
}

/** 逐手局的一手请求里的序号：0 起、不能离谱 */
export function parseTurnIndex(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > TURN_INDEX_MAX) return null;
  return raw;
}

/**
 * 两边各自算的同一场（§X5）：主人家是 a（事件里 actor 0），种子是「客人随机数:主人家随机数」。
 * 两边都调它、传同一对随机数，事件序列逐个相同——顺序反了就是另一场，测试里钉住这条。
 */
export function sparFight(
  host: Fighter,
  guest: Fighter,
  guestNonce: string,
  hostNonce: string,
  options?: FightOptions,
): BattleEvent[] {
  return fight(host, guest, `${guestNonce}:${hostNonce}`, undefined, {
    damageScale: SPAR_DAMAGE_SCALE,
    maxHitShare: SPAR_MAX_HIT_SHARE,
    ...options,
  });
}

/**
 * 解说台词的随机数（X12）：主客两边都拿同一对随机数、按同一个种子挑句子，
 * 两块屏幕上的解说才会逐句相同（动作、飞行物、气血本来就由同一场事件决定）。
 * 心魔试炼、渡劫没有对面那个随机数，照旧用 `Math.random`。
 */
export function sparLineRng(guestNonce: string, hostNonce: string): () => number {
  return rngFrom(`${guestNonce}:${hostNonce}:lines`);
}

// ---------- 发现 ----------

export interface Beacon {
  /** 串门身份 id（认出自己发的信标） */
  id: string;
  owner: string;
  pet: string;
  /** 接待端口 */
  port: number;
}

export interface Neighbor extends Beacon {
  address: string;
  seenAt: number;
}

const beaconSchema = z.object({
  app: z.literal('dsh-pet'),
  v: z.literal(1),
  id: z.string().min(8).max(64),
  owner: z.string(),
  pet: z.string(),
  port: z.number().int().min(1).max(65535),
});

export function encodeBeacon(beacon: Beacon): Buffer {
  return Buffer.from(JSON.stringify({ app: 'dsh-pet', v: 1, ...beacon }), 'utf8');
}

/** 解析一条信标；不是我们的、超长、字段不对或名字清理后为空 → null */
export function parseBeacon(raw: Buffer): Beacon | null {
  if (raw.length > MAX_BEACON_BYTES) return null;
  try {
    const beacon = beaconSchema.parse(JSON.parse(raw.toString('utf8')));
    const owner = cleanName(beacon.owner);
    const pet = cleanName(beacon.pet);
    return owner && pet ? { id: beacon.id, owner, pet, port: beacon.port } : null;
  } catch {
    return null;
  }
}

/** 探测：只出门、不接待的一方也能让对方知道「往这儿回」；不带身份、昵称、宠物名 */
export function encodeProbe(): Buffer {
  return Buffer.from(JSON.stringify({ app: 'dsh-pet', v: 1, probe: true }), 'utf8');
}

/** 是不是一条探测（旧版本 parseBeacon 解析失败，直接当垃圾丢掉） */
export function isProbe(raw: Buffer): boolean {
  if (raw.length > MAX_BEACON_BYTES) return false;
  try {
    const value = JSON.parse(raw.toString('utf8')) as Record<string, unknown> | null;
    return value?.app === 'dsh-pet' && value.v === 1 && value.probe === true;
  } catch {
    return false;
  }
}

const ipv4ToInt = (address: string): number => address.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
const intToIpv4 = (value: number): string => [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');

/**
 * 本机每块 IPv4 局域网网卡的广播地址。只发 255.255.255.255 的话只走默认那块网卡，
 * 同时插着网线和连着 Wi-Fi 时另一边收不到（TN3179 建议在每块能广播的网卡上发）。
 * /31、/32（点对点、VPN 隧道）没有广播地址，跳过。
 */
export function broadcastAddresses(interfaces = networkInterfaces()): string[] {
  const result = new Set<string>();
  for (const list of Object.values(interfaces)) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const mask = ipv4ToInt(item.netmask);
      if (mask >= 0xfffffffe) continue;
      result.add(intToIpv4(((ipv4ToInt(item.address) & mask) | ~mask) >>> 0));
    }
  }
  return [...result];
}

/** 私有网段 / 链路本地 / 运营商 NAT 段（Tailscale 用它）/ 本机：只收这些地址来的连接 */
export function isLanAddress(raw: string | undefined): boolean {
  const address = (raw ?? '').replace(/^::ffff:/, '');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return address === '::1';
  const [a, b] = address.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** 设置页手动填的邻居：点分 IPv4（每段 0–255，不带前导零），而且是局域网地址；不合格整份配置拒收 */
export function isPeerAddress(value: string): boolean {
  return isIPv4(value) && isLanAddress(value);
}

/**
 * 收到对方的信标 / 探测后要不要单播回一条：局域网地址，而且不在本机任何一块「有广播地址」的
 * IPv4 网卡的网段里（本网段的邻居已经被广播覆盖；回环网卡与 /31、/32 的 VPN 隧道不算覆盖）。
 */
export function shouldReply(address: string, interfaces = networkInterfaces()): boolean {
  const ip = (address ?? '').replace(/^::ffff:/, '');
  if (!isLanAddress(ip)) return false;
  // 回环的 IPv6（::1）按本机处理，下面只比 IPv4 网段
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return true;
  for (const list of Object.values(interfaces)) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const mask = ipv4ToInt(item.netmask);
      if (mask >= 0xfffffffe) continue;
      if ((ipv4ToInt(item.address) & mask) >>> 0 === (ipv4ToInt(ip) & mask) >>> 0) return false;
    }
  }
  return true;
}

export interface NeighborhoodOptions {
  /** 串门身份 id（认出自己发的信标） */
  id: string;
  /**
   * 自己的信标内容（每次发时现取：昵称、宠物名改了下一条就是新的）；
   * null = 不接待客人，只听不发（别人看不到自己，自己照样能看到别人）
   */
  announce: () => Omit<Beacon, 'id'> | null;
  log: (message: string) => void;
  /** 监听的信标端口（测试用 0 = 随机） */
  port?: number;
  /** 信标发往哪些地址（默认每块网卡的广播地址 + BEACON_PORT） */
  targets?: () => Array<{ address: string; port: number }>;
  /** 设置页手动填的邻居：追加在默认广播地址（或 targets）后面，每次发送时现取 */
  peers?: () => Array<{ address: string; port: number }>;
  /** 发信标的间隔（测试用，默认 BEACON_MS） */
  intervalMs?: number;
  now?: () => number;
}

/** 回发名单里的一位：收到过对方的信标 / 探测，回发时单播给它 */
interface ReplyTarget {
  address: string;
  port: number;
  seenAt: number;
}

export class Neighborhood {
  private socket: Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSendError = '';
  private readonly neighbors = new Map<string, Neighbor>();
  private readonly replies = new Map<string, ReplyTarget>();
  private readonly options: NeighborhoodOptions;

  constructor(options: NeighborhoodOptions) {
    this.options = options;
  }

  /** 绑定信标端口并开始发；端口被占等错误直接抛给调用方 */
  async start(): Promise<void> {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.options.port ?? BEACON_PORT, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    socket.setBroadcast(true);
    socket.on('message', (raw, info) => this.receive(raw, info.address, info.port));
    socket.on('error', (error) => this.options.log(`串门：信标出错：${error.message}`));
    this.socket = socket;
    this.send();
    this.timer = setInterval(() => this.send(), this.options.intervalMs ?? BEACON_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
    this.neighbors.clear();
    this.replies.clear();
  }

  /** 实际绑定的信标端口（测试用） */
  port(): number {
    return this.socket?.address().port ?? 0;
  }

  /** 最近 NEIGHBOR_TTL_MS 内收到过信标的邻居，按昵称排序 */
  list(): Neighbor[] {
    const now = this.now();
    for (const [id, neighbor] of this.neighbors) {
      if (now - neighbor.seenAt > NEIGHBOR_TTL_MS) this.neighbors.delete(id);
    }
    return [...this.neighbors.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.pet.localeCompare(b.pet));
  }

  get(id: string): Neighbor | undefined {
    return this.list().find((neighbor) => neighbor.id === id);
  }

  private send(): void {
    const socket = this.socket;
    if (!socket) return;
    const now = this.now();
    const self = this.options.announce();
    // 不接待客人时只听不发：只把手动填的邻居用探测告诉一声，让它们知道「往这儿回」
    if (!self) {
      const peers = uniqueTargets(this.options.peers?.() ?? []);
      if (peers.length === 0) return;
      const probe = encodeProbe();
      for (const target of peers) this.sendTo(socket, probe, target);
      return;
    }
    this.pruneReplies(now);
    const payload = encodeBeacon({ id: this.options.id, ...self });
    const targets = uniqueTargets([
      ...(this.options.targets?.() ?? broadcastAddresses().map((address) => ({ address, port: BEACON_PORT }))),
      ...(this.options.peers?.() ?? []),
      ...[...this.replies.values()].map(({ address, port }) => ({ address, port })),
    ]);
    for (const target of targets) this.sendTo(socket, payload, target);
  }

  private sendTo(socket: Socket, payload: Buffer, target: { address: string; port: number }): void {
    socket.send(payload, target.port, target.address, (error) => {
      // 没授权「本地网络」时每一条都会失败：同样的错只记一次，恢复后再出错再记
      const message = error ? `${target.address}：${error.message}` : '';
      if (message && message !== this.lastSendError) this.options.log(`串门：信标发不出去 ${message}`);
      this.lastSendError = message;
    });
  }

  private receive(raw: Buffer, address: string, port: number): void {
    const beacon = parseBeacon(raw);
    if (beacon) {
      if (beacon.id === this.options.id) return;
      this.neighbors.set(beacon.id, { ...beacon, address, seenAt: this.now() });
      this.rememberReply(address, port);
      return;
    }
    // 探测只影响回发名单，不进邻居列表
    if (isProbe(raw)) this.rememberReply(address, port);
  }

  /**
   * 记下「要单播回去」的地址：只记局域网里、不在本机广播覆盖范围内的（收到信标或探测时）。
   * 新地址立刻回一条信标，免得跨网段的邻居要等下一个 5 秒；已经在名单里的只刷新时间，不额外发。
   */
  private rememberReply(address: string, port: number): void {
    if (!shouldReply(address)) return;
    const now = this.now();
    this.pruneReplies(now);
    const key = `${address}:${port}`;
    const known = this.replies.delete(key);
    // 删了再放回去：Map 按放进去的先后排，排头的就是最久没收到的那位，满了从它丢
    this.replies.set(key, { address, port, seenAt: now });
    if (known) return;
    while (this.replies.size > REPLY_MAX) this.replies.delete(this.replies.keys().next().value as string);
    const socket = this.socket;
    const self = this.options.announce();
    if (!socket || !self) return;
    this.sendTo(socket, encodeBeacon({ id: this.options.id, ...self }), { address, port });
  }

  /** 丢掉过期（NEIGHBOR_TTL_MS 内没再收到）的回发地址 */
  private pruneReplies(now: number): void {
    for (const [key, reply] of this.replies) if (now - reply.seenAt > NEIGHBOR_TTL_MS) this.replies.delete(key);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** 按 address:port 去重，保留头一次出现的顺序 */
function uniqueTargets(targets: Array<{ address: string; port: number }>): Array<{ address: string; port: number }> {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.address}:${target.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- 接待 ----------

export interface Visitor {
  owner: string;
  pet: string;
  address: string;
  /** 敲门签名验证通过时的客人身份 id（visit-identity.ts）；没验证上（旧版本、签名不对）就没有 */
  id?: string;
}

export type KnockFailure = 'busy' | 'too-soon' | 'declined' | 'no-answer';

/** 这边要告诉客人的事（客人报平安时捎过去）：这边宠物主动说了句话 / 主人摸了客人一下 / 一起玩什么 / 请它吃什么 / 捎给客人主人的话 / 邀它切磋（X5） */
export type HostEvent =
  | { type: 'line'; text: string }
  | { type: 'poke' }
  | { type: 'play'; what: string }
  | { type: 'gift'; what: string }
  | { type: 'note'; text: string }
  /** 邀切磋（X5）；`mode: 'live'` = 发起方选了逐手局（X19），旧客人不认识 mode 时照自动走 */
  | { type: 'spar-invite'; mode?: 'live' };
/** 一次最多捎几件事（攒多了丢最早的） */
const EVENTS_MAX = 8;

/** /v1/spar 的应答：答应了带这边的名帖与随机数；拒绝带原因（unsupported-mode / version / bad-card 在协议层，off / busy / no-id 在 features.ts） */
export type SparReply =
  | { ok: true; card: SparCard; nonce: string }
  | {
      ok: false;
      reason:
        | 'unsupported-mode'
        | 'off'
        | 'busy'
        | 'no-id'
        | 'version'
        | 'bad-card'
        | 'bad-request'
        | 'sent-home'
        | 'declined'
        | 'not-visiting'
        | 'old-host';
    };

/** /v1/spar/reveal 的应答：对不上（mismatch）或超时（late）都按客人认输，应答里如实带回去 */
export type SparRevealReply =
  { ok: true } | { ok: false; reason: 'mismatch' | 'late' | 'sent-home' | 'not-visiting' | 'old-host' };

/** 应战方对隔空切磋的答复（X15）：答应时带上这边自己的名帖与随机数；off / busy 在 features.ts 答 */
export type DuelAnswer =
  { ok: true; card: SparCard; nonce: string } | { ok: false; reason: 'off' | 'busy' | 'declined' | 'timeout' };

/** 挑战方发 /v1/duel 可能听到的全部原因（bad-sig 也算，挑战方的应答签名验不过时当对方没应） */
export type DuelFailure =
  | 'bad-sig'
  | 'off'
  | 'busy'
  | 'unsupported-mode'
  | 'version'
  | 'bad-card'
  | 'bad-request'
  | 'declined'
  | 'timeout'
  | 'too-soon'
  | 'old-host';

/** /v1/duel 的应答：答应时带这边的名帖、随机数、令牌与签名（挑战方验过签名才算数） */
export type DuelReply = { ok: true; card: SparCard; nonce: string; token: string } | { ok: false; reason: DuelFailure };

/** /v1/duel/reveal 的应答：对不上（mismatch）或超时（late）都按挑战方认输，应答里如实带回去 */
export type DuelRevealReply = { ok: true } | { ok: false; reason: 'mismatch' | 'late' | 'not-visiting' | 'old-host' };

/**
 * 逐手局一手（X19）的应答：轮到对面出手时带回它的 action；`illegal` = 收到的出手过不了
 * `legalActions`（按掉线处理），`late` = 序号对不上 / 这一场已经收了，`not-visiting` = 没有这一场。
 */
export type SparTurnReply =
  | { ok: true; action?: Action }
  | { ok: false; reason: 'illegal' | 'late' | 'busy' | 'bad-request' | 'not-visiting' | 'sent-home' };

export interface HostHandlers {
  /** 现在能不能接待（自己的宠物出门在外、正在敲别人家的门时不行） */
  canHost(): boolean;
  /** 有人敲门了：等主人 answer() */
  knocked(visitor: Visitor): void;
  /** 敲门没等到答复就结束了：no-answer = 主人一直没点；gone = 对方不等了 */
  knockEnded(visitor: Visitor, reason: 'no-answer' | 'gone'): void;
  /** 客人说了一句，返回这边宠物回的话 */
  line(visitor: Visitor, text: string): Promise<string>;
  /** 客人捎来的话（它家主人写给这边的）：返回收不收——只收自己熟人的（T7，features.ts 查邻居簿） */
  note(visitor: Visitor, text: string): boolean;
  /**
   * 客人应约（或主动）发来切磋（X5 第 2 步）：名帖与承诺已在协议层验过（parseSparCard / isSparNonce），
   * 这里只答切磋关不关（off）、在不在打（busy）、认不认得客人（no-id），答应对了回名帖与随机数
   */
  spar(visitor: Visitor, card: SparCard, commit: string, live?: boolean): Promise<SparReply>;
  /** 客人亮随机数（X5 第 4 步，line 是它带来的赛后感言）：核对承诺后开打，对不上或超时按客人认输 */
  reveal(visitor: Visitor, nonce: string, line: string): Promise<SparRevealReply>;
  /** 逐手局的一手（X19）：收到（或等）对方这一手；不合法 / 序号不对 / 没有这一场在这里回 */
  sparTurn?(visitor: Visitor, index: number, action?: Action): Promise<SparTurnReply>;
  /**
   * 隔空切磋（X15）的挑战：等主人答复；off / busy / declined / timeout 在这里答，
   * 答应时回这边自己的名帖与随机数（令牌与应答签名在协议层出）
   */
  duel(visitor: Visitor, card: SparCard, commit: string, live?: boolean): Promise<DuelAnswer>;
  /** 挑战方亮对了随机数：名帖与随机数都齐了，开演（features.ts 记账 + 演出） */
  duelReveal(visitor: Visitor, nonce: string, line: string): void;
  /** 逐手局的一手（X19，隔空切磋） */
  duelTurn?(visitor: Visitor, index: number, action?: Action): Promise<SparTurnReply>;
  /** 挑战方没亮随机数（对不上 / 超时，协议层已判）：按它认输记一场 */
  duelConceded(visitor: Visitor, reason: 'mismatch' | 'late'): void;
  /** 客人走了：leave = 告辞（text 是告别的话，可空）；lost = 太久没动静 */
  left(visitor: Visitor, reason: 'leave' | 'lost', text: string): void;
}

interface Session {
  visitor: Visitor;
  token: string;
  lastSeen: number;
  /** 等客人下次报平安时捎过去的事 */
  outbox: HostEvent[];
  /** 这趟客人已经捎来几句话、上一条是什么时候（限额在接待端卡） */
  noteCount: number;
  lastNoteAt: number;
}

interface PendingKnock {
  visitor: Visitor;
  finish: (answer: boolean | 'no-answer' | 'gone') => void;
}

/** 等主人答复的一次挑战（/v1/duel 的 HTTP 应答挂着） */
interface PendingDuelAsk {
  visitor: Visitor;
  timer: ReturnType<typeof setTimeout> | null;
  finish: (answer: DuelAnswer | 'gone') => void;
}

/** 应战以后等挑战方亮随机数的那一场（X15） */
interface PendingDuel {
  visitor: Visitor;
  token: string;
  commit: string;
  card: SparCard;
  nonce: string;
  acceptedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 逐手局（X19）：亮随机数后还留着这条会话给 /v1/duel/turn 认令牌 */
  live: boolean;
}

export interface HostOptions {
  log: (message: string) => void;
  /** 本机身份：有它才验客人的敲门签名、才给进门应答签名（旧对端 / 没身份时都当陌生人） */
  identity?: VisitIdentity | null;
  now?: () => number;
  knockWaitMs?: number;
  /** 隔空切磋等主人答复 / 等亮随机数的时限（测试调短用，默认 DUEL_WAIT_MS） */
  duelWaitMs?: number;
  lostAfterMs?: number;
}

export class VisitHost {
  private server: Server | null = null;
  private session: Session | null = null;
  private pending: PendingKnock | null = null;
  /** 等主人答复的那次隔空切磋（同一时间只挂一个挑战） */
  private duelAsk: PendingDuelAsk | null = null;
  /** 应战以后等挑战方亮随机数的那一场 */
  private duelSession: PendingDuel | null = null;
  /** 刚超时的那一场：挑战方迟到亮随机数时回 late（主人家已经在超时那一步记过账了） */
  private lastDuel: { token: string; visitor: Visitor; at: number } | null = null;
  /** 被主人请回家的那位的令牌：它下一次来报平安时告诉它 sent-home */
  private sentHomeToken: string | null = null;
  private lostTimer: ReturnType<typeof setInterval> | null = null;
  private readonly knockedAt = new Map<string, number>();
  /** 隔空切磋的冷却按地址各算各的（和敲门分开，X15） */
  private readonly duelAt = new Map<string, number>();
  /** 见过的 (客人 id, ts)：防有人把抄来的敲门请求原样再发一遍 */
  private readonly knocksSeen = new Map<string, number>();
  /** 接待监听的端口（验签名、给应答签名都要拼进内容） */
  private listenPort = 0;
  private readonly handlers: HostHandlers;
  private readonly options: HostOptions;

  constructor(handlers: HostHandlers, options: HostOptions) {
    this.handlers = handlers;
    this.options = options;
  }

  /**
   * 开始监听（默认所有网卡、随机端口），返回端口
   * @param host 测试用 127.0.0.1
   */
  async listen(host = '0.0.0.0'): Promise<number> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.options.log(`串门：接待出错：${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) send(res, 500, { ok: false, reason: 'error' });
        else res.end();
      });
    });
    // 只限「收完请求」的时间；敲门的应答要挂着等主人，不受它限制
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.maxConnections = 32;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.listenPort = (server.address() as AddressInfo).port;
    this.lostTimer = setInterval(() => this.checkLost(), PING_MS);
    return this.listenPort;
  }

  async close(): Promise<void> {
    if (this.lostTimer !== null) clearInterval(this.lostTimer);
    this.lostTimer = null;
    this.pending?.finish('gone');
    this.session = null;
    // 还挂着的隔空挑战：等主人答复的那次回 timeout（直接断开也行，这里如实结束），应战后的那场不再记账
    if (this.duelAsk) this.finishDuelAsk(this.duelAsk, { ok: false, reason: 'timeout' });
    if (this.duelSession?.timer) clearTimeout(this.duelSession.timer);
    this.duelSession = null;
    this.lastDuel = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 正在敲门、等主人答复的那位 */
  knocking(): Visitor | null {
    return this.pending?.visitor ?? null;
  }

  /** 正在家里做客的那位 */
  guest(): Visitor | null {
    return this.session?.visitor ?? null;
  }

  /** 主人答复敲门；返回敲门的那位（没人在敲时 null） */
  answer(accept: boolean): Visitor | null {
    const pending = this.pending;
    pending?.finish(accept);
    return pending?.visitor ?? null;
  }

  /** 攒一件事，客人下次报平安时捎过去；没有客人时 false */
  tell(event: HostEvent): boolean {
    const session = this.session;
    if (!session) return false;
    session.outbox.push(event);
    if (session.outbox.length > EVENTS_MAX) session.outbox.shift();
    return true;
  }

  /** 主人请客人回家；返回那位（没有客人时 null） */
  sendHome(): Visitor | null {
    const session = this.session;
    if (!session) return null;
    this.session = null;
    this.sentHomeToken = session.token;
    return session.visitor;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (!isLanAddress(address) || req.headers.origin !== undefined) {
      return send(res, 403, { ok: false, reason: 'forbidden' });
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, reason: 'method' });
    const body = await readJson(req);
    if (body === undefined) return send(res, 400, { ok: false, reason: 'bad-request' });
    const path = new URL(req.url ?? '/', 'http://visit').pathname;
    if (path === '/v1/knock') {
      // 验签名要用「本机收到这个连接的地址」：客人按它拨的地址签，两边得是同一个
      const local = (req.socket.localAddress ?? '').replace(/^::ffff:/, '');
      return this.knock(address, local, body, res);
    }
    // 隔空切磋（X15）不用先串门，也就没有进门令牌：和敲门一样在 session 检查之前处理
    if (path === '/v1/duel') {
      const local = (req.socket.localAddress ?? '').replace(/^::ffff:/, '');
      return this.duel(address, local, body, res);
    }
    if (path === '/v1/duel/reveal') return this.duelReveal(address, body, res);
    if (path === '/v1/duel/turn') return this.duelTurn(address, body, res);

    const session = this.session;
    if (!session || body.token !== session.token || address !== session.visitor.address) {
      const reason = typeof body.token === 'string' && body.token === this.sentHomeToken ? 'sent-home' : 'not-visiting';
      return send(res, 200, { ok: false, reason });
    }
    session.lastSeen = this.now();
    switch (path) {
      case '/v1/ping':
        return send(res, 200, { ok: true, events: session.outbox.splice(0) });
      case '/v1/chat': {
        const text = cleanText(body.text, LINE_MAX);
        if (!text) return send(res, 400, { ok: false, reason: 'bad-request' });
        const reply = await this.handlers.line(session.visitor, text).catch((error: unknown) => {
          this.options.log(`串门：回话失败：${error instanceof Error ? error.message : String(error)}`);
          return '';
        });
        return send(res, 200, { ok: true, reply: cleanText(reply, LINE_MAX) });
      }
      case '/v1/note': {
        const text = cleanText(body.text, LINE_MAX);
        if (!text) return send(res, 400, { ok: false, reason: 'bad-request' });
        // 先卡限额（纯协议层），再问这边收不收（features.ts 查邻居簿）；收下的才算数
        const now = this.now();
        if (session.noteCount >= NOTE_MAX || (session.noteCount > 0 && now - session.lastNoteAt < NOTE_GAP_MS))
          return send(res, 200, { ok: false, reason: 'too-many' });
        if (!this.handlers.note(session.visitor, text)) return send(res, 200, { ok: false, reason: 'not-friend' });
        session.noteCount += 1;
        session.lastNoteAt = now;
        return send(res, 200, { ok: true });
      }
      case '/v1/spar': {
        // 先验模式，再验版本（未来版本的名帖字段可能对不上现在的 schema，得先说清是版本问题），再验名帖
        const live = body.mode === SPAR_LIVE_MODE;
        if (body.mode !== SPAR_MODE && !live) return send(res, 200, { ok: false, reason: 'unsupported-mode' });
        const commit = typeof body.commit === 'string' ? body.commit : '';
        if (!isSparNonce(commit)) return send(res, 400, { ok: false, reason: 'bad-request' });
        const card = parseSparCard(body.card);
        if (card === 'version') return send(res, 200, { ok: false, reason: 'version' });
        if (card === null) return send(res, 200, { ok: false, reason: 'bad-card' });
        return send(res, 200, await this.handlers.spar(session.visitor, card, commit, live));
      }
      case '/v1/spar/turn': {
        const reply = await this.turnBody(body, (index, action) =>
          this.handlers.sparTurn
            ? this.handlers.sparTurn(session.visitor, index, action)
            : Promise.resolve({ ok: false, reason: 'not-visiting' as const }),
        );
        return send(res, 200, reply);
      }
      case '/v1/spar/reveal': {
        // 感言是客人捎来给自己家客人窗口说的：照台词清洗截断，核过承诺才上屏（features.ts）
        const nonce = typeof body.nonce === 'string' ? body.nonce : '';
        const reply = await this.handlers.reveal(session.visitor, nonce, cleanText(body.line, LINE_MAX));
        return send(res, 200, reply);
      }
      case '/v1/leave':
        this.session = null;
        this.handlers.left(session.visitor, 'leave', cleanText(body.text, LINE_MAX));
        return send(res, 200, { ok: true });
      default:
        return send(res, 404, { ok: false, reason: 'not-found' });
    }
  }

  private async knock(
    address: string,
    local: string,
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    const owner = cleanName(body.owner);
    const pet = cleanName(body.pet);
    if (!owner || !pet) return send(res, 400, { ok: false, reason: 'bad-request' });
    if (this.session || this.pending || !this.handlers.canHost()) return send(res, 200, { ok: false, reason: 'busy' });
    const now = this.now();
    const last = this.knockedAt.get(address);
    if (last !== undefined && now - last < KNOCK_COOLDOWN_MS) return send(res, 200, { ok: false, reason: 'too-soon' });
    this.knockedAt.set(address, now);

    const visitor: Visitor = { owner, pet, address };
    const verifiedId = this.verifyGuest(body, owner, pet, local, now);
    if (verifiedId) visitor.id = verifiedId;
    const answer = await new Promise<boolean | 'no-answer' | 'gone'>((resolve) => {
      const pending: PendingKnock = {
        visitor,
        finish: (result) => {
          if (this.pending !== pending) return;
          this.pending = null;
          clearTimeout(timer);
          resolve(result);
        },
      };
      const timer = setTimeout(() => pending.finish('no-answer'), this.options.knockWaitMs ?? KNOCK_WAIT_MS);
      // 对方等不及断开了：撤掉这次敲门（应答写完后也会触发 close，那时 pending 已清，finish 不再生效）
      res.once('close', () => pending.finish('gone'));
      this.pending = pending;
      this.handlers.knocked(visitor);
    });
    if (answer === 'no-answer' || answer === 'gone') {
      this.handlers.knockEnded(visitor, answer);
      if (answer === 'no-answer') send(res, 200, { ok: false, reason: 'no-answer' });
      return;
    }
    if (!answer) return send(res, 200, { ok: false, reason: 'declined' });
    const token = randomBytes(16).toString('hex');
    this.session = { visitor, token, lastSeen: this.now(), outbox: [], noteCount: 0, lastNoteAt: 0 };
    this.sentHomeToken = null;
    // 给验明正身的客人签应答：客人拿它认下这家人（T4 记邻居、T7 捎话都以这个为准）
    const identity = this.options.identity;
    const guestId = visitor.id;
    if (identity && guestId) {
      const sig = identity.sign(welcomeMessage({ guestId, address: local, port: this.listenPort, token }));
      return send(res, 200, { ok: true, token, id: identity.id, pub: identity.pub, sig });
    }
    send(res, 200, { ok: true, token });
  }

  /**
   * 验客人的敲门签名。任何一步不过都**不拒绝**，只当陌生人（visitor 不带 id，照旧等主人点头），
   * 原因记进日志；全部通过返回客人的身份 id。
   */
  private verifyGuest(
    body: Record<string, unknown>,
    owner: string,
    pet: string,
    local: string,
    now: number,
  ): string | null {
    const stranger = (reason: string): null => {
      this.options.log(`串门：客人身份没验证上（${reason}），当陌生人`);
      return null;
    };
    const { id, pub, ts, sig } = body;
    if (
      typeof id !== 'string' ||
      typeof pub !== 'string' ||
      typeof ts !== 'string' ||
      typeof sig !== 'string' ||
      id.length > 32 ||
      pub.length > 100 ||
      sig.length > 100 ||
      !/^\d{1,16}$/.test(ts)
    ) {
      return stranger('字段不对');
    }
    const pubId = idOfPub(pub);
    if (!pubId || pubId !== id) return stranger('公钥对不上 id');
    const at = Number(ts);
    if (Math.abs(now - at) > KNOCK_TS_SKEW_MS) return stranger('时间戳太旧');
    // 防重放：同一个 (id, ts) 只认第一次。先记再验签名：签名错的也不许换一张签名重试同一个 ts
    for (const [seen, seenAt] of this.knocksSeen) if (now - seenAt > REPLAY_MS) this.knocksSeen.delete(seen);
    const replayKey = `${id}/${ts}`;
    if (this.knocksSeen.has(replayKey)) return stranger('重放');
    this.knocksSeen.set(replayKey, now);
    while (this.knocksSeen.size > REPLAY_MAX) this.knocksSeen.delete(this.knocksSeen.keys().next().value as string);
    const identity = this.options.identity;
    if (!identity) return stranger('本机没有身份');
    const message = knockMessage({ hostId: identity.id, address: local, port: this.listenPort, ts: at, owner, pet });
    if (!verifyWithPub(pub, message, sig)) return stranger('签名不对');
    return id;
  }

  /**
   * 隔空切磋（X15）的挑战：验签 → 验模式 / 承诺 / 名帖 → 挂着等主人答复，最多 DUEL_WAIT_MS。
   * 没带 id 或验不过一律 bad-sig（奖励和邻居簿都靠 id 记，不接匿名挑战）。
   */
  private async duel(
    address: string,
    local: string,
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    const owner = cleanName(body.owner);
    const pet = cleanName(body.pet);
    if (!owner || !pet) return send(res, 400, { ok: false, reason: 'bad-request' });
    // 同一时间只挂一个挑战；有客人在家、有人敲门、自己出门时也不接（和敲门同一口径）
    if (this.session || this.pending || this.duelAsk || this.duelSession || !this.handlers.canHost())
      return send(res, 200, { ok: false, reason: 'busy' });
    const now = this.now();
    const last = this.duelAt.get(address);
    if (last !== undefined && now - last < KNOCK_COOLDOWN_MS) return send(res, 200, { ok: false, reason: 'too-soon' });
    this.duelAt.set(address, now);

    // 验签在冷却之后：和敲门一个顺序（验不过的也占一次冷却，免得同一地址反复打）
    const challengerId = this.verifyDuel(body, owner, pet, local, now);
    if (!challengerId) return send(res, 200, { ok: false, reason: 'bad-sig' });
    const live = body.mode === SPAR_LIVE_MODE;
    if (body.mode !== SPAR_MODE && !live) return send(res, 200, { ok: false, reason: 'unsupported-mode' });
    const commit = typeof body.commit === 'string' ? body.commit : '';
    if (!isSparNonce(commit)) return send(res, 400, { ok: false, reason: 'bad-request' });
    const card = parseSparCard(body.card);
    if (card === 'version') return send(res, 200, { ok: false, reason: 'version' });
    if (card === null) return send(res, 200, { ok: false, reason: 'bad-card' });

    const visitor: Visitor = { owner, pet, address, id: challengerId };
    const answer = await new Promise<DuelAnswer | 'gone'>((resolve) => {
      const pending: PendingDuelAsk = {
        visitor,
        timer: null,
        finish: (result) => {
          if (this.duelAsk !== pending) return;
          this.duelAsk = null;
          if (pending.timer !== null) clearTimeout(pending.timer);
          resolve(result);
        },
      };
      pending.timer = setTimeout(
        () => pending.finish({ ok: false, reason: 'timeout' }),
        this.options.duelWaitMs ?? DUEL_WAIT_MS,
      );
      // 对方等不及断开了：撤掉这次挑战（应答写完后也会触发 close，那时已经清掉，finish 不再生效）
      res.once('close', () => pending.finish('gone'));
      this.duelAsk = pending;
      void this.handlers.duel(visitor, card, commit, live).then(
        (result) => pending.finish(result),
        (error: unknown) => {
          this.options.log(`串门：隔空切磋出错：${error instanceof Error ? error.message : String(error)}`);
          pending.finish({ ok: false, reason: 'busy' });
        },
      );
    });
    if (answer === 'gone') return;
    if (!answer.ok) return send(res, 200, { ok: false, reason: answer.reason });

    const identity = this.options.identity;
    if (!identity) return send(res, 200, { ok: false, reason: 'bad-sig' });
    const token = randomBytes(16).toString('hex');
    const session: PendingDuel = {
      visitor,
      token,
      commit,
      card,
      nonce: answer.nonce,
      acceptedAt: this.now(),
      timer: null,
      live,
    };
    session.timer = setTimeout(() => this.timeoutDuel(session), this.options.duelWaitMs ?? DUEL_WAIT_MS);
    this.duelSession = session;
    this.lastDuel = null;
    // 给验明正身的挑战方签应答：挑战方拿它认下这家人（地址按挑战方拨的地址拼，转发来的就对不上）
    const sig = identity.sign(duelAcceptMessage({ challengerId, address: local, port: this.listenPort, token }));
    return send(res, 200, {
      ok: true,
      card: answer.card,
      nonce: answer.nonce,
      token,
      id: identity.id,
      pub: identity.pub,
      sig,
    });
  }

  /** 挑战方亮随机数（X15）：对不上或超时都按它认输；核过了交给 features.ts 开演 */
  private duelReveal(address: string, body: Record<string, unknown>, res: ServerResponse): void {
    const token = typeof body.token === 'string' ? body.token : '';
    const session = this.duelSession;
    if (!session || session.token !== token || session.visitor.address !== address) {
      // 超时之后才到的 reveal：按迟到回，挑战方好按认输记（主人家已经在超时那一步记过了）
      const late = this.lastDuel;
      if (late && late.token === token && late.visitor.address === address)
        return send(res, 200, { ok: false, reason: 'late' });
      return send(res, 200, { ok: false, reason: 'not-visiting' });
    }
    const nonce = typeof body.nonce === 'string' ? body.nonce : '';
    if (session.timer !== null) clearTimeout(session.timer);
    session.timer = null;
    if (this.now() - session.acceptedAt > (this.options.duelWaitMs ?? DUEL_WAIT_MS)) {
      this.duelSession = null;
      this.lastDuel = { token, visitor: session.visitor, at: session.acceptedAt };
      this.handlers.duelConceded(session.visitor, 'late');
      return send(res, 200, { ok: false, reason: 'late' });
    }
    if (sparCommit(nonce) !== session.commit) {
      this.duelSession = null;
      this.handlers.duelConceded(session.visitor, 'mismatch');
      return send(res, 200, { ok: false, reason: 'mismatch' });
    }
    // 逐手局（X19）：这条会话留着给 /v1/duel/turn 认令牌，打完由 features 调 finishDuel() 收
    if (!session.live) this.duelSession = null;
    this.handlers.duelReveal(session.visitor, nonce, cleanText(body.line, LINE_MAX));
    return send(res, 200, { ok: true });
  }

  /** 逐手局的隔空切磋打完了 / 断了：把留着认令牌的会话收掉（下一场挑战才能进来） */
  finishDuel(): void {
    const session = this.duelSession;
    if (!session) return;
    this.duelSession = null;
    if (session.timer !== null) clearTimeout(session.timer);
  }

  /** 逐手局的隔空切磋一手（X19）：令牌与来源地址对上才交给 features；结构不对当 bad-request */
  private async duelTurn(address: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const token = typeof body.token === 'string' ? body.token : '';
    const session = this.duelSession;
    if (!session || session.token !== token || session.visitor.address !== address) {
      return send(res, 200, { ok: false, reason: 'not-visiting' });
    }
    const reply = await this.turnBody(body, (index, action) =>
      this.handlers.duelTurn
        ? this.handlers.duelTurn(session.visitor, index, action)
        : Promise.resolve({ ok: false, reason: 'not-visiting' as const }),
    );
    return send(res, 200, reply);
  }

  /** 逐手局请求体的结构校验（序号、出手形状）：过了才交给 features 判 `legalActions` */
  private async turnBody(
    body: Record<string, unknown>,
    ask: (index: number, action: Action | undefined) => Promise<SparTurnReply>,
  ): Promise<SparTurnReply> {
    const index = parseTurnIndex(body.index);
    if (index === null) return { ok: false, reason: 'bad-request' };
    let action: Action | undefined;
    if (body.action !== undefined && body.action !== null) {
      const parsed = parseSparAction(body.action);
      // 结构不对：当掉线（对端不该发这种形状）；不回 illegal 是因为连「它出了哪一手」都认不出
      if (!parsed) return { ok: false, reason: 'bad-request' };
      action = parsed;
    }
    return ask(index, action);
  }

  /** 超时没亮随机数：主人家按挑战方认输记一场，槽位腾出来；迟到的 reveal 还能认出来回 late */
  private timeoutDuel(session: PendingDuel): void {
    if (this.duelSession !== session) return;
    this.duelSession = null;
    if (session.timer !== null) clearTimeout(session.timer);
    this.lastDuel = { token: session.token, visitor: session.visitor, at: session.acceptedAt };
    this.handlers.duelConceded(session.visitor, 'late');
  }

  /** 等主人答复的挑战被撤掉（应战 / 不应战 / 超时 / 断开 / 退出） */
  private finishDuelAsk(pending: PendingDuelAsk, answer: DuelAnswer | 'gone'): void {
    pending.finish(answer);
  }

  /**
   * 验挑战方的隔空切磋签名：字段、公钥与 id、时间戳新鲜度、防重放、duelMessage 的签名，任何一步不过都 null。
   * 和敲门不同：验不过就是 bad-sig，不当陌生人接——没有 id 的挑战不记账，也不进邻居簿。
   */
  private verifyDuel(
    body: Record<string, unknown>,
    owner: string,
    pet: string,
    local: string,
    now: number,
  ): string | null {
    const { id, pub, ts, sig } = body;
    if (
      typeof id !== 'string' ||
      typeof pub !== 'string' ||
      typeof ts !== 'string' ||
      typeof sig !== 'string' ||
      id.length > 32 ||
      pub.length > 100 ||
      sig.length > 100 ||
      !/^\d{1,16}$/.test(ts)
    ) {
      return null;
    }
    const pubId = idOfPub(pub);
    if (!pubId || pubId !== id) return null;
    const at = Number(ts);
    if (Math.abs(now - at) > KNOCK_TS_SKEW_MS) return null;
    // 防重放和敲门各用各的键：同一个 ts 的敲门签名挪不过来（前缀本来就不同）
    for (const [seen, seenAt] of this.knocksSeen) if (now - seenAt > REPLAY_MS) this.knocksSeen.delete(seen);
    const replayKey = `duel/${id}/${ts}`;
    if (this.knocksSeen.has(replayKey)) return null;
    this.knocksSeen.set(replayKey, now);
    while (this.knocksSeen.size > REPLAY_MAX) this.knocksSeen.delete(this.knocksSeen.keys().next().value as string);
    const identity = this.options.identity;
    if (!identity) return null;
    const commit = typeof body.commit === 'string' ? body.commit : '';
    const message = duelMessage({
      hostId: identity.id,
      address: local,
      port: this.listenPort,
      ts: at,
      owner,
      pet,
      commit,
    });
    return verifyWithPub(pub, message, sig) ? id : null;
  }

  private checkLost(): void {
    const session = this.session;
    if (!session || this.now() - session.lastSeen <= (this.options.lostAfterMs ?? LOST_AFTER_MS)) return;
    this.session = null;
    this.handlers.left(session.visitor, 'lost', '');
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

// ---------- 出门做客（客人这一侧的请求） ----------

export interface HostAddress {
  address: string;
  port: number;
}

async function post(
  host: HostAddress,
  path: string,
  body: unknown,
  timeoutMs: number,
  abort?: AbortSignal,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`http://${host.address}:${host.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: abort ? AbortSignal.any([timeout, abort]) : timeout,
  });
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('应答太大');
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('应答不是 JSON 对象');
  return parsed as Record<string, unknown>;
}

const KNOCK_FAILURES: readonly string[] = ['busy', 'too-soon', 'declined', 'no-answer'];

export type KnockAnswer = { ok: true; token: string; verified: boolean } | { ok: false; reason: KnockFailure };

/**
 * 敲门：挂着等对方主人答复；连不上时抛错。
 * 带上自家身份（和信标里的主人家的 id）时给敲门签名，并验应答里主人家的签名：
 * 对上了 verified = true；旧对端不带签名时照常进门，只是 verified = false。
 */
export async function knockOn(
  host: HostAddress,
  me: { owner: string; pet: string },
  identity?: VisitIdentity | null,
  hostId?: string | null,
): Promise<KnockAnswer> {
  const body: Record<string, unknown> = { ...me };
  if (identity && hostId) {
    const ts = Date.now();
    body.id = identity.id;
    body.pub = identity.pub;
    body.ts = String(ts);
    body.sig = identity.sign(
      knockMessage({ hostId, address: host.address, port: host.port, ts, owner: me.owner, pet: me.pet }),
    );
  }
  const result = await post(host, '/v1/knock', body, KNOCK_WAIT_MS + 10_000);
  if (result.ok === true && typeof result.token === 'string' && /^[0-9a-f]{32}$/.test(result.token)) {
    const { token } = result;
    // 应答签名也按「客人拨的地址」拼：假信标把请求转发给别家，这里的地址就对不上。
    // 公钥还得真是信标里那个 id 的：id 是明文广播的，谁都能往应答里填，pub 和签名可以是自己的钥匙
    const welcome =
      identity &&
      hostId &&
      result.id === hostId &&
      typeof result.pub === 'string' &&
      typeof result.sig === 'string' &&
      idOfPub(result.pub) === hostId
        ? verifyWithPub(
            result.pub,
            welcomeMessage({ guestId: identity.id, address: host.address, port: host.port, token }),
            result.sig,
          )
        : false;
    return { ok: true, token, verified: welcome };
  }
  const reason =
    typeof result.reason === 'string' && KNOCK_FAILURES.includes(result.reason) ? result.reason : 'no-answer';
  return { ok: false, reason: reason as KnockFailure };
}

export type TripReply =
  { ok: true; reply: string; events: HostEvent[] } | { ok: false; reason: 'sent-home' | 'not-visiting' };

/** 对方捎来的事：不认识的、字段不对的丢掉，文字照样清理截断；旧版本不带 events 时当没有 */
export function parseEvents(raw: unknown): HostEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: HostEvent[] = [];
  for (const item of raw.slice(0, EVENTS_MAX)) {
    const event = item as Record<string, unknown> | null;
    if (event?.type === 'poke') events.push({ type: 'poke' });
    // 邀切磋：旧客人不认识这种类型，走到这儿也不匹配，照样丢掉（X5 的兼容口径）。
    // 逐手局（X19）多带一个 mode: 'live'；旧客人只认 type，照样按自动应战
    if (event?.type === 'spar-invite')
      events.push({ type: 'spar-invite', ...(event.mode === 'live' ? { mode: 'live' as const } : {}) });
    const text = cleanText(event?.text, LINE_MAX);
    if (event?.type === 'line' && text) events.push({ type: 'line', text });
    // 捎给客人主人的话：只当文本显示，不进任何提示词（features.ts 的 onHostEvent）
    if (event?.type === 'note' && text) events.push({ type: 'note', text });
    const what = cleanText(event?.what, NAME_MAX);
    if (event?.type === 'play' && what) events.push({ type: 'play', what });
    if (event?.type === 'gift' && what) events.push({ type: 'gift', what });
  }
  return events;
}

/**
 * 做客期间的请求（chat / ping / leave）；连不上时抛错
 * @returns ok:false = 对方已经不当我是客人了（sent-home = 被请回家），该回家了
 */
export async function tripRequest(
  host: HostAddress,
  path: '/v1/chat' | '/v1/ping' | '/v1/leave',
  body: { token: string; text?: string },
): Promise<TripReply> {
  // 说一句要等对方模型回话，给足时间；报平安与告辞要快
  const result = await post(host, path, body, path === '/v1/chat' ? 60_000 : 5_000);
  if (result.ok === true)
    return { ok: true, reply: cleanText(result.reply, LINE_MAX), events: parseEvents(result.events) };
  return { ok: false, reason: result.reason === 'sent-home' ? 'sent-home' : 'not-visiting' };
}

export type NoteReply =
  { ok: true } | { ok: false; reason: 'not-friend' | 'too-many' | 'sent-home' | 'not-visiting' | 'old-host' };

/**
 * 捎话（客人 → 主人家）；连不上时抛错。
 * 旧主人家没有这条路径，回的是 404 + not-found：如实映射成 old-host，客人那边好说「对方的版本太旧」。
 */
export async function sendNote(host: HostAddress, body: { token: string; text: string }): Promise<NoteReply> {
  const result = await post(host, '/v1/note', body, 5_000);
  if (result.ok === true) return { ok: true };
  if (result.reason === 'not-friend' || result.reason === 'too-many' || result.reason === 'sent-home')
    return { ok: false, reason: result.reason };
  return { ok: false, reason: result.reason === 'not-found' ? 'old-host' : 'not-visiting' };
}

/** /v1/spar 拒绝时客人那边要能说人话的全部原因（mismatch / late 只出现在 reveal 的应答里） */
export type SparFailure = Exclude<SparReply, { ok: true }>['reason'];

const SPAR_FAILURES: readonly string[] = [
  'unsupported-mode',
  'off',
  'busy',
  'no-id',
  'version',
  'bad-card',
  'bad-request',
  'sent-home',
  'declined',
];

/**
 * 客人应约（或主动）发切磋（X5 第 2 步）；连不上时抛错。
 * 应答里主人家的名帖与随机数照样不可信：名帖再过一遍 parseSparCard、随机数验格式，不对就当 bad-card。
 * 旧主人家没有这条路径（404 + not-found）：如实映射成 old-host，客人那边好说「对方的桌宠还不会切磋」。
 */
export async function sendSpar(
  host: HostAddress,
  body: { token: string; mode: string; card: SparCard; commit: string },
): Promise<SparReply> {
  // 逐手局里主人家要先在自己的出招面板里选方式（10 秒不点按自动），请求要等得比 5 秒久
  const result = await post(host, '/v1/spar', body, body.mode === SPAR_LIVE_MODE ? 15_000 : 5_000);
  if (result.ok === true) {
    const nonce = typeof result.nonce === 'string' ? result.nonce : '';
    const card = parseSparCard(result.card);
    if (card !== null && card !== 'version' && isSparNonce(nonce)) return { ok: true, card, nonce };
    return { ok: false, reason: 'bad-card' };
  }
  const reason = typeof result.reason === 'string' ? result.reason : '';
  if (reason === 'not-found') return { ok: false, reason: 'old-host' };
  return {
    ok: false,
    reason: SPAR_FAILURES.includes(reason) ? (reason as SparFailure) : 'not-visiting',
  };
}

/**
 * 逐手局的一手（X19，串门切磋）：轮到自家出手时带 action，轮到对面时不带、挂着等它回 action。
 * 等的一方 35 秒还没收到就当掉线（`TURN_WAIT_MS`），连不上 / 超时都抛错，由调用方按掉线收。
 */
export async function sendSparTurn(
  host: HostAddress,
  body: { token: string; index: number; action?: Action },
  signal?: AbortSignal,
): Promise<SparTurnReply> {
  return sendTurn(host, '/v1/spar/turn', body, signal);
}

async function sendTurn(
  host: HostAddress,
  path: '/v1/spar/turn' | '/v1/duel/turn',
  body: { token: string; index: number; action?: Action },
  signal?: AbortSignal,
): Promise<SparTurnReply> {
  const result = await post(host, path, body, TURN_WAIT_MS, signal);
  if (result.ok === true) {
    if (result.action === undefined || result.action === null) return { ok: true };
    const action = parseSparAction(result.action);
    return action ? { ok: true, action } : { ok: false, reason: 'illegal' };
  }
  const reason = typeof result.reason === 'string' ? result.reason : '';
  if (reason === 'not-found') return { ok: false, reason: 'not-visiting' };
  return {
    ok: false,
    reason:
      reason === 'illegal' ||
      reason === 'late' ||
      reason === 'busy' ||
      reason === 'bad-request' ||
      reason === 'sent-home'
        ? (reason as Extract<SparTurnReply, { ok: false }>['reason'])
        : 'not-visiting',
  };
}

/** 亮随机数（X5 第 4 步），line 是自家宠物的赛后感言，主人家核过承诺后让客人窗口说；连不上时抛错 */
export async function sendReveal(
  host: HostAddress,
  body: { token: string; nonce: string; line: string },
): Promise<SparRevealReply> {
  const result = await post(host, '/v1/spar/reveal', body, 5_000);
  if (result.ok === true) return { ok: true };
  const reason = typeof result.reason === 'string' ? result.reason : '';
  if (reason === 'not-found') return { ok: false, reason: 'old-host' };
  if (reason === 'mismatch' || reason === 'late') return { ok: false, reason };
  return { ok: false, reason: 'not-visiting' };
}

/** /v1/duel 拒绝时挑战方要能说人话的全部原因（mismatch / late 只出现在 reveal 的应答里） */
const DUEL_FAILURES: readonly string[] = [
  'bad-sig',
  'off',
  'busy',
  'unsupported-mode',
  'version',
  'bad-card',
  'bad-request',
  'declined',
  'timeout',
  'too-soon',
];

/**
 * 隔空切磋（X15 第 1 步）：带上签名（承诺签在里面）发 /v1/duel，挂着等对方主人答复；连不上时抛错。
 * 应答里对方的名帖、随机数与签名照样不可信：名帖过 parseSparCard、随机数验格式、应答签名验过才算数。
 * 旧版本的对端没有这条路径（404 / 被 session 检查挡回 not-visiting）：如实映射成 old-host。
 */
export async function sendDuel(
  host: HostAddress,
  hostId: string,
  me: { owner: string; pet: string },
  identity: VisitIdentity,
  body: { mode: string; card: SparCard; commit: string },
): Promise<DuelReply> {
  const ts = Date.now();
  // 名字先按接待端的口径清理再签：那边验签用的是 cleanName 之后的名字，原样签会因空格 / 半角斜杠对不上
  const owner = cleanName(me.owner);
  const pet = cleanName(me.pet);
  const message = duelMessage({
    hostId,
    address: host.address,
    port: host.port,
    ts,
    owner,
    pet,
    commit: body.commit,
  });
  const result = await post(
    host,
    '/v1/duel',
    {
      owner,
      pet,
      id: identity.id,
      pub: identity.pub,
      ts: String(ts),
      sig: identity.sign(message),
      mode: body.mode,
      card: body.card,
      commit: body.commit,
    },
    // 逐手局里应战方在答复主人以后还要选出招方式（10 秒），比自动局多留一点
    DUEL_WAIT_MS + (body.mode === SPAR_LIVE_MODE ? 25_000 : 10_000),
  );
  if (result.ok === true) {
    const token = typeof result.token === 'string' ? result.token : '';
    // 令牌、公钥、id、签名缺一不可：验不过就当对方没应
    if (
      !/^[0-9a-f]{32}$/.test(token) ||
      result.id !== hostId ||
      typeof result.pub !== 'string' ||
      typeof result.sig !== 'string' ||
      idOfPub(result.pub) !== hostId
    ) {
      return { ok: false, reason: 'bad-sig' };
    }
    const nonce = typeof result.nonce === 'string' ? result.nonce : '';
    const card = parseSparCard(result.card);
    if (card === null || card === 'version' || !isSparNonce(nonce)) return { ok: false, reason: 'bad-card' };
    const accepted = verifyWithPub(
      result.pub,
      duelAcceptMessage({ challengerId: identity.id, address: host.address, port: host.port, token }),
      result.sig,
    );
    return accepted ? { ok: true, card, nonce, token } : { ok: false, reason: 'bad-sig' };
  }
  const reason = typeof result.reason === 'string' ? result.reason : '';
  // 旧版本没有 /v1/duel：老代码会先撞上 session 检查回 not-visiting，两种都当「还不会隔空切磋」
  if (reason === 'not-found' || reason === 'not-visiting') return { ok: false, reason: 'old-host' };
  return { ok: false, reason: DUEL_FAILURES.includes(reason) ? (reason as DuelFailure) : 'bad-request' };
}

/** 逐手局的一手（X19，隔空切磋）：同 `sendSparTurn`，只是走 /v1/duel/turn 的令牌 */
export async function sendDuelTurn(
  host: HostAddress,
  body: { token: string; index: number; action?: Action },
  signal?: AbortSignal,
): Promise<SparTurnReply> {
  return sendTurn(host, '/v1/duel/turn', body, signal);
}

/** 亮随机数（X15 第 3 步），line 是挑战方宠物的赛后感言，应战方核过承诺后开演；连不上时抛错 */
export async function sendDuelReveal(
  host: HostAddress,
  body: { token: string; nonce: string; line: string },
): Promise<DuelRevealReply> {
  const result = await post(host, '/v1/duel/reveal', body, 5_000);
  if (result.ok === true) return { ok: true };
  const reason = typeof result.reason === 'string' ? result.reason : '';
  if (reason === 'not-found') return { ok: false, reason: 'old-host' };
  if (reason === 'mismatch' || reason === 'late' || reason === 'not-visiting') return { ok: false, reason };
  return { ok: false, reason: 'not-visiting' };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  // 事件式读取（与 app-routes.ts 同法）：tsconfig 的 lib 不认 Readable 的 async iterator
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
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
