/**
 * dev/visit-peer.mjs —— 假邻居（开发自测工具，不入 npm 包）：没有第二台电脑，也能让真 app 当主人家或当客人来测串门。
 *
 * host  扮演主人家：开一个接待监听，每 2 秒往 127.0.0.1:47340 发一条信标，真 app 开着串门时右键「串门」里
 *       就会出现「去 测试邻居 家」；app 来敲门时按 --accept 处理（auto 1 秒后让进，ask 等标准输入 y / n），
 *       客人说话回一句固定的话，敲门、说话、告辞这些事都打印出来。新版 app 会往发信标的源端口回一条，
 *       这个 socket 收到就打印「听到 X 家的信标（回发）」。隔空切磋（X15）按 --duel 处理（auto 自动应战，
 *       ask 等标准输入 y / n，no 一律不应战）。
 * listen 扮演只出门、不接待的新版本：每 2 秒往 127.0.0.1:47340 发一条探测（不带昵称、宠物名），
 *       打印收到的信标；发探测用的 socket 就是收信标的 socket，对方回发到源端口。
 * visit 扮演客人：往真 app 敲门进门（不给 --port 时，从 app.log 最后一条「串门：接待开了，端口 N」里读端口），
 *       进门后每 5 秒报一次平安，收到的事（它家宠物说话、摸一下、一起玩、请吃零食）都打印出来。
 * duel  扮演隔空切磋的挑战方（X15）：发探测等真 app 的信标（或给 --port 与 --host-id），签名发 /v1/duel，
 *       对方应战后亮随机数、打印结果。
 *
 * 用法（strip-types 与 test-register 的说明见 scripts/test-ts-resolver.mjs）：
 *   node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs host  [--owner 测试邻居] [--pet 小测] [--accept auto|ask] [--duel auto|ask|no] [--drop <轮号>] [--identity <路径>|none]
 *   node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs listen
 *   node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs visit [--port N] [--host-id <32位十六进制>] [--live] [--drop <轮号>] [--identity <路径>|none]
 *   node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs duel  [--port N] [--host-id <32位十六进制>] [--live] [--drop <轮号>] [--identity <路径>|none]
 *
 * --identity 给了路径才落盘（脚本与真 app 互相验明正身、日志里看 verified 用）；缺省在内存里生成，不写文件；
 *   --identity none 模拟旧版本，不签名。visit 模式签名需要主人家的 id（来自信标）：脚本连脚本自测时
 *   从 host 模式打印的「身份」里抄过来，用 --host-id 带上；不带 --host-id 就不签名（当旧版本客人）。
 *
 * host 的标准输入命令：line <话> / poke / play <项> / gift <项> / note <话>（捎给客人的主人）/ friend <y|n>（收不收客人的捎话，默认收）/ spar [live]（邀客人切磋，live = 同步轮）/ home（请客人回家）；ask 模式下 y / n 答复敲门，--duel ask 时 y / n 答复隔空切磋。
 * duel 不给 --port / --host-id 时往 127.0.0.1:47340 发一条探测，从回信标里读对方的身份 id 与接待端口（真 app 要开着接待）。
 * visit 的标准输入命令：say <话> / note <话>（捎给对方主人）/ spar [live]（主动切磋或手动应约）/ leave（告辞，后面可以带告别的话）。
 * 10 分钟后自动退出。一对一切磋用同一套固定配装，不读修炼存档：自动局两边各自算结果；同步轮双方先锁招再结算，
 * 脚本用和 app 一样的后备挑法出招，但不播放动画。--drop <轮号> 从 0 数，host 故意不回该轮，visit / duel 故意不发，供测试对面判掉线。
 */
import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { startLiveClient, startLiveServer } from '../../src/app/battle-live.ts';
import { SPAR_OPTIONS, sparFighter } from '../../src/app/spar-rules.ts';
import {
  BEACON_PORT,
  PING_MS,
  SPAR_LIVE_MODE,
  SPAR_MODE,
  TURN_WAIT_MS,
  VisitHost,
  encodeBeacon,
  encodeProbe,
  knockOn,
  parseBeacon,
  randomSparNonce,
  sendDuel,
  sendDuelReveal,
  sendDuelTurn,
  sendNote,
  sendReveal,
  sendSpar,
  sendSparTurn,
  sparCardOf,
  sparCommit,
  sparFight,
  sparLineRng,
  tripRequest,
} from '../../src/app/visit.ts';
import { generateVisitIdentity, loadVisitIdentity } from '../../src/app/visit-identity.ts';

const OWNER_DEFAULT = '测试邻居';
const PET_DEFAULT = '小测';
/** 客人说话时固定回的这一句 */
const REPLY = '欢迎欢迎，随便玩呀～';
const BEACON_MS = 2_000;
const AUTO_EXIT_MS = 10 * 60_000;
/** 真 app 的日志（接待端口从这里读） */
const LOG_PATH = join(homedir(), 'Library', 'Logs', 'dsh-pet', 'app.log');

const print = (message) => console.log(`[visit-peer] ${message}`);
const errorText = (error) => (error instanceof Error ? error.message : String(error));

const fixedCard = sparCardOf(sparFighter(PET_DEFAULT), 0);
const noop = () => {};
const silentSide = { play: noop, say: noop };
const silentShow = { self: silentSide, foe: silentSide, arena: noop, shoot: noop };
const shutdown = new AbortController();
const NOT_VISITING = { ok: false, reason: 'not-visiting' };

function exit(code) {
  shutdown.abort();
  process.exit(code);
}

function printFightResult(label, events, hostName, guestName) {
  const end = events?.at(-1);
  if (end?.kind !== 'end') {
    print(`${label}没打完，不算胜负`);
    return false;
  }
  const outcome = end.draw ? '平局' : `${end.winner === 0 ? hostName : guestName} 赢`;
  const detail = {
    ko: end.draw ? '双方同时倒下' : '打到分晓',
    timeout: '到轮数上限',
    forfeit: `${end.winner === 0 ? guestName : hostName} 认输`,
  }[end.reason];
  print(`${label}（${events.length} 个事件）：${outcome}${detail ? `，${detail}` : ''}`);
  return true;
}

function autoFight(hostName, guestName, guestNonce, hostNonce) {
  return sparFight(sparFighter(hostName), sparFighter(guestName), guestNonce, hostNonce);
}

// 主人 / 应战方总是引擎 0 号；随机数仍按「客人:主人」拼。
function liveOptions(hostName, guestName, guestNonce, hostNonce, local) {
  return {
    ...SPAR_OPTIONS,
    a: sparFighter(hostName),
    b: sparFighter(guestName),
    seed: `${guestNonce}:${hostNonce}`,
    local,
    show: silentShow,
    lineRng: sparLineRng(guestNonce, hostNonce),
    decide: async () => null,
    think: noop,
    log: print,
    waitMs: TURN_WAIT_MS,
  };
}

function skipShow(live) {
  const dispose = () => live.dispose();
  shutdown.signal.addEventListener('abort', dispose, { once: true });
  void live.done.then(() => {
    shutdown.signal.removeEventListener('abort', dispose);
    dispose();
  });
  live.skip();
  return live;
}

async function serveLiveTurn(match, visitor, index, action, forfeit, dropAt) {
  if (match?.visitor !== visitor) return NOT_VISITING;
  if (index !== dropAt) return match.live.turn(index, action, forfeit);
  print(`故意不回轮号 ${index} 的请求，等对面判掉线`);
  // 不把这一轮交给驱动，也不提前回错误；让生产请求先超时。
  await delay(TURN_WAIT_MS + 1_000, undefined, { signal: shutdown.signal, ref: false }).catch((error) => {
    if (!shutdown.signal.aborted) throw error;
  });
  return NOT_VISITING;
}

function startPeerClient(options, dropAt, sendTurn) {
  return skipShow(
    startLiveClient({
      ...options,
      async sendTurn(body, signal) {
        if (body.index !== dropAt) return sendTurn(body, signal);
        print(`故意不发轮号 ${body.index} 的请求，等对面判掉线`);
        return NOT_VISITING;
      },
    }),
  );
}

const USAGE = `用法：
  node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs host  [--owner 测试邻居] [--pet 小测] [--accept auto|ask] [--duel auto|ask|no] [--drop <轮号>] [--identity <路径>|none]
  node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs listen
  node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs visit [--port N] [--host-id <32位十六进制>] [--live] [--drop <轮号>] [--identity <路径>|none]
  node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/visit-peer.mjs duel  [--port N] [--host-id <32位十六进制>] [--live] [--drop <轮号>] [--identity <路径>|none]

同步轮：host 输入「spar live」邀客人切磋；visit 输入「spar live」或加 --live，duel 加 --live。
--drop <轮号> 从 0 数，host 故意不回该轮，visit / duel 故意不发，用来试对面判掉线。`;

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== 'host' && mode !== 'listen' && mode !== 'visit' && mode !== 'duel') return null;
  const options = {
    mode,
    owner: OWNER_DEFAULT,
    pet: PET_DEFAULT,
    accept: 'auto',
    duel: 'auto',
    port: 0,
    hostId: '',
    identity: '',
    // CLI 保留 --live；--drop 使用线上从 0 开始的轮号。
    live: false,
    drop: -1,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--owner' && value) {
      options.owner = value;
      i += 1;
    } else if (flag === '--pet' && value) {
      options.pet = value;
      i += 1;
    } else if (flag === '--accept' && (value === 'auto' || value === 'ask')) {
      options.accept = value;
      i += 1;
    } else if (flag === '--duel' && (value === 'auto' || value === 'ask' || value === 'no')) {
      options.duel = value;
      i += 1;
    } else if (flag === '--port' && /^\d+$/.test(value ?? '') && Number(value) >= 1 && Number(value) <= 65535) {
      options.port = Number(value);
      i += 1;
    } else if (flag === '--host-id' && /^[0-9a-f]{32}$/.test(value ?? '')) {
      options.hostId = value;
      i += 1;
    } else if (flag === '--identity' && value) {
      options.identity = value;
      i += 1;
    } else if (flag === '--live') {
      options.live = true;
    } else if (flag === '--drop' && /^\d+$/.test(value ?? '')) {
      options.drop = Number(value);
      i += 1;
    } else {
      return null;
    }
  }
  return options;
}

/** 本脚本的串门身份：--identity none 模拟旧版本（不签名）；给了路径才落盘，不给就在内存里生成一对（不留文件） */
function identityOf(options) {
  if (options.identity === 'none') return null;
  if (options.identity) {
    const identity = loadVisitIdentity(options.identity, (message) => print(`串门：${message}`));
    print(`身份 ${identity.id}（${options.identity}）`);
    return identity;
  }
  const identity = generateVisitIdentity();
  print(`身份 ${identity.id}（内存里，不写文件；要跨进程不变就用 --identity <路径>）`);
  return identity;
}

// ---------- host 模式 ----------

async function runHost(options) {
  const identity = identityOf(options);
  // 客人捎来的话收不收（收 = 模拟熟人；要测 not-friend 就 friend n）
  let friend = true;
  let pendingSpar = null;
  let pendingDuel = null;
  let answerDuel = null;
  const liveMatches = { spar: null, duel: null };

  function forgetGuestSpar(visitor) {
    if (pendingSpar?.visitor === visitor) pendingSpar = null;
    const match = liveMatches.spar;
    if (match?.visitor !== visitor) return;
    liveMatches.spar = null;
    match.live.dispose();
  }

  function startHostBattle(kind, visitor, guestNonce, hostNonce) {
    const live = skipShow(
      startLiveServer({
        ...liveOptions(options.pet, visitor.pet, guestNonce, hostNonce, 0),
        onEnd(receipt) {
          if (kind === 'spar') host.rememberSparEnd(visitor, hostNonce, receipt);
          else host.rememberDuelEnd(visitor, receipt);
        },
      }),
    );
    const match = { visitor, live };
    liveMatches[kind] = match;
    void live.done.then((events) => {
      if (liveMatches[kind] !== match) return;
      liveMatches[kind] = null;
      if (kind === 'duel') host.finishDuel(visitor);
      printFightResult(kind === 'spar' ? '同步轮' : '隔空同步轮', events, options.pet, visitor.pet);
    });
  }

  const host = new VisitHost(
    {
      canHost: () => true,
      knocked(visitor) {
        print(
          `${visitor.owner}（${visitor.address}）家的 ${visitor.pet} 来敲门${visitor.id ? `，verified（${visitor.id}）` : '，没验证上（当陌生人）'}`,
        );
        if (options.accept === 'auto') setTimeout(() => host.answer(true), 1_000);
        else print('等标准输入：y 让进 / n 不让进');
      },
      knockEnded(visitor, reason) {
        print(`${visitor.owner} 家的 ${visitor.pet} ${reason === 'gone' ? '不等答复，走了' : '敲门没等到答复'}`);
      },
      async line(visitor, text) {
        print(`${visitor.pet}：${text}`);
        return REPLY;
      },
      note(visitor, text) {
        if (!friend) {
          print(`${visitor.owner} 捎来一句话：${text}（friend n，没收）`);
          return false;
        }
        print(`${visitor.owner} 捎来一句话：${text}`);
        return true;
      },
      async spar(visitor, _card, commit, live) {
        if (liveMatches.spar) return { ok: false, reason: 'busy' };
        const hostNonce = randomSparNonce();
        pendingSpar = { visitor, commit, hostNonce, live };
        print(`${visitor.pet} 来切磋（${live ? '同步轮' : '自动'}），承诺收下`);
        return { ok: true, card: fixedCard, nonce: hostNonce };
      },
      async reveal(visitor, nonce, line) {
        const pending = pendingSpar;
        if (pending?.visitor !== visitor) return { ok: false, reason: 'late' };
        pendingSpar = null;
        if (sparCommit(nonce) !== pending.commit) {
          print(`${visitor.pet} 亮的随机数对不上，按它认输记`);
          return { ok: false, reason: 'mismatch' };
        }
        if (pending.live) {
          startHostBattle('spar', visitor, nonce, pending.hostNonce);
          print(`${visitor.pet} 亮了随机数，开始同步轮（这边按后备挑法出）`);
        } else {
          const events = autoFight(options.pet, visitor.pet, nonce, pending.hostNonce);
          printFightResult('自动切磋', events, options.pet, visitor.pet);
        }
        if (line) print(`它家宠物的赛后感言：${line}`);
        return { ok: true };
      },
      sparTurn(visitor, index, action, forfeit) {
        return serveLiveTurn(liveMatches.spar, visitor, index, action, forfeit, options.drop);
      },
      async duel(visitor, _card, _commit, live) {
        print(`${visitor.owner} 家的 ${visitor.pet} 来隔空切磋（${live ? '同步轮' : '自动'}）`);
        if (options.duel === 'no') {
          print('不应战（--duel no）');
          return { ok: false, reason: 'declined' };
        }
        const acceptDuel = () => {
          const hostNonce = randomSparNonce();
          pendingDuel = { visitor, hostNonce, live };
          return { ok: true, card: fixedCard, nonce: hostNonce };
        };
        if (options.duel === 'auto') {
          print(live ? '自动应战（同步轮，这边按后备挑法出）' : '自动应战');
          return acceptDuel();
        }
        print('等标准输入：y 应战 / n 不应战');
        return new Promise((resolve) => {
          answerDuel = (accept) => {
            answerDuel = null;
            print(`${accept ? '应战' : '不应战'} ${visitor.pet}`);
            resolve(accept ? acceptDuel() : { ok: false, reason: 'declined' });
          };
        });
      },
      duelReveal(visitor, nonce, line) {
        // VisitHost 已核过承诺，这里只取回这一场的状态。
        const pending = pendingDuel;
        if (pending?.visitor !== visitor) return;
        pendingDuel = null;
        if (pending.live) {
          try {
            startHostBattle('duel', visitor, nonce, pending.hostNonce);
          } catch (error) {
            host.finishDuel(visitor);
            throw error;
          }
          print(`${visitor.pet} 亮了随机数，开始隔空同步轮（这边按后备挑法出）`);
        } else {
          const events = autoFight(options.pet, visitor.pet, nonce, pending.hostNonce);
          printFightResult('隔空自动切磋', events, options.pet, visitor.pet);
        }
        if (line) print(`它家宠物的赛后感言：${line}`);
      },
      duelTurn(visitor, index, action, forfeit) {
        return serveLiveTurn(liveMatches.duel, visitor, index, action, forfeit, options.drop);
      },
      duelConceded(visitor, reason) {
        if (pendingDuel?.visitor === visitor) pendingDuel = null;
        print(`${visitor.pet} ${reason === 'late' ? '没按时亮随机数' : '随机数没对上'}，按它认输记`);
      },
      left(visitor, reason, text) {
        forgetGuestSpar(visitor);
        print(`${visitor.pet} ${reason === 'leave' ? `告辞：${text || '（没说话）'}` : '太久没动静，当它走了'}`);
      },
    },
    { log: (message) => print(message), identity },
  );
  const port = await host.listen('127.0.0.1');
  print(`接待开了，端口 ${port}`);
  print(`信标每 ${BEACON_MS / 1000} 秒发往 127.0.0.1:${BEACON_PORT}（owner=${options.owner}，pet=${options.pet}）`);

  // 信标只发不收：真 app 在 BEACON_PORT 上听；那边没开串门也没关系，UDP 发出去就不管了。
  // 新版 app 会往发信标的源端口回发一条，这个 socket 顺便打印出来（真机看回发用）
  const beacon = createSocket({ type: 'udp4' });
  beacon.on('error', () => {});
  beacon.on('message', (raw) => {
    const heard = parseBeacon(raw);
    if (heard) print(`听到 ${heard.owner} 家的信标（回发）`);
  });
  const payload = encodeBeacon({
    id: identity ? identity.id : randomUUID(),
    owner: options.owner,
    pet: options.pet,
    port,
  });
  const sendBeacon = () => beacon.send(payload, BEACON_PORT, '127.0.0.1', () => {});
  sendBeacon();
  setInterval(sendBeacon, BEACON_MS);

  createInterface({ input: process.stdin }).on('line', (raw) => {
    const input = raw.trim();
    const command = input.split(/\s+/)[0];
    const text = input.slice(command.length).trim();
    if (command === 'y' || command === 'n') {
      if (answerDuel) {
        answerDuel(command === 'y');
        return;
      }
      const visitor = host.answer(command === 'y');
      print(visitor ? (command === 'y' ? `让 ${visitor.pet} 进来了` : `没让 ${visitor.pet} 进来`) : '没有人在敲门');
      return;
    }
    switch (command) {
      case 'line':
        if (!text) {
          print('用法：line <话>');
          return;
        }
        print(host.tell({ type: 'line', text }) ? `捎给客人：${text}` : '没有客人在，捎不出去');
        return;
      case 'poke':
        print(host.tell({ type: 'poke' }) ? '捎给客人：主人摸了它一下' : '没有客人在，捎不出去');
        return;
      case 'play':
      case 'gift': {
        if (!text) {
          print(`用法：${command} <项>`);
          return;
        }
        const sent = host.tell(command === 'play' ? { type: 'play', what: text } : { type: 'gift', what: text });
        print(sent ? `捎给客人：${command === 'play' ? '一起' : '请它吃'}${text}` : '没有客人在，捎不出去');
        return;
      }
      case 'note': {
        if (!text) {
          print('用法：note <话>');
          return;
        }
        print(host.tell({ type: 'note', text }) ? `托客人捎话给它的主人：${text}` : '没有客人在，捎不出去');
        return;
      }
      case 'friend': {
        if (text !== 'y' && text !== 'n') {
          print('用法：friend <y|n>（收不收客人的捎话，默认 y）');
          return;
        }
        friend = text === 'y';
        print(friend ? '客人的捎话按熟人收' : '客人的捎话一律拒收（not-friend）');
        return;
      }
      case 'spar': {
        const live = text === 'live';
        const sent = host.tell(live ? { type: 'spar-invite', mode: SPAR_LIVE_MODE } : { type: 'spar-invite' });
        print(
          sent
            ? live
              ? `邀客人同步切磋：它应战就会发 /v1/spar（mode: ${SPAR_LIVE_MODE}）来`
              : '邀客人切磋：它应战就会发 /v1/spar 来'
            : '没有客人在，邀不了',
        );
        return;
      }
      case 'home': {
        const visitor = host.sendHome();
        if (visitor) forgetGuestSpar(visitor);
        print(visitor ? `请 ${visitor.pet} 回家了` : '没有客人在');
        return;
      }
      default:
        if (input) {
          print(
            `不认识的命令：${command}（line / poke / play / gift / note / friend / spar / home${options.accept === 'ask' || options.duel === 'ask' ? ' / y / n' : ''}）`,
          );
        }
    }
  });
}

// ---------- listen 模式 ----------

/** 扮演只出门、不接待的新版本：只往真 app 的 47340 发探测，等对方回信标 */
async function runListen() {
  const socket = createSocket({ type: 'udp4' });
  socket.on('error', (error) => print(`信标出错：${errorText(error)}`));
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve();
    });
  });
  socket.on('message', (raw) => {
    const heard = parseBeacon(raw);
    if (heard) print(`听到 ${heard.owner} 家的 ${heard.pet}（接待端口 ${heard.port}）`);
  });
  print(`只出门、不接待：每 ${BEACON_MS / 1000} 秒往 127.0.0.1:${BEACON_PORT} 发探测，等对方回信标`);
  const probe = encodeProbe();
  const sendProbe = () => socket.send(probe, BEACON_PORT, '127.0.0.1', () => {});
  sendProbe();
  setInterval(sendProbe, BEACON_MS);
}

// ---------- visit 模式 ----------

/** app.log 最后一条「串门：接待开了，端口 N」里的端口；读不到 null */
function hostPortFromLog() {
  let text;
  try {
    // 只读文件末尾一段：日志会越长越大，接待端口基本都在最近
    const fd = openSync(LOG_PATH, 'r');
    try {
      const { size } = fstatSync(fd);
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const found = [...text.matchAll(/串门：接待开了，端口 (\d+)/g)].at(-1);
  return found ? Number(found[1]) : null;
}

function printEvent(event) {
  if (event.type === 'line') print(`它家宠物说：${event.text}`);
  else if (event.type === 'note') print(`它家宠物带回它主人的话：${event.text}`);
  else if (event.type === 'poke') print('它家主人摸了你一下');
  else if (event.type === 'play') print(`它家请你一起玩：${event.what}`);
  else if (event.type === 'spar-invite')
    print(`它家邀你切磋（脚本不自动应战，输 spar${event.mode === SPAR_LIVE_MODE ? ' live' : ''} 应战）`);
  else print(`它家请你吃：${event.what}`);
}

/** 被请回家 / 不被当客人了：都该走了 */
const HOME_REASONS = { 'sent-home': '被请回家了', 'not-visiting': '那边已经不当我是客人了' };
/** 捎话没捎成的结果 */
const NOTE_FAIL_REASONS = {
  'not-friend': '对方没把我们当熟人',
  'too-many': '发太多了',
  'sent-home': '已经回家了',
  'not-visiting': '那边已经不当我是客人了',
  'old-host': '对方的版本太旧，没有捎话这个功能',
};

async function runVisit(options) {
  const identity = identityOf(options);
  let port = options.port;
  if (!port) {
    port = hostPortFromLog();
    if (!port) {
      print(`没给 --port，${LOG_PATH} 里也读不到「串门：接待开了，端口 N」`);
      exit(1);
    }
    print(`从 app.log 读到接待端口 ${port}`);
  }
  if (identity && !options.hostId) print('没给 --host-id：当旧版本客人，不签名');
  const host = { address: '127.0.0.1', port };
  print(`敲 ${host.address}:${port} 的门（${options.owner} 家的 ${options.pet}）……`);
  const answer = await knockOn(
    host,
    { owner: options.owner, pet: options.pet },
    identity,
    options.hostId || null,
  ).catch((error) => {
    print(`敲门失败：${errorText(error)}`);
    exit(1);
  });
  if (!answer.ok) {
    print(`敲门没成：${answer.reason}`);
    exit(1);
  }
  const token = answer.token;
  print(
    `进门啦（${answer.verified ? 'verified：主人家的签名对上了' : '没认出主人家（旧对端或签名不对）'}）；say <话> 说话，leave 告辞`,
  );

  let sparInFlight = false;
  async function sparWithHost(live) {
    const ownNonce = randomSparNonce();
    const reply = await sendSpar(host, {
      token,
      mode: live ? SPAR_LIVE_MODE : SPAR_MODE,
      card: fixedCard,
      commit: sparCommit(ownNonce),
    }).catch((error) => ({ ok: false, reason: errorText(error) }));
    if (!reply.ok) {
      print(`没打成：${reply.reason}`);
      return;
    }
    const hostName = '主人家的宠物';
    print(`主人家应战（${live ? '同步轮' : '自动'}）`);
    if (!live) {
      const events = autoFight(hostName, options.pet, ownNonce, reply.nonce);
      printFightResult('两边各自算的这场', events, hostName, options.pet);
    }
    const revealed = await sendReveal(host, {
      token,
      ...(live ? { match: reply.nonce } : {}),
      nonce: ownNonce,
      line: live ? '' : '承让承让～',
    }).catch((error) => ({ ok: false, reason: errorText(error) }));
    if (!revealed.ok) {
      print(`没亮成：${revealed.reason}`);
      return;
    }
    if (!live) {
      print('亮了随机数，主人家的屏幕上该开演了');
      return;
    }
    print('亮了随机数，同步轮开始（这边按后备挑法出）');
    const match = startPeerClient(
      liveOptions(hostName, options.pet, ownNonce, reply.nonce, 1),
      options.drop,
      (body, signal) => sendSparTurn(host, { token, match: reply.nonce, ...body }, signal),
    );
    printFightResult('同步轮', await match.done, hostName, options.pet);
  }

  // 每 5 秒报一次平安，打印主人家捎来的事；连着 3 次送不到（跟真 app 一样）就当失联，回家
  let pingFailures = 0;
  setInterval(() => {
    void tripRequest(host, '/v1/ping', { token })
      .then((result) => {
        pingFailures = 0;
        if (!result.ok) {
          print(`该回家了：${HOME_REASONS[result.reason] ?? result.reason}`);
          exit(0);
        }
        for (const event of result.events) printEvent(event);
      })
      .catch((error) => {
        pingFailures += 1;
        print(`报平安失败（${pingFailures}）：${errorText(error)}`);
        if (pingFailures >= 3) {
          print('和主人家连不上了，回家');
          exit(0);
        }
      });
  }, PING_MS);

  createInterface({ input: process.stdin }).on('line', (raw) => {
    const input = raw.trim();
    const command = input.split(/\s+/)[0];
    const text = input.slice(command.length).trim();
    if (command !== 'say' && command !== 'note' && command !== 'spar' && command !== 'leave') {
      if (input) print(`不认识的命令：${command}（say / note / spar [live] / leave）`);
      return;
    }
    if (command !== 'leave' && command !== 'spar' && !text) {
      print(`用法：${command} <话>`);
      return;
    }
    if (command === 'spar') {
      if (sparInFlight) {
        print('上一场切磋还没结束');
        return;
      }
      sparInFlight = true;
      void sparWithHost(options.live || text === 'live')
        .catch((error) => print(`切磋中断：${errorText(error)}`))
        .finally(() => {
          sparInFlight = false;
        });
      return;
    }
    if (command === 'note') {
      void sendNote(host, { token, text })
        .then((result) => print(result.ok ? '捎到啦' : `没捎成：${NOTE_FAIL_REASONS[result.reason] ?? result.reason}`))
        .catch((error) => print(`没送到：${errorText(error)}`));
      return;
    }
    void tripRequest(host, command === 'say' ? '/v1/chat' : '/v1/leave', { token, text })
      .then((result) => {
        if (command === 'leave') {
          print(result.ok ? '告辞了' : `告辞没成：${result.reason}`);
          exit(0);
          return;
        }
        if (!result.ok) {
          print(`说不了话，${HOME_REASONS[result.reason] ?? result.reason}`);
          exit(0);
          return;
        }
        print(`它家宠物回：${result.reply || '……'}`);
        for (const event of result.events) printEvent(event);
      })
      .catch((error) => print(`没送到：${errorText(error)}`));
  });
}

// ---------- duel 模式（X15，扮挑战方） ----------

/** 往 127.0.0.1:47340 发一条探测，等对方回信标：拿到身份 id 与接待端口；3 秒没等到返回 null */
async function discoverHost() {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // 已经关了
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 3_000);
    socket.on('error', () => finish(null));
    socket.bind(0, '127.0.0.1', () => {
      socket.on('message', (raw) => {
        const heard = parseBeacon(raw);
        if (heard)
          finish({ address: '127.0.0.1', port: heard.port, hostId: heard.id, owner: heard.owner, pet: heard.pet });
      });
      socket.send(encodeProbe(), BEACON_PORT, '127.0.0.1', () => {});
    });
  });
}

async function runDuel(options) {
  const identity = identityOf(options);
  if (!identity) {
    print('duel 模式要签名，不能用 --identity none');
    return 1;
  }
  let target;
  if (options.port && options.hostId) {
    target = { address: '127.0.0.1', port: options.port, hostId: options.hostId, owner: '', pet: '' };
  } else {
    print('发探测找附近的桌宠（真 app 要开着「允许别人来我家做客」）……');
    target = await discoverHost();
  }
  if (!target) {
    print('没等到信标：开真 app 的接待，或者用 --port 与 --host-id 指定（host 模式会打印身份 id）');
    return 1;
  }
  const targetLabel = target.pet || '对方';
  print(
    `挑战 ${target.owner ? `${target.owner} 家的 ` : ''}${targetLabel}（${target.address}:${target.port}，id ${target.hostId}）${
      options.live ? '，同步轮' : ''
    }……`,
  );
  const hostAddress = { address: target.address, port: target.port };
  const ownNonce = randomSparNonce();
  let reply;
  try {
    reply = await sendDuel(hostAddress, target.hostId, { owner: options.owner, pet: options.pet }, identity, {
      mode: options.live ? SPAR_LIVE_MODE : SPAR_MODE,
      card: fixedCard,
      commit: sparCommit(ownNonce),
    });
  } catch (error) {
    print(`挑战没送到：${errorText(error)}`);
    return 1;
  }
  if (!reply.ok) {
    print(`没打成：${reply.reason}${reply.reason === 'old-host' ? '（对方的桌宠还不会隔空切磋）' : ''}`);
    return 1;
  }
  print(`对方应战（${options.live ? '同步轮' : '自动'}）`);
  if (!options.live) {
    const events = autoFight(targetLabel, options.pet, ownNonce, reply.nonce);
    printFightResult('两边各自算的这场', events, targetLabel, options.pet);
  }
  const revealed = await sendDuelReveal(hostAddress, {
    token: reply.token,
    nonce: ownNonce,
    line: options.live ? '' : '承让承让～',
  }).catch((error) => ({ ok: false, reason: errorText(error) }));
  if (!revealed.ok) {
    print(`没亮成：${revealed.reason}`);
    return 1;
  }
  if (!options.live) {
    print('亮了随机数，对方的屏幕上该开演了');
    return 0;
  }
  print('亮了随机数，隔空同步轮开始（这边按后备挑法出）');
  const match = startPeerClient(
    liveOptions(targetLabel, options.pet, ownNonce, reply.nonce, 1),
    options.drop,
    (body, signal) => sendDuelTurn(hostAddress, { token: reply.token, ...body }, signal),
  );
  return printFightResult('隔空同步轮', await match.done, targetLabel, options.pet) ? 0 : 1;
}

// ---------- 入口 ----------

const options = parseArgs(process.argv.slice(2));
if (!options) {
  console.error(USAGE);
  exit(1);
}
process.once('SIGINT', () => exit(0));
setTimeout(() => {
  print('10 分钟到了，自动退出');
  exit(0);
}, AUTO_EXIT_MS).unref();
try {
  if (options.mode === 'host') await runHost(options);
  else if (options.mode === 'listen') await runListen();
  else if (options.mode === 'duel') process.exitCode = await runDuel(options);
  else await runVisit(options);
} catch (error) {
  print(`跑不起来：${errorText(error)}`);
  exit(1);
}
