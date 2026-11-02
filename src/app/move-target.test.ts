import assert from 'node:assert/strict';
import { test } from 'node:test';

import { moveTargetOf, parseMoveAnswer } from './move-target.ts';

const AREA = { x: 0, y: 0, width: 1440, height: 900 };
const UNION = { x: 0, y: 0, width: 1440, height: 900 };

test('解析：auto 听出飞/走 + 数字', () => {
  assert.deepEqual(parseMoveAnswer('飞6', 'auto'), { kind: 'fly', cell: 6 });
  assert.deepEqual(parseMoveAnswer('我想走 2。', 'auto'), { kind: 'walk', cell: 2 });
  assert.deepEqual(parseMoveAnswer('飞 ６', 'auto'), { kind: 'fly', cell: 6 });
});

test('解析：菜单指定方式时，模型说反了也按菜单来', () => {
  assert.deepEqual(parseMoveAnswer('走4', 'fly'), { kind: 'fly', cell: 4 });
  assert.deepEqual(parseMoveAnswer('飞4', 'walk'), { kind: 'walk', cell: 4 });
});

test('解析：只有数字时 auto 留空（交给距离），固定方式直接用', () => {
  assert.deepEqual(parseMoveAnswer('5', 'auto'), { kind: null, cell: 5 });
  assert.deepEqual(parseMoveAnswer('5', 'walk'), { kind: 'walk', cell: 5 });
  assert.equal(parseMoveAnswer('看不懂', 'auto'), null);
  assert.equal(parseMoveAnswer('', 'auto'), null);
});

test('解析：模型只答方位词也能换算（小模型常不按数字格式回答）', () => {
  assert.deepEqual(parseMoveAnswer('飞右上角', 'auto'), { kind: 'fly', cell: 3 });
  assert.deepEqual(parseMoveAnswer('走左边', 'auto'), { kind: 'walk', cell: 4 });
  assert.deepEqual(parseMoveAnswer('中间。', 'auto'), { kind: null, cell: 5 });
  assert.deepEqual(parseMoveAnswer('右', 'auto'), { kind: null, cell: 6 });
  assert.equal(parseMoveAnswer('主人正在写代码', 'auto'), null, '别把「正在」当成中间');
  assert.equal(parseMoveAnswer('屏幕上', 'auto'), null, '别把「屏幕上」当成上方');
});

test('九宫格换算：6 号格在中间行右侧，落点留在工作区内', () => {
  const t = moveTargetOf({
    cell: 6,
    kind: 'fly',
    area: AREA,
    union: UNION,
    size: 300,
    current: { x: 250, y: 480 },
    rng: () => 0.5,
  });
  assert.ok(t);
  assert.equal(t.kind, 'fly');
  assert.ok(t.x > 0.7 && t.x < 0.9, `x=${t.x}`);
  assert.ok(t.y > 0.4 && t.y < 0.6, `y=${t.y}`);
});

test('九宫格换算：贴边格按宠物大小夹进工作区', () => {
  const t = moveTargetOf({
    cell: 1,
    kind: 'walk',
    area: AREA,
    union: UNION,
    size: 300,
    current: null,
    rng: () => 0,
  });
  assert.ok(t);
  // 左边距 = 150 + 20，上边距 = 84.375 + 20
  assert.ok(Math.abs(t.x * 1440 - 170) < 1e-9);
  assert.ok(Math.abs(t.y * 900 - ((300 * 9) / 32 + 20)) < 1e-9);
});

test('九宫格换算：离当前位置太近时往屏幕另一侧推，auto 按距离选飞', () => {
  const t = moveTargetOf({
    cell: 5,
    kind: null,
    area: AREA,
    union: UNION,
    size: 300,
    current: { x: 700, y: 450 },
    rng: () => 0.5,
  });
  assert.ok(t);
  assert.equal(t.kind, 'fly');
  assert.ok(Math.abs(t.x * 1440 - 700) > 300, `应离开原地，x=${t.x * 1440}`);
});

test('九宫格换算：编号非法 / 面积为零 → null', () => {
  const base = { kind: 'fly' as const, area: AREA, union: UNION, size: 300, current: null };
  for (const cell of [0, 10, 1.5, NaN]) assert.equal(moveTargetOf({ ...base, cell }), null);
  assert.equal(moveTargetOf({ ...base, cell: 1, union: { ...UNION, width: 0 } }), null);
});
