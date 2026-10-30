/**
 * 逐手出招（X17）的接线测试：心魔试炼的三种出招方式、AI 失败的后备、手动 / 选方式超时、收摊与退出关面板。
 * 引擎与时间线的纯逻辑在 battle.test.ts / battle-show.test.ts；这里只核 features 的接线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diaryDate } from './diary.ts';
import type { DiaryDay } from './diary.ts';
import {
  cultivationEarly,
  cultivationSave,
  env,
  fightCount,
  freeUdpPort,
  guestCard,
  hostedApp,
  liveWindowsOn,
  pickPanel,
  until,
  visitConfig,
  windowOn,
  windows,
  withFeatures,
} from './features-testkit.ts';
import { generateVisitIdentity } from './visit-identity.ts';
import { sendDuel, SPAR_MODE, sparCommit } from './visit.ts';

/** 点「修炼/心魔试炼」并等出招面板 */
async function openTrial(
  features: Parameters<typeof pickPanel>[0],
  clicks: string[],
  menus: string[][],
): Promise<void> {
  await until(() => (menus[menus.length - 1] ?? []).includes('修炼/心魔试炼'), '心魔试炼菜单');
  clicks.push('修炼/心魔试炼');
  await until(() => features.battle.state() !== null, '出招面板');
}

function diaryText(home: string, kind: string): string {
  const path = join(home, 'diary', `${diaryDate(Date.now())}.json`);
  const day = JSON.parse(readFileSync(path, 'utf8')) as DiaryDay;
  return day.events
    .filter((event) => event.kind === kind)
    .map((event) => event.text)
    .join('\n');
}

test('X17 心魔试炼：自动 / AI 出招 / 手动三种方式各打一场，日记带对应后缀', async () => {
  for (const [pick, suffix] of [
    [1, ''],
    [2, '（AI 出招）'],
    [3, '（手动）'],
  ] as const) {
    const clicks: string[] = [];
    windows.length = 0;
    env.battleCalls = 0;
    env.battleReplies = [];
    env.battleHold = null;
    await withFeatures(
      {
        cultivation: cultivationEarly(),
        clicks,
        modeTimeoutMs: 2_000,
        aiTurnTimeoutMs: 2_000,
        actionTimeoutMs: 2_000,
      },
      async (features, _said, _bodies, home, extras) => {
        const { menus } = extras;
        try {
          if (pick === 2) env.battleReplies = Array.from({ length: 30 }, () => '{"pick":1}');
          await openTrial(features, clicks, menus);
          assert.ok(features.battle.choose(pick), `选了第 ${pick} 种出招方式`);
          await until(() => (menus[menus.length - 1] ?? []).includes('修炼/快进'), '开打');
          // 全量测试并行跑时动画定时器会漂：给 AI 请求留足等待（断言本身不改）
          if (pick === 2) await until(() => env.battleCalls > 0, '问了 AI 一手', 800);
          if (pick === 3) {
            await until(() => features.battle.state()?.kind === 'action', '手动出招面板');
            assert.ok(features.battle.choose(1), '点了第一手');
          }
          clicks.push('修炼/快进');
          await until(() => fightCount(home) === 1, '记账');
          await until(
            () => /心魔试炼/.test(diaryText(home, 'cultivate')) && diaryText(home, 'cultivate').includes(suffix),
            `日记后缀 ${suffix}`,
          );
        } finally {
          env.battleReplies = [];
          env.battleHold = null;
        }
      },
    );
  }
});

test('X17 AI 出招：坏 JSON / 不合法的招 / 15 秒超时都按后备挑法出，不卡住', async () => {
  for (const setup of ['bad-json', 'illegal', 'timeout'] as const) {
    const clicks: string[] = [];
    windows.length = 0;
    env.battleCalls = 0;
    env.battleReplies = [setup === 'bad-json' ? '我不会出招' : '{"pick":99,"line":"乱来"}'];
    env.battleHold = setup === 'timeout' ? new Promise<void>(() => undefined) : null;
    try {
      await withFeatures(
        {
          cultivation: cultivationEarly(),
          clicks,
          modeTimeoutMs: 2_000,
          aiTurnTimeoutMs: 40,
          actionTimeoutMs: 2_000,
        },
        async (features, _said, _bodies, home, extras) => {
          const { menus, logs } = extras;
          await openTrial(features, clicks, menus);
          assert.ok(features.battle.choose(2), 'AI 出招');
          await until(() => logs.some((line) => /逐手出招：AI 出招失败/.test(line)), `${setup} 走了后备`, 200);
          clicks.push('修炼/快进');
          await until(() => fightCount(home) === 1, `${setup} 记了账`);
        },
      );
    } finally {
      env.battleReplies = [];
      env.battleHold = null;
    }
  }
});

test('X17 手动出招：20 秒（测试调短）不点按后备挑法出，面板收起、整场不卡住', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationEarly(), clicks, modeTimeoutMs: 2_000, actionTimeoutMs: 40 },
    async (features, _said, _bodies, home, extras) => {
      const { menus, logs } = extras;
      await openTrial(features, clicks, menus);
      assert.ok(features.battle.choose(3), '手动出招');
      await until(() => features.battle.state()?.kind === 'action', '手动面板');
      await until(() => logs.some((line) => /手动没点/.test(line)), '超时按后备');
      assert.equal(features.battle.state(), null, '超时后面板收起');
      clicks.push('修炼/快进');
      await until(() => fightCount(home) === 1, '记账');
    },
  );
});

test('X17 选方式：10 秒（测试调短）不点按自动，面板关掉', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationEarly(), clicks, modeTimeoutMs: 40 },
    async (features, _said, _bodies, home, extras) => {
      const { menus } = extras;
      await openTrial(features, clicks, menus);
      // 不点：到点按自动，直接开演
      await until(() => (menus[menus.length - 1] ?? []).includes('修炼/快进'), '超时后自动开打');
      assert.equal(features.battle.state(), null, '选方式的面板已经收起');
      clicks.push('修炼/快进');
      await until(() => fightCount(home) === 1, '记账');
    },
  );
});

test('X17 AI 的台词在出这一手时说出来（anim: false，替掉模板解说）', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  env.battleReplies = Array.from({ length: 30 }, () => '{"pick":1,"line":"先用陀螺晕住它！"}');
  try {
    await withFeatures(
      { cultivation: cultivationEarly(), clicks, modeTimeoutMs: 2_000, aiTurnTimeoutMs: 2_000 },
      async (features, _said, bodies, home, extras) => {
        const { menus } = extras;
        await openTrial(features, clicks, menus);
        assert.ok(features.battle.choose(2), 'AI 出招');
        await until(
          () => bodies.some((body) => body.text === '先用陀螺晕住它！' && body.anim === false),
          'AI 台词',
          400,
        );
        clicks.push('修炼/快进');
        await until(() => fightCount(home) === 1, '记账');
      },
    );
  } finally {
    env.battleReplies = [];
  }
});

test('X17 模型没配好：开打前的「AI 出招」灰掉，点了也选不上', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  env.ready = false;
  try {
    await withFeatures(
      { cultivation: cultivationEarly(), clicks, modeTimeoutMs: 2_000 },
      async (features, _said, _bodies, home, extras) => {
        const { menus } = extras;
        await openTrial(features, clicks, menus);
        const state = features.battle.state();
        assert.equal(state?.kind, 'mode');
        assert.equal(state?.options.find((option) => option.pick === 2)?.disabled, true, 'AI 选项灰掉');
        assert.equal(features.battle.choose(2), false, '灰掉的选项点不上');
        assert.ok(features.battle.choose(1), '退回自动');
        await until(() => (menus[menus.length - 1] ?? []).includes('修炼/快进'), '自动开打');
        clicks.push('修炼/快进');
        await until(() => fightCount(home) === 1, '记账');
      },
    );
  } finally {
    env.ready = true;
  }
});

test('X17 收摊与退出：出招面板一起关；退出时这一场不记账', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationEarly(), clicks, modeTimeoutMs: 2_000, actionTimeoutMs: 2_000 },
    async (features, _said, _bodies, home, extras) => {
      const { menus } = extras;
      await openTrial(features, clicks, menus);
      assert.ok(features.battle.choose(3), '手动出招');
      await until(() => features.battle.state()?.kind === 'action', '手动面板');
      const panel = windowOn('/app/panel')!;
      assert.ok(panel !== undefined && !panel.destroyed, '面板开着');
      // 退出：面板与三扇窗都关，等着的选择作废，这一场不记账
      features.dispose();
      await until(() => panel.destroyed, '面板随退出关掉', 50);
      assert.equal(fightCount(home), 0, '退出这一场不记账');
      await until(() => liveWindowsOn('/app/guest').length === 0, '心魔窗口也关了', 50);
    },
  );
});

/** 逐手打心魔时来一次隔空挑战（冷却按地址算，同一套实例里只能挑一次） */
async function duelDuringTrial(stage: 'mode' | 'action'): Promise<void> {
  const clicks: string[] = [];
  windows.length = 0;
  const beaconPort = await freeUdpPort();
  await withFeatures(
    {
      config: visitConfig(),
      cultivation: cultivationEarly(),
      clicks,
      beacon: { port: beaconPort, targets: () => [] },
      modeTimeoutMs: 5_000,
      actionTimeoutMs: 5_000,
    },
    async (features, _said, _bodies, home, extras) => {
      const { menus } = extras;
      const { port, hostId } = await hostedApp(home, extras);
      await openTrial(features, clicks, menus);
      if (stage === 'action') {
        assert.ok(features.battle.choose(3), '手动出招');
        await until(() => features.battle.state()?.kind === 'action', '手动面板');
      }
      assert.deepEqual(
        await sendDuel(
          { address: '127.0.0.1', port },
          hostId,
          { owner: '小李', pet: '阿花' },
          generateVisitIdentity(),
          { mode: SPAR_MODE, card: guestCard(), commit: sparCommit('c'.repeat(64)) },
        ),
        { ok: false, reason: 'busy' },
      );
      assert.ok(
        menus.every((labels) => !labels.some((label) => label.startsWith('修炼/应战'))),
        '逐手打心魔时不挂应答菜单',
      );
      if (stage === 'mode') assert.ok(features.battle.choose(1), '选自动');
      clicks.push('修炼/快进');
      await until(() => fightCount(home) === 1, '记账');
    },
  );
}

test('X17 选方式的面板挂着时来隔空挑战回 busy，不挂应答菜单', async () => {
  await duelDuringTrial('mode');
});

test('X17 逐手局等主人点招时来隔空挑战回 busy，不挂应答菜单', async () => {
  await duelDuringTrial('action');
});

test('X26 心魔：选方式前不亮血条，开打才亮；自动局从菜单认输按负场记账', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationEarly(), clicks, modeTimeoutMs: 2_000 },
    async (features, _said, _bodies, home, extras) => {
      const { menus } = extras;
      await openTrial(features, clicks, menus);
      const arena = windowOn('/app/arena')!;
      assert.equal(arena.inactiveShown, 0, '选方式时血条还没亮');
      assert.ok(features.battle.choose(1), '自动');
      await until(() => arena.inactiveShown > 0, '开打才亮血条');
      await until(() => (menus[menus.length - 1] ?? []).includes('修炼/认输'), '打的时候有认输项');
      clicks.push('修炼/认输');
      await until(() => /确定认输/.test(features.battle.state()?.title ?? ''), '认输二次确认');
      assert.deepEqual(
        features.battle.state()?.options.map((option) => option.label),
        ['继续打', '认输'],
        '默认继续打，认输是第二项',
      );
      assert.ok(features.battle.choose(2), '确认认输');
      await until(() => fightCount(home) === 1, '认输也按一场记账');
      const record = cultivationSave(home)!.record as { wins: number; losses: number };
      assert.equal(record.losses, 1, '认输记负场');
      assert.equal(record.wins, 0, '没按预先算好的胜负记赢');
      assert.match(diaryText(home, 'cultivate'), /认输/, '日记写明认输');
    },
  );
});

test('X26 心魔手动：出招面板里的认输二次确认后按负场记账，这一手不再出', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationEarly(), clicks, modeTimeoutMs: 2_000, actionTimeoutMs: 2_000 },
    async (features, _said, _bodies, home, extras) => {
      const { menus } = extras;
      await openTrial(features, clicks, menus);
      assert.ok(features.battle.choose(3), '手动出招');
      await until(() => features.battle.state()?.kind === 'action', '手动面板');
      const state = features.battle.state()!;
      const forfeitPick = state.options.find((option) => option.label === '认输')?.pick;
      assert.ok(forfeitPick, '面板里有认输');
      assert.ok(features.battle.choose(forfeitPick), '点认输');
      await until(() => /确定认输/.test(features.battle.state()?.title ?? ''), '二次确认');
      assert.ok(features.battle.choose(1), '先选继续打');
      await until(() => features.battle.state()?.kind === 'action', '回到出招面板，这一手没被吞掉');
      assert.equal(features.battle.state()?.title.includes('轮到你了'), true, '还是同一手');
      const again = features.battle.state()!;
      assert.ok(features.battle.choose(again.options.find((option) => option.label === '认输')!.pick), '再点认输');
      await until(() => /确定认输/.test(features.battle.state()?.title ?? ''), '再确认');
      assert.ok(features.battle.choose(2), '这次确认认输');
      await until(() => fightCount(home) === 1, '认输记账');
      const record = cultivationSave(home)!.record as { wins: number; losses: number };
      assert.equal(record.losses, 1, '认输记负场');
      assert.ok(!menus[menus.length - 1]?.includes('修炼/认输'), '收摊后认输项没了');
    },
  );
});
