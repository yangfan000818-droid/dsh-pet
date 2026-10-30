import { SANWANG } from './dungeon-sanwang.ts';
import { startRun } from './dungeon.ts';
import type { Fighter } from './battle.ts';
import { withFeatures, cultivationEarly, until, last, windows, cultivationSeed, windowOn } from './features-testkit.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('历练：菜单里有「修炼/历练」，多了这一项总数仍不超过 20', async () => {
  await withFeatures({ cultivation: cultivationEarly() }, async (_features, _said, _bodies, _home, { menus }) => {
    await until(() => menus.some((labels) => labels.includes('修炼/历练')), '历练菜单');
    assert.ok((last(menus)?.length ?? 0) <= 20, '菜单项不超过宿主上限');
  });
});

test('历练：小窗开着时菜单里没有心魔试炼和渡劫，关了小窗再出现', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  await withFeatures(
    { cultivation: cultivationSeed(), clicks },
    async (_features, _said, _bodies, _home, { menus }) => {
      await until(() => (last(menus) ?? []).includes('修炼/渡劫'), '渡劫菜单');
      await until(() => (last(menus) ?? []).includes('修炼/心魔试炼'), '心魔菜单');
      clicks.push('修炼/历练');
      await until(() => windowOn('/app/adventure') !== undefined, '历练小窗');
      const win = windowOn('/app/adventure')!;
      await until(
        () => win.calls.some((code) => code.startsWith('adv.render(') && code.includes('"kind":"entry"')),
        '入口页',
      );
      await until(() => {
        const latest = last(menus) ?? [];
        return latest.includes('修炼/历练') && !latest.includes('修炼/心魔试炼') && !latest.includes('修炼/渡劫');
      }, '小窗开着时藏起心魔与渡劫');
      win.answerAdv({ kind: 'close' });
      await until(() => win.destroyed, '小窗关掉');
      await until(() => {
        const latest = last(menus) ?? [];
        return latest.includes('修炼/心魔试炼') && latest.includes('修炼/渡劫');
      }, '关了小窗，菜单项回来');
    },
  );
});

test('历练：存档里有没走完的一趟，菜单写「修炼/历练（第 N 层）」，点开直接接着走', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const run = startRun(SANWANG, {
    pet: { name: '阿鱼', hp: 100, power: 10, agility: 10, speed: 10, weapons: [], skills: [] },
    stage: 8,
    suppressed: false,
    nonce: 'resume',
    now: Date.now(),
  });
  run.readyAt = Date.now() - 1;
  const seed = { ...cultivationSeed(), adventure: { run, cleared: {}, titles: [] } };
  await withFeatures({ cultivation: seed, clicks }, async (_features, _said, _bodies, _home, { menus }) => {
    await until(() => (last(menus) ?? []).includes('修炼/历练（第 1 层）'), '带层数的菜单');
    clicks.push('修炼/历练（第 1 层）');
    await until(() => windowOn('/app/adventure') !== undefined, '历练小窗');
    const win = windowOn('/app/adventure')!;
    await until(
      () => win.calls.some((code) => code.startsWith('adv.render(') && code.includes('"kind":"run"')),
      '接着走的一趟',
    );
    win.answerAdv({ kind: 'close' });
    await until(() => win.destroyed, '关掉');
  });
});

test('历练：这一趟在走时菜单多「自动走：开 / 关」，切了标签跟着变，修炼还是最多 5 项', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const run = startRun(SANWANG, {
    pet: { name: '阿鱼', hp: 100, power: 10, agility: 10, speed: 10, weapons: [], skills: [] },
    stage: 8,
    suppressed: false,
    nonce: 'auto',
    now: Date.now(),
  });
  run.readyAt = Date.now() - 1;
  const seed = { ...cultivationSeed(), adventure: { run, cleared: {}, titles: [] } };
  await withFeatures({ cultivation: seed, clicks }, async (_features, _said, _bodies, _home, { menus }) => {
    await until(() => (last(menus) ?? []).includes('修炼/历练（第 1 层）'), '带层数的菜单');
    assert.ok(!(last(menus) ?? []).some((label) => label.startsWith('修炼/自动走：')), '没开小窗时没有自动走');
    clicks.push('修炼/历练（第 1 层）');
    await until(() => windowOn('/app/adventure') !== undefined, '历练小窗');
    const win = windowOn('/app/adventure')!;
    await until(() => (last(menus) ?? []).includes('修炼/自动走：关'), '默认关着的自动走');
    const own = (last(menus) ?? []).filter((label) => label.startsWith('修炼/'));
    assert.ok(own.length <= 5, `修炼最多 5 项，实际 ${own.join('、')}`);
    assert.ok(!(last(menus) ?? []).includes('修炼/心魔试炼'), '这一趟在走时藏起来');
    assert.ok(!(last(menus) ?? []).includes('修炼/渡劫'));
    clicks.push('修炼/自动走：关');
    await until(() => (last(menus) ?? []).includes('修炼/自动走：开'), '切成开');
    clicks.push('修炼/自动走：开');
    await until(() => (last(menus) ?? []).includes('修炼/自动走：关'), '切回关');
    win.answerAdv({ kind: 'close' });
    await until(() => win.destroyed, '关掉');
  });
});

test('历练：收起来以后从菜单能叫回来，心魔试炼和渡劫照旧藏着', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const run = startRun(SANWANG, {
    pet: { name: '阿鱼', hp: 100, power: 10, agility: 10, speed: 10, weapons: [], skills: [] },
    stage: 8,
    suppressed: false,
    nonce: 'hide',
    now: Date.now(),
  });
  run.readyAt = Date.now() - 1;
  const seed = { ...cultivationSeed(), adventure: { run, cleared: {}, titles: [] } };
  await withFeatures({ cultivation: seed, clicks }, async (_features, _said, _bodies, _home, { menus }) => {
    await until(() => (last(menus) ?? []).includes('修炼/历练（第 1 层）'), '带层数的菜单');
    clicks.push('修炼/历练（第 1 层）');
    await until(() => windowOn('/app/adventure') !== undefined, '历练小窗');
    const win = windowOn('/app/adventure')!;
    await until(
      () => win.calls.some((code) => code.startsWith('adv.render(') && code.includes('"kind":"run"')),
      '接着走的一趟',
    );
    win.answerAdv({ kind: 'hide' });
    await until(() => win.hidden, '收起来了');
    await until(() => (last(menus) ?? []).includes('修炼/历练（第 1 层）'), '菜单还在');
    assert.ok(!(last(menus) ?? []).includes('修炼/心魔试炼'), '宠物还在秘境里');
    assert.ok(!(last(menus) ?? []).includes('修炼/渡劫'));
    clicks.push('修炼/历练（第 1 层）');
    await until(() => !win.hidden, '从菜单叫回来');
    win.answerAdv({ kind: 'close' });
    await until(() => win.destroyed, '关掉');
  });
});

test('X18 历练逐手：GET /app/battle 看到在选方式 / 等一手，POST 同一口径能选方式、能点招', async () => {
  const clicks: string[] = [];
  windows.length = 0;
  const pet: Fighter = { name: '阿鱼', hp: 104, power: 8, agility: 8, speed: 8, weapons: ['water-gun'], skills: [] };
  const run = startRun(SANWANG, { pet, stage: 8, suppressed: false, nonce: 'live-boss', now: Date.now() });
  run.layer = 5;
  run.step = 1;
  run.readyAt = Date.now() - 1;
  run.pending = { node: 'collapse', need: 'loadout', options: [] };
  run.flags = { ...run.flags, road: 'dog' };
  run.decisions = [];
  const seed = { ...cultivationSeed(), adventure: { run, cleared: {}, titles: [] } };
  await withFeatures(
    { cultivation: seed, clicks, actionTimeoutMs: 5_000, aiTurnTimeoutMs: 1_000 },
    async (features, _said, _bodies, _home, { menus }) => {
      await until(() => (last(menus) ?? []).includes('修炼/历练（第 5 层）'), '历练菜单');
      clicks.push('修炼/历练（第 5 层）');
      await until(() => windowOn('/app/adventure') !== undefined, '历练小窗');
      const win = windowOn('/app/adventure')!;
      await until(() => features.battle.state()?.kind === 'mode', '本机接口看到选方式');
      const mode = features.battle.state();
      assert.deepEqual(
        mode?.options.map((option) => option.label),
        ['自动', 'AI 出招', '手动'],
        '选方式三个按钮',
      );
      assert.ok(features.battle.choose(3), 'curl 选手动');
      await until(() => features.battle.state()?.kind === 'action', '本机接口看到手动出招');
      const action = features.battle.state();
      assert.ok((action?.options.length ?? 0) > 0, '这一手有得选');
      assert.ok(features.battle.choose(1), 'curl 点第一手');
      await until(() => (last(menus) ?? []).includes('修炼/快进'), '逐手局开打（菜单换成快进）');
      // X26：认输项插在「快进」旁，不能把心魔试炼的 guard 一起放开；历练也不支持认输
      assert.ok(!(last(menus) ?? []).includes('修炼/心魔试炼'), '打历练时不冒心魔试炼');
      assert.ok(!(last(menus) ?? []).includes('修炼/认输'), '历练不支持认输');
      clicks.push('修炼/快进');
      // 快进以后可能打赢（结局页），也可能输了（只剩倒带 / 收场）：输了就点「就此收场」
      await until(() => {
        const latest = win.calls.filter((code) => code.startsWith('adv.render(')).pop() ?? '';
        if (latest.includes('"kind":"ending"')) return true;
        if (latest.includes('"kind":"rewind"')) win.answerAdv({ kind: 'end' });
        return false;
      }, '打完到结局页');
      assert.equal(features.battle.state(), null, '收场后本机接口不再挂着选择');
      win.answerAdv({ kind: 'close' });
      await until(() => win.destroyed, '关掉');
    },
  );
});
