import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  broadcastAddresses,
  cardFighter,
  cleanText,
  encodeBeacon,
  encodeProbe,
  isLanAddress,
  isPeerAddress,
  isProbe,
  isSparNonce,
  knockOn,
  Neighborhood,
  parseBeacon,
  parseEvents,
  parseSparAction,
  parseSparCard,
  parseTurnIndex,
  PING_MS,
  randomSparNonce,
  sendDuel,
  sendDuelReveal,
  sendDuelTurn,
  sendNote,
  sendReveal,
  sendSpar,
  sendSparTurn,
  SPAR_LIVE_MODE,
  shouldReply,
  sparCardOf,
  sparCommit,
  sparFight,
  sparLineRng,
  SPAR_MODE,
  tripRequest,
  VisitHost,
} from './visit.ts';
import type { Beacon, DuelAnswer, HostHandlers, SparCard, Visitor } from './visit.ts';
import { BATTLE_VERSION, SKILL_IDS, WEAPON_IDS, rngFrom } from './battle.ts';
import type { Fighter, SkillId, WeaponId } from './battle.ts';
import { startLiveClient, startLiveServer } from './battle-live.ts';
import type { LiveVersus } from './battle-live.ts';
import { swapSides, timeline } from './battle-show.ts';
import type { ShowSides } from './battle-show.ts';
import { duelMessage, generateVisitIdentity, knockMessage, welcomeMessage } from './visit-identity.ts';
import type { VisitIdentity } from './visit-identity.ts';

const me = { owner: '小王', pet: '小鱼' };

/** 等一会儿（测试里的 UDP 往返） */
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 等条件成立，超时就断言失败 */
async function waitUntil(check: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check() && Date.now() < end) await delay(10);
  assert.ok(check(), `等待超时 ${what}`);
}

test('cleanText drops control and bidi characters, squeezes spaces, and cuts by characters', () => {
  assert.equal(cleanText('  你好\n\t世界\u202e反过来\u0000 ', 60), '你好 世界 反过来');
  assert.equal(cleanText('一二三四五六七八九十十一十二', 12), '一二三四五六七八九十十一');
  assert.equal(cleanText('😀😀😀', 2), '😀😀');
  assert.equal(cleanText(42, 12), '');
  assert.equal(cleanText('\u200b\n', 12), '');
});

test('beacons round-trip, and anything that is not ours or is malformed is ignored', () => {
  const beacon: Beacon = { id: 'abcdef0123456789', owner: '小王\n', pet: '小鱼', port: 51234 };
  assert.deepEqual(parseBeacon(encodeBeacon(beacon)), { ...beacon, owner: '小王' });
  const raw = (value: unknown) => Buffer.from(JSON.stringify(value));
  const base = { app: 'dsh-pet', v: 1, id: 'abcdef0123456789', owner: '小王', pet: '小鱼', port: 51234 };
  assert.equal(parseBeacon(raw({ ...base, app: 'other' })), null);
  assert.equal(parseBeacon(raw({ ...base, v: 2 })), null);
  assert.equal(parseBeacon(raw({ ...base, port: 70000 })), null);
  assert.equal(parseBeacon(raw({ ...base, owner: '\u0000' })), null);
  assert.equal(parseBeacon(raw({ ...base, pet: 'x'.repeat(600) })), null); // 超过一条信标的大小
  assert.equal(parseBeacon(Buffer.from('not json')), null);
  assert.equal(parseBeacon(raw({ ...base, owner: '一二三四五六七八九十十一十二' }))?.owner, '一二三四五六七八九十十一');
  // 名字要拼进右键菜单项：半角「/」会被当成子菜单分隔，换成全角
  assert.equal(parseBeacon(raw({ ...base, owner: '小/王', pet: 'a/b' }))?.pet, 'a／b');
});

test('broadcast addresses: one per LAN interface, skipping loopback, IPv6 and point-to-point tunnels', () => {
  const iface = (address: string, netmask: string, extra: Partial<NetworkInterfaceInfo> = {}) =>
    ({ address, netmask, family: 'IPv4', internal: false, mac: '', cidr: null, ...extra }) as NetworkInterfaceInfo;
  assert.deepEqual(
    broadcastAddresses({
      lo0: [iface('127.0.0.1', '255.0.0.0', { internal: true })],
      en0: [
        iface('192.168.1.23', '255.255.255.0'),
        {
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6',
          internal: false,
        } as NetworkInterfaceInfo,
      ],
      en7: [iface('10.0.5.7', '255.255.0.0')],
      bridge0: [iface('192.168.1.40', '255.255.255.0')], // 同一网段：只发一次
      utun4: [iface('100.101.102.103', '255.255.255.255')],
    }),
    ['192.168.1.255', '10.0.255.255'],
  );
});

test('only private, link-local, CGNAT and loopback addresses count as the LAN', () => {
  for (const address of [
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.9',
    '169.254.3.4',
    '100.64.0.1',
    '127.0.0.1',
    '::ffff:192.168.1.2',
    '::1',
  ]) {
    assert.equal(isLanAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '', undefined]) {
    assert.equal(isLanAddress(address), false, String(address));
  }
});

test('manual peers must be dotted LAN IPv4 addresses', () => {
  for (const address of ['10.1.2.3', '172.16.0.1', '192.168.11.23', '100.64.0.1', '127.0.0.1']) {
    assert.equal(isPeerAddress(address), true, address);
  }
  for (const address of [
    '8.8.8.8',
    '1.1.1.1',
    '256.1.1.1',
    '192.168.1.256',
    ' 192.168.1.2',
    '192.168.1.2 ',
    '192.168.1',
    '192.168.1.2.3',
    '010.1.1.1',
    '192.168.01.2',
    '::1',
    'fe80::1',
    'localhost',
    'example.com',
    '',
    '192.168.1.-1',
  ]) {
    assert.equal(isPeerAddress(address), false, JSON.stringify(address));
  }
});

test('a reply is only due for LAN addresses that our own broadcast cannot reach', () => {
  const iface = (address: string, netmask: string, extra: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo =>
    ({ address, netmask, family: 'IPv4', internal: false, mac: '', cidr: null, ...extra }) as NetworkInterfaceInfo;
  const interfaces = {
    lo0: [iface('127.0.0.1', '255.0.0.0', { internal: true })],
    en0: [iface('192.168.1.23', '255.255.255.0')],
    en1: [iface('10.0.5.7', '255.255.0.0')],
    utun4: [iface('100.101.102.103', '255.255.255.255')],
  };
  // 本网段的邻居已经被广播覆盖，不用回发
  assert.equal(shouldReply('192.168.1.99', interfaces), false);
  assert.equal(shouldReply('10.0.9.9', interfaces), false);
  // 别的局域网段：回发
  assert.equal(shouldReply('192.168.11.23', interfaces), true);
  assert.equal(shouldReply('10.1.2.3', interfaces), true);
  // 公网：不回
  assert.equal(shouldReply('8.8.8.8', interfaces), false);
  // 只有 /32 的 Tailscale 网卡不算覆盖，本机和回环都要回发
  assert.equal(shouldReply('100.101.102.104', interfaces), true);
  assert.equal(shouldReply('127.0.0.1', interfaces), true);
});

test('a probe is not a beacon: old versions drop it, and isProbe only knows probes', () => {
  assert.equal(parseBeacon(encodeProbe()), null);
  assert.equal(isProbe(encodeProbe()), true);
  assert.equal(
    isProbe(
      Buffer.from(JSON.stringify({ app: 'dsh-pet', v: 1, id: 'a'.repeat(16), owner: '小王', pet: '小鱼', port: 1 })),
    ),
    false,
  );
  assert.equal(isProbe(Buffer.from('junk')), false);
  assert.equal(isProbe(Buffer.from(JSON.stringify({ app: 'dsh-pet', v: 1, probe: 'yes' }))), false);
  assert.equal(isProbe(Buffer.from(JSON.stringify({ app: 'dsh-pet', v: 2, probe: true }))), false);
  assert.equal(isProbe(Buffer.from('x'.repeat(600))), false);
});

test('manual peers are appended to the broadcast targets, not replacing them', async () => {
  const logs: string[] = [];
  const b = new Neighborhood({
    id: 'bbbbbbbb-other',
    announce: () => ({ owner: '小李', pet: '阿花', port: 2222 }),
    log: (m) => logs.push(m),
    port: 0,
    targets: () => [],
    intervalMs: 100,
  });
  const a = new Neighborhood({
    id: 'aaaaaaaa-self',
    announce: () => ({ owner: '小王', pet: '小鱼', port: 1111 }),
    log: (m) => logs.push(m),
    port: 0,
    targets: () => [],
    peers: () => [{ address: '127.0.0.1', port: b.port() }],
    intervalMs: 100,
  });
  try {
    await b.start();
    await a.start();
    // targets 是空的，照样靠 peers 让 b 听见 a：peers 是追加，不是替换
    await waitUntil(() => b.list().some((neighbor) => neighbor.id === 'aaaaaaaa-self'), 'b 听到手动填的 a');
    assert.deepEqual(logs, []);
  } finally {
    a.stop();
    b.stop();
  }
});

test('a new manual peer gets a beacon back right away, without waiting for the next interval', async () => {
  const b = new Neighborhood({
    id: 'bbbbbbbb-other',
    announce: () => ({ owner: '小李', pet: '阿花', port: 2222 }),
    log: () => undefined,
    port: 0,
    targets: () => [],
    // 周期足够长：这一拍只有「新地址立刻回一条」能送到
    intervalMs: 60_000,
  });
  const a = new Neighborhood({
    id: 'aaaaaaaa-self',
    announce: () => ({ owner: '小王', pet: '小鱼', port: 1111 }),
    log: () => undefined,
    port: 0,
    targets: () => [],
    peers: () => [{ address: '127.0.0.1', port: b.port() }],
    intervalMs: 60_000,
  });
  try {
    await b.start();
    await a.start();
    await waitUntil(() => a.list().some((neighbor) => neighbor.id === 'bbbbbbbb-other'), 'a 立刻看到 b', 1_000);
  } finally {
    a.stop();
    b.stop();
  }
});

test('a listener that does not host probes its manual peers, sees them, and stays invisible itself', async () => {
  const b = new Neighborhood({
    id: 'bbbbbbbb-other',
    announce: () => ({ owner: '小李', pet: '阿花', port: 2222 }),
    log: () => undefined,
    port: 0,
    targets: () => [],
    intervalMs: 60_000,
  });
  const a = new Neighborhood({
    id: 'aaaaaaaa-self',
    announce: () => null,
    log: () => undefined,
    port: 0,
    targets: () => [],
    peers: () => [{ address: '127.0.0.1', port: b.port() }],
    intervalMs: 60_000,
  });
  try {
    await b.start();
    await a.start();
    await waitUntil(() => a.list().some((neighbor) => neighbor.id === 'bbbbbbbb-other'), 'a 收到 b 的回发');
    // 探测不进邻居列表：b 看不到不接待的 a
    await delay(100);
    assert.deepEqual(b.list(), []);
  } finally {
    a.stop();
    b.stop();
  }
});

test('a reply address expires: no more beacons after NEIGHBOR_TTL_MS without hearing from it again', async () => {
  let clock = 1_000_000;
  const logs: string[] = [];
  const b = new Neighborhood({
    id: 'bbbbbbbb-other',
    announce: () => ({ owner: '小李', pet: '阿花', port: 2222 }),
    log: (m) => logs.push(m),
    port: 0,
    targets: () => [],
    intervalMs: 20,
    now: () => clock,
  });
  const listener = createSocket('udp4');
  let heard = 0;
  listener.on('message', () => (heard += 1));
  await new Promise<void>((done) => listener.bind(0, '127.0.0.1', done));
  try {
    await b.start();
    listener.send(encodeProbe(), b.port(), '127.0.0.1', () => {});
    // 探测到了：立刻回一条，之后每拍也发
    await waitUntil(() => heard > 0, '收到回发');
    clock += 20_001;
    await delay(100); // 让过期后的几拍都跑完
    heard = 0;
    await delay(120);
    assert.equal(heard, 0, '回发名单过期后不再给它发');
    assert.deepEqual(logs, []);
  } finally {
    listener.close();
    b.stop();
  }
});

test('the reply list keeps at most 32 addresses, dropping the one heard from longest ago', async () => {
  let clock = 1_000_000;
  const b = new Neighborhood({
    id: 'bbbbbbbb-other',
    announce: () => ({ owner: '小李', pet: '阿花', port: 2222 }),
    log: () => undefined,
    port: 0,
    targets: () => [],
    intervalMs: 20,
    now: () => clock,
  });
  const senders = Array.from({ length: 33 }, () => createSocket('udp4'));
  const heard = new Array<number>(33).fill(0);
  senders.forEach((sender, index) => sender.on('message', () => (heard[index] += 1)));
  for (const sender of senders) await new Promise<void>((done) => sender.bind(0, '127.0.0.1', done));
  try {
    await b.start();
    const probe = async (index: number) => {
      senders[index].send(encodeProbe(), b.port(), '127.0.0.1', () => {});
      clock += 1;
      await delay(5); // 保证按顺序处理
    };
    for (let index = 0; index < 32; index += 1) await probe(index);
    // 第一个又来了一次：它不再是最久没收到的，满了该丢第二个
    await probe(0);
    await probe(32);
    await delay(50); // 排空前面攒下的回发
    heard.fill(0);
    await delay(150);
    assert.equal(heard[1], 0, '最久没收到的被丢掉');
    assert.ok(heard[0] > 0, '刚又收到过的还在名单里');
    assert.ok(heard[32] > 0, '最新的还在名单里');
    assert.ok(heard.filter((count) => count > 0).length >= 31);
  } finally {
    for (const sender of senders) sender.close();
    b.stop();
  }
});

test('a neighborhood lists other pets it hears from, ignores itself and junk, forgets the silent ones, and can listen without announcing', async () => {
  let clock = 1_000_000;
  const logs: string[] = [];
  const a: Neighborhood = new Neighborhood({
    id: 'aaaaaaaa-self',
    announce: () => ({ owner: '我', pet: '小蓝', port: 1111 }),
    log: (m) => logs.push(m),
    port: 0,
    targets: () => [{ address: '127.0.0.1', port: a.port() }], // 发给自己：要被认出来忽略掉
    now: () => clock,
  });
  await a.start();
  let hosting = true;
  const b = new Neighborhood({
    id: 'bbbbbbbb-other',
    announce: () => (hosting ? { owner: '小王', pet: '小鱼', port: 2222 } : null),
    log: (m) => logs.push(m),
    port: 0,
    targets: () => [{ address: '127.0.0.1', port: a.port() }],
    now: () => clock,
  });
  const junk = createSocket('udp4');
  try {
    await b.start();
    junk.send('{"app":"dsh-pet"}', a.port(), '127.0.0.1');
    for (let i = 0; i < 100 && a.list().length === 0; i += 1) await new Promise((done) => setTimeout(done, 10));
    assert.deepEqual(
      a.list().map(({ id, owner, pet, port, address }) => ({ id, owner, pet, port, address })),
      [{ id: 'bbbbbbbb-other', owner: '小王', pet: '小鱼', port: 2222, address: '127.0.0.1' }],
    );
    assert.equal(a.get('bbbbbbbb-other')?.owner, '小王');
    // 127.0.0.1 不在本机网段里，a、b 还会互相单播回一条信标：先让 b 不再发，等已经发出的落地再拨钟，
    // 否则慢一点的机器（Windows CI）上 b 的回发会在拨钟之后才处理，被当成「刚又听到」
    b.stop();
    await new Promise((done) => setTimeout(done, 100));
    clock += 21_000;
    assert.deepEqual(a.list(), []);
    assert.equal(a.get('bbbbbbbb-other'), undefined);
    // 不接待客人：只听不发，别人看不到它
    hosting = false;
    await b.start();
    await new Promise((done) => setTimeout(done, 100));
    assert.deepEqual(a.list(), []);
    assert.deepEqual(logs, []);
  } finally {
    junk.close();
    a.stop();
    b.stop();
  }
});

/** 起一个只听 127.0.0.1 的接待端，handlers 可按测试覆盖；fn 结束后关掉 */
async function withHost(
  overrides: Partial<HostHandlers> & {
    knockWaitMs?: number;
    duelWaitMs?: number;
    now?: () => number;
    identity?: VisitIdentity | null;
  },
  fn: (host: VisitHost, port: number, calls: string[], logs: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  const logs: string[] = [];
  const handlers: HostHandlers = {
    canHost: () => true,
    knocked: (visitor) => calls.push(`knocked ${visitor.owner}/${visitor.pet}@${visitor.address}`),
    knockEnded: (_visitor, reason) => calls.push(`knock-ended ${reason}`),
    line: (visitor, text) => {
      calls.push(`line ${text}`);
      return Promise.resolve(`欢迎\n${visitor.pet}～`);
    },
    note: (visitor, text) => {
      calls.push(`note ${visitor.owner}:${text}`);
      return true;
    },
    spar: (visitor, card, commit) => {
      calls.push(`spar ${visitor.pet} stage${card.stage} hp${card.hp} ${commit.slice(0, 8)}`);
      return Promise.resolve({ ok: false, reason: 'off' });
    },
    reveal: (visitor, nonce, line) => {
      calls.push(`reveal ${visitor.pet} ${nonce.slice(0, 8)} ${line}`);
      return Promise.resolve({ ok: false, reason: 'late' });
    },
    duel: (visitor, card, commit) => {
      calls.push(`duel ${visitor.pet} stage${card.stage} hp${card.hp} ${commit.slice(0, 8)}`);
      return Promise.resolve({ ok: false, reason: 'off' });
    },
    duelReveal: (visitor, nonce, line) => {
      calls.push(`duel-reveal ${visitor.pet} ${nonce.slice(0, 8)} ${line}`);
    },
    duelConceded: (visitor, reason) => calls.push(`duel-conceded ${visitor.pet} ${reason}`),
    left: (_visitor, reason, text) => calls.push(`left ${reason} ${text}`),
    ...overrides,
  };
  const host = new VisitHost(handlers, {
    log: (message) => logs.push(message),
    knockWaitMs: overrides.knockWaitMs,
    duelWaitMs: overrides.duelWaitMs,
    now: overrides.now,
    identity: overrides.identity,
  });
  const port = await host.listen('127.0.0.1');
  try {
    await fn(host, port, calls, logs);
  } finally {
    await host.close();
  }
}

/** 等接待端挂上敲门后按 accept 答复，返回那位 */
function answerWhen(host: VisitHost, accept: boolean): Promise<Visitor | null> {
  return new Promise((resolve) => {
    const wait = () => (host.knocking() ? resolve(host.answer(accept)) : setTimeout(wait, 5));
    wait();
  });
}

/** 敲门，并在对方「主人」收到敲门后按 accept 答复 */
function knockAndAnswer(host: VisitHost, port: number, accept: boolean) {
  return Promise.all([knockOn({ address: '127.0.0.1', port }, me), answerWhen(host, accept)]);
}

test('a visit: knock, get let in, chat, then leave; a second knock meanwhile is busy', async () => {
  let clock = 0;
  await withHost({ now: () => clock }, async (host, port, calls) => {
    const target = { address: '127.0.0.1', port };
    const [answer, visitor] = await knockAndAnswer(host, port, true);
    assert.equal(answer.ok, true);
    assert.deepEqual(visitor, { owner: '小王', pet: '小鱼', address: '127.0.0.1' });
    assert.deepEqual(host.guest(), visitor);
    const token = answer.ok ? answer.token : '';

    assert.deepEqual(await knockOn(target, { owner: '小李', pet: '阿花' }), { ok: false, reason: 'busy' });
    assert.deepEqual(await tripRequest(target, '/v1/chat', { token, text: '你好呀\n' }), {
      ok: true,
      reply: '欢迎 小鱼～',
      events: [],
    });
    assert.deepEqual(await tripRequest(target, '/v1/ping', { token }), { ok: true, reply: '', events: [] });
    assert.deepEqual(await tripRequest(target, '/v1/ping', { token: 'f'.repeat(32) }), {
      ok: false,
      reason: 'not-visiting',
    });
    assert.deepEqual(await tripRequest(target, '/v1/leave', { token, text: '拜拜' }), {
      ok: true,
      reply: '',
      events: [],
    });
    assert.equal(host.guest(), null);
    assert.deepEqual(await tripRequest(target, '/v1/ping', { token }), { ok: false, reason: 'not-visiting' });

    // 同一地址 30 秒内不能再敲
    assert.deepEqual(await knockOn(target, me), { ok: false, reason: 'too-soon' });
    clock += 31_000;
    const [again] = await knockAndAnswer(host, port, false);
    assert.deepEqual(again, { ok: false, reason: 'declined' });
    assert.deepEqual(calls, [
      'knocked 小王/小鱼@127.0.0.1',
      'line 你好呀',
      'left leave 拜拜',
      'knocked 小王/小鱼@127.0.0.1',
    ]);
  });
});

test('what the host has to tell the guest rides on the next ping, once, newest kept when too much piles up', async () => {
  await withHost({}, async (host, port) => {
    const target = { address: '127.0.0.1', port };
    assert.equal(host.tell({ type: 'poke' }), false, '没有客人时没人可告诉');
    const [answer] = await knockAndAnswer(host, port, true);
    const token = answer.ok ? answer.token : '';
    assert.equal(host.tell({ type: 'line', text: '你喜欢吃什么？' }), true);
    host.tell({ type: 'poke' });
    host.tell({ type: 'play', what: '吃西瓜' });
    const ping = await tripRequest(target, '/v1/ping', { token });
    assert.deepEqual(ping.ok && ping.events, [
      { type: 'line', text: '你喜欢吃什么？' },
      { type: 'poke' },
      { type: 'play', what: '吃西瓜' },
    ]);
    const again = await tripRequest(target, '/v1/ping', { token });
    assert.deepEqual(again.ok && again.events, [], '捎过一次就清掉');
    for (let n = 1; n <= 10; n += 1) host.tell({ type: 'line', text: `第 ${n} 句` });
    const piled = await tripRequest(target, '/v1/ping', { token });
    assert.deepEqual(piled.ok && piled.events.map((event) => (event.type === 'line' ? event.text : event.type)), [
      '第 3 句',
      '第 4 句',
      '第 5 句',
      '第 6 句',
      '第 7 句',
      '第 8 句',
      '第 9 句',
      '第 10 句',
    ]);
  });
});

test('events from the other side are checked like everything else it sends', () => {
  assert.deepEqual(parseEvents(undefined), [], '旧版本不带 events');
  assert.deepEqual(parseEvents('poke'), []);
  assert.deepEqual(
    parseEvents([
      { type: 'line', text: '你好\u202e呀\n' },
      { type: 'line', text: '' },
      { type: 'note', text: '帮我告诉我主人：明天带伞' },
      { type: 'note', text: '\u0000' },
      { type: 'poke', extra: 1 },
      { type: 'play', what: '吃西瓜吃西瓜吃西瓜吃西瓜吃西瓜' },
      { type: 'play' },
      { type: 'gift', what: '糖葫芦' },
      { type: 'gift', what: 42 },
      { type: 'dance' },
      null,
      'line',
    ]),
    [
      { type: 'line', text: '你好 呀' },
      { type: 'note', text: '帮我告诉我主人：明天带伞' },
      { type: 'poke' },
      { type: 'play', what: '吃西瓜吃西瓜吃西瓜吃西瓜' },
      { type: 'gift', what: '糖葫芦' },
    ],
  );
  assert.equal(parseEvents(Array.from({ length: 20 }, () => ({ type: 'poke' }))).length, 8);
});

test('the host can send a guest home, and the guest hears it on its next ping', async () => {
  await withHost({}, async (host, port, calls) => {
    const target = { address: '127.0.0.1', port };
    const [answer] = await knockAndAnswer(host, port, true);
    const token = answer.ok ? answer.token : '';
    assert.equal(host.sendHome()?.pet, '小鱼');
    assert.equal(host.sendHome(), null);
    assert.deepEqual(await tripRequest(target, '/v1/ping', { token }), { ok: false, reason: 'sent-home' });
    assert.deepEqual(await tripRequest(target, '/v1/chat', { token, text: '诶？' }), {
      ok: false,
      reason: 'sent-home',
    });
    // 送走客人不经 left（主人自己点的，调用方自己收尾）
    assert.deepEqual(calls, ['knocked 小王/小鱼@127.0.0.1']);
  });
});

test('notes: a friend’s note gets through (cleaned), strangers, floods and old hosts are told why', async () => {
  let clock = 0;
  let accept = true;
  const notes: string[] = [];
  await withHost(
    {
      now: () => clock,
      note: (visitor, text) => {
        notes.push(`${visitor.owner}:${text}`);
        return accept;
      },
    },
    async (host, port) => {
      const target = { address: '127.0.0.1', port };
      const [answer] = await knockAndAnswer(host, port, true);
      const token = answer.ok ? answer.token : '';
      // 熟人的收下，超长的按 cleanText 截到 LINE_MAX
      assert.deepEqual(await sendNote(target, { token, text: '告诉我主人：明天带伞' }), { ok: true });
      clock += 10_000;
      assert.deepEqual(await sendNote(target, { token, text: '一'.repeat(80) }), { ok: true });
      assert.deepEqual(notes, ['小王:告诉我主人：明天带伞', `小王:${'一'.repeat(60)}`]);
      assert.deepEqual(await sendNote(target, { token, text: '太快' }), { ok: false, reason: 'too-many' });
      clock += 10_000;
      // 不是熟人（对方没把自己标成熟人）：拒收（先问收不收，才算这条数）
      accept = false;
      assert.deepEqual(await sendNote(target, { token, text: '试试' }), { ok: false, reason: 'not-friend' });
      accept = true;
      for (let n = 2; n <= 4; n += 1) {
        clock += 10_000;
        assert.deepEqual(await sendNote(target, { token, text: `第 ${n} 句` }), { ok: true });
      }
      // 每趟最多 5 条：隔得再久也捎不进第 6 条
      clock += 10_000;
      assert.deepEqual(await sendNote(target, { token, text: '第 6 句' }), { ok: false, reason: 'too-many' });
      // 没进门 / 被请回家：如实带原因回去
      const stranger = 'f'.repeat(32);
      assert.deepEqual(await sendNote(target, { token: stranger, text: '谁？' }), {
        ok: false,
        reason: 'not-visiting',
      });
      host.sendHome();
      assert.deepEqual(await sendNote(target, { token, text: '还在吗' }), { ok: false, reason: 'sent-home' });
    },
  );

  // 旧主人家没有 /v1/note（404 + not-found）：客人这边认得出「对方的版本太旧」
  const old = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const body = JSON.stringify({ ok: false, reason: 'not-found' });
      res.writeHead(404, { 'content-type': 'application/json', 'content-length': body.length });
      res.end(body);
    });
  });
  await new Promise<void>((done) => old.listen(0, '127.0.0.1', done));
  try {
    const port = (old.address() as AddressInfo).port;
    assert.deepEqual(await sendNote({ address: '127.0.0.1', port }, { token: 'ab'.repeat(16), text: '你好' }), {
      ok: false,
      reason: 'old-host',
    });
  } finally {
    old.closeAllConnections();
    await new Promise<void>((done) => old.close(() => done()));
  }
});

test('nobody answering the door ends the knock; a busy host turns knocks away without asking', async () => {
  await withHost({ knockWaitMs: 50 }, async (host, port, calls) => {
    assert.deepEqual(await knockOn({ address: '127.0.0.1', port }, me), { ok: false, reason: 'no-answer' });
    assert.equal(host.knocking(), null);
    assert.deepEqual(calls, ['knocked 小王/小鱼@127.0.0.1', 'knock-ended no-answer']);
  });
  await withHost({ canHost: () => false }, async (_host, port, calls) => {
    assert.deepEqual(await knockOn({ address: '127.0.0.1', port }, me), { ok: false, reason: 'busy' });
    assert.deepEqual(calls, []);
  });
});

test('a guest that goes quiet is reported lost', async () => {
  let clock = 0;
  // 只接管 setInterval（失联检查是接待端 listen 时起的 setInterval，必须在那之前接管）；
  // 敲门用的 setTimeout 与网络照常走真的
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    await withHost({ now: () => clock }, async (host, port, calls) => {
      await knockAndAnswer(host, port, true);
      clock += 29_000;
      mock.timers.tick(PING_MS);
      assert.ok(host.guest(), '没到 30 秒还算在');
      clock += 2_000;
      mock.timers.tick(PING_MS);
      assert.equal(host.guest(), null);
      assert.deepEqual(calls, ['knocked 小王/小鱼@127.0.0.1', 'left lost ']);
    });
  } finally {
    mock.timers.reset();
  }
});

/** 直接发一个请求（fetch 不让随便设 Origin），返回状态码与应答 */
function raw(
  port: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/knock', method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('requests from web pages, oversized or malformed bodies and nameless knocks are refused', async () => {
  await withHost({}, async (_host, port, calls) => {
    const knock = JSON.stringify(me);
    assert.equal((await raw(port, knock, { origin: 'http://192.168.1.9:8080' })).status, 403);
    // 超过 4 KB：读到一半直接断开连接，不读完
    await assert.rejects(raw(port, 'x'.repeat(5000)));
    assert.equal((await raw(port, '[1]')).status, 400);
    assert.equal((await raw(port, JSON.stringify({ owner: '\u0000', pet: '小鱼' }))).status, 400);
    assert.deepEqual(calls, []);
  });
});

// ---------- 敲门签名与应答签名 ----------

/** 手拼一个签过名的敲门请求体（默认按 127.0.0.1、当前时间、要发出去的名字签，配得上的 hostId） */
function signedKnock(
  port: number,
  guest: VisitIdentity,
  host: VisitIdentity,
  tweaks: { id?: string; ts?: number; owner?: string; signOwner?: string; address?: string } = {},
): string {
  const owner = tweaks.owner ?? me.owner;
  const ts = tweaks.ts ?? Date.now();
  const sig = guest.sign(
    knockMessage({
      hostId: host.id,
      address: tweaks.address ?? '127.0.0.1',
      port,
      ts,
      owner: tweaks.signOwner ?? owner,
      pet: me.pet,
    }),
  );
  return JSON.stringify({ owner, pet: me.pet, id: tweaks.id ?? guest.id, pub: guest.pub, ts: String(ts), sig });
}

/** 敲一道签了名的门并放进来，返回进来的那位与应答；任何一步断了抛错 */
async function rawKnockIn(
  host: VisitHost,
  port: number,
  body: string,
): Promise<{ visitor: Visitor | null; answer: unknown }> {
  const answering = answerWhen(host, true);
  const result = await raw(port, body);
  return { visitor: await answering, answer: JSON.parse(result.body) };
}

test('a signed knock checks out; anything off is just a stranger the owner can still let in', async () => {
  const hostIdentity = generateVisitIdentity();
  const guestIdentity = generateVisitIdentity();

  // 四件套都对：客人以自己的身份进门，客人那边也应答验证通过
  await withHost({ identity: hostIdentity }, async (host, port) => {
    const answering = answerWhen(host, true);
    const answer = await knockOn({ address: '127.0.0.1', port }, me, guestIdentity, hostIdentity.id);
    const visitor = await answering;
    assert.equal(answer.ok && answer.verified, true);
    assert.equal(visitor?.id, guestIdentity.id);
    assert.equal(host.guest()?.id, guestIdentity.id);
  });

  // 旧版本：不带签名四件套——当陌生人，照旧能人工让进
  await withHost({ identity: hostIdentity }, async (host, port, _calls, logs) => {
    const { visitor, answer } = await rawKnockIn(host, port, JSON.stringify(me));
    assert.equal((answer as { ok: boolean }).ok, true);
    assert.equal(visitor?.id, undefined);
    assert.equal(host.guest(), visitor);
    assert.ok(
      logs.some((line) => line.includes('当陌生人')),
      '日志里记下原因',
    );
  });

  // id 和公钥对不上
  await withHost({ identity: hostIdentity }, async (host, port) => {
    const { visitor } = await rawKnockIn(
      host,
      port,
      signedKnock(port, guestIdentity, hostIdentity, { id: '0'.repeat(32) }),
    );
    assert.equal(visitor?.id, undefined);
  });

  // 时间戳超过 120 秒（签名也按那个时间签的，骗不过）
  await withHost({ identity: hostIdentity }, async (host, port) => {
    const { visitor } = await rawKnockIn(
      host,
      port,
      signedKnock(port, guestIdentity, hostIdentity, { ts: Date.now() - 200_000 }),
    );
    assert.equal(visitor?.id, undefined);
  });

  // 签名里的地址和本机地址不同（模拟抄来的信标把请求转发给了别家）
  await withHost({ identity: hostIdentity }, async (host, port) => {
    const { visitor } = await rawKnockIn(
      host,
      port,
      signedKnock(port, guestIdentity, hostIdentity, { address: '127.0.0.2' }),
    );
    assert.equal(visitor?.id, undefined);
  });

  // 篡改了 owner：签的是「小王」，发出去的是「小李」
  await withHost({ identity: hostIdentity }, async (host, port) => {
    const { visitor } = await rawKnockIn(
      host,
      port,
      signedKnock(port, guestIdentity, hostIdentity, { owner: '小李', signOwner: '小王' }),
    );
    assert.equal(visitor?.id, undefined);
  });
});

test('the same signed knock cannot be replayed within the window', async () => {
  const hostIdentity = generateVisitIdentity();
  const guestIdentity = generateVisitIdentity();
  const ts = Date.now();
  let clock = ts;
  await withHost({ identity: hostIdentity, now: () => clock }, async (host, port) => {
    const body = signedKnock(port, guestIdentity, hostIdentity, { ts });
    const firstAnswering = answerWhen(host, true);
    const first = JSON.parse((await raw(port, body)).body) as { ok: boolean; token: string };
    assert.equal(first.ok, true);
    assert.equal((await firstAnswering)?.id, guestIdentity.id);
    await tripRequest({ address: '127.0.0.1', port }, '/v1/leave', { token: first.token, text: '' });
    // 过了同地址冷却（30 秒），ts 还在 120 秒窗口里：原样再发一遍
    clock += 31_000;
    const secondAnswering = answerWhen(host, true);
    const second = JSON.parse((await raw(port, body)).body) as { ok: boolean };
    assert.equal(second.ok, true);
    assert.equal((await secondAnswering)?.id, undefined, '重放的当陌生人');
  });
});

test('the guest only trusts a welcome signed for the address it dialed', async () => {
  const hostIdentity = generateVisitIdentity();
  const guestIdentity = generateVisitIdentity();
  // 旧主人家（没身份）：不带应答签名，照常进门，但不算认出这家人
  await withHost({}, async (host, port) => {
    const answering = answerWhen(host, true);
    const answer = await knockOn({ address: '127.0.0.1', port }, me, guestIdentity, hostIdentity.id);
    assert.equal(answer.ok, true);
    assert.equal(answer.verified, false);
    assert.equal((await answering)?.id, undefined);
  });
  // 应答签名里的地址不是自己拨的（真主人家在别处）：不认
  // 应答里 id 冒充熟人（抄来的），pub 和 sig 用自己的钥匙，签名内容、地址都对：也得识破
  const answerWith = (
    make: (token: string, port: number) => { id: string; pub: string; sig: string },
  ): Promise<{ port: number; close: () => Promise<void> }> => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const port = (server.address() as AddressInfo).port;
        const token = 'ab'.repeat(16);
        const payload = JSON.stringify({ ok: true, token, ...make(token, port) });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': payload.length });
        res.end(payload);
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () =>
        resolve({
          port: (server.address() as AddressInfo).port,
          close: () =>
            new Promise<void>((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
        }),
      );
    });
  };
  const cases = [
    // 地址不符
    (token: string) => ({
      id: hostIdentity.id,
      pub: hostIdentity.pub,
      sig: hostIdentity.sign(welcomeMessage({ guestId: guestIdentity.id, address: '127.0.0.2', port: 41234, token })),
    }),
    // 冒充熟人：id 填真主人家的，钥匙用自己的
    (token: string, port: number) => {
      const attacker = generateVisitIdentity();
      return {
        id: hostIdentity.id,
        pub: attacker.pub,
        sig: attacker.sign(welcomeMessage({ guestId: guestIdentity.id, address: '127.0.0.1', port, token })),
      };
    },
  ];
  for (const make of cases) {
    const { port, close } = await answerWith(make);
    try {
      const answer = await knockOn({ address: '127.0.0.1', port }, me, guestIdentity, hostIdentity.id);
      assert.equal(answer.ok, true);
      assert.equal(answer.verified, false);
    } finally {
      await close();
    }
  }
});

// ---------- 切磋（X5） ----------

/** 一份合法的名帖（炼气二层：statCap(1) 是气血 61、其余 7，都有余量） */
const aCard: SparCard = {
  v: BATTLE_VERSION,
  stage: 1,
  hp: 56,
  power: 5,
  agility: 5,
  speed: 5,
  weapons: ['water-gun', 'poker'],
  skills: ['dove'],
};

const aFighter: Fighter = {
  name: '小鱼',
  hp: 80,
  power: 6,
  agility: 6,
  speed: 6,
  weapons: ['water-gun', 'top'],
  skills: ['dove', 'critical'],
};

test('cards: a valid card parses; version mismatches and anything over the codex or statCap is refused', () => {
  assert.deepEqual(parseSparCard(aCard), aCard);
  // 引擎版本不同（含 v 缺失、类型不对）都说「版本」；名帖本身倒是其余不合法都说 bad-card
  assert.equal(parseSparCard({ ...aCard, v: BATTLE_VERSION + 1 }), 'version');
  assert.equal(parseSparCard({ ...aCard, v: '1' }), 'version');
  assert.equal(parseSparCard('名帖'), 'version');
  assert.equal(parseSparCard({ ...aCard, hp: 999 }), null, '数值超过该境界的理论上限');
  assert.equal(parseSparCard({ ...aCard, power: 8 }), null);
  assert.equal(parseSparCard({ ...aCard, hp: 0 }), null);
  assert.equal(parseSparCard({ ...aCard, weapons: [...WEAPON_IDS, 'water-gun'] as WeaponId[] }), null, '法宝超过 8 件');
  assert.equal(parseSparCard({ ...aCard, weapons: ['nunchaku'] }), null, '法宝编号不认识');
  assert.equal(parseSparCard({ ...aCard, skills: [...SKILL_IDS, 'dove'] }), null, '招式超过 10 个');
  assert.equal(parseSparCard({ ...aCard, stage: 99 }), null, '境界出格');
  assert.equal(parseSparCard({ ...aCard, stage: -1 }), null);
  // 名帖与战斗档案互转，数值一件不少
  assert.deepEqual(cardFighter('阿花', sparCardOf(aFighter, 3)), { ...aFighter, name: '阿花' });
});

test('nonces and commits: 32-byte hex in, sha256 hex out', () => {
  const nonce = randomSparNonce();
  assert.ok(isSparNonce(nonce));
  assert.equal(nonce.length, 64);
  assert.equal(sparCommit(nonce), createHash('sha256').update(nonce).digest('hex'));
  assert.ok(!isSparNonce('a'.repeat(63)));
  assert.ok(!isSparNonce('g'.repeat(64)));
  assert.ok(!isSparNonce(nonce.toUpperCase()));
  assert.ok(!isSparNonce(''));
});

test('sparFight: both sides compute the same fight, the host is actor 0, and the seed order is pinned', () => {
  const guest: Fighter = {
    name: '阿花',
    hp: 76,
    power: 6,
    agility: 5,
    speed: 7,
    weapons: ['poker', 'snowball'],
    skills: ['bloom', 'sixth-sense'],
  };
  const guestNonce = 'a'.repeat(64);
  const hostNonce = 'b'.repeat(64);
  const events = sparFight(aFighter, guest, guestNonce, hostNonce);
  // 两边各自调，事件序列逐个相同（§X5 第 5 步）
  assert.deepEqual(sparFight(aFighter, guest, guestNonce, hostNonce), events);
  assert.equal(events[0].kind, 'start');
  assert.equal(events[0].actor, 0, '主人家是 actor 0');
  assert.equal(events[0].hp[0], aFighter.hp);
  // 种子是「客人随机数:主人家随机数」：顺序反了就是另一场
  assert.notDeepEqual(sparFight(aFighter, guest, hostNonce, guestNonce), events);
});

test('sparFight: 串门送友风开关两边各算同一场，不传就没有 farewell 收场（X16）', () => {
  const host: Fighter = {
    ...aFighter,
    name: '主人家',
    hp: 9_999,
    weapons: [],
    skills: ['farewell-wind'],
  };
  const guest: Fighter = {
    name: '客人',
    hp: 9_999,
    power: 5,
    agility: 5,
    speed: 6,
    weapons: [],
    skills: [],
  };
  const hostNonce = 'b'.repeat(64);
  let sent: { guestNonce: string; events: ReturnType<typeof sparFight> } | null = null;
  for (let i = 0; i < 80 && sent === null; i++) {
    const guestNonce = i.toString(16).padStart(64, '0');
    const events = sparFight(host, guest, guestNonce, hostNonce, { farewell: true });
    const end = events[events.length - 1];
    if (end.kind === 'end' && end.reason === 'farewell') sent = { guestNonce, events };
  }
  assert.ok(sent, '该有一个种子在串门里把客人送走');
  // 两边各自调 sparFight（主人家 / 客人）算出同一串；种子顺序仍钉住
  assert.deepEqual(sparFight(host, guest, sent!.guestNonce, hostNonce, { farewell: true }), sent!.events);
  const last = sent!.events[sent!.events.length - 1];
  assert.equal(last?.kind === 'end' && last.winner, 0, '主人家（施放方）赢');
  // 不传 farewell：同一对随机数不会再送走
  const plain = sparFight(host, guest, sent!.guestNonce, hostNonce);
  assert.ok(!plain.some((event) => event.kind === 'end' && event.reason === 'farewell'));
});

test('sparLineRng: 同一对随机数给出同一串、换个顺序就不同（两边的解说才会一致）', () => {
  const guestNonce = 'a'.repeat(64);
  const hostNonce = 'b'.repeat(64);
  const draw = (rng: () => number): number[] => Array.from({ length: 8 }, () => rng());
  const first = draw(sparLineRng(guestNonce, hostNonce));
  assert.deepEqual(draw(sparLineRng(guestNonce, hostNonce)), first);
  assert.notDeepEqual(draw(sparLineRng(hostNonce, guestNonce)), first);
});

test('切磋两边的时间线：台词与动作逐步相同，客人这边只是把本地宠物换到 0 号', () => {
  const guest: Fighter = {
    name: '阿花',
    hp: 76,
    power: 6,
    agility: 5,
    speed: 7,
    weapons: ['poker', 'snowball'],
    skills: ['bloom', 'sixth-sense'],
  };
  const guestNonce = 'a'.repeat(64);
  const hostNonce = 'b'.repeat(64);
  const events = sparFight(aFighter, guest, guestNonce, hostNonce);
  const skills: [SkillId[], SkillId[]] = [aFighter.skills, guest.skills];
  // 主人家：自家 fighter 是 0 号，名字 / 招式表照引擎顺序
  const hostView = timeline(events, [aFighter.name, guest.name], sparLineRng(guestNonce, hostNonce), skills);
  // 客人：同样先照引擎顺序排（主人家 0 号），再换边成本地视角
  const guestView = swapSides(
    timeline(events, [aFighter.name, guest.name], sparLineRng(guestNonce, hostNonce), skills),
  );
  assert.deepEqual(swapSides(guestView), hostView, '换回引擎视角后逐步相同（时刻、动作、台词、气血都在）');
  assert.deepEqual(
    guestView.map((step) => step.line),
    hostView.map((step) => step.line),
    '台词逐句相同',
  );
  assert.ok(
    hostView.some((step) => step.line),
    '这一场确实排出了台词（否则上面的逐句比较没意义）',
  );
});

test("a spar challenge goes through with the host's card and nonce, and the reveal gets its line cleaned", async () => {
  await withHost(
    {
      spar: async (visitor, card, commit) => {
        assert.equal(visitor.pet, me.pet);
        assert.deepEqual(card, aCard);
        assert.equal(commit, sparCommit('c'.repeat(64)));
        return { ok: true, card: sparCardOf(aFighter, 4), nonce: 'b'.repeat(64) };
      },
      reveal: async (visitor, nonce, line) => {
        assert.equal(visitor.pet, me.pet);
        // 感言照台词清洗截断（没带的就空）
        assert.equal(line, nonce === 'c'.repeat(64) ? '你好 呀' : '');
        return nonce === 'c'.repeat(64) ? { ok: true } : { ok: false, reason: 'mismatch' };
      },
    },
    async (host, port) => {
      const target = { address: '127.0.0.1', port };
      const [answer] = await knockAndAnswer(host, port, true);
      const token = answer.ok ? answer.token : '';
      const reply = await sendSpar(target, {
        token,
        mode: SPAR_MODE,
        card: aCard,
        commit: sparCommit('c'.repeat(64)),
      });
      assert.ok(reply.ok);
      assert.equal(reply.ok && reply.nonce, 'b'.repeat(64));
      assert.ok(reply.ok && reply.card.v === BATTLE_VERSION && reply.card.stage === 4);
      // 应答里的名帖与随机数也照对方的规矩验过一遍（坏的要当 bad-card）
      assert.deepEqual(await sendReveal(target, { token, nonce: 'c'.repeat(64), line: '  你好\u202e呀\n' }), {
        ok: true,
      });
      assert.deepEqual(await sendReveal(target, { token, nonce: 'd'.repeat(64), line: '' }), {
        ok: false,
        reason: 'mismatch',
      });
    },
  );
});

test('a spar is refused with the right reason for each kind of wrong before the host is even asked', async () => {
  let asked = 0;
  await withHost(
    {
      spar: async () => {
        asked += 1;
        return { ok: false, reason: 'off' as const };
      },
    },
    async (host, port) => {
      const target = { address: '127.0.0.1', port };
      const [answer] = await knockAndAnswer(host, port, true);
      const token = answer.ok ? answer.token : '';
      const ask = (body: Record<string, unknown>) =>
        sendSpar(target, { token, mode: SPAR_MODE, card: aCard, commit: sparCommit('c'.repeat(64)), ...body });
      assert.deepEqual(await ask({ mode: 'manual' }), { ok: false, reason: 'unsupported-mode' });
      assert.deepEqual(await ask({ commit: 'nope' }), { ok: false, reason: 'bad-request' });
      assert.deepEqual(await ask({ card: { ...aCard, v: BATTLE_VERSION + 1 } }), { ok: false, reason: 'version' });
      assert.deepEqual(await ask({ card: { ...aCard, hp: 999 } }), { ok: false, reason: 'bad-card' });
      assert.deepEqual(await ask({ card: { ...aCard, weapons: ['nunchaku'] } }), { ok: false, reason: 'bad-card' });
      assert.equal(asked, 0, '不对的请求根本没到 handlers.spar');
      // 到了的：handlers 说什么回什么；客人走了以后如实带 sent-home 回去
      assert.deepEqual(await ask({}), { ok: false, reason: 'off' });
      assert.equal(asked, 1);
      host.sendHome();
      assert.deepEqual(await ask({}), { ok: false, reason: 'sent-home' });
    },
  );
});

test("the guest also checks the host's reply card, nonce and reasons like everything else it sends", async () => {
  const replyWith = async (body: unknown): Promise<Awaited<ReturnType<typeof sendSpar>>> => {
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const payload = JSON.stringify(body);
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        res.end(payload);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const port = (server.address() as AddressInfo).port;
      return await sendSpar(
        { address: '127.0.0.1', port },
        {
          token: 'ab'.repeat(16),
          mode: SPAR_MODE,
          card: aCard,
          commit: sparCommit('c'.repeat(64)),
        },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  };
  // 名帖越上限 / 版本不同 / 随机数格式不对：都当 bad-card
  assert.deepEqual(await replyWith({ ok: true, card: { ...aCard, hp: 9_999 }, nonce: 'b'.repeat(64) }), {
    ok: false,
    reason: 'bad-card',
  });
  assert.deepEqual(await replyWith({ ok: true, card: { ...aCard, v: BATTLE_VERSION + 1 }, nonce: 'b'.repeat(64) }), {
    ok: false,
    reason: 'bad-card',
  });
  assert.deepEqual(await replyWith({ ok: true, card: aCard, nonce: '短' }), {
    ok: false,
    reason: 'bad-card',
  });
  // 拒绝的原因原样带回去；没有的路由（旧主人家）如实说 old-host
  assert.deepEqual(await replyWith({ ok: false, reason: 'off' }), { ok: false, reason: 'off' });
  assert.deepEqual(await replyWith({ ok: false, reason: 'not-found' }), { ok: false, reason: 'old-host' });
  assert.deepEqual(await replyWith({ ok: false, reason: '什么鬼' }), { ok: false, reason: 'not-visiting' });

  // 旧主人家没有 /v1/spar 与 /v1/spar/reveal（404 + not-found，同 sendNote 的口径）：两个方向都说「还不会切磋」
  const old = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const payload = JSON.stringify({ ok: false, reason: 'not-found' });
      res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  await new Promise<void>((done) => old.listen(0, '127.0.0.1', done));
  try {
    const port = (old.address() as AddressInfo).port;
    const target = { address: '127.0.0.1', port };
    assert.deepEqual(
      await sendSpar(target, {
        token: 'ab'.repeat(16),
        mode: SPAR_MODE,
        card: aCard,
        commit: sparCommit('c'.repeat(64)),
      }),
      { ok: false, reason: 'old-host' },
    );
    assert.deepEqual(await sendReveal(target, { token: 'ab'.repeat(16), nonce: 'c'.repeat(64), line: '' }), {
      ok: false,
      reason: 'old-host',
    });
  } finally {
    old.closeAllConnections();
    await new Promise<void>((done) => old.close(() => done()));
  }
});

test('a spar invite rides the next ping, and parseEvents keeps it while still dropping unknown kinds', async () => {
  assert.deepEqual(parseEvents([{ type: 'spar-invite' }]), [{ type: 'spar-invite' }]);
  assert.deepEqual(parseEvents([{ type: 'spar-invite', mode: 'live' }]), [{ type: 'spar-invite', mode: 'live' }]);
  assert.deepEqual(parseEvents([{ type: 'spar-invite', mode: '别的' }]), [{ type: 'spar-invite' }]);
  assert.deepEqual(parseEvents([{ type: 'spar-invite' }, { type: 'dance' }, null]), [{ type: 'spar-invite' }]);
  await withHost({}, async (host, port) => {
    const target = { address: '127.0.0.1', port };
    const [answer] = await knockAndAnswer(host, port, true);
    const token = answer.ok ? answer.token : '';
    assert.equal(host.tell({ type: 'spar-invite' }), true);
    const ping = await tripRequest(target, '/v1/ping', { token });
    assert.deepEqual(ping.ok && ping.events, [{ type: 'spar-invite' }]);
  });
});

// ---------- 隔空切磋（X15） ----------

/** 直接往指定路径发一个请求（fetch 不让随便设 Origin / 手拼签名） */
function rawPost(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** 手拼一个签过名的 /v1/duel 请求体（默认按 127.0.0.1、给定 ts、要发出去的名字与承诺签） */
function signedDuel(
  port: number,
  challenger: VisitIdentity,
  host: VisitIdentity,
  tweaks: {
    id?: string;
    ts?: number;
    owner?: string;
    pet?: string;
    signOwner?: string;
    signPet?: string;
    commit?: string;
    signCommit?: string;
    address?: string;
    mode?: string;
    card?: unknown;
    sig?: string;
  } = {},
): Record<string, unknown> {
  const owner = tweaks.owner ?? me.owner;
  const pet = tweaks.pet ?? me.pet;
  const ts = tweaks.ts ?? Date.now();
  const commit = tweaks.commit ?? 'c'.repeat(64);
  const sig =
    tweaks.sig ??
    challenger.sign(
      duelMessage({
        hostId: host.id,
        address: tweaks.address ?? '127.0.0.1',
        port,
        ts,
        owner: tweaks.signOwner ?? owner,
        pet: tweaks.signPet ?? pet,
        commit: tweaks.signCommit ?? commit,
      }),
    );
  return {
    owner,
    pet,
    id: tweaks.id ?? challenger.id,
    pub: challenger.pub,
    ts: String(ts),
    sig,
    mode: tweaks.mode ?? SPAR_MODE,
    card: tweaks.card ?? aCard,
    commit,
  };
}

async function bodyOf(result: Promise<{ status: number; body: string }>): Promise<Record<string, unknown>> {
  const { body } = await result;
  return JSON.parse(body) as Record<string, unknown>;
}

test('隔空切磋：签名挑战 → 应战 → 亮随机数 → 两边算出同一场，应答签名验得过', async () => {
  const challenger = generateVisitIdentity();
  const hostIdentity = generateVisitIdentity();
  const guestNonce = 'c'.repeat(64);
  const hostNonce = 'b'.repeat(64);
  let revealed: { nonce: string; line: string } | null = null;
  await withHost(
    {
      identity: hostIdentity,
      duel: async (visitor, card, commit) => {
        assert.equal(visitor.id, challenger.id);
        assert.equal(visitor.owner, me.owner);
        assert.equal(visitor.pet, me.pet);
        assert.deepEqual(card, aCard);
        assert.equal(commit, sparCommit(guestNonce));
        return { ok: true, card: sparCardOf(aFighter, 4), nonce: hostNonce };
      },
      duelReveal: (visitor, nonce, line) => {
        assert.equal(visitor.id, challenger.id);
        revealed = { nonce, line };
      },
      duelConceded: () => assert.fail('不该认输'),
    },
    async (_host, port) => {
      const reply = await sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
        mode: SPAR_MODE,
        card: aCard,
        commit: sparCommit(guestNonce),
      });
      assert.ok(reply.ok, JSON.stringify(reply));
      assert.equal(reply.ok && reply.nonce, hostNonce);
      assert.match(reply.ok ? reply.token : '', /^[0-9a-f]{32}$/);
      // 应战方手里是挑战方的名帖；挑战方手里是应战方的名帖：两边各自算同一场，应战方是 0 号
      const fight = sparFight(aFighter, cardFighter(me.pet, aCard), guestNonce, hostNonce);
      assert.equal(fight[0].kind, 'start');
      assert.equal(fight[0].actor, 0, '应战方是 0 号');
      assert.deepEqual(
        sparFight(
          cardFighter('阿花', reply.ok ? reply.card : aCard),
          cardFighter(me.pet, aCard),
          guestNonce,
          hostNonce,
        ),
        fight,
      );
      const token = reply.ok ? reply.token : '';
      // 感言照台词清洗截断；亮完随机数就开打
      assert.deepEqual(
        await sendDuelReveal({ address: '127.0.0.1', port }, { token, nonce: guestNonce, line: '  你好\u202e呀\n' }),
        { ok: true },
      );
      assert.deepEqual(revealed, { nonce: guestNonce, line: '你好 呀' });
    },
  );
});

test('隔空切磋：不应战、超时都不亮随机数，也不记账', async () => {
  const challenger = generateVisitIdentity();
  const hostIdentity = generateVisitIdentity();
  let answers = 0;
  await withHost(
    {
      identity: hostIdentity,
      duel: async () => {
        answers += 1;
        return { ok: false, reason: 'declined' as const };
      },
      duelReveal: () => assert.fail('不应战时不该开打'),
      duelConceded: () => assert.fail('不应战不记输赢'),
    },
    async (_host, port) => {
      assert.deepEqual(
        await sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
          mode: SPAR_MODE,
          card: aCard,
          commit: sparCommit('c'.repeat(64)),
        }),
        { ok: false, reason: 'declined' },
      );
    },
  );
  assert.equal(answers, 1);

  // 主人一直不点：DUEL_WAIT_MS 到点回 timeout
  await withHost(
    {
      identity: hostIdentity,
      duel: () => new Promise<DuelAnswer>(() => undefined),
      duelWaitMs: 50,
      duelReveal: () => assert.fail('超时不该开打'),
      duelConceded: () => assert.fail('没应战不记输赢'),
    },
    async (_host, port) => {
      assert.deepEqual(
        await sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
          mode: SPAR_MODE,
          card: aCard,
          commit: sparCommit('c'.repeat(64)),
        }),
        { ok: false, reason: 'timeout' },
      );
    },
  );
});

test('隔空切磋：签名不对、没有 id、改过 commit / 名字、拿敲门签名来冒充，都回 bad-sig', async () => {
  const challenger = generateVisitIdentity();
  const hostIdentity = generateVisitIdentity();
  let clock = Date.now();
  await withHost(
    {
      identity: hostIdentity,
      now: () => clock,
      duel: async () => {
        assert.fail('验不过的挑战不该到 handlers.duel');
      },
    },
    async (_host, port) => {
      const send = (tweaks: Parameters<typeof signedDuel>[3] = {}) =>
        bodyOf(
          rawPost(
            port,
            '/v1/duel',
            JSON.stringify(signedDuel(port, challenger, hostIdentity, { ts: clock, ...tweaks })),
          ),
        );
      // 没有 id
      assert.deepEqual(await send({ id: '' }), { ok: false, reason: 'bad-sig' });
      clock += 31_000;
      // 拿敲门的签名来冒充
      assert.deepEqual(
        await send({
          sig: challenger.sign(
            knockMessage({
              hostId: hostIdentity.id,
              address: '127.0.0.1',
              port,
              ts: clock,
              owner: me.owner,
              pet: me.pet,
            }),
          ),
        }),
        { ok: false, reason: 'bad-sig' },
      );
      clock += 31_000;
      // 签的是另一个承诺，发出去的 commit 被改过
      assert.deepEqual(await send({ signCommit: 'd'.repeat(64) }), { ok: false, reason: 'bad-sig' });
      clock += 31_000;
      // 签的是另一个名字
      assert.deepEqual(await send({ signOwner: '小李' }), { ok: false, reason: 'bad-sig' });
    },
  );
});

test('隔空切磋：版本不同、模式不认识、名帖超上限、承诺格式不对，各有各的原因', async () => {
  const challenger = generateVisitIdentity();
  const hostIdentity = generateVisitIdentity();
  let clock = Date.now();
  let asked = 0;
  await withHost(
    {
      identity: hostIdentity,
      now: () => clock,
      duel: async () => {
        asked += 1;
        return { ok: false, reason: 'off' as const };
      },
    },
    async (_host, port) => {
      const send = (tweaks: Parameters<typeof signedDuel>[3] = {}) =>
        bodyOf(
          rawPost(
            port,
            '/v1/duel',
            JSON.stringify(signedDuel(port, challenger, hostIdentity, { ts: clock, ...tweaks })),
          ),
        );
      assert.deepEqual(await send({ mode: 'manual' }), { ok: false, reason: 'unsupported-mode' });
      clock += 31_000;
      assert.deepEqual(await send({ card: { ...aCard, v: BATTLE_VERSION + 1 } }), {
        ok: false,
        reason: 'version',
      });
      clock += 31_000;
      assert.deepEqual(await send({ card: { ...aCard, hp: 9_999 } }), { ok: false, reason: 'bad-card' });
      clock += 31_000;
      assert.deepEqual(await send({ commit: 'nope' }), { ok: false, reason: 'bad-request' });
      assert.equal(asked, 0, '这些请求都没到 handlers.duel');
    },
  );
});

let finishFirst: ((answer: DuelAnswer) => void) | null = null;

test('隔空切磋：同一地址 30 秒内再挑回 too-soon；同时来第二个挑战回 busy', async () => {
  const challenger = generateVisitIdentity();
  const hostIdentity = generateVisitIdentity();
  let clock = Date.now();
  await withHost(
    {
      identity: hostIdentity,
      now: () => clock,
      duel: () => new Promise<DuelAnswer>((resolve) => (finishFirst = resolve)),
    },
    async (_host, port) => {
      const first = sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
        mode: SPAR_MODE,
        card: aCard,
        commit: sparCommit('c'.repeat(64)),
      });
      // 等第一个挑战挂上（handler 被问了才说明已经过了验签）
      await waitUntil(() => finishFirst !== null, '第一个挑战挂上');
      assert.deepEqual(
        await sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
          mode: SPAR_MODE,
          card: aCard,
          commit: sparCommit('d'.repeat(64)),
        }),
        { ok: false, reason: 'busy' },
      );
      finishFirst!({ ok: false, reason: 'declined' });
      assert.deepEqual(await first, { ok: false, reason: 'declined' });
    },
  );

  // 冷却按地址算，和敲门分开：一次已结束的挑战之后，30 秒内再挑回 too-soon
  clock = Date.now();
  await withHost(
    {
      identity: hostIdentity,
      now: () => clock,
      duel: async () => ({ ok: false, reason: 'declined' as const }),
    },
    async (_host, port) => {
      assert.deepEqual(
        await sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
          mode: SPAR_MODE,
          card: aCard,
          commit: sparCommit('c'.repeat(64)),
        }),
        { ok: false, reason: 'declined' },
      );
      assert.deepEqual(
        await sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
          mode: SPAR_MODE,
          card: aCard,
          commit: sparCommit('d'.repeat(64)),
        }),
        { ok: false, reason: 'too-soon' },
      );
      clock += 31_000;
      assert.deepEqual(
        await sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
          mode: SPAR_MODE,
          card: aCard,
          commit: sparCommit('e'.repeat(64)),
        }),
        { ok: false, reason: 'declined' },
      );
    },
  );
});

test('隔空切磋：敲门的冷却不占隔空切磋的（各算各的）', async () => {
  const challenger = generateVisitIdentity();
  const hostIdentity = generateVisitIdentity();
  await withHost(
    {
      identity: hostIdentity,
      knockWaitMs: 50,
      duel: async () => ({ ok: false, reason: 'declined' as const }),
    },
    async (_host, port) => {
      // 敲门没人应：这一下占掉的是敲门的冷却
      assert.deepEqual(await knockOn({ address: '127.0.0.1', port }, me), { ok: false, reason: 'no-answer' });
      // 30 秒内接着隔空切磋：不该被敲门的冷却挡住
      assert.deepEqual(
        await sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
          mode: SPAR_MODE,
          card: aCard,
          commit: sparCommit('c'.repeat(64)),
        }),
        { ok: false, reason: 'declined' },
      );
    },
  );
});

test('隔空切磋：名字先按接待端口径清理再签，空格和半角斜杠也验得上', async () => {
  const challenger = generateVisitIdentity();
  const hostIdentity = generateVisitIdentity();
  let seen = '';
  await withHost(
    {
      identity: hostIdentity,
      duel: async (visitor) => {
        seen = `${visitor.owner}/${visitor.pet}`;
        return { ok: false, reason: 'declined' as const };
      },
    },
    async (_host, port) => {
      assert.deepEqual(
        await sendDuel(
          { address: '127.0.0.1', port },
          hostIdentity.id,
          { owner: ' 小/王 ', pet: '小 鱼' },
          challenger,
          { mode: SPAR_MODE, card: aCard, commit: sparCommit('c'.repeat(64)) },
        ),
        { ok: false, reason: 'declined' },
      );
      // 接待端看到的是 cleanName 之后的名字；签名要是按原样签的，这里根本到不了 handlers.duel
      assert.equal(seen, '小／王/小 鱼');
    },
  );
});

test('隔空切磋：有客人在家、自己不在家时都回 busy', async () => {
  const challenger = generateVisitIdentity();
  const hostIdentity = generateVisitIdentity();
  const ask = (port: number) =>
    sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
      mode: SPAR_MODE,
      card: aCard,
      commit: sparCommit('c'.repeat(64)),
    });
  // 有客人在家：session 占着，协议层直接回 busy
  await withHost({ identity: hostIdentity }, async (host, port) => {
    await knockAndAnswer(host, port, true);
    assert.deepEqual(await ask(port), { ok: false, reason: 'busy' });
  });
  // 主人说不能接待（自己出门了）：canHost 为 false
  await withHost({ identity: hostIdentity, canHost: () => false }, async (_host, port) => {
    assert.deepEqual(await ask(port), { ok: false, reason: 'busy' });
  });
});

test('隔空切磋：reveal 对不上或超时，按挑战方认输；迟到的 reveal 回 late', async () => {
  const challenger = generateVisitIdentity();
  const hostIdentity = generateVisitIdentity();
  const guestNonce = 'c'.repeat(64);
  const calls: string[] = [];
  await withHost(
    {
      identity: hostIdentity,
      duel: async () => ({ ok: true, card: aCard, nonce: 'b'.repeat(64) }),
      duelReveal: () => calls.push('reveal'),
      duelConceded: (_visitor, reason) => calls.push(`conceded ${reason}`),
    },
    async (_host, port) => {
      const reply = await sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
        mode: SPAR_MODE,
        card: aCard,
        commit: sparCommit(guestNonce),
      });
      assert.ok(reply.ok);
      const token = reply.ok ? reply.token : '';
      assert.deepEqual(
        await sendDuelReveal({ address: '127.0.0.1', port }, { token, nonce: 'd'.repeat(64), line: '胡说的' }),
        { ok: false, reason: 'mismatch' },
      );
      assert.deepEqual(calls, ['conceded mismatch']);
      // 这场已经收了：再亮一次就是 not-visiting，不会重复记账
      assert.deepEqual(await sendDuelReveal({ address: '127.0.0.1', port }, { token, nonce: guestNonce, line: '' }), {
        ok: false,
        reason: 'not-visiting',
      });
    },
  );

  // 超时没亮：主人家按挑战方认输；之后迟到的 reveal 回 late
  const lateCalls: string[] = [];
  await withHost(
    {
      identity: hostIdentity,
      duelWaitMs: 50,
      duel: async () => ({ ok: true, card: aCard, nonce: 'b'.repeat(64) }),
      duelReveal: () => lateCalls.push('reveal'),
      duelConceded: (_visitor, reason) => lateCalls.push(`conceded ${reason}`),
    },
    async (_host, port) => {
      const reply = await sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
        mode: SPAR_MODE,
        card: aCard,
        commit: sparCommit(guestNonce),
      });
      assert.ok(reply.ok);
      const token = reply.ok ? reply.token : '';
      await waitUntil(() => lateCalls.includes('conceded late'), '超时认输');
      assert.deepEqual(
        await sendDuelReveal({ address: '127.0.0.1', port }, { token, nonce: guestNonce, line: '迟到的' }),
        { ok: false, reason: 'late' },
      );
      assert.deepEqual(lateCalls, ['conceded late'], '超时只记一次，迟到的 reveal 不再开打');
    },
  );
});

test('隔空切磋：旧对端（404 / 被 session 挡回）映射成 old-host；应答签名验不过当对方没应', async () => {
  const challenger = generateVisitIdentity();
  const hostIdentity = generateVisitIdentity();
  const fakeServer = (reply: (res: import('node:http').ServerResponse) => void) =>
    new Promise<{ server: import('node:http').Server; port: number }>((resolve) => {
      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => reply(res));
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
    });
  const close = (server: import('node:http').Server) =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  const send = (port: number) =>
    sendDuel({ address: '127.0.0.1', port }, hostIdentity.id, me, challenger, {
      mode: SPAR_MODE,
      card: aCard,
      commit: sparCommit('c'.repeat(64)),
    });

  // 旧版本没有 /v1/duel：404 + not-found
  const old = await fakeServer((res) => {
    const payload = JSON.stringify({ ok: false, reason: 'not-found' });
    res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  try {
    assert.deepEqual(await send(old.port), { ok: false, reason: 'old-host' });
  } finally {
    await close(old.server);
  }
  // 老代码会先撞 session 检查回 not-visiting：同样当还不会隔空切磋
  const older = await fakeServer((res) => {
    const payload = JSON.stringify({ ok: false, reason: 'not-visiting' });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  try {
    assert.deepEqual(await send(older.port), { ok: false, reason: 'old-host' });
  } finally {
    await close(older.server);
  }

  // 应战应答的签名验不过（拿假签名 / 别人的公钥）：当对方没应
  const badSig = await fakeServer((res) => {
    const payload = JSON.stringify({
      ok: true,
      card: aCard,
      nonce: 'b'.repeat(64),
      token: 'ab'.repeat(16),
      id: hostIdentity.id,
      pub: hostIdentity.pub,
      sig: 'AAAA',
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  try {
    assert.deepEqual(await send(badSig.port), { ok: false, reason: 'bad-sig' });
  } finally {
    await close(badSig.server);
  }
  // 应答里的公钥不是那个 id 的：同样不认
  const stranger = await fakeServer((res) => {
    const payload = JSON.stringify({
      ok: true,
      card: aCard,
      nonce: 'b'.repeat(64),
      token: 'ab'.repeat(16),
      id: hostIdentity.id,
      pub: generateVisitIdentity().pub,
      sig: 'AAAA',
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  try {
    assert.deepEqual(await send(stranger.port), { ok: false, reason: 'bad-sig' });
  } finally {
    await close(stranger.server);
  }
});

// ---------- 逐手对传（X19） ----------

test('parseSparAction / parseTurnIndex：只认图鉴里的编号，序号从 0 起', () => {
  assert.deepEqual(parseSparAction({ kind: 'weapon', weapon: 'water-gun' }), { kind: 'weapon', weapon: 'water-gun' });
  assert.deepEqual(parseSparAction({ kind: 'unarmed' }), { kind: 'unarmed' });
  assert.deepEqual(parseSparAction({ kind: 'skill', skill: 'dove' }), { kind: 'skill', skill: 'dove' });
  assert.equal(parseSparAction({ kind: 'weapon', weapon: 'nope' }), null);
  assert.equal(parseSparAction({ kind: 'skill', skill: 'nope' }), null);
  assert.equal(parseSparAction('unarmed'), null);
  assert.equal(parseSparAction(null), null);
  assert.equal(parseTurnIndex(0), 0);
  assert.equal(parseTurnIndex(12), 12);
  assert.equal(parseTurnIndex(-1), null);
  assert.equal(parseTurnIndex(1.5), null);
  assert.equal(parseTurnIndex('0'), null);
  assert.equal(parseTurnIndex(10_000), null);
});

test('逐手局：两边走 /v1/spar/turn 对传，算出同一串事件；坏令牌、坏形状都被拒', async () => {
  const silent: ShowSides = {
    self: { play: () => undefined, say: () => undefined },
    foe: { play: () => undefined, say: () => undefined },
    arena: () => undefined,
    shoot: () => undefined,
  };
  const guestNonce = 'c'.repeat(64);
  const hostNonce = 'b'.repeat(64);
  const seed = `${guestNonce}:${hostNonce}`;
  let live: LiveVersus | null = null;
  let sawLive: boolean | null = null;
  await withHost(
    {
      spar: async (_visitor, _card, _commit, isLive) => {
        sawLive = isLive === true;
        return { ok: true, card: sparCardOf(aFighter, 4), nonce: hostNonce };
      },
      reveal: async () => ({ ok: true }),
      sparTurn: async (_visitor, index, action) => {
        assert.ok(live, '先亮随机数才有一手');
        return live!.turn(index, action);
      },
    },
    async (host, port) => {
      const target = { address: '127.0.0.1', port };
      const [answer] = await knockAndAnswer(host, port, true);
      const token = answer.ok ? answer.token : '';
      const reply = await sendSpar(target, {
        token,
        mode: SPAR_LIVE_MODE,
        card: aCard,
        commit: sparCommit(guestNonce),
      });
      assert.ok(reply.ok, `逐手切磋应战没成：${JSON.stringify(reply)}`);
      assert.equal(sawLive, true, 'mode: live 传到了 handlers.spar');
      assert.deepEqual(await sendReveal(target, { token, nonce: guestNonce, line: '' }), { ok: true });
      // 坏令牌 / 坏出手形状都在协议层挡掉（不会递进这一场）
      assert.deepEqual(await sendSparTurn(target, { token: '0'.repeat(32), index: 0 }), {
        ok: false,
        reason: 'not-visiting',
      });
      assert.deepEqual(
        await sendSparTurn(target, { token, index: 0, action: { kind: 'weapon', weapon: 'nope' } as never }),
        { ok: false, reason: 'bad-request' },
      );
      // 应战方（主人家）这一侧按后备挑法出；发起方（客人）这一侧也走同一套驱动
      live = startLiveServer({
        a: cardFighter('小鱼', reply.ok ? reply.card : aCard),
        b: { ...aFighter, name: '小王' },
        seed,
        local: 0,
        show: silent,
        lineRng: rngFrom(`${seed}:lines`),
        decide: async () => null,
        think: () => undefined,
        log: () => undefined,
        waitMs: 2_000,
      });
      live.skip();
      const client = startLiveClient({
        a: cardFighter('小鱼', reply.ok ? reply.card : aCard),
        b: { ...aFighter, name: '小王' },
        seed,
        local: 1,
        show: silent,
        lineRng: rngFrom(`${seed}:lines`),
        decide: async () => null,
        think: () => undefined,
        log: () => undefined,
        waitMs: 2_000,
        sendTurn: (body, signal) => sendSparTurn(target, { token, ...body }, signal),
      });
      client.skip();
      const [clientEvents, serverEvents] = await Promise.all([client.done, live.done]);
      assert.ok(clientEvents, '发起方打完了');
      assert.ok(serverEvents, '应战方打完了');
      assert.deepEqual(clientEvents, serverEvents, '两边逐条事件相同');
    },
  );
});

test('逐手局：对面出的招不合法、等超时，都按掉线', async () => {
  // 这一条在 battle-live.test.ts 里按驱动测过；这里核 features 的出口能拿到同样的原因
  let illegal: Awaited<ReturnType<typeof sendSparTurn>> | undefined;
  await withHost(
    {
      spar: async () => ({ ok: true, card: sparCardOf(aFighter, 4), nonce: 'b'.repeat(64) }),
      reveal: async () => ({ ok: true }),
      sparTurn: async () => ({ ok: false, reason: 'illegal' }),
    },
    async (_host, port) => {
      const target = { address: '127.0.0.1', port };
      const [answer] = await knockAndAnswer(_host, port, true);
      const token = answer.ok ? answer.token : '';
      await sendSpar(target, { token, mode: SPAR_LIVE_MODE, card: aCard, commit: sparCommit('c'.repeat(64)) });
      await sendReveal(target, { token, nonce: 'c'.repeat(64), line: '' });
      illegal = await sendSparTurn(target, { token, index: 0, action: { kind: 'weapon', weapon: 'poker' } });
    },
  );
  assert.deepEqual(illegal, { ok: false, reason: 'illegal' });
});

test('逐手局协议：forfeit 经 /v1/spar/turn 结构校验后递给 sparTurn，应答带回认输通知', async () => {
  const seen: Array<{ index: number; action: unknown; forfeit: boolean | undefined }> = [];
  await withHost(
    {
      spar: async () => ({ ok: true, card: sparCardOf(aFighter, 4), nonce: 'b'.repeat(64) }),
      reveal: async () => ({ ok: true }),
      sparTurn: async (_visitor, index, action, forfeit) => {
        seen.push({ index, action, forfeit });
        return { ok: true, forfeit: true };
      },
    },
    async (host, port) => {
      const target = { address: '127.0.0.1', port };
      const [answer] = await knockAndAnswer(host, port, true);
      const token = answer.ok ? answer.token : '';
      await sendSpar(target, { token, mode: SPAR_LIVE_MODE, card: aCard, commit: sparCommit('c'.repeat(64)) });
      await sendReveal(target, { token, nonce: 'c'.repeat(64), line: '' });

      assert.deepEqual(await sendSparTurn(target, { token, index: 2, forfeit: true }), {
        ok: true,
        forfeit: true,
      });
      assert.deepEqual(seen, [{ index: 2, action: undefined, forfeit: true }]);

      // 认输不能夹带出手；forfeit 只认布尔值。结构不对的不会递进这一场
      assert.deepEqual(await sendSparTurn(target, { token, index: 2, forfeit: true, action: { kind: 'unarmed' } }), {
        ok: false,
        reason: 'bad-request',
      });
      assert.deepEqual(await sendSparTurn(target, { token, index: 2, forfeit: 'yes' as never }), {
        ok: false,
        reason: 'bad-request',
      });
      assert.equal(seen.length, 1);
    },
  );
});

test('隔空切磋逐手局协议：forfeit 标记同样过 turnBody 校验并带回认输通知', async () => {
  const hostIdentity = generateVisitIdentity();
  const challenger = generateVisitIdentity();
  const hostNonce = 'b'.repeat(64);
  const seen: Array<{ index: number; action: unknown; forfeit: boolean | undefined }> = [];
  await withHost(
    {
      identity: hostIdentity,
      duel: async () => ({ ok: true, card: sparCardOf(aFighter, 4), nonce: hostNonce }),
      duelReveal: () => undefined,
      duelTurn: async (_visitor, index, action, forfeit) => {
        seen.push({ index, action, forfeit });
        return { ok: true, forfeit: true };
      },
    },
    async (_host, port) => {
      const target = { address: '127.0.0.1', port };
      const reply = await sendDuel(target, hostIdentity.id, me, challenger, {
        mode: SPAR_LIVE_MODE,
        card: aCard,
        commit: sparCommit('c'.repeat(64)),
      });
      assert.ok(reply.ok, `逐手挑战没应：${JSON.stringify(reply)}`);
      const token = reply.ok ? reply.token : '';
      assert.deepEqual(await sendDuelReveal(target, { token, nonce: 'c'.repeat(64), line: '' }), { ok: true });
      assert.deepEqual(await sendDuelTurn(target, { token, index: 0, forfeit: true }), {
        ok: true,
        forfeit: true,
      });
      assert.deepEqual(seen, [{ index: 0, action: undefined, forfeit: true }]);
      assert.deepEqual(await sendDuelTurn(target, { token, index: 0, forfeit: true, action: { kind: 'unarmed' } }), {
        ok: false,
        reason: 'bad-request',
      });
      assert.equal(seen.length, 1);
    },
  );
});

test('隔空切磋逐手局：/v1/duel/turn 用应战后留着的令牌；自动局 reveal 后会话收掉', async () => {
  const hostIdentity = generateVisitIdentity();
  const challenger = generateVisitIdentity();
  const hostNonce = 'b'.repeat(64);
  const guestNonce = 'c'.repeat(64);
  let live = false;
  await withHost(
    {
      identity: hostIdentity,
      duel: async (_visitor, _card, _commit, isLive) => {
        live = isLive === true;
        return { ok: true, card: sparCardOf(aFighter, 4), nonce: hostNonce };
      },
      duelReveal: () => undefined,
      duelTurn: async (_visitor, index) =>
        index === 0 ? { ok: true, action: { kind: 'weapon', weapon: 'poker' } } : { ok: true },
    },
    async (_host, port) => {
      const target = { address: '127.0.0.1', port };
      const liveReply = await sendDuel(target, hostIdentity.id, me, challenger, {
        mode: SPAR_LIVE_MODE,
        card: aCard,
        commit: sparCommit(guestNonce),
      });
      assert.ok(liveReply.ok, `逐手挑战没应：${JSON.stringify(liveReply)}`);
      assert.equal(live, true);
      const token = liveReply.ok ? liveReply.token : '';
      assert.deepEqual(await sendDuelReveal(target, { token, nonce: guestNonce, line: '' }), { ok: true });
      // 令牌错了不认；对了才递进 handlers.duelTurn
      assert.deepEqual(await sendDuelTurn(target, { token: '0'.repeat(32), index: 0 }), {
        ok: false,
        reason: 'not-visiting',
      });
      assert.deepEqual(await sendDuelTurn(target, { token, index: 0 }), {
        ok: true,
        action: { kind: 'weapon', weapon: 'poker' },
      });
    },
  );

  // 自动局：reveal 之后不再留会话，/v1/duel/turn 回 not-visiting
  await withHost(
    {
      identity: hostIdentity,
      duel: async () => ({ ok: true, card: sparCardOf(aFighter, 4), nonce: hostNonce }),
      duelReveal: () => undefined,
    },
    async (_host, port) => {
      const target = { address: '127.0.0.1', port };
      const reply = await sendDuel(target, hostIdentity.id, me, challenger, {
        mode: SPAR_MODE,
        card: aCard,
        commit: sparCommit('d'.repeat(64)),
      });
      assert.ok(reply.ok);
      const token = reply.ok ? reply.token : '';
      await sendDuelReveal(target, { token, nonce: 'd'.repeat(64), line: '' });
      assert.deepEqual(await sendDuelTurn(target, { token, index: 0 }), {
        ok: false,
        reason: 'not-visiting',
      });
    },
  );
});
