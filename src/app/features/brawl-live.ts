/**
 * X27 群架联机（B4）：开桌、加入、逐手定局、整场演出。
 *
 * 分工（`docs/x27-brawl-design.md` §3）：
 * - 星型中继在 `brawl-net.ts`（报文、校验、掉线、房主移交），这里只负责把报文递到线上；
 * - 线上只有「每手选了谁、打谁」；各家本地按同一串选择重放引擎（`brawl-live.ts` 的定手驱动），
 *   所以事件序列、名次不靠网络传；
 * - 定完整场才开演：`brawl-run` 拿现成事件摆窗口，演的过程中不再收报文，
 *   有人中途退出也不影响已经定下来的这一场。
 *
 * 传输走串门接待服务器的 `/v1/brawl/*`：一封网络报文 = 一次 POST，收件方自己长轮询取走。
 * 两家都得开着「允许别人来串门」（接待端口），否则收不到报文。
 */
import { rngFrom } from '../battle';
import {
  BRAWL_MAX,
  autoBrawlController,
  brawlFighterOf,
  brawlWinner,
  type BrawlEvent,
  type BrawlFighter,
} from '../brawl';
import { createBrawlLive, type BrawlLive } from '../brawl-live';
import { createBrawlNet, type BrawlNet, type BrawlNetMsg, type BrawlNetState } from '../brawl-net';
import { runBrawl } from '../brawl-run';
import { brawlLobbyOf, pollBrawlMsgs, postBrawlMsg, randomSparNonce, type HostAddress } from '../visit';
import { CLOSE_HOLD_MS, MENU_BRAWL_GROUP, lazyFns } from './context';
import type { FeatureContext } from './context';
import { delay, errorText } from './util';

/** 影子没在演动作时循环播的待机（对手窗口没有立绘；各家用自家素材是后续） */
const LIVE_IDLE = '待机呼吸休闲';
/** 编号 → 换色滤镜：暂时没有各家宠物的素材，用自家素材换色区分 */
const LIVE_FILTERS = [
  '',
  'hue-rotate(200deg) saturate(1.2)',
  'hue-rotate(120deg) saturate(1.2)',
  'hue-rotate(310deg) saturate(1.2)',
  'hue-rotate(45deg) saturate(1.5)',
];
/** 演出锁的时长（同本地演示） */
const LIVE_HOLD_MS = 10 * 60_000;
/** 本机邮箱长轮询一次挂多久（服务器上限 30 秒） */
const POLL_WAIT_MS = 15_000;
/** 菜单里最多列几家的「加入」项：菜单总共就 20 项，串门与切磋项还占着位置 */
const JOIN_ITEMS_MAX = 2;

/** 开着的桌（房主或客人）。同一时间只有一张。 */
interface LiveTable {
  role: 'host' | 'guest';
  net: BrawlNet;
  /** 编号 → 收件地址；房主在 join 时登记，客人从 start 报文里拿 */
  peers: Map<number, HostAddress>;
  /** 客人：房主的地址（房主移交后换成新房主） */
  host: HostAddress | null;
  fighters: BrawlFighter[] | null;
  driver: BrawlLive | null;
  /** 停掉本机的长轮询 */
  abort: AbortController;
  /** 开演以后不再收报文 */
  showing: boolean;
}

/** `http://10.0.0.2:7340` → { address, port }；格式不对返回 null */
function parseHost(raw: unknown): HostAddress | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const url = new URL(raw);
    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port <= 0) return null;
    return { address: url.hostname, port };
  } catch {
    return null;
  }
}

export interface BrawlLiveFeature {
  brawlLiveActions(): Map<string, () => unknown>;
  brawlMsg(msg: unknown, address: string): boolean;
  brawlLobby(): { players: Array<{ id: number; name: string }> } | null;
  closeBrawlLive(): void;
}

export function createBrawlLiveFeature(ctx: FeatureContext): BrawlLiveFeature {
  const { cultivationOn, holdPet, petName, playExtra, refreshMenu, releasePet, say, petRequest } = lazyFns(ctx);
  const { deps, electron, homePet, log } = ctx;
  let table: LiveTable | null = null;

  /** 现在正打着别的（切磋 / 心魔 / 历练）：先排队 */
  function arenaBusy(): boolean {
    return ctx.state.battle !== null || ctx.state.liveBattle !== null || ctx.state.actionPanel !== null;
  }

  /** 本机得开着接待端口才收得到报文（群架是双向的，不像串门可以只听不发） */
  function ready(): boolean {
    if (ctx.state.disposed) return false;
    if (!cultivationOn()) {
      void say('还没开始修炼，先炼起来吧～');
      return false;
    }
    if (arenaBusy()) {
      void say('现在正打着呢，等这场演完～');
      return false;
    }
    if (!ctx.state.visitHost || ctx.state.hostPort <= 0) {
      void say('先把「允许别人来串门」打开，别人才收得到你的出手～');
      return false;
    }
    return true;
  }

  /** 报文出站：房主按编号查地址，客人一律发房主 */
  function sendFor(current: LiveTable) {
    return (msg: BrawlNetMsg): void => {
      const to = current.role === 'host' ? current.peers.get(msg.to) : current.host;
      if (!to) return;
      // join 再带一个「往哪儿回」的端口：房主按来源地址 + 这个端口拼回信地址
      const body: Record<string, unknown> = msg.kind === 'join' ? { ...msg, port: ctx.state.hostPort } : { ...msg };
      void postBrawlMsg(to, body).catch((error: unknown) => {
        log(`群架：发给 ${to.address}:${to.port} 失败：${errorText(error)}`);
      });
    };
  }

  /** 本机邮箱：长轮询取报文，顺路把 start 里的地址表记下来 */
  function startPoll(current: LiveTable): void {
    void (async () => {
      while (table === current && !ctx.state.disposed) {
        let msgs: unknown[];
        try {
          msgs = await pollBrawlMsgs(
            { address: '127.0.0.1', port: ctx.state.hostPort },
            POLL_WAIT_MS,
            current.abort.signal,
          );
        } catch (error) {
          if (table !== current) return;
          log(`群架：取报文失败：${errorText(error)}`);
          await delay(1_000);
          continue;
        }
        for (const raw of msgs) {
          if (table !== current) return;
          if (!raw || typeof raw !== 'object') continue;
          const msg = raw as BrawlNetMsg;
          if (msg.kind === 'start' && Array.isArray(msg.addresses)) {
            msg.addresses.forEach((url, id) => {
              const parsed = parseHost(url);
              if (parsed) current.peers.set(id, parsed);
            });
          }
          current.net.receive(msg);
        }
      }
    })();
  }

  /** 开打：按名帖建人、种子派生的自动控制器、逐手定局 */
  function begin(current: LiveTable, state: BrawlNetState): void {
    const fighters = state.players.map((peer) => ({
      ...brawlFighterOf(peer.card, peer.id),
      name: peer.name || `对手${peer.id + 1}`,
    }));
    const seed = state.seed ?? '';
    const controllers = new Map(fighters.map((f) => [f.id, autoBrawlController(rngFrom(`${seed}:pick:${f.id}`))]));
    let driver: BrawlLive | null = null;
    driver = createBrawlLive({
      fighters,
      seed,
      self: state.self,
      choose: (view) =>
        (controllers.get(view.self) ?? autoBrawlController(rngFrom(`${seed}:pick:${view.self}`))).decide(view),
      submit: (target, action) => {
        try {
          current.net.submitMove(target, action);
        } catch (error) {
          log(`群架：这一手没交出去：${errorText(error)}`);
          driver?.retry();
        }
      },
    });
    current.fighters = fighters;
    current.driver = driver;
    driver.pump();
  }

  /** 整场定完：摆开环、演一遍、报名次 */
  async function show(current: LiveTable): Promise<void> {
    const fighters = current.fighters;
    const driver = current.driver;
    if (!fighters || !driver || current.showing) return;
    current.showing = true;
    const events: BrawlEvent[] = driver.events();
    const names = fighters.map((f) => f.name);
    const origin = new URL(deps.petBase).origin;
    const box = homePet.box();
    const point = box
      ? { x: box.left + box.size / 2, y: box.top + box.size / 2 }
      : electron.screen.getCursorScreenPoint();
    let done = false;
    try {
      await holdPet([], LIVE_HOLD_MS);
      await runBrawl(
        {
          electron,
          pages: { foe: `${origin}/app/foe`, fx: `${origin}/app/fx`, arena: `${origin}/app/brawl-arena` },
          home: homePet.box,
          workArea: () => electron.screen.getDisplayNearestPoint(point).workArea,
          playExtra: (anim, opts) => void playExtra(anim, opts),
          moveSelf: (x, y) => void petRequest('POST', '/position', { x, y, mode: 'instant' }),
          say: (line, ms) => void say(line, { anim: false, durationMs: ms }),
          log,
        },
        fighters,
        {
          events,
          seed: current.net.state().seed ?? undefined,
          self: current.net.state().self,
          fxBase: `${deps.petBase}/pic/fx/`,
          closeHoldMs: 800,
          idle: LIVE_IDLE,
          filter: (f) => LIVE_FILTERS[f.id] ?? '',
        },
      );
      done = true;
      const winner = brawlWinner(events);
      void say(winner === null ? '群架打完了，谁也没剩下～' : `群架打完了，${names[winner] ?? '有人'}站到最后～`);
      log(`群架联机：${names.join(' / ')}；${winner === null ? '没有赢家' : `${names[winner]} 站到最后`}`);
    } catch (error) {
      log(`群架联机没演成：${errorText(error)}`);
      void say('这场群架没摆开，等下再试～');
    } finally {
      releasePet(done ? CLOSE_HOLD_MS : 0);
      closeTable(current);
      await refreshMenu();
    }
  }

  /**
   * 定手阶段有人掉线 / 认输：这一场作罢（各家一起收摊）。
   * 引擎还不会「认输就退场」，硬接着打会演成出错的名次——不如直接散场，下次再来。
   */
  function lostBeforeShow(current: LiveTable, id: number): void {
    if (current.showing || table !== current) return;
    const name = current.net.state().players.find((p) => p.id === id)?.name || `对手${id + 1}`;
    log(`群架联机：${name} 掉线，这一场作罢`);
    void say(`${name} 掉线了，这场群架先散了吧～`);
    closeTable(current);
    void refreshMenu();
  }

  function closeTable(current: LiveTable): void {
    if (table !== current) return;
    table = null;
    current.abort.abort();
    current.net.dispose();
  }

  function closeBrawlLive(): void {
    const current = table;
    if (!current) return;
    closeTable(current);
  }

  /** 房主开桌：自己拿 0 号，等邻居来 join */
  async function openTable(): Promise<void> {
    if (table) {
      void say('群架桌已经开着了，等人来就行～');
      return;
    }
    if (!ready()) return;
    const practice = cultivationOn();
    if (!practice) return;
    const hostPort = ctx.state.hostPort;
    const current: LiveTable = {
      role: 'host',
      net: null as unknown as BrawlNet,
      peers: new Map(),
      host: null,
      fighters: null,
      driver: null,
      abort: new AbortController(),
      showing: false,
    };
    current.net = createBrawlNet({
      self: 0,
      name: petName(),
      card: practice.fighter(petName()),
      nonce: randomSparNonce(),
      send: sendFor(current),
      addressOf: (id) => {
        const peer = current.peers.get(id);
        return peer ? `http://${peer.address}:${peer.port}` : null;
      },
      turnOf: () => current.driver?.pending()?.id ?? null,
      onStart: (state) => begin(current, state),
      onDeliver: (move) => {
        current.driver?.push(move);
        if (current.driver?.done()) void show(current);
      },
      onExit: (id) => lostBeforeShow(current, id),
      onReject: () => current.driver?.retry(),
    });
    table = current;
    startPoll(current);
    log(`群架联机：开了桌（端口 ${hostPort}），等邻居加入`);
    void say('群架桌开好啦，等附近的桌宠加入～');
    await refreshMenu();
  }

  /** 客人：问一声对方有没有开桌，有就按名单算编号报名 */
  async function joinNeighbor(id: string): Promise<void> {
    if (table) {
      void say('已经在桌上了，打完再说～');
      return;
    }
    if (!ready()) return;
    const neighbor = ctx.state.neighborhood?.get(id);
    if (!neighbor) {
      void say('没找到这家邻居，可能刚走开～');
      return;
    }
    const practice = cultivationOn();
    if (!practice) return;
    const host: HostAddress = { address: neighbor.address, port: neighbor.port };
    const lobby = await brawlLobbyOf(host);
    if (!lobby.ok) {
      void say(
        lobby.reason === 'unreachable' ? `${neighbor.pet} 家连不上，可能刚走开～` : `${neighbor.pet} 家没开群架桌呢～`,
      );
      return;
    }
    if (lobby.players.length >= BRAWL_MAX) {
      void say(`${neighbor.pet} 家的群架已经满员了～`);
      return;
    }
    const current: LiveTable = {
      role: 'guest',
      net: null as unknown as BrawlNet,
      peers: new Map(),
      host,
      fighters: null,
      driver: null,
      abort: new AbortController(),
      showing: false,
    };
    current.net = createBrawlNet({
      // 房主按 players.length 发编号；先按名单长度猜，welcome 以房主发的为准
      self: lobby.players.length,
      name: petName(),
      card: practice.fighter(petName()),
      nonce: randomSparNonce(),
      send: sendFor(current),
      turnOf: () => current.driver?.pending()?.id ?? null,
      onStart: (state) => begin(current, state),
      onDeliver: (move) => {
        current.driver?.push(move);
        if (current.driver?.done()) void show(current);
      },
      onExit: (id) => lostBeforeShow(current, id),
      onReject: (reason) => {
        current.driver?.retry();
        log(`群架：房主没认这一手（${reason}）`);
      },
      onHostChange: (hostId) => {
        const next = current.peers.get(hostId);
        if (next) current.host = next;
      },
    });
    table = current;
    startPoll(current);
    current.net.join();
    log(`群架联机：向 ${neighbor.owner} 家的 ${neighbor.pet} 报名`);
    void say(`去 ${neighbor.pet} 家的群架桌～`);
    await refreshMenu();
  }

  /** 房主开打：至少要三个人（两人才打得出花样的话走 1v1，这条路径不做） */
  function startTable(): void {
    const current = table;
    if (!current || current.role !== 'host') return;
    const count = current.net.state().players.length;
    if (count < 3) {
      void say('群架至少三个人才热闹，再等一位吧～');
      return;
    }
    try {
      current.net.start();
      log(`群架联机：开打，${count} 人`);
    } catch (error) {
      log(`群架联机：开打失败：${errorText(error)}`);
      void say('这场群架没开起来，等下再试～');
      closeTable(current);
    }
    void refreshMenu();
  }

  function brawlLiveActions(): Map<string, () => unknown> {
    const actions = new Map<string, () => unknown>();
    if (!cultivationOn()) return actions;
    const current = table;
    if (current) {
      const count = current.net.state().players.length;
      if (current.role === 'host') {
        actions.set(`${MENU_BRAWL_GROUP}/开打（${count} 人）`, startTable);
        actions.set(`${MENU_BRAWL_GROUP}/散场`, closeBrawlLive);
      } else {
        actions.set(`${MENU_BRAWL_GROUP}/离开这张桌`, closeBrawlLive);
      }
      return actions;
    }
    actions.set(`${MENU_BRAWL_GROUP}/联机开桌`, () => void openTable());
    // 加入哪家：列最近的几家邻居（菜单一共 20 项，列三家就够）
    const nearby = (ctx.state.neighborhood?.list() ?? []).slice(0, JOIN_ITEMS_MAX);
    for (const neighbor of nearby) {
      let label = `${MENU_BRAWL_GROUP}/加入 ${neighbor.pet} 家`;
      for (let n = 2; actions.has(label); n += 1) label = `${MENU_BRAWL_GROUP}/加入 ${neighbor.pet} 家（${n}）`;
      actions.set(label, () => void joinNeighbor(neighbor.id));
    }
    return actions;
  }

  /** VisitHost 收报文：先按桌上的编号登记来源地址，再入队等本机轮询取走 */
  function brawlMsg(raw: unknown, address: string): boolean {
    const current = table;
    if (!current || current.showing) return false;
    if (!raw || typeof raw !== 'object') return false;
    const msg = raw as BrawlNetMsg;
    if (current.role === 'host' && msg.kind === 'join') {
      const port = Number((raw as { port?: unknown }).port);
      if (!Number.isInteger(port) || port <= 0) return false;
      current.peers.set(msg.from, { address, port });
      void say(`${msg.name || '有桌宠'} 加入群架桌啦～`);
      void refreshMenu();
    }
    return true;
  }

  function brawlLobby(): { players: Array<{ id: number; name: string }> } | null {
    const current = table;
    if (!current || current.role !== 'host' || current.showing) return null;
    const state = current.net.state();
    return { players: state.players.map((p) => ({ id: p.id, name: p.name ?? '' })) };
  }

  return { brawlLiveActions, brawlMsg, brawlLobby, closeBrawlLive };
}
