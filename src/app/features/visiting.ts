import { userInfo } from 'node:os';

import { findPetInstance, readAllConfig } from '../../host/config';
import { durationText } from '../activity';
import { notesAllowed, shouldAutoAdmit } from '../neighbors';

import { GUEST_ASK, guestPrompt, HOST_ASK, hostPrompt, memoPrompt, openerGap, travelPrompt } from '../visit-talk';
import { AWAY_OPACITY, fadeHome, openGuestWindow } from '../visit-windows';
import {
  BEACON_PORT,
  cleanText,
  knockOn,
  LINE_MAX,
  NAME_MAX,
  Neighborhood,
  PING_MS,
  tripRequest,
  VisitHost,
} from '../visit';
import type { HostHandlers, KnockAnswer, KnockFailure, Neighbor, Visitor } from '../visit';

import { lazyFns } from './context';
import type { FeatureContext, GuestOffOptions, HomeReason, Hosting, Trip } from './context';
import { errorText } from './util';

/** 捎到的话在客人窗口的气泡里显示多久（比聊天的话久：主人要读自己写的那句到了没） */
const NOTE_BUBBLE_MS = 20_000;
/** 一句没聊上就回家时，回家的经过（照实说：不写清楚小模型会自己编，比如「门锁着」） */
const HOME_WITHOUT_CHAT: Record<HomeReason, string> = {
  'time-up': '待到点就回来了，没聊上话',
  called: '刚进门家里就有事，先回来了',
  'sent-home': '刚进门就被它家主人请回来了',
  lost: '突然连不上它家，只好回来了',
  farewell: '被一阵风送回来了，还没聊上话',
};

/** 串门：网络、敲门、接待、右键项与回家 */
export interface Visiting {
  nickname(): string;
  petName(): string;
  syncVisit(): Promise<void>;
  closeHost(): Promise<void>;
  letIn(accept: boolean): void;
  sendGuestHome(options?: GuestOffOptions): void;
  goVisit(id: string): Promise<void>;
  visitLine(instruction: string, fallback: string): Promise<string>;
  comeHome(reason: HomeReason): Promise<void>;
}

export function createVisiting(ctx: FeatureContext): Visiting {
  const {
    cancelSpar,
    closeAdventureShows,
    closeTrial,
    compose,
    duelTurn,
    hostDuel,
    hostDuelConceded,
    hostDuelReveal,
    hostReveal,
    hostSpar,
    sparTurn,
    openTopic,
    petId,
    pingTrip,
    pokeGuest,
    refreshMenu,
    refreshStatus,
    say,
    skipTrial,
    speak,
    talk,
  } = lazyFns(ctx);
  const { deps, log, electron, tracker, diary, neighbors, homePet } = ctx;
  // ---------- 串门 ----------

  /** 邻居看到的主人昵称：设置里填的，没填用登录用户名 */
  function nickname(): string {
    let fallback = '';
    try {
      fallback = userInfo().username;
    } catch {
      // 取不到登录用户名（极少见）：下面按「主人」
    }
    return cleanText(deps.appConfig().visit.nickname || fallback, NAME_MAX) || '主人';
  }

  function petName(): string {
    try {
      const found = findPetInstance(readAllConfig(deps.configPaths), petId());
      return cleanText(String(found?.pet.name ?? ''), NAME_MAX) || '桌宠';
    } catch {
      return '桌宠';
    }
  }

  /**
   * 按设置开 / 关串门的两块网络（每拍查一次：设置页改了下一拍生效）：
   * 接待端口跟「允许别人来」走；信标（听邻居；接待时也报自己）在总开关开着、接待或出门开了任一项时开着。
   * 不许出门了，在外的宠物直接回家。
   */
  async function syncVisit(): Promise<void> {
    const { enabled, hosting: hostingEnabled, visiting } = deps.appConfig().visit;
    if (!enabled) ctx.state.visitBroken = false;
    if (ctx.state.visitSwitching || ctx.state.visitBroken) return;
    const wantHost = enabled && hostingEnabled;
    const wantNeighborhood = enabled && (hostingEnabled || visiting);
    ctx.state.visitSwitching = true;
    try {
      if (ctx.state.trip && !(enabled && visiting)) await comeHome('called');
      if (wantHost && !ctx.state.visitHost) await openHost();
      if (!wantHost && ctx.state.visitHost) await closeHost();
      if (wantNeighborhood && !ctx.state.neighborhood) await openNeighborhood();
      if (!wantNeighborhood && ctx.state.neighborhood) {
        ctx.state.neighborhood.stop();
        ctx.state.neighborhood = null;
        log('串门：信标关了');
      }
    } finally {
      ctx.state.visitSwitching = false;
    }
  }

  async function openHost(): Promise<void> {
    const host = new VisitHost(hostHandlers, { log, identity: ctx.state.visitIdentity });
    try {
      ctx.state.hostPort = await host.listen();
    } catch (error) {
      ctx.state.visitBroken = true;
      log(`串门：接待端口开不了：${errorText(error)}`);
      return;
    }
    ctx.state.visitHost = host;
    log(`串门：接待开了，端口 ${ctx.state.hostPort}`);
  }

  /** 关接待：家里的客人窗口直接关掉（客人下次报平安时知道自己该回家了） */
  async function closeHost(): Promise<void> {
    if (ctx.state.hosting && ctx.state.hosting.openerTimer !== null) clearTimeout(ctx.state.hosting.openerTimer);
    ctx.state.hosting?.window.close(0);
    ctx.state.hosting = null;
    const host = ctx.state.visitHost;
    ctx.state.visitHost = null;
    await host?.close();
    log('串门：接待关了');
  }

  async function openNeighborhood(): Promise<void> {
    const hood = new Neighborhood({
      id: ctx.state.visitIdentity.id,
      // 不接待客人时只听不发：别人看不到自己，自己照样能出门
      announce: () => (ctx.state.visitHost ? { owner: nickname(), pet: petName(), port: ctx.state.hostPort } : null),
      log,
      // 端口与发往地址默认照常（BEACON_PORT + 每块网卡的广播地址）；测试里注入成随机的、不往外发
      ...(deps.beacon?.port !== undefined ? { port: deps.beacon.port } : {}),
      ...(deps.beacon?.targets ? { targets: deps.beacon.targets } : {}),
      // 设置页手动填的邻居：广播之外再单播一份（跨网段用），每次发送时现取，改了下一拍生效
      peers: () =>
        deps.appConfig().visit.peers.map((address) => ({ address, port: deps.beacon?.peerPort ?? BEACON_PORT })),
    });
    try {
      await hood.start();
    } catch (error) {
      ctx.state.visitBroken = true;
      log(`串门：信标端口开不了：${errorText(error)}`);
      return;
    }
    ctx.state.neighborhood = hood;
    log('串门：信标开了');
  }

  /** 串门的一句台词：开了「串门时用模型聊天」就按人设生成，没开用固定句 */
  function visitLine(instruction: string, fallback: string): Promise<string> {
    return deps.appConfig().visit.chat ? compose(instruction, fallback) : Promise.resolve(fallback);
  }

  /** 见面结束后给自己记一句摘要（不 await：可能正是从说话队列里被叫回来的）；生成不了就保留旧摘要 */
  function saveMemo(id: string, owner: string, pet: string, lines: readonly string[]): void {
    if (!deps.appConfig().visit.chat || spokenCount(lines) < 2) return;
    void compose(memoPrompt(owner, pet, lines), '')
      .then((text) => {
        const summary = cleanText(text, LINE_MAX);
        if (summary) neighbors.setSummary(id, summary);
      })
      .catch((error: unknown) => log(`串门：写见面摘要失败：${errorText(error)}`));
  }

  /** 接待这一侧：VisitHost 收到敲门、说话、告辞时来问这里 */
  const hostHandlers: HostHandlers = {
    canHost: () =>
      ctx.state.trip === null &&
      ctx.state.knockingOn === null &&
      !ctx.state.duelWait &&
      !ctx.state.duelAccepted &&
      !ctx.state.duel,
    knocked(visitor) {
      log(`串门：${visitor.owner}（${visitor.address}）家的 ${visitor.pet} 来敲门`);
      // 正在演一场（心魔 / 历练）：照常接待，先把这场快进结束——客人窗口要站在宠物旁边，不能让两只叠着
      skipTrial();
      // 历练小窗也收起：进度都在存档里，客人走了再从菜单接着走
      ctx.state.adventure?.suspend();
      closeAdventureShows(0);
      // 熟人 + 开了「直接请进」 + 主人在电脑前：不用主人点头（VisitHost.knock 调这里之前就挂好了 pending，同步让进是安全的）
      if (shouldAutoAdmit(neighbors, visitor, deps.appConfig().visit.autoAdmitFriends, tracker.snapshot()?.present)) {
        void say(`熟人 ${visitor.owner} 家的 ${visitor.pet} 来啦，直接请它进来～`);
        letIn(true);
        void refreshMenu();
        return;
      }
      // 没验证过身份、昵称却和某个熟人一样：多半是抄来的名字，说清楚让主人自己拿主意
      if (!visitor.id && neighbors.list().some((record) => record.friend && record.owner === visitor.owner)) {
        void say(`自称是 ${visitor.owner} 家的 ${visitor.pet}，可我没认出来，要让它进来吗？`);
      } else {
        void say(`${visitor.owner} 家的 ${visitor.pet} 来敲门啦，右键点「让 ${visitor.pet} 进来」请它进门～`);
      }
      void refreshMenu();
    },
    knockEnded(visitor, reason) {
      log(`串门：${visitor.owner} 家的 ${visitor.pet} ${reason === 'gone' ? '不等了' : '敲门没等到答复'}`);
      void refreshMenu();
    },
    async line(visitor, text) {
      const current = ctx.state.hosting?.visitor === visitor ? ctx.state.hosting : null;
      current?.window.say(text);
      const lines = current?.lines ?? [];
      lines.push(`${visitor.pet}：${text}`);
      if (current) current.lastLineAt = Date.now();
      const reply = cleanText(
        await visitLine(
          hostPrompt(visitor.owner, visitor.pet, lines, HOST_ASK.answer, current?.memory ?? null),
          '欢迎来玩呀～',
        ),
        LINE_MAX,
      );
      lines.push(`你：${reply}`);
      if (current) current.lastLineAt = Date.now();
      // 正在演一场（切磋）：回话不联动说话动画，别顶掉演出的动画
      await say(reply, ctx.state.battle || ctx.state.liveBattle ? { anim: false } : undefined);
      return reply;
    },
    note(visitor, text) {
      // 只收熟人的捎话：验过身份（有 id 才算验上）、是熟人、开着捎话，缺一样都不收
      if (!notesAllowed(neighbors, visitor.id, visitor.id !== undefined, deps.appConfig().visit.notes)) return false;
      log(`串门：${visitor.owner} 托 ${visitor.pet} 捎来一句话`);
      // 客人窗口的气泡里念出来，自家宠物不复述；原文不进提示词
      if (ctx.state.hosting?.visitor === visitor)
        ctx.state.hosting.window.say(`${visitor.owner} 托我带话：${text}`, NOTE_BUBBLE_MS);
      diary.note(Date.now(), 'visit', `${visitor.owner} 托 ${visitor.pet} 带来一句话`);
      return true;
    },
    // 切磋（X5）：协议层已验过模式、版本与名帖；关不关、忙不忙、认不认得客人在这边答。
    // 逐手局（X19）多一个 live：这边要在自己的出招面板里选自家方式
    spar(visitor, card, commit, live) {
      return hostSpar(visitor, card, commit, live);
    },
    reveal(visitor, nonce, line) {
      return hostReveal(visitor, nonce, line);
    },
    sparTurn(visitor, index, action, forfeit) {
      return sparTurn(visitor, index, action, forfeit);
    },
    // 隔空切磋（X15）：协议层已验过签名、模式、版本与名帖；关不关、忙不忙、主人答不答应在这边
    duel(visitor, card, commit, live) {
      return hostDuel(visitor, card, commit, live);
    },
    duelReveal(visitor, nonce, line) {
      hostDuelReveal(visitor, nonce, line);
    },
    duelTurn(visitor, index, action, forfeit) {
      return duelTurn(visitor, index, action, forfeit);
    },
    duelConceded(visitor, reason) {
      hostDuelConceded(visitor, reason);
    },
    left(visitor, reason, text) {
      seeGuestOff(
        visitor,
        text,
        reason === 'lost' ? `${visitor.pet} 突然不见了，可能回家了～` : `${visitor.pet} 回家啦，下次再来玩～`,
      );
    },
  };

  /** 主人答复敲门 */
  function letIn(accept: boolean): void {
    const visitor = ctx.state.visitHost?.answer(accept);
    if (!visitor) return;
    if (!accept) {
      void say(`好，那就不让 ${visitor.pet} 进来啦～`);
      return;
    }
    log(`串门：${visitor.owner} 家的 ${visitor.pet} 进门了`);
    // 刚打完一场、窗口还没收摊：立刻关掉——客人窗口和心魔窗口都按同一套位置规则摆在宠物旁边，叠着不像话
    closeTrial(0);
    const now = Date.now();
    // 进门时先把「记这次之前」的上次见面备忘算好，整趟都用它；再记这次见面（只记验证过身份的）
    const memory = visitor.id
      ? neighbors.meet(visitor.id, { owner: visitor.owner, pet: visitor.pet }, 'hosted', now)
      : null;
    const current: Hosting = {
      visitor,
      window: openGuestWindow(
        electron,
        `${new URL(deps.petBase).origin}/app/guest`,
        `${visitor.owner} 家的 ${visitor.pet}`,
        homePet.box,
        () => pokeGuest(current),
      ),
      since: now,
      lines: [],
      lastLineAt: now,
      openers: 0,
      memory,
      lastNudgeAt: 0,
      notesSent: 0,
      lastNoteAt: 0,
      openerTimer: null,
    };
    ctx.state.hosting = current;
    if (deps.appConfig().visit.chat) current.openerTimer = setTimeout(() => void openTopic(current), openerGap(true));
  }

  function sendGuestHome(options: GuestOffOptions = {}): void {
    const visitor = ctx.state.visitHost?.sendHome();
    if (visitor)
      seeGuestOff(visitor, options.farewell ?? '那我先回家啦～', `${visitor.pet} 回家啦～`, {
        wave: options.wave ?? true,
        floatAway: options.floatAway === true,
        closeMs: options.closeMs ?? 5_000,
      });
  }

  /** 送客：客人窗口说完告别的话、挥挥手再关，自家宠物说一句，记进日记 */
  function seeGuestOff(
    visitor: Visitor,
    farewell: string,
    line: string,
    options: { wave?: boolean; floatAway?: boolean; closeMs?: number } = {},
  ): void {
    const current = ctx.state.hosting;
    ctx.state.hosting = null;
    // 正在切磋（主人家这一侧）：收摊——账在亮随机数那一步就记过了，不会漏
    cancelSpar();
    if (current) {
      if (current.openerTimer !== null) clearTimeout(current.openerTimer);
      if (farewell) current.window.say(farewell);
      if (options.wave ?? true) current.window.wave();
      if (options.floatAway === true) current.window.floatAway(options.closeMs ?? 1_500);
      current.window.close(options.closeMs ?? 5_000);
    }
    log(`串门：${visitor.owner} 家的 ${visitor.pet} 走了`);
    diary.note(
      Date.now(),
      'visit',
      `${visitor.owner} 家的宠物 ${visitor.pet} 来串门，待了 ${durationText(Date.now() - (current?.since ?? Date.now()))}`,
    );
    if (visitor.id) {
      saveMemo(visitor.id, visitor.owner, visitor.pet, current?.lines ?? []);
      ctx.state.lastGuest = { id: visitor.id, at: Date.now() };
    }
    void say(line);
    void refreshMenu();
  }
  /** 出门：先敲门，对方主人点头了才进门 */
  async function goVisit(id: string): Promise<void> {
    const neighbor = ctx.state.neighborhood?.get(id);
    if (!neighbor) {
      await say('它好像已经不在附近了～');
      return;
    }
    if (
      ctx.state.trip ||
      ctx.state.knockingOn ||
      ctx.state.duel ||
      ctx.state.duelWait ||
      ctx.state.duelAccepted ||
      ctx.state.visitHost?.guest() ||
      ctx.state.visitHost?.knocking() ||
      !deps.appConfig().visit.visiting
    )
      return;
    // 出门前先收起历练小窗；正在打或者正在赶路时不能出门（进度在存档里，等这一趟走完再去）
    if (ctx.state.adventure && !ctx.state.adventure.beforeTrip()) {
      await say('这边正打着呢，等这一趟走完再去吧～');
      return;
    }
    ctx.state.knockingOn = neighbor;
    void refreshMenu();
    void say(`我去 ${neighbor.owner} 家敲门啦～`);
    let answer: KnockAnswer | null;
    try {
      answer = await knockOn(neighbor, { owner: nickname(), pet: petName() }, ctx.state.visitIdentity, neighbor.id);
    } catch (error) {
      // fetch 只说「fetch failed」，真正的原因（没授权本地网络时是 EHOSTUNREACH）在 cause 里
      const cause = (error as { cause?: unknown }).cause;
      log(
        `串门：敲 ${neighbor.owner}（${neighbor.address}）家的门失败：${errorText(error)}${cause ? `（${errorText(cause)}）` : ''}`,
      );
      answer = null;
    } finally {
      ctx.state.knockingOn = null;
    }
    if (!answer?.ok) {
      await say(knockFailText(neighbor.owner, answer ? answer.reason : 'unreachable'));
      return;
    }
    // 等答复期间关了串门 / 不许出门了 / 退出了：进门就告辞
    const { enabled, visiting } = deps.appConfig().visit;
    if (!enabled || !visiting || ctx.state.disposed) {
      void tripRequest(neighbor, '/v1/leave', { token: answer.token, text: '' }).catch(() => undefined);
      return;
    }
    startTrip(neighbor, answer.token, answer.verified);
  }

  /** @param verified 进门应答的签名验证过了：这一家确实是对着自己信标里那个 id 的门（T4 记邻居、T7 捎话以此为前提） */
  function startTrip(host: Neighbor, token: string, verified: boolean): void {
    // 进门时先把「记这次之前」的上次见面备忘算好，整趟都用它；再记这次见面（只记验证过身份的）
    const memory = verified
      ? neighbors.meet(host.id, { owner: host.owner, pet: host.pet }, 'visited', Date.now())
      : null;
    const current: Trip = {
      host,
      token,
      verified,
      memory,
      since: Date.now(),
      lines: [],
      lastLineAt: Date.now(),
      rounds: 0,
      answers: 0,
      treats: [],
      notesSent: 0,
      lastNoteAt: 0,
      queue: Promise.resolve(),
      failures: 0,
      pinging: false,
      talkTimer: null,
      pingTimer: setInterval(() => void pingTrip(current), PING_MS),
      pendingHome: null,
      farewell: false,
      farewellTimer: null,
    };
    ctx.state.trip = current;
    fadeHome(electron, AWAY_OPACITY);
    log(`串门：进了 ${host.owner} 家的门`);
    current.talkTimer = setTimeout(() => void talk(current), 3_000);
    void refreshStatus(Date.now());
    void refreshMenu();
  }

  /** 做客时自己开口：头一句打招呼，之后隔 30–90 秒接着聊（刚有人说过话就再等等），说满 tripRounds 句就只回不说 */

  /**
   * 回家：告辞（被请回、失联时不用）、恢复自家宠物、记日记、跟主人讲讲见闻。
   * 叫回家时**不等说话队列**：它可能正是从说话队列里被叫回来的（speak → say → comeHome），等就死锁了；
   * 只有到点回家（报平安的定时器里，不在队列里）才等模型生成告别的话。
   */
  async function comeHome(reason: HomeReason): Promise<void> {
    const current = ctx.state.trip;
    if (!current) return;
    ctx.state.trip = null;
    // 正在切磋（客人这一侧）：转播收摊，账在亮随机数那一步就记过了，不会漏
    cancelSpar();
    clearInterval(current.pingTimer);
    if (current.talkTimer !== null) clearTimeout(current.talkTimer);
    if (current.farewellTimer) clearTimeout(current.farewellTimer);
    current.farewellTimer = null;
    fadeHome(electron, 1);
    const { owner, pet } = current.host;
    log(`串门：从 ${owner} 家回来了（${reason}）`);
    if (reason === 'time-up' || reason === 'called') {
      const farewell =
        reason === 'time-up'
          ? cleanText(
              await visitLine(
                guestPrompt(owner, pet, current.lines, GUEST_ASK.farewell),
                `${pet}，我该回家啦，下次见～`,
              ),
              LINE_MAX,
            )
          : '家里叫我啦，先回去啦～';
      void tripRequest(current.host, '/v1/leave', { token: current.token, text: farewell }).catch((error: unknown) =>
        log(`串门：告辞没送到：${errorText(error)}`),
      );
    }
    const chats = current.lines.filter((line) => line.startsWith('你：')).length;
    // 送友风送回家（X16）：被对方送回来的用任务书那句；自己把对方送飘起来的，照实说一句
    const farewellEnding = current.farewellBySelf
      ? `，用送友风把 ${pet} 送得飘起来，告辞回家了`
      : `，被 ${pet} 的送友风送回家了`;
    const ending =
      reason === 'farewell'
        ? farewellEnding
        : reason === 'sent-home'
          ? '，被它家主人请回来了'
          : reason === 'lost'
            ? '，后来连不上就回来了'
            : '';
    const treats = current.treats.length > 0 ? `，吃到了${current.treats.join('、')}` : '';
    diary.note(Date.now(), 'visit', `去 ${owner} 家串门，和它家的宠物 ${pet} 聊了 ${chats} 句${treats}${ending}`);
    if (current.verified) saveMemo(current.host.id, owner, pet, current.lines);
    void refreshStatus(Date.now());
    void refreshMenu();
    const back = `我从 ${owner} 家回来啦～`;
    // 不用模型聊天：回家也只说固定的一句
    if (!deps.appConfig().visit.chat) {
      void say(back);
      return;
    }
    void speak(
      current.lines.length > 0
        ? travelPrompt(owner, pet, current.lines)
        : `你去 ${owner} 家串门，${HOME_WITHOUT_CHAT[reason]}。跟主人说一声。`,
      back,
    );
  }
  return { nickname, petName, syncVisit, closeHost, letIn, sendGuestHome, goVisit, visitLine, comeHome };
}

/** 这次见面聊过的句数（「（一起吃西瓜）」这类一起做过的事不算） */
function spokenCount(lines: readonly string[]): number {
  return lines.filter((line) => !line.startsWith('（')).length;
}

function knockFailText(owner: string, reason: KnockFailure | 'unreachable'): string {
  switch (reason) {
    case 'busy':
      return `${owner} 家现在不方便，下次再去吧～`;
    case 'too-soon':
      return `刚敲过 ${owner} 家的门，等会儿再去～`;
    case 'declined':
      return `${owner} 家没让我进门，呜～`;
    case 'no-answer':
      return `${owner} 家半天没人应门～`;
    case 'unreachable':
      return `连不上 ${owner} 家，看看系统设置里有没有允许 dsh-pet 访问本地网络～`;
  }
}
