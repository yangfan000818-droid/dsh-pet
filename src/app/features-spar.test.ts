import { timeline, swapSides } from './battle-show.ts';
import { fairSparPair } from './battle.ts';
import {
  FAREWELL_WAIT_MS,
  guestFarewellDiary,
  hostFarewellDiary,
  hostFarewellPrompt,
  hostFarewellSend,
} from './features/spar.ts';
import { diaryDate } from './diary.ts';
import type { DiaryDay } from './diary.ts';
import {
  windows,
  freeUdpPort,
  deferred,
  withFeatures,
  visitConfig,
  cultivationEarly,
  emitPetBounds,
  knockIn,
  until,
  guestCard,
  hostFighter,
  petNameIn,
  cultivationSave,
  windowOn,
  memeAsks,
  env,
  TEST_APP_CONFIG,
  last,
  neighborRecord,
  hostedApp,
  fightCount,
  fakeDuelHost,
  pickPanel,
} from './features-testkit.ts';
import { generateVisitIdentity } from './visit-identity.ts';
import {
  tripRequest,
  randomSparNonce,
  sendSpar,
  SPAR_MODE,
  sparCommit,
  sendReveal,
  sparFight,
  cardFighter,
  sparLineRng,
  sparCardOf,
  VisitHost,
  encodeBeacon,
  sendDuel,
  sendDuelReveal,
  SPAR_LIVE_MODE,
} from './visit.ts';
import type { SparCard } from './visit.ts';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('切磋（主人家）：旧客人开口的全自动局 → 应战 → 亮随机数 → 演出与擂台 → 修为、战绩、邻居簿、日记都记上', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const beaconPort = await freeUdpPort();
  // 自家感言卡在 compose 上不返回（§X14）：窗口和菜单不等它
  const gate = deferred();
  try {
    await withFeatures(
      {
        config: visitConfig(),
        cultivation: cultivationEarly(),
        clicks,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (_features, said, bodies, home, extras) => {
        const { menus } = extras;
        // 真机上 helper 会一直报自家宠物位置；先报一次，特效层才摆得出来
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        const { port, token } = await knockIn(home, clicks, extras);
        // 切磋的菜单项有了（开着修炼、客人在、验证过身份、没在打）
        await until(() => menus.some((labels) => labels.includes('串门/和客人切磋')), '切磋菜单项');
        // 主人家邀的一律是逐手局（X19）：全自动局只剩旧客人自己开口这一种，照旧应战、整场算好；
        // 正在打时再来一发是 busy
        const ownNonce = randomSparNonce();
        const ask = () =>
          sendSpar(
            { address: '127.0.0.1', port },
            { token, mode: SPAR_MODE, card: guestCard(), commit: sparCommit(ownNonce) },
          );
        const reply = await ask();
        assert.ok(reply.ok, `应战没成：${JSON.stringify(reply)}`);
        const hostNonce = reply.ok ? reply.nonce : '';
        assert.deepEqual(await ask(), { ok: false, reason: 'busy' });
        // 亮随机数 → 开打（两边各自算同一场，赢家照这边自己的口径复核）
        assert.deepEqual(
          await sendReveal({ address: '127.0.0.1', port }, { token, nonce: ownNonce, line: '承让承让～' }),
          { ok: true },
        );
        const [zero, one] = fairSparPair(hostFighter, cardFighter('阿花', guestCard()));
        const fightEvents = sparFight(zero, one, ownNonce, hostNonce);
        const fightEnd = fightEvents[fightEvents.length - 1]!;
        const won = fightEnd.kind === 'end' && fightEnd.winner === 0;
        // 主人家这边的解说也用 sparLineRng（X12）：复算一遍时间线，自己那一方的第一句要在 /broadcast 里出现
        const expectedSteps = timeline(fightEvents, [petNameIn(home), '阿花'], sparLineRng(ownNonce, hostNonce), [
          zero.skills,
          one.skills,
        ]);
        const ownLine = expectedSteps.find((step) => step.line && step.who === 0)?.line;
        const firstLine = ownLine ?? expectedSteps.find((step) => step.line)?.line;
        assert.ok(firstLine, '这一场排出了解说台词');
        // 这边的账：战绩 +1、修为进账（anim:false 的冒泡）、邻居簿、日记
        await until(() => {
          const record = cultivationSave(home)?.record as { wins: number; losses: number } | undefined;
          return record !== undefined && record.wins + record.losses === 1;
        }, '战绩记上了');
        const record = cultivationSave(home)!.record as { wins: number; losses: number };
        assert.equal(won ? record.wins : record.losses, 1, '输赢跟两边各自算的那场一致');
        assert.ok((cultivationSave(home)!.progress as number) > 0, '修为进了账');
        const book = JSON.parse(readFileSync(join(home, 'neighbors.json'), 'utf8')) as {
          neighbors: Array<Record<string, unknown>>;
        };
        assert.equal(book.neighbors.length, 1);
        assert.equal(book.neighbors[0][won ? 'sparWins' : 'sparLosses'], 1, '邻居簿记了切磋账');
        assert.equal(book.neighbors[0].lastSparWon, won, '上次切磋的输赢留给见面提');
        const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
        assert.ok(
          day.events.some((event) => event.kind === 'cultivate' && /切磋/.test(event.text)),
          '记了日记',
        );
        // 演出：擂台开了、客人窗口照旧粉色、打的时候菜单换成快进
        await until(() => windowOn('/app/arena') !== undefined, '擂台开了', 400);
        const guest = windowOn('/app/guest');
        const arenaWin = windowOn('/app/arena');
        const fxWin = windowOn('/app/fx');
        assert.ok(guest, '客人窗口在');
        assert.ok(arenaWin, '擂台在');
        assert.ok(fxWin, '特效层在');
        assert.ok(!guest!.calls.some((code) => code.includes('"shadow"')), '切磋的客人窗口不是心魔配色');
        await until(() => menus.some((labels) => labels.includes('修炼/快进')), '打的时候换成快进');
        await until(
          () =>
            ownLine !== undefined
              ? bodies.some((body) => body.anim === false && body.text === ownLine)
              : guest!.calls.some((code) => code.startsWith('guest.say(') && code.includes(firstLine)),
          '主人家也按 sparLineRng 挑台词（复算的第一句出现在对应的那一侧）',
          1000,
        );
        // 快进收场：客人的感言（跟着 reveal 带来的）上了客人窗口、自家感言走 compose。
        // 让自家的 compose 卡住不返回（§X14）：前面的招呼等人设台词都已经说完，这里只卡赛后感言
        const asksBefore = memeAsks.length;
        env.memeHold = gate.promise;
        env.memeAnswer = '切磋后的感言～';
        clicks.push('修炼/快进');
        await until(
          () => guest!.calls.some((code) => code.startsWith('guest.say(') && code.includes('承让承让')),
          '客人的感言上了客人窗口',
          400,
        );
        await until(() => memeAsks.slice(asksBefore).some((ask) => /切磋/.test(ask)), '自家感言走 compose', 400);
        // 收摊不等模型（§X14）：compose 还卡着，擂台上这一场的窗口已经按 CLOSE_HOLD_MS 关掉
        // （客人窗口属于这趟串门，客人还在就留着，不是切磋的 window 组）
        await until(() => arenaWin!.destroyed && fxWin!.destroyed, '窗口不等感言就关', 400);
        assert.ok(!said.some((text) => text.includes('切磋后的感言～')), '感言还没回来');
        // 菜单同样不等感言——必须看**最新**一帧（some 扫历史会被开打前的快照满足，真机 battle
        // 残留的 bug 就是从这漏过去的）：快进消失、切磋项回来了
        await until(
          () => {
            const latest = menus[menus.length - 1] ?? [];
            return latest.includes('串门/和客人切磋') && !latest.includes('修炼/快进');
          },
          '打完菜单收回来（battle 清零、快进消失）',
          400,
        );
        // 放开 compose：自家感言照说
        gate.resolve();
        await until(() => said.some((text) => text.includes('切磋后的感言～')), '放开后自家感言说出来了', 400);
      },
    );
  } finally {
    env.memeHold = null;
    env.memeAnswer = '无';
    gate.resolve();
  }
});

test('切磋（主人家）：客人开打前直接弹应战确认，点不应战就回 declined', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const beaconPort = await freeUdpPort();
  await withFeatures(
    {
      config: visitConfig(),
      cultivation: cultivationEarly(),
      clicks,
      modeTimeoutMs: 2_000,
      beacon: { port: beaconPort, targets: () => [] },
    },
    async (features, _said, _bodies, home, extras) => {
      const { port, token } = await knockIn(home, clicks, extras);
      const target = { address: '127.0.0.1', port };
      const asking = sendSpar(target, {
        token,
        mode: SPAR_LIVE_MODE,
        card: guestCard(),
        commit: sparCommit('c'.repeat(64)),
      });
      await until(() => features.battle.state() !== null, '切磋应战确认面板');
      const prompt = features.battle.state()!;
      assert.match(prompt.title, /阿花 想跟你切磋/);
      assert.deepEqual(
        prompt.options.map((option) => option.label),
        ['自动', 'AI 出招', '手动', '不应战'],
      );
      assert.equal(features.battle.choose(4), true, '面板上直接点不应战');
      assert.deepEqual(await asking, { ok: false, reason: 'declined' });
      assert.equal(windowOn('/app/arena'), undefined, '没开擂台');
    },
  );
});

test('切磋：随机数对不上、超时没亮、邀约没人接，各按各的口径收场（不开打、没有擂台）', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const beaconPort = await freeUdpPort();
  await withFeatures(
    {
      config: visitConfig(),
      cultivation: cultivationEarly(),
      clicks,
      sparWaitMs: 300,
      beacon: { port: beaconPort, targets: () => [] },
    },
    async (features, said, _bodies, home, extras) => {
      const { menus } = extras;
      const { port, token } = await knockIn(home, clicks, extras);
      const target = { address: '127.0.0.1', port };
      // 邀约没人接：过了时限收摊，说一句没接招
      await until(() => menus.some((labels) => labels.includes('串门/和客人切磋')));
      clicks.push('串门/和客人切磋');
      await pickPanel(features, 1, '串门切磋方式');
      await until(() => said.some((text) => text.includes('过两招')), '开场那句');
      // 主人选的是自动，邀的照样是逐手局：客人也能在它自己的面板里选
      const ping = await tripRequest(target, '/v1/ping', { token });
      assert.ok(
        ping.ok && ping.events.some((event) => event.type === 'spar-invite' && event.mode === 'live'),
        '邀约带 mode: live',
      );
      await until(() => said.some((text) => text.includes('没接招')), '邀约超时收摊');
      // 应战 → 亮的随机数对不上：按客人认输记（这边的战绩是赢），应答如实说 mismatch
      const reply = await sendSpar(target, {
        token,
        mode: SPAR_MODE,
        card: guestCard(),
        commit: sparCommit('c'.repeat(64)),
      });
      assert.ok(reply.ok, `应战没成：${JSON.stringify(reply)}`);
      assert.deepEqual(await sendReveal(target, { token, nonce: 'd'.repeat(64), line: '胡说的' }), {
        ok: false,
        reason: 'mismatch',
      });
      await until(() => (cultivationSave(home)?.record as { wins: number }).wins === 1, '认输记成赢');
      // 没开打：没有擂台、没有快进、客人那句「感言」也没上屏
      await new Promise((done) => setTimeout(done, 200));
      assert.equal(windowOn('/app/arena'), undefined, '没开擂台');
      assert.ok(
        menus.every((labels) => !labels.includes('修炼/快进')),
        '没开打',
      );
      assert.ok(!windowOn('/app/guest')!.calls.some((code) => code.includes('胡说的')), '没核上承诺的感言不上屏');
      await until(() => said.some((text) => text.includes('算它认输')), '说了认输');
      // 再来一场，超时才亮：同样按认输记
      const again = await sendSpar(target, {
        token,
        mode: SPAR_MODE,
        card: guestCard(),
        commit: sparCommit('c'.repeat(64)),
      });
      assert.ok(again.ok);
      await new Promise((done) => setTimeout(done, 500));
      assert.deepEqual(await sendReveal(target, { token, nonce: 'c'.repeat(64), line: '迟到的' }), {
        ok: false,
        reason: 'late',
      });
      await until(() => (cultivationSave(home)?.record as { wins: number }).wins === 2, '超时也是认输');
    },
  );
});

test('切磋（客人）：旧主人家邀的全自动局 → 应战、亮随机数 → 自家屏幕上演全套、账记上、没被叫回家、回家收窗', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const config = structuredClone(TEST_APP_CONFIG);
  config.visit.enabled = true;
  config.visit.visiting = true;
  // 假主人家（跟 dev/visit-peer.mjs 的 host 模式同一套）：应战用一份假名帖，随机数是固定的
  const HOST_NONCE = 'b'.repeat(64);
  const fakeCard = sparCardOf(
    { name: '大个', hp: 70, power: 8, agility: 6, speed: 6, weapons: ['top'], skills: ['shadow-fists'] },
    3,
  );
  const fakeId = 'f'.repeat(32);
  const saw: { card: SparCard | null; commit: string | null; nonce: string | null; line: string | null } = {
    card: null,
    commit: null,
    nonce: null,
    line: null,
  };
  const fake = new VisitHost(
    {
      canHost: () => true,
      knocked: (visitor) => {
        setTimeout(() => fake.answer(true), 50);
        assert.ok(visitor);
      },
      knockEnded: () => undefined,
      line: () => Promise.resolve('欢迎欢迎，随便玩呀～'),
      note: () => false,
      async spar(_visitor, card, commit) {
        saw.card = card;
        saw.commit = commit;
        return { ok: true, card: fakeCard, nonce: HOST_NONCE };
      },
      async reveal(_visitor, nonce, line) {
        saw.nonce = nonce;
        saw.line = line;
        return sparCommit(nonce) === saw.commit ? { ok: true } : { ok: false, reason: 'mismatch' };
      },
      // 隔空切磋不在这条用例里测：默认不应战
      duel: async () => ({ ok: false, reason: 'off' as const }),
      duelReveal: () => undefined,
      duelConceded: () => undefined,
      left: () => undefined,
    },
    { log: () => undefined },
  );
  const fakePort = await fake.listen('127.0.0.1');
  const beaconPort = await freeUdpPort();
  // 信标：让 features 听见这位邻居（beacon 旋钮把 features 的信标绑到测试自己的端口）
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const beaconPayload = encodeBeacon({ id: fakeId, owner: '测试邻居', pet: '大个', port: fakePort });
  const sendBeacon = () => beacon.send(beaconPayload, beaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const beaconTimer = setInterval(sendBeacon, 500);
  try {
    await withFeatures(
      { config, cultivation: cultivationEarly(), clicks, beacon: { port: beaconPort, targets: () => [] } },
      async (_features, said, bodies, home, extras) => {
        const { menus } = extras;
        // 真机上 helper 会一直报自家宠物位置；先报一次，切磋的特效层才摆得出来
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        await until(
          () => menus.some((labels) => labels.some((label) => label.startsWith('串门/去 '))),
          '信标听见了邻居（菜单要等下一拍才重注册）',
          400,
        );
        clicks.push('串门/去 测试邻居 家');
        await until(() => menus.some((labels) => labels.includes('串门/找主人家的宠物切磋')), '进了门、切磋项出现');
        // 自己开口的一律是逐手局（X19）：全自动局只剩旧主人家邀的这一种（邀约不带 mode），客人不弹面板、直接应战
        assert.ok(fake.tell({ type: 'spar-invite' }), '邀约攒进出风箱');
        // 客人发来名帖与承诺，接着亮随机数（带一句按人设编的感言）
        // 邀约跟着下一次报平安（PING_MS）才到客人那边
        await until(() => saw.card !== null, '切磋请求送到了主人家', 400);
        await until(() => saw.nonce !== null, '亮了随机数');
        assert.equal(saw.line, env.memeAnswer, '感言走 compose（假模型的回答，不是兜底模板）');
        // 账：测试拿同一对随机数复核这场谁赢，客人的记录必须一致
        const [away, own] = fairSparPair(cardFighter('大个', fakeCard), hostFighter);
        const expected = sparFight(away, own, saw.nonce!, HOST_NONCE);
        const expectedEnd = expected[expected.length - 1]!;
        const won = expectedEnd.kind === 'end' && expectedEnd.winner === 1;
        // 两边台词用同一颗种子（X12）：客人这边换边后的时间线里，第一句要在自己的 /broadcast 里出现
        const guestSteps = swapSides(
          timeline(expected, ['大个', petNameIn(home)], sparLineRng(saw.nonce!, HOST_NONCE), [away.skills, own.skills]),
        );
        const ownGuestLine = guestSteps.find((step) => step.line && step.who === 0)?.line;
        const firstGuestLine = ownGuestLine ?? guestSteps.find((step) => step.line)?.line;
        assert.ok(firstGuestLine, '这一场排出了解说台词');
        await until(() => {
          const record = cultivationSave(home)?.record as { wins: number; losses: number } | undefined;
          return record !== undefined && record.wins + record.losses === 1;
        }, '客人这边记了账');
        const record = cultivationSave(home)!.record as { wins: number; losses: number };
        assert.equal(won ? record.wins : record.losses, 1, '输赢跟两边各自算的那场一致');
        assert.ok((cultivationSave(home)!.progress as number) > 0, '修为进了账（relay，不叫回家）');
        const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
        assert.ok(
          day.events.some((event) => event.kind === 'cultivate' && /切磋/.test(event.text)),
          '记了日记',
        );
        // 转播：开场那句、台词、结果都是 anim:false 的气泡（转播排队，每条至少占 RELAY_MIN_MS：
        // 邀约跟着报平安才到，开场那句排在进门的两句聊天后面）
        await until(
          () => bodies.some((body) => body.anim === false && String(body.text).includes('过两招')),
          '开场那句转播了',
          600,
        );
        await until(() => menus.some((labels) => labels.includes('修炼/快进')), '转播中可快进');
        // 自家屏幕上也是全套（X12）：对手窗口（粉色、名牌是主人家的）、擂台、特效层
        await until(
          () =>
            windowOn('/app/guest') !== undefined &&
            windowOn('/app/arena') !== undefined &&
            windowOn('/app/fx') !== undefined,
          '客人这边的三扇窗',
          400,
        );
        const foeWindow = windowOn('/app/guest')!;
        const arena = windowOn('/app/arena')!;
        const fx = windowOn('/app/fx')!;
        await until(
          () => foeWindow.calls.some((code) => code.startsWith('guest.arrive(') && code.includes('测试邻居')),
          '对手窗口名牌是主人家的',
        );
        assert.ok(!foeWindow.calls.some((code) => code.includes('"shadow"')), '客人这边的对手窗口照旧粉色');
        await until(() => foeWindow.calls.some((code) => code.startsWith('guest.play(')), '主人家的宠物按时间线播动画');
        // 自家宠物走 /anim 的 url 形态、带朝向（面朝对手）
        await until(
          () =>
            extras.anims.some(
              (anim) => String(anim.url ?? '').includes(encodeURIComponent('战斗-起手')) && anim.facing !== undefined,
            ),
          '自家宠物播 url 形态的动画、带朝向',
          400,
        );
        // 开演前占住宠物（和心魔试炼同一把锁），演完（快进也算）才放
        const hold = extras.requests.findIndex((request) => request.path === '/lock');
        assert.ok(hold >= 0, '开演前拿了锁');
        assert.ok(hold < extras.requests.findIndex((request) => request.path === '/anim'), '拿锁在自家第一段动画之前');
        await until(() => arena.calls.some((code) => code.startsWith('arena.update(')), '擂台按时间线刷气血');
        assert.ok(
          arena.calls.some((code) => code.includes('"大个')),
          `擂台对手那条是主人家的宠物：${last(arena.calls)}`,
        );
        // 快进之前先等到复算出来的第一句台词：自己的走 /broadcast，对手的走对手窗口（同一颗台词种子）
        await until(
          () =>
            ownGuestLine !== undefined
              ? bodies.some((body) => body.anim === false && body.text === ownGuestLine)
              : foeWindow.calls.some((code) => code.startsWith('guest.say(') && code.includes(firstGuestLine)),
          '客人这边也按 sparLineRng 挑台词（复算的第一句出现在对应的那一侧）',
          1000,
        );
        clicks.push('修炼/快进');
        await until(() => extras.requests.some((request) => request.path === '/lock/release'), '演完放锁', 400);
        await until(
          () => bodies.some((body) => body.anim === false && String(body.text).startsWith('（切磋）这场')),
          '结果转播了',
          1000,
        );
        // 没被叫回家：还在别人家
        await until(() => menus.some((labels) => labels.includes('从 测试邻居 家回来')), '还在别人家做客');
        assert.ok(
          said.every((text) => !text.includes('我从 测试邻居 家回来')),
          '转播不走 say',
        );
        // 回家：对手窗口、擂台、特效层一起立刻关（漏一个，测试进程就会被那两个 interval 挂住）
        clicks.push('从 测试邻居 家回来');
        await until(() => foeWindow.destroyed && arena.destroyed && fx.destroyed, '回家后三个窗口都销毁了', 400);
      },
    );
  } finally {
    clearInterval(beaconTimer);
    beacon.close();
    await fake.close();
  }
});

test('隔空切磋（应战方）：冒话、两个菜单项 → 点应战 → 三扇窗、拿锁、记账、日记 → 收摊全关', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const beaconPort = await freeUdpPort();
  const challenger = generateVisitIdentity();
  const ownNonce = 'c'.repeat(64);
  const card = guestCard();
  try {
    await withFeatures(
      {
        config: visitConfig(),
        cultivation: cultivationEarly(),
        neighbors: { neighbors: [neighborRecord(challenger.id, '小李', '阿花')] },
        clicks,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (_features, said, _bodies, home, extras) => {
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        const { port, hostId } = await hostedApp(home, extras);
        const asking = sendDuel({ address: '127.0.0.1', port }, hostId, { owner: '小李', pet: '阿花' }, challenger, {
          mode: SPAR_MODE,
          card,
          commit: sparCommit(ownNonce),
        });
        // 冒话 + 两项应答（和敲门的「让进 / 不让进」同一优先级，不能被菜单截掉）
        await until(() => said.some((text) => text.includes('小李 家的 阿花 想跟我切磋')), '冒话');
        await until(() => {
          const latest = extras.menus[extras.menus.length - 1] ?? [];
          return latest.includes('修炼/应战：小李 家的 阿花') && latest.includes('修炼/不应战');
        }, '两个应答项');
        clicks.push('修炼/应战：小李 家的 阿花');
        const reply = await asking;
        assert.ok(reply.ok, `应战没成：${JSON.stringify(reply)}`);
        assert.deepEqual(reply.ok ? reply.card : null, sparCardOf(hostFighter, 0), '应战方回自己的名帖');
        const hostNonce = reply.ok ? reply.nonce : '';
        // 亮随机数 → 开打；两边各自算同一场（应战方 0 号）
        assert.deepEqual(
          await sendDuelReveal(
            { address: '127.0.0.1', port },
            { token: reply.ok ? reply.token : '', nonce: ownNonce, line: '承让承让～' },
          ),
          { ok: true },
        );
        const [zero, one] = fairSparPair(hostFighter, cardFighter('阿花', card));
        const expected = sparFight(zero, one, ownNonce, hostNonce);
        const end = expected[expected.length - 1]!;
        const won = end.kind === 'end' && end.winner === 0;
        // 这边的账：修为进账、战绩、邻居簿、日记（都是开打那一步记的）
        await until(() => fightCount(home) === 1, '战绩记上了');
        const record = cultivationSave(home)!.record as { wins: number; losses: number };
        assert.equal(won ? record.wins : record.losses, 1, '输赢跟两边各自算的那场一致');
        assert.ok((cultivationSave(home)!.progress as number) > 0, '修为进了账');
        const book = JSON.parse(readFileSync(join(home, 'neighbors.json'), 'utf8')) as {
          neighbors: Array<Record<string, unknown>>;
        };
        assert.equal(book.neighbors[0][won ? 'sparWins' : 'sparLosses'], 1, '邻居簿记了隔空切磋账');
        assert.equal(book.neighbors[0].lastSparWon, won);
        await until(() => {
          const path = join(home, 'diary', `${diaryDate(Date.now())}.json`);
          if (!existsSync(path)) return false;
          const day = JSON.parse(readFileSync(path, 'utf8')) as DiaryDay;
          return day.events.some((event) => event.kind === 'cultivate' && event.text.includes('隔空切磋'));
        }, '记了日记');
        // 演出：三扇窗、对手名牌、自家宠物播 url 形态的动画、占锁、快进
        await until(
          () =>
            windowOn('/app/guest') !== undefined &&
            windowOn('/app/arena') !== undefined &&
            windowOn('/app/fx') !== undefined,
          '三扇窗',
          400,
        );
        const foe = windowOn('/app/guest')!;
        const arena = windowOn('/app/arena')!;
        const fx = windowOn('/app/fx')!;
        await until(
          () => foe.calls.some((code) => code.startsWith('guest.arrive(') && code.includes('小李')),
          '对手窗口名牌是挑战方的',
        );
        await until(
          () =>
            extras.anims.some(
              (anim) => String(anim.url ?? '').includes(encodeURIComponent('战斗-起手')) && anim.facing !== undefined,
            ),
          '自家宠物播 url 形态的动画、带朝向',
          400,
        );
        const hold = extras.requests.findIndex((request) => request.path === '/lock');
        assert.ok(hold >= 0, '开演前拿了锁');
        assert.ok(hold < extras.requests.findIndex((request) => request.path === '/anim'), '拿锁在自家第一段动画之前');
        await until(() => arena.calls.some((code) => code.startsWith('arena.update(')), '擂台按时间线刷气血');
        await until(() => extras.menus.some((labels) => labels.includes('修炼/快进')), '打的时候换成快进');
        // 长局先快进，再等挑战方随 reveal 带来的赛后感言上对手窗口（X23 拉长切磋后不再 1 秒内演完）
        clicks.push('修炼/快进');
        await until(
          () => foe.calls.some((code) => code.startsWith('guest.say(') && code.includes('承让承让')),
          '挑战方感言上了对手窗口',
          3000,
        );
        await until(() => extras.requests.some((request) => request.path === '/lock/release'), '演完放锁', 400);
        await until(() => foe.destroyed && arena.destroyed && fx.destroyed, '收摊全关', 400);
      },
    );
  } finally {
    env.memeAnswer = '无';
  }
  // 退出时窗口全关（上面已经收完，这里再兜一遍）
  assert.ok(
    windows.every((win) => win.destroyed),
    '退出时窗口全关',
  );
});

test('隔空切磋（应战方）：点不应战不记账，也不开窗', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const beaconPort = await freeUdpPort();
  const challenger = generateVisitIdentity();
  await withFeatures(
    {
      config: visitConfig(),
      cultivation: cultivationEarly(),
      neighbors: { neighbors: [neighborRecord(challenger.id, '小李', '阿花')] },
      clicks,
      beacon: { port: beaconPort, targets: () => [] },
    },
    async (_features, said, _bodies, home, extras) => {
      const { port, hostId } = await hostedApp(home, extras);
      const asking = sendDuel({ address: '127.0.0.1', port }, hostId, { owner: '小李', pet: '阿花' }, challenger, {
        mode: SPAR_MODE,
        card: guestCard(),
        commit: sparCommit('c'.repeat(64)),
      });
      await until(() => {
        const latest = extras.menus[extras.menus.length - 1] ?? [];
        return latest.includes('修炼/不应战');
      }, '不应战菜单项');
      clicks.push('修炼/不应战');
      assert.deepEqual(await asking, { ok: false, reason: 'declined' });
      await until(() => said.some((text) => text.includes('不跟 阿花 切磋')), '说了不应战');
      await new Promise((done) => setTimeout(done, 200));
      assert.equal(fightCount(home), 0, '不应战不记账');
      assert.equal(windowOn('/app/arena'), undefined, '没开擂台');
      assert.equal(windowOn('/app/guest'), undefined, '没开对手窗口');
      const path = join(home, 'diary', `${diaryDate(Date.now())}.json`);
      if (existsSync(path)) {
        const day = JSON.parse(readFileSync(path, 'utf8')) as DiaryDay;
        assert.ok(!day.events.some((event) => event.text.includes('隔空切磋')), '不应战不记日记');
      }
    },
  );
});

test('隔空切磋（应战方）：收到挑战直接弹确认面板，点不应战就回 declined', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const beaconPort = await freeUdpPort();
  const challenger = generateVisitIdentity();
  await withFeatures(
    {
      config: visitConfig(),
      cultivation: cultivationEarly(),
      neighbors: { neighbors: [neighborRecord(challenger.id, '小李', '阿花')] },
      clicks,
      modeTimeoutMs: 2_000,
      beacon: { port: beaconPort, targets: () => [] },
    },
    async (features, said, _bodies, home, extras) => {
      const { port, hostId } = await hostedApp(home, extras);
      const asking = sendDuel({ address: '127.0.0.1', port }, hostId, { owner: '小李', pet: '阿花' }, challenger, {
        mode: SPAR_MODE,
        card: guestCard(),
        commit: sparCommit('c'.repeat(64)),
      });
      // 不用等右键菜单，也不点菜单：挑战一到面板就弹出来
      await until(() => features.battle.state() !== null, '应战确认面板');
      const prompt = features.battle.state()!;
      assert.match(prompt.title, /小李 家的 阿花 想跟你切磋/);
      assert.deepEqual(
        prompt.options.map((option) => option.label),
        ['应战', '不应战'],
      );
      assert.equal(features.battle.choose(2), true, '面板上直接点不应战');
      assert.deepEqual(await asking, { ok: false, reason: 'declined' });
      await until(() => said.some((text) => text.includes('不跟 阿花 切磋')), '说了不应战');
      assert.equal(windowOn('/app/arena'), undefined, '没开擂台');
      assert.equal(windowOn('/app/guest'), undefined, '没开对手窗口');
      assert.equal(fightCount(home), 0, '不应战不记账');
    },
  );
});

test('隔空切磋（应战方）：熟人自动应战，不挂菜单；退出时窗口全关', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const beaconPort = await freeUdpPort();
  const challenger = generateVisitIdentity();
  const config = visitConfig();
  config.visit.autoAdmitFriends = true;
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        neighbors: { neighbors: [neighborRecord(challenger.id, '小李', '阿花', { friend: true })] },
        clicks,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
        // 主人在电脑前才会自动应战（应该在第一拍采样之后就为 true）
        await until(() => features.activity()?.present === true, '主人在电脑前');
        const { port, hostId } = await hostedApp(home, extras);
        const reply = await sendDuel(
          { address: '127.0.0.1', port },
          hostId,
          { owner: '小李', pet: '阿花' },
          challenger,
          { mode: SPAR_MODE, card: guestCard(), commit: sparCommit('c'.repeat(64)) },
        );
        assert.ok(reply.ok, `熟人应自动应战：${JSON.stringify(reply)}`);
        await until(() => said.some((text) => text.includes('直接应战')), '说了直接应战');
        assert.ok(
          extras.menus.every((labels) => !labels.some((label) => label.startsWith('修炼/应战'))),
          '自动应战不挂「应战」菜单',
        );
        // 亮随机数开演：先看到三扇窗，然后直接退出（withFeatures 的 finally 收摊）
        assert.deepEqual(
          await sendDuelReveal(
            { address: '127.0.0.1', port },
            { token: reply.ok ? reply.token : '', nonce: 'c'.repeat(64), line: '承让承让～' },
          ),
          { ok: true },
        );
        await until(
          () =>
            windowOn('/app/guest') !== undefined &&
            windowOn('/app/arena') !== undefined &&
            windowOn('/app/fx') !== undefined,
          '三扇窗',
          400,
        );
      },
    );
  } finally {
    env.memeAnswer = '无';
  }
  // 演出没快进就退出：dispose 把三扇窗全部关掉
  assert.ok(
    windows.every((win) => win.destroyed),
    '退出时窗口全关',
  );
});

test('隔空切磋：有客人在家、自己出门做客时都回 busy，不开应答菜单', async () => {
  const challenger = generateVisitIdentity();
  // 有客人在家：串门客人占着 session
  const clicks: string[] = [];
  windows.length = 0;
  const beaconPort = await freeUdpPort();
  await withFeatures(
    {
      config: visitConfig(),
      cultivation: cultivationEarly(),
      clicks,
      beacon: { port: beaconPort, targets: () => [] },
    },
    async (_features, _said, _bodies, home, extras) => {
      await knockIn(home, clicks, extras);
      const { port, hostId } = await hostedApp(home, extras);
      assert.deepEqual(
        await sendDuel({ address: '127.0.0.1', port }, hostId, { owner: '小李', pet: '阿花' }, challenger, {
          mode: SPAR_MODE,
          card: guestCard(),
          commit: sparCommit('c'.repeat(64)),
        }),
        { ok: false, reason: 'busy' },
      );
      await new Promise((done) => setTimeout(done, 100));
      assert.ok(
        extras.menus.every((labels) => !labels.some((label) => label.startsWith('修炼/应战'))),
        '有客人在家不挂应答菜单',
      );
    },
  );

  // 自己出门做客：canHost 为 false
  const config = visitConfig();
  config.visit.visiting = true;
  const tripClicks: string[] = [];
  const appBeaconPort = await freeUdpPort();
  const fakeIdentity = generateVisitIdentity();
  const fake = new VisitHost(
    {
      canHost: () => true,
      knocked: () => setTimeout(() => fake.answer(true), 50),
      knockEnded: () => undefined,
      line: () => Promise.resolve('欢迎欢迎～'),
      note: () => false,
      spar: async () => ({ ok: false, reason: 'off' as const }),
      reveal: async () => ({ ok: false, reason: 'late' as const }),
      duel: async () => ({ ok: false, reason: 'off' as const }),
      duelReveal: () => undefined,
      duelConceded: () => undefined,
      left: () => undefined,
    },
    { log: () => undefined, identity: fakeIdentity },
  );
  const fakePort = await fake.listen('127.0.0.1');
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const payload = encodeBeacon({ id: fakeIdentity.id, owner: '测试邻居', pet: '大个', port: fakePort });
  const sendBeacon = () => beacon.send(payload, appBeaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const timer = setInterval(sendBeacon, 300);
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        clicks: tripClicks,
        beacon: { port: appBeaconPort, targets: () => [] },
      },
      async (_features, _said, _bodies, home, extras) => {
        await until(
          () => extras.menus.some((labels) => labels.some((label) => label.startsWith('串门/去 '))),
          '信标听见了邻居',
          400,
        );
        tripClicks.push('串门/去 测试邻居 家');
        await until(() => extras.menus.some((labels) => labels.includes('从 测试邻居 家回来')), '进了门', 400);
        const { port, hostId } = await hostedApp(home, extras);
        assert.deepEqual(
          await sendDuel({ address: '127.0.0.1', port }, hostId, { owner: '小李', pet: '阿花' }, challenger, {
            mode: SPAR_MODE,
            card: guestCard(),
            commit: sparCommit('c'.repeat(64)),
          }),
          { ok: false, reason: 'busy' },
        );
        tripClicks.push('从 测试邻居 家回来');
        await until(
          () => extras.menus.some((labels) => labels.some((label) => label.startsWith('串门/去 '))),
          '回家了',
          400,
        );
      },
    );
  } finally {
    clearInterval(timer);
    beacon.close();
    await fake.close();
  }
});

test('隔空切磋（挑战方）：只列带 id 的在线邻居，最多 3 个，熟人在前', async () => {
  const config = visitConfig();
  config.visit.hosting = false;
  config.visit.visiting = true;
  const beaconPort = await freeUdpPort();
  // 四个邻居的名字按同一套 localeCompare 排：把排在最后的那位设成熟人，熟人优先时它才进得了前三
  const owners = ['甲', '乙', '丙', '丁'];
  const sorted = [...owners].sort((a, b) => a.localeCompare(b));
  const friendOwner = sorted[sorted.length - 1]!;
  const all = owners.map((owner, index) => ({
    id: String.fromCharCode(97 + index).repeat(32),
    owner,
    pet: `小${owner}`,
  }));
  const friend = all.find((item) => item.owner === friendOwner)!;
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  await new Promise<void>((done) => beacon.bind(0, '127.0.0.1', () => done()));
  const send = () => {
    for (const item of all) {
      const payload = encodeBeacon({ id: item.id, owner: item.owner, pet: item.pet, port: 9 });
      beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
    }
  };
  send();
  const timer = setInterval(send, 200);
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        neighbors: { neighbors: [neighborRecord(friend.id, friend.owner, friend.pet, { friend: true })] },
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (_features, _said, _bodies, _home, extras) => {
        await until(
          () => {
            const latest = extras.menus[extras.menus.length - 1] ?? [];
            return latest.filter((label) => label.startsWith('修炼/切磋/')).length === 3;
          },
          '三个切磋项',
          600,
        );
        const latest = extras.menus[extras.menus.length - 1]!;
        const duelLabels = latest.filter((label) => label.startsWith('修炼/切磋/'));
        assert.equal(duelLabels.length, 3, '最多 3 个');
        assert.ok(
          duelLabels.includes(`修炼/切磋/${friend.owner} 家的 ${friend.pet}`),
          '熟人在前（哪怕它按名字排在最后）',
        );
        const cut = sorted[sorted.length - 2]!;
        assert.ok(!duelLabels.includes(`修炼/切磋/${cut} 家的 小${cut}`), '被截掉的是排序最后的那位');
      },
    );
  } finally {
    clearInterval(timer);
    beacon.close();
  }
});

test('隔空切磋（挑战方）：对方不应战就说一句，不记账、不开窗', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const fake = await fakeDuelHost({ duel: async () => ({ ok: false, reason: 'declined' }) });
  const config = visitConfig();
  config.visit.hosting = false;
  config.visit.visiting = true;
  const beaconPort = await freeUdpPort();
  const beacon = createSocket('udp4');
  beacon.on('error', () => undefined);
  const payload = encodeBeacon({ id: fake.id, owner: '测试邻居', pet: '大个', port: fake.port });
  const sendBeacon = () => beacon.send(payload, beaconPort, '127.0.0.1', () => undefined);
  sendBeacon();
  const timer = setInterval(sendBeacon, 300);
  try {
    await withFeatures(
      {
        config,
        cultivation: cultivationEarly(),
        neighbors: { neighbors: [neighborRecord(fake.id, '测试邻居', '大个')] },
        clicks,
        beacon: { port: beaconPort, targets: () => [] },
      },
      async (features, said, _bodies, home, extras) => {
        await until(
          () => extras.menus.some((labels) => labels.includes('修炼/切磋/测试邻居 家的 大个')),
          '挑战项出现',
          400,
        );
        clicks.push('修炼/切磋/测试邻居 家的 大个');
        await pickPanel(features, 1, '隔空切磋方式');
        await until(() => said.some((text) => text.includes('没应战')), '说了没应战');
        await new Promise((done) => setTimeout(done, 200));
        assert.equal(fightCount(home), 0, '不记账');
        assert.equal(windowOn('/app/arena'), undefined, '没开擂台');
        assert.equal(windowOn('/app/guest'), undefined, '没开对手窗口');
        const path = join(home, 'diary', `${diaryDate(Date.now())}.json`);
        if (existsSync(path)) {
          const day = JSON.parse(readFileSync(path, 'utf8')) as DiaryDay;
          assert.ok(!day.events.some((event) => event.text.includes('隔空切磋')), '不记日记');
        }
        // 应战方没应战：挑战项回来，可以再点
        await until(
          () => extras.menus.some((labels) => labels.includes('修炼/切磋/测试邻居 家的 大个')),
          '挑战项回来',
          400,
        );
      },
    );
  } finally {
    clearInterval(timer);
    beacon.close();
    await fake.host.close();
  }
});

test('X16 串门里送走：主人家送客的演法与日记、客人家回家的日记，都按任务书的口径', () => {
  // 自己把客人送走：客人飘走（整扇窗往上飘、淡出），不挥手也不说告别的话；1.5 秒后关
  assert.deepEqual(hostFarewellSend(true), { farewell: '', wave: false, floatAway: true, closeMs: 1_500 });
  assert.equal(hostFarewellDiary('小李', '阿花', true), '用送友风把 阿花 送回家了');
  // 被客人送走：客人说「告辞～」再走
  assert.deepEqual(hostFarewellSend(false), { farewell: '告辞～', wave: true });
  assert.match(hostFarewellDiary('小李', '阿花', false), /被它的送友风送得飘起来/);
  assert.match(hostFarewellPrompt('小李', '阿花', true), /用送友风把来串门的阿花/);
  // 客人这一侧：被送回家的用任务书那句；自己放的说清是「把它送得飘起来」
  assert.equal(guestFarewellDiary('小李', '阿花', false), '和 小李 家的 阿花 切磋，被它的送友风送回家了');
  assert.match(guestFarewellDiary('小李', '阿花', true), /用送友风把它送得飘起来/);
  assert.equal(FAREWELL_WAIT_MS, 15_000, '演完等 sent-home 的兜底是 15 秒');
});
