import { ANNOUNCE_AFTER_MS } from './claude-hooks.ts';
import { diaryDate } from './diary.ts';
import type { DiaryDay } from './diary.ts';
import {
  TEST_APP_CONFIG,
  withFeatures,
  until,
  cultivationSave,
  cultivationFull,
  windows,
  windowOn,
  memeAsks,
  SKILL_NAMES,
  last,
  cultivationEarly,
  deferred,
  emitPetBounds,
  env,
  startTrial,
  pickPanel,
  liveWindowsOn,
  fightCount,
} from './features-testkit.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('修炼：开关关着不建档，也没有修炼的菜单项', async () => {
  const config = structuredClone(TEST_APP_CONFIG);
  config.cultivation.enabled = false;
  await withFeatures({ config }, async (features, _said, _bodies, home, { menus }) => {
    await until(() => features.activity()?.present === true);
    await new Promise((done) => setTimeout(done, 300)); // 多跑几拍：不许中途偷偷建档
    assert.equal(cultivationSave(home), null);
    assert.equal(features.cultivation.view(), null);
    assert.ok(menus.every((labels) => labels.every((label) => !label.startsWith('修炼/'))));
  });
});

test('修炼：开着就建档，菜单里有「修炼」信息项', async () => {
  await withFeatures({}, async (features, _said, _bodies, home, { menus }) => {
    await until(() => features.activity()?.present === true);
    // 建了档（在电脑前的修为怎么攒、怎么封顶，数值口径见 cultivation.test.ts；这里只看接线）
    await until(() => cultivationSave(home) !== null);
    const save = cultivationSave(home)!;
    assert.equal(save.version, 1);
    assert.equal(save.stage, 0);
    const view = features.cultivation.view();
    assert.equal(view?.label, '炼气一层');
    // 菜单是建档之后异步刷新的：等它出来再看（Windows CI 上机器慢，立刻断言偶发失败）
    await until(
      () => menus.some((labels) => labels.some((label) => /^修炼\/炼气一层 · \d+%$/.test(label))),
      '修炼信息项',
    );
  });
});

test('修炼：Claude 干完一轮 ≥ 30 秒的活能拿到丹（注入的随机数），冒泡记日记', async (t) => {
  // 建档先消耗三个随机数（灵力、身法、法宝），第 4 个是丹的概率（0.05 < 0.2，必成）
  const draws = [0.5, 0.5, 0.5, 0.05];
  await withFeatures({ rng: () => draws.shift() ?? 0.5 }, async (features, said, bodies, home) => {
    await until(() => features.activity()?.present === true);
    // 不真等 31 秒：只接管 Date（setTimeout 照常走真的，采样的拍子不受影响），
    // 把时钟拨过「干满 30 秒才算一轮活干完」的口径（claude-hooks 的 ANNOUNCE_AFTER_MS）
    const realNow = Date.now();
    try {
      t.mock.timers.enable({ apis: ['Date'] });
      t.mock.timers.setTime(realNow);
      await features.handleClaudeHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/x/dsh-pet' });
      t.mock.timers.setTime(realNow + ANNOUNCE_AFTER_MS + 1_000);
      await features.handleClaudeHook({ hook_event_name: 'Stop', session_id: 's1' });
    } finally {
      t.mock.timers.reset();
    }
    await until(() => (cultivationSave(home)?.pills as number | undefined) === 1);
    // 冒泡排进了说话队列：等它真说出来；平常的气泡照旧联动说话动画
    await until(() => said.includes('炼成一颗破境丹～'));
    assert.equal(bodies.find((body) => body.text === '炼成一颗破境丹～')?.anim, true);
    const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
    assert.ok(day.events.some((event) => event.kind === 'cultivate' && event.text === '炼成一颗破境丹'));
  });
});

test('修炼：圆满时菜单是「渡劫」（不再是「突破」），有丹再多一项「服丹后渡劫」', async () => {
  await withFeatures(
    { cultivation: cultivationFull({ pills: 0 }) },
    async (_features, _said, _bodies, _home, { menus }) => {
      await until(() =>
        menus.some((labels) => labels.includes('修炼/炼气九层 · 100%') && labels.includes('修炼/渡劫')),
      );
      assert.ok(
        menus.every((labels) => !labels.includes('修炼/突破')),
        '「突破」已经被渡劫替换',
      );
      assert.ok(
        menus.every((labels) => !labels.includes('修炼/服丹后渡劫')),
        '没丹就没有服丹那一项',
      );
    },
  );
  await withFeatures(
    { cultivation: cultivationFull({ pills: 2 }) },
    async (_features, _said, _bodies, _home, { menus }) => {
      await until(() => menus.some((labels) => labels.includes('修炼/服丹后渡劫')), '有丹时的服丹项');
    },
  );
});

test('渡劫成功：扛雷演出（无对手窗口）→ 进大境界 → 挂出两项「领悟」→ 点一个招式到手', async () => {
  const clicks: string[] = [];
  // 气血给到 10 万：天雷怎么劈都劈不死，这一场必赢（雷数、动画、二选一都要看得清）
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationFull({ pills: 2, stats: { hp: 100_000, power: 8, agility: 8, speed: 8 } }), clicks },
    async (_features, _said, bodies, home, { menus, anims }) => {
      await until(() => menus.some((labels) => labels.includes('修炼/服丹后渡劫')), '服丹后渡劫可点');
      const before = menus.length;
      clicks.push('修炼/服丹后渡劫');
      await until(() => menus.some((labels) => labels.includes('修炼/快进')), '开打后菜单换成快进');
      // 吃了丹：开场先播 修炼-服丹（url 形态）；渡劫没有对手，不开任何窗口
      await until(
        () => anims.some((body) => String(body.url ?? '').includes(encodeURIComponent('修炼-服丹'))),
        '服丹动画',
        400,
      );
      assert.equal(windowOn('/app/guest'), undefined, '渡劫不该开心魔 / 客人窗口');
      assert.equal(windowOn('/app/arena'), undefined, '只有一只挨雷，没有擂台血条');
      // 台词报第几道雷，走 anim: false + 一步长（带 anim 的气泡会顶掉正在播的动画）
      clicks.push('修炼/快进');
      await until(() => (cultivationSave(home)?.stage as number | undefined) === 9, '进了筑基');
      const save = cultivationSave(home)!;
      assert.equal(save.pills, 1, '丹扣了一颗（2 → 1）');
      assert.equal((save.stats as { hp: number }).hp, 100_020, '大境界加成 +20 气血');
      assert.ok((save.offer as Record<string, unknown> | null) !== null, '二选一挂出来了');
      // 挨雷的动画（快进只播收场，前面那几步不一定发得出去，这里核收场的 修炼-突破）
      await until(
        () => anims.some((body) => String(body.url ?? '').includes(encodeURIComponent('修炼-突破'))),
        '突破动画',
        400,
      );
      // 结果感言走 compose（只带人设）
      await until(() => memeAsks.some((ask) => /渡劫|天雷/.test(ask)), '结果感言的指令', 400);
      // 菜单：两项「领悟：X」，不再有两个渡劫项
      const offer = save.offer as { a: string; b: string };
      const names = [offer.a, offer.b].map((id) => SKILL_NAMES[id]);
      await until(
        () =>
          menus.some(
            (labels) => labels.includes(`修炼/领悟：${names[0]}`) && labels.includes(`修炼/领悟：${names[1]}`),
          ),
        `领悟两项（一共 ${before} 次注册）`,
        400,
      );
      const tail = last(menus)!;
      assert.ok(
        tail.filter((label) => label.startsWith('修炼/')).length <= 5,
        `修炼子菜单不超名额：${JSON.stringify(tail)}`,
      );
      clicks.push(`修炼/领悟：${names[0]}`);
      await until(() => {
        const now = cultivationSave(home)!;
        return (now.skills as string[]).includes(offer.a) && now.offer === null;
      }, '点了领悟：招式到手、二选一收走');
      await until(
        () => menus.some((labels) => !labels.some((label) => label.startsWith('修炼/领悟：'))),
        '菜单收回领悟两项',
      );
      assert.ok(
        bodies.some((body) => body.anim === false),
        '演出台词不联动动画',
      );
      const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
      assert.ok(
        day.events.some((event) => event.kind === 'cultivate' && /突破到筑基初期/.test(event.text)),
        '记了渡劫成功',
      );
    },
  );
});

test('渡劫失败：扣 20% 修为、境界不掉、不再是圆满（不设冷却），播池内的垂头叹气', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  // 气血 1：三道雷只要有一道没躲开就倒下（全躲开的概率约 3e-6）
  await withFeatures(
    { cultivation: cultivationFull({ stats: { hp: 1, power: 8, agility: 8, speed: 8 }, pills: 0 }), clicks },
    async (_features, _said, _bodies, home, { menus, anims }) => {
      await until(() => menus.some((labels) => labels.includes('修炼/渡劫')), '渡劫可点');
      clicks.push('修炼/渡劫');
      await until(() => menus.some((labels) => labels.includes('修炼/快进')), '开打');
      // 快进前该已经挨上雷了（X7：乌云聚起、闪电劈中那一刻触电，第一道约在 3.1 秒；
      // 第一道被躲开的话要等下一道，再晚两秒左右）
      await until(
        () => anims.some((body) => String(body.url ?? '').includes(encodeURIComponent('修炼-触电'))),
        '触电动画',
        800,
      );
      clicks.push('修炼/快进');
      await until(() => (cultivationSave(home)?.progress as number | undefined) === 120, '扣了 30 修为');
      const save = cultivationSave(home)!;
      assert.equal(save.stage, 8, '不掉境界');
      assert.equal(save.offer, null, '失败不挂二选一');
      // 不再是圆满：菜单里渡劫那项没了，攒回 100% 才会再出现
      await until(() => menus.some((labels) => labels.includes('修炼/炼气九层 · 80%')), '菜单跟着改');
      assert.ok(last(menus)!.every((label) => label !== '修炼/渡劫' && label !== '修炼/服丹后渡劫'));
      // 失败收场是池里的现有素材（名字形态，不是 url）
      await until(() => anims.some((body) => body.name === '工作状态-垂头叹气冒汗'), '垂头叹气冒汗走名字形态播', 400);
      const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
      assert.ok(day.events.some((event) => event.kind === 'cultivate' && /渡劫没扛住，修为退了 30/.test(event.text)));
    },
  );
});

test('二选一过期没人挑：下一拍随机定一个（拨 Date，不真等 10 分钟）', async (t) => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationFull({ pills: 0, stats: { hp: 100_000, power: 8, agility: 8, speed: 8 } }), clicks },
    async (_features, _said, _bodies, home, { menus }) => {
      await until(() => menus.some((labels) => labels.includes('修炼/渡劫')), '渡劫可点');
      const realNow = Date.now();
      clicks.push('修炼/渡劫');
      await until(() => menus.some((labels) => labels.includes('修炼/快进')), '开打');
      clicks.push('修炼/快进');
      await until(() => cultivationSave(home)?.offer !== null, '二选一挂出来');
      const offer = cultivationSave(home)!.offer as { a: string; b: string };
      await until(
        () => menus.some((labels) => labels.includes(`修炼/领悟：${SKILL_NAMES[offer.a]}`)),
        '菜单有领悟两项',
      );
      try {
        // 只接管 Date（拍子照走真的），把时钟拨过 10 分钟：tick 那一拍该随机定一个
        t.mock.timers.enable({ apis: ['Date'] });
        t.mock.timers.setTime(realNow + 11 * 60_000);
        // 拨完表要等下一拍（TICK_MS = 5 秒，真的）：tries 给够
        await until(() => cultivationSave(home)?.offer === null, '过期自动定', 800);
      } finally {
        t.mock.timers.reset();
      }
      const save = cultivationSave(home)!;
      const skills = save.skills as string[];
      assert.equal(skills.length, 1);
      assert.ok(skills[0] === offer.a || skills[0] === offer.b, `定的是两个里的一个：${skills[0]}`);
      await until(() => menus.some((labels) => !labels.some((label) => label.startsWith('修炼/领悟：'))), '菜单收回');
    },
  );
});

test('心魔试炼：菜单里有该项；窗口与动画、血条按时间线走；快进后奖励进存档', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures({ cultivation: cultivationEarly(), clicks }, async (features, _said, bodies, home, extras) => {
    const { menus, anims } = extras;
    await until(() => menus.some((labels) => labels.includes('修炼/心魔试炼')), 'trial menu');
    clicks.push('修炼/心魔试炼');
    await pickPanel(features, 1, '这一场');
    // 心魔窗口（暗色）与擂台窗口都开了
    await until(() => windowOn('/app/guest') !== undefined && windowOn('/app/arena') !== undefined, 'windows');
    const guest = windowOn('/app/guest')!;
    const arena = windowOn('/app/arena')!;
    assert.ok(
      guest.calls.some((code) => code.includes('"shadow"')),
      '心魔窗口是 shadow 配色',
    );
    // 开场那一步（t=0）：自家宠物走 /anim 的 url 形态，带朝向（面朝对手）与倍速（正好占满一步）
    await until(
      () => anims.some((body) => String(body.url ?? '').includes(encodeURIComponent('战斗-起手'))),
      'opening anim',
    );
    const opening = anims.find((body) => String(body.url ?? '').includes(encodeURIComponent('战斗-起手')))!;
    assert.equal(opening.facing, 'left');
    assert.equal(typeof opening.rate, 'number');
    assert.ok(
      Number(opening.rate) >= 0.5 && Number(opening.rate) <= 3,
      `倍速在 /anim 允许的区间：${String(opening.rate)}`,
    );
    // 心魔窗口那边同样按时间线播动画（带倍速）
    await until(
      () => guest.calls.some((code) => code.startsWith('guest.play(') && !code.endsWith(', 1)')),
      'guest play rate',
    );
    // 擂台按引擎的事件刷血，两条分别是我与心魔
    await until(() => arena.calls.some((code) => code.startsWith('arena.update(')), 'arena update');
    assert.ok(
      arena.calls.some((code) => code.includes('"label":"心魔"')),
      `对手那条是心魔：${last(arena.calls)}`,
    );
    // 演出台词：anim 一律 false，时长跟着时间线的一步（下一句自然顶替上一句）——带 anim 的气泡会顶掉正在播的动画
    await until(
      () => bodies.some((body) => body.anim === false && body.duration === 2400),
      'show line anim:false + duration',
      1_000,
    );
    // 打的时候：菜单换成快进、没有「心魔试炼」
    await until(() => menus.some((labels) => labels.includes('修炼/快进')), 'fast-forward menu');
    // 快进看结果
    clicks.push('修炼/快进');
    await until(() => (cultivationSave(home)?.today as { trial: number }).trial === 1, 'trial counted');
    const save = cultivationSave(home)!;
    const record = save.record as { wins: number; losses: number };
    assert.equal(record.wins + record.losses, 1, '一场的心魔战绩记上了');
    assert.ok((save.progress as number) > 0, '修为进了账（赢 +30 / 输 +10）');
    // 赛后感言走 compose（只带人设），指令里说清了对手与胜负
    await until(() => memeAsks.some((ask) => /心魔/.test(ask)), 'postgame compose');
    const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
    assert.ok(
      day.events.some((event) => event.kind === 'cultivate' && /心魔试炼/.test(event.text)),
      '记了日记',
    );
    // 演完收回菜单：又有「心魔试炼」、没有「快进」
    await until(
      () => menus.some((labels) => labels.includes('修炼/心魔试炼') && !labels.includes('修炼/快进')),
      'menu back',
    );
  });
});

test('心魔试炼：开演前占住宠物（两段动画之间不插播随机活动），演出的动画与台词都带着锁，演完放开', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures({ cultivation: cultivationEarly(), clicks }, async (features, _said, _bodies, _home, extras) => {
    const { menus, requests } = extras;
    await until(() => menus.some((labels) => labels.includes('修炼/心魔试炼')), 'trial menu');
    clicks.push('修炼/心魔试炼');
    await pickPanel(features, 1, '这一场');
    await until(() => requests.some((r) => r.path === '/anim'), 'opening anim');
    // 回归（X9 真机：两段演出动画之间宠物插播堆雪人、吃糖葫芦）：先拿锁，再播第一段
    const hold = requests.findIndex((r) => r.path === '/lock');
    assert.ok(hold >= 0 && hold < requests.findIndex((r) => r.path === '/anim'), '拿锁在开场动画之前');
    const ttl = Number(requests[hold].body.ttl);
    assert.ok(ttl > 0 && ttl <= 30 * 60 * 1000, `锁的时长在 /lock 允许的区间：${ttl}`);
    await until(() => requests.some((r) => r.path === '/broadcast'), 'show line', 1_000);
    clicks.push('修炼/快进');
    // 演完停 CLOSE_HOLD_MS（§X14 起是 1 秒：收场动作播完、在最后一帧停一会儿）才放锁
    await until(() => requests.some((r) => r.path === '/lock/release'), 'release', 400);
    const release = requests.findIndex((r) => r.path === '/lock/release');
    assert.equal(requests[release].body.lockId, 'show-lock');
    const during = requests.slice(hold + 1, release).filter((r) => r.path === '/anim' || r.path === '/broadcast');
    assert.ok(during.length > 0);
    assert.ok(
      during.every((r) => r.lock === 'show-lock'),
      '占着的时候应用自己的动画与台词都带锁（不带会被宿主当成别人、回 lock-required）',
    );
  });
});

test('心魔试炼（手动逐手）：先占住宠物再开演，占锁慢一点也不让第一段动画抢前面', async () => {
  const clicks: string[] = [];
  const lockMs = 400;
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationEarly(), clicks, lockDelayMs: lockMs },
    async (features, _said, _bodies, _home, extras) => {
      const { menus, requests } = extras;
      await until(() => menus.some((labels) => labels.includes('修炼/心魔试炼')), 'trial menu');
      clicks.push('修炼/心魔试炼');
      await pickPanel(features, 3, '这一场');
      await until(() => requests.some((r) => r.path === '/anim'), 'opening anim');
      // 回归：逐手局一创建就演第一手，第一段动画得等 /lock 到手（假 /lock 故意晚 400ms）
      const lock = requests.find((one) => one.path === '/lock');
      const first = requests.find((one) => one.path === '/anim');
      assert.ok(lock && first && lock.at !== undefined && first.at !== undefined, '记下了占锁与第一段动画的时刻');
      assert.ok(
        first.at >= lock.at + lockMs,
        `第一段动画在锁到手之后（锁 ${lockMs}ms，动画晚 ${first.at - lock.at}ms）`,
      );
      clicks.push('修炼/快进');
      await until(() => requests.some((r) => r.path === '/lock/release'), 'release', 600);
    },
  );
});

test('心魔试炼：锁被用户撤掉（点了 / 拖了宠物）就不带锁重发，接着照常演，演完也不再放锁', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationEarly(), clicks, lockLost: true },
    async (features, _said, _bodies, home, extras) => {
      const { menus, anims, requests, logs } = extras;
      await until(() => menus.some((labels) => labels.includes('修炼/心魔试炼')), 'trial menu');
      clicks.push('修炼/心魔试炼');
      await pickPanel(features, 1, '这一场');
      await until(() => anims.length > 0, 'opening anim resent');
      const opening = requests.filter((r) => r.path === '/anim').slice(0, 2);
      assert.deepEqual(
        opening.map((r) => r.lock),
        ['show-lock', null],
        '开场那段先带锁被拒、再不带锁重发',
      );
      assert.ok(logs.some((line) => /占用锁没了（preempted）/.test(line)));
      clicks.push('修炼/快进');
      await until(() => (cultivationSave(home)?.today as { trial: number }).trial === 1, 'trial counted');
      await new Promise((done) => setTimeout(done, 3_200));
      const later = requests.filter((r) => r.path === '/anim' || r.path === '/broadcast').slice(2);
      assert.ok(later.length > 0);
      assert.ok(
        later.every((r) => r.lock === null),
        '锁没了以后不再带它',
      );
      assert.ok(!requests.some((r) => r.path === '/lock/release'), '锁已经不在手里，演完不放');
    },
  );
});

test('修炼：演完一场马上再点第二场，两场都记，第二场还没缓过来、不加修为并说一声（心魔收益随间隔恢复）', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const record = (home: string) => cultivationSave(home)?.record as { wins: number; losses: number };
  await withFeatures({ cultivation: cultivationEarly(), clicks }, async (features, said, _bodies, home, extras) => {
    const { menus } = extras;
    let firstRound = -1;
    for (const round of [1, 2]) {
      await until(() => menus.some((labels) => labels.includes('修炼/心魔试炼')), `第 ${round} 场可点`);
      clicks.push('修炼/心魔试炼');
      await pickPanel(features, 1, `第 ${round} 场`);
      await until(() => menus.some((labels) => labels.includes('修炼/快进')), `第 ${round} 场开打`);
      clicks.push('修炼/快进');
      await until(() => record(home).wins + record(home).losses >= round, `第 ${round} 场记账`);
      if (round === 1) firstRound = (cultivationSave(home)?.progress as number) ?? 0;
    }
    const save = cultivationSave(home)!;
    assert.equal((save.today as { trial: number }).trial, 2, '两场都记了场次');
    assert.equal(record(home).wins + record(home).losses, 2, '两场战绩都记');
    assert.equal(save.progress, firstRound, '隔了几秒的第二场一点修为都没进账');
    assert.ok(firstRound > 0, '第一场（没打过）是满额');
    await until(() => said.some((line) => /心魔还没缓过来/.test(line)), '说一声还没缓过来');
  });
});

test('心魔试炼：第一场感言没回来就开第二场，第一场的窗口立刻关、第二场不被误关（§X14 泄漏回归）', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const gate = deferred();
  await withFeatures({ cultivation: cultivationEarly(), clicks }, async (features, said, _bodies, home, extras) => {
    const { menus } = extras;
    try {
      // 真机上 helper 会一直报自家宠物位置；先报一次，特效层才摆得出来
      emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
      env.memeHold = gate.promise;
      env.memeReplies = ['第一场的感言', '第二场的感言'];
      await startTrial(features, clicks, menus, '第 1 场');
      await until(
        () =>
          liveWindowsOn('/app/guest').length === 1 &&
          liveWindowsOn('/app/arena').length === 1 &&
          liveWindowsOn('/app/fx').length === 1,
        '第 1 场三扇窗',
      );
      const first = {
        guest: liveWindowsOn('/app/guest')[0]!,
        arena: liveWindowsOn('/app/arena')[0]!,
        fx: liveWindowsOn('/app/fx')[0]!,
      };
      clicks.push('修炼/快进');
      await until(() => fightCount(home) === 1, '第 1 场记账');
      // 不等感言：菜单已经换回来（旧代码这里还挂着「快进」，第二场根本点不了）
      await until(() => {
        const latest = menus[menus.length - 1] ?? [];
        return latest.includes('修炼/心魔试炼') && !latest.includes('修炼/快进');
      }, '第 1 场收摊、菜单换回来');
      // 第一场的 compose 还挂着，这时开第二场
      await startTrial(features, clicks, menus, '第 2 场');
      await until(() => liveWindowsOn('/app/guest').length === 1, '第 2 场心魔窗口');
      const second = {
        guest: liveWindowsOn('/app/guest')[0]!,
        arena: liveWindowsOn('/app/arena')[0]!,
        fx: liveWindowsOn('/app/fx')[0]!,
      };
      assert.ok(
        first.guest !== second.guest && first.arena !== second.arena && first.fx !== second.fx,
        '两场各开各的窗口',
      );
      // 新开一场时上一场还没关完的那组立刻关
      await until(() => first.guest.destroyed && first.arena.destroyed && first.fx.destroyed, '第 1 场三扇窗立刻关');
      // 熬过第一场原来的收摊时刻：第二场的窗口还在（旧代码会被第一场的收摊关掉）
      await new Promise((done) => setTimeout(done, 1_200));
      assert.ok(!second.guest.destroyed && !second.arena.destroyed && !second.fx.destroyed, '第 2 场的三扇窗还开着');
      // 第二场打完、放开 compose：所有窗口都关掉，两场的感言各说各的
      clicks.push('修炼/快进');
      await until(() => fightCount(home) === 2, '第 2 场记账');
      await until(
        () =>
          liveWindowsOn('/app/guest').length === 0 &&
          liveWindowsOn('/app/arena').length === 0 &&
          liveWindowsOn('/app/fx').length === 0,
        '两场窗口都关了',
        400,
      );
      gate.resolve();
      await until(() => said.includes('第一场的感言') && said.includes('第二场的感言'), '两场的感言都说了', 400);
    } finally {
      env.memeHold = null;
      env.memeReplies = [];
      gate.resolve();
    }
  });
});

test('心魔试炼：compose 挂着不返回时，三扇窗到点先关、菜单先回来、账与日记先记，放开后感言照说（§X14）', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const gate = deferred();
  await withFeatures({ cultivation: cultivationEarly(), clicks }, async (features, said, _bodies, home, extras) => {
    const { menus } = extras;
    try {
      // 真机上 helper 会一直报自家宠物位置；先报一次，特效层才摆得出来
      emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
      env.memeHold = gate.promise;
      env.memeReplies = ['收摊以后才回来的感言'];
      const asksBefore = memeAsks.length;
      await startTrial(features, clicks, menus, '这一场');
      clicks.push('修炼/快进');
      await until(() => fightCount(home) === 1, '记账');
      // compose 的模型调用已经发出去、卡在闸上
      await until(() => memeAsks.slice(asksBefore).some((ask) => /心魔/.test(ask)), '赛后感言的模型调用');
      assert.ok(!said.includes('收摊以后才回来的感言'), '感言还没回来');
      await until(
        () =>
          liveWindowsOn('/app/guest').length === 0 &&
          liveWindowsOn('/app/arena').length === 0 &&
          liveWindowsOn('/app/fx').length === 0,
        'CLOSE_HOLD_MS 后三扇窗都关了',
        400,
      );
      await until(() => {
        const latest = menus[menus.length - 1] ?? [];
        return latest.includes('修炼/心魔试炼') && !latest.includes('修炼/快进');
      }, '菜单不等感言就换回来');
      assert.equal((cultivationSave(home)?.today as { trial: number }).trial, 1, '账记上了');
      const day = JSON.parse(readFileSync(join(home, 'diary', `${diaryDate(Date.now())}.json`), 'utf8')) as DiaryDay;
      assert.ok(
        day.events.some((event) => event.kind === 'cultivate' && /心魔试炼/.test(event.text)),
        '日记不等感言就记上了',
      );
      gate.resolve();
      await until(() => said.includes('收摊以后才回来的感言'), '放开后赛后感言照说', 400);
    } finally {
      env.memeHold = null;
      env.memeReplies = [];
      gate.resolve();
    }
  });
});

test('心魔试炼：第一场的感言在第二场开演以后才回来，就不再说了（§X14）', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const gate = deferred();
  await withFeatures({ cultivation: cultivationEarly(), clicks }, async (features, said, _bodies, home, extras) => {
    const { menus } = extras;
    try {
      // 真机上 helper 会一直报自家宠物位置；先报一次，特效层才摆得出来
      emitPetBounds({ x: 100, y: 100, marginL: 0, marginT: 0, size: 200, bottomPad: 20 });
      env.memeHold = gate.promise;
      env.memeReplies = ['第一场的旧感言', '第二场的感言'];
      const asksBefore = memeAsks.length;
      await startTrial(features, clicks, menus, '第 1 场');
      clicks.push('修炼/快进');
      await until(() => fightCount(home) === 1, '第 1 场记账');
      await until(() => {
        const latest = menus[menus.length - 1] ?? [];
        return latest.includes('修炼/心魔试炼') && !latest.includes('修炼/快进');
      }, '第 1 场收摊、菜单换回来');
      await startTrial(features, clicks, menus, '第 2 场');
      await until(() => memeAsks.slice(asksBefore).some((ask) => /心魔/.test(ask)), '第 1 场的感言卡在模型上');
      // 第二场还在演，放开第一场的 compose：这一句过时了，不许插进第二场
      gate.resolve();
      env.memeHold = null;
      await until(() => env.memeReplies.length === 1, '第 1 场感言回来了（用掉一条回答）');
      await new Promise((done) => setTimeout(done, 100));
      assert.ok(!said.includes('第一场的旧感言'), '过时的感言没说');
      // 第二场打完，第二场的感言照说，旧感言一直不出现
      clicks.push('修炼/快进');
      await until(() => fightCount(home) === 2, '第 2 场记账');
      await until(() => said.includes('第二场的感言'), '第 2 场的感言', 400);
      assert.ok(!said.includes('第一场的旧感言'), '过时的感言一直没说');
    } finally {
      env.memeHold = null;
      env.memeReplies = [];
      gate.resolve();
    }
  });
});

test('修炼关掉时没有「心魔试炼」这一项', async () => {
  const config = structuredClone(TEST_APP_CONFIG);
  config.cultivation.enabled = false;
  await withFeatures({ config }, async (_features, _said, _bodies, _home, { menus }) => {
    await until(() => menus.length > 0);
    assert.ok(menus.every((labels) => !labels.includes('修炼/心魔试炼')));
    // 群架要用修炼存档里的 Fighter，修炼关着就一起收起来
    assert.ok(menus.every((labels) => labels.every((label) => !label.startsWith('群架/'))));
  });
});

test('群架：修炼开着时菜单里「群架」分组下挂 3 / 4 / 5 人三项', async () => {
  await withFeatures({}, async (_features, _said, _bodies, _home, { menus }) => {
    await until(
      () => menus.some((labels) => labels.includes('群架/3 人')),
      '群架菜单项',
    );
    const tail = last(menus)!;
    for (const n of [3, 4, 5]) assert.ok(tail.includes(`群架/${n} 人`), JSON.stringify(tail));
    // 根菜单只占一项「群架」，人数都在它下面（不各占一个根菜单按钮）
    assert.equal(tail.some((label) => label.startsWith('群架·')), false, JSON.stringify(tail));
  });
});

// ---------- 切磋（X5） ----------
