/**
 * 羁绊纯逻辑的单测：阶段门槛、每日上限、摸摸头冷却、小剧场选择、跟班改名与存档。
 *
 * 跑法：node --experimental-strip-types --import ./scripts/test-register.mjs --test src/app/bond.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BOND_DAILY_CAPS,
  BOND_SCENES,
  BOND_STAGES,
  BOND_TOUCH_GAP_MS,
  Bond,
  COMPANION_DEFAULT_NAME,
  cleanBondName,
  nextSceneOf,
  stageOf,
} from './bond.ts';

const NOW = new Date(2026, 10, 3, 10, 0, 0).getTime();

function tempPath(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bond-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'bond.json');
}

function warn(): void {
  /* 测试里不关心告警内容 */
}

describe('阶段与小剧场门槛', () => {
  test('分数落在正确的阶段', () => {
    assert.equal(stageOf(0), 0);
    assert.equal(stageOf(11), 0);
    assert.equal(stageOf(12), 1);
    assert.equal(stageOf(35), 1);
    assert.equal(stageOf(36), 2);
    assert.equal(stageOf(80), 3);
    assert.equal(stageOf(999), 3);
  });

  test('未看过的、分数够的最早一幕先演', () => {
    assert.equal(nextSceneOf(0, []), null);
    assert.equal(nextSceneOf(12, []), 'night-milk');
    assert.equal(nextSceneOf(80, []), 'night-milk');
    assert.equal(nextSceneOf(80, ['night-milk']), 'rain-blanket');
    assert.equal(nextSceneOf(80, ['night-milk', 'rain-blanket']), 'star-promise');
    assert.equal(nextSceneOf(80, ['night-milk', 'rain-blanket', 'star-promise']), null);
  });

  test('每一幕的选项 id 不重复，且至少两个选项', () => {
    for (const scene of Object.values(BOND_SCENES)) {
      const ids = scene.choices.map((choice) => choice.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(scene.choices.length >= 2);
      assert.ok(scene.intro.length > 0 && scene.choices.every((choice) => choice.reply.length > 0));
    }
  });
});

describe('Bond：好感来源与上限', () => {
  test('新存档是初识、跟班默认开着', (t) => {
    const bond = new Bond(tempPath(t), NOW, warn);
    const status = bond.status(NOW);
    assert.equal(status.stageName, '初识');
    assert.equal(status.points, 0);
    assert.equal(status.pending, null);
    assert.equal(status.companion.enabled, true);
    assert.equal(status.companion.name, COMPANION_DEFAULT_NAME);
    assert.equal(status.days, 1);
  });

  test('对话每天最多算 8 次，第二天恢复', (t) => {
    const bond = new Bond(tempPath(t), NOW, warn);
    for (let i = 0; i < 8; i++) assert.equal(bond.add('chat', NOW + i * 1000).added, 1);
    const blocked = bond.add('chat', NOW + 9_000);
    assert.equal(blocked.added, 0);
    assert.equal(blocked.capped, true);
    const nextDay = bond.add('chat', NOW + 86_400_000);
    assert.equal(nextDay.added, 1);
  });

  test('摸摸头隔 10 分钟才算一次', (t) => {
    const bond = new Bond(tempPath(t), NOW, warn);
    assert.equal(bond.add('touch', NOW).added, 2);
    assert.equal(bond.add('touch', NOW + BOND_TOUCH_GAP_MS - 1).added, 0);
    assert.equal(bond.add('touch', NOW + BOND_TOUCH_GAP_MS).added, 2);
  });

  test('加到门槛会升阶段并挂上小剧场', (t) => {
    const bond = new Bond(tempPath(t), NOW, warn);
    let now = NOW;
    for (let i = 0; i < 8; i++) {
      now += 1000;
      bond.add('chat', now);
    }
    const second = bond.add('touch', now);
    const third = bond.add('touch', now + BOND_TOUCH_GAP_MS);
    assert.equal(second.added, 2);
    assert.equal(third.added, 2);
    const status = bond.status(now + BOND_TOUCH_GAP_MS);
    assert.equal(status.points, BOND_STAGES[1].at);
    assert.equal(status.stageName, '熟悉');
    assert.equal(status.pending, 'night-milk');
    assert.equal(third.stageUp, true);
    assert.equal(third.scene, 'night-milk');
  });

  test('每日上限表覆盖所有来源', () => {
    assert.deepEqual(Object.keys(BOND_DAILY_CAPS).sort(), ['battle', 'chat', 'feed', 'touch', 'visit']);
  });
});

describe('Bond：小剧场与跟班', () => {
  test('选对了才生效，加选项奖励分并挂下一幕', (t) => {
    const bond = new Bond(tempPath(t), NOW, warn);
    assert.equal(bond.choose('night-milk', 'thanks'), null); // 还没挂上
    let now = NOW;
    for (let i = 0; i < 8; i++) {
      now += 1000;
      bond.add('chat', now);
    }
    bond.add('touch', now);
    bond.add('touch', now + BOND_TOUCH_GAP_MS);
    assert.equal(bond.status(now).pending, 'night-milk');
    assert.equal(bond.choose('night-milk', 'nope'), null);
    const result = bond.choose('night-milk', 'thanks');
    assert.ok(result);
    assert.equal(result?.scene.id, 'night-milk');
    assert.equal(result?.bonus, 2);
    assert.deepEqual(result?.reply, BOND_SCENES['night-milk'].choices[0].reply);
    const status = bond.status(now);
    assert.equal(status.points, 14);
    // 还差 22 分到 36，这一幕看完以后不挂着
    assert.equal(status.pending, null);
    assert.equal(bond.lastSeenScene()?.id, 'night-milk');
  });

  test('改名字：清理控制字符、按字符截断、空名字不接受', (t) => {
    const bond = new Bond(tempPath(t), NOW, warn);
    assert.equal(cleanBondName('  小\u0000鲸  鱼 '), '小鲸 鱼');
    assert.equal(cleanBondName('一二三四五六七八九十'), '一二三四五六七八');
    assert.equal(bond.renameCompanion('   '), false);
    assert.equal(bond.renameCompanion('鲸鱼宝宝'), true);
    assert.equal(bond.companionName(), '鲸鱼宝宝');
    assert.equal(bond.renameCompanion('鲸鱼宝宝'), false);
  });

  test('跟班开关落盘，重启后还认得', (t) => {
    const path = tempPath(t);
    const bond = new Bond(path, NOW, warn);
    bond.setCompanionEnabled(false);
    bond.renameCompanion('小白');
    const again = new Bond(path, NOW + 1000, warn);
    assert.equal(again.companionEnabled(), false);
    assert.equal(again.companionName(), '小白');
  });

  test('对话提示词带上阶段、未说出口的心事与跟班名字', (t) => {
    const bond = new Bond(tempPath(t), NOW, warn);
    assert.ok(bond.chatContext(NOW).includes('初识'));
    assert.ok(!bond.chatContext(NOW).includes('心事'));
    let now = NOW;
    for (let i = 0; i < 8; i++) {
      now += 1000;
      bond.add('chat', now);
    }
    bond.add('touch', now);
    bond.add('touch', now + BOND_TOUCH_GAP_MS);
    const text = bond.chatContext(now + BOND_TOUCH_GAP_MS);
    assert.ok(text.includes('「熟悉」阶段'));
    assert.ok(text.includes('心事'));
    assert.ok(text.includes(COMPANION_DEFAULT_NAME));
    bond.setCompanionEnabled(false);
    assert.ok(!bond.chatContext(now).includes('【小跟班】'));
  });
});

describe('Bond：存档', () => {
  test('分数、阶段、看过的一幕、选项都落盘', (t) => {
    const path = tempPath(t);
    const bond = new Bond(path, NOW, warn);
    let now = NOW;
    for (let i = 0; i < 8; i++) {
      now += 1000;
      bond.add('chat', now);
    }
    bond.add('touch', now);
    bond.add('touch', now + BOND_TOUCH_GAP_MS);
    bond.choose('night-milk', 'ask');
    const again = new Bond(path, now + 86_400_000, warn);
    const status = again.status(now + 86_400_000);
    assert.equal(status.points, 13);
    assert.equal(status.stageName, '熟悉');
    assert.equal(status.pending, null);
    assert.equal(again.lastSeenScene()?.id, 'night-milk');
  });

  test('坏文件改名成 .bad-* 并从头建档，不静默覆盖', (t) => {
    const path = tempPath(t);
    writeFileSync(path, '{不是 JSON', 'utf8');
    const bond = new Bond(path, NOW, warn);
    assert.equal(bond.status(NOW).points, 0);
    assert.equal(bond.status(NOW).stageName, '初识');
    const files = readdirSync(join(path, '..'));
    assert.ok(files.some((name) => name.startsWith('bond.json.bad-')));
    assert.ok(existsSync(path) === false);
  });
});
