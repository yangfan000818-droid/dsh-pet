/**
 * 羁绊小窗与跟班窗口的几何单测：都只算坐标，不碰 Electron。
 *
 * 跑法：node --experimental-strip-types --import ./scripts/test-register.mjs --test src/app/bond-window.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BOND_HEIGHT, BOND_WIDTH, bondBounds } from './bond-window.ts';
import { companionBounds, companionSize } from './companion-window.ts';
import type { PetBox, Rect } from './visit-windows.ts';

const WORK: Rect = { x: 0, y: 0, width: 1200, height: 800 };
const pet = (left: number, top: number, size = 400): PetBox => ({ left, top, size, bottomPad: 0 });

describe('羁绊小窗位置', () => {
  test('宠物左边放得下就放左边，垂直居中于宠物', () => {
    const rect = bondBounds(pet(600, 200), WORK);
    assert.equal(rect.width, BOND_WIDTH);
    assert.equal(rect.height, BOND_HEIGHT);
    assert.equal(rect.x, 600 - BOND_WIDTH - 16);
    assert.equal(rect.y, Math.round(200 + 200 - BOND_HEIGHT / 2));
  });

  test('左边放不下换右边，仍然超出就夹回工作区', () => {
    assert.equal(bondBounds(pet(100, 200), WORK).x, 100 + 400 + 16);
    const nearRight = bondBounds(pet(1150, 200), WORK);
    assert.ok(nearRight.x + BOND_WIDTH <= WORK.x + WORK.width - 4);
  });

  test('不知道宠物在哪时居中', () => {
    const rect = bondBounds(null, WORK);
    assert.equal(rect.x, Math.round((WORK.width - BOND_WIDTH) / 2));
    assert.equal(rect.y, Math.round((WORK.height - BOND_HEIGHT) / 2));
  });
});

describe('跟班位置', () => {
  test('按宠物大小缩放，最小 48px', () => {
    assert.equal(companionSize(500), 160);
    assert.equal(companionSize(100), 48);
    assert.equal(companionSize(1000), 320);
  });

  test('优先挂在宠物左下角外侧', () => {
    const rect = companionBounds(pet(600, 200), WORK);
    const size = companionSize(400);
    assert.equal(rect.width, size);
    assert.equal(rect.height, size);
    assert.equal(rect.x, Math.round(600 - size * 0.55));
    assert.equal(rect.y, Math.round(200 + 400 * 0.7));
  });

  test('左边没地方换到右下角', () => {
    const rect = companionBounds(pet(0, 200), WORK);
    assert.equal(rect.x, Math.round(0 + 400 - companionSize(400) * 0.45));
  });

  test('贴屏幕底边时夹回工作区', () => {
    const rect = companionBounds(pet(600, 700), WORK);
    assert.ok(rect.y + rect.height <= WORK.y + WORK.height - 4);
  });

  test('工作区有偏移时也夹在偏移后的范围里', () => {
    const work = { x: 1400, y: 100, width: 900, height: 700 };
    const rect = companionBounds(pet(1400, 600), work);
    assert.ok(rect.x >= work.x + 4);
    assert.ok(rect.x + rect.width <= work.x + work.width - 4);
    assert.ok(rect.y >= work.y + 4);
    assert.ok(rect.y + rect.height <= work.y + work.height - 4);
  });
});
