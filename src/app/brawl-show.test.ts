/**
 * X27 群架演出层（B1）的单测：环形摆位、命中坐标、时间线、执行接口调用顺序。
 *
 * 坐标与时间线都是纯函数，直接核对；执行接口用记录本核对顺序，不真等定时器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rngFrom } from './battle.ts';
import { fighterAt, seededRng } from './battle-testkit.ts';
import { ATTACK_SHOW } from './battle-show.ts';
import { autoBrawlController, brawl, type BrawlEvent } from './brawl.ts';
import {
  BRAWL_MIN_WINDOW_WIDTH,
  brawlAngles,
  brawlStageLayout,
  brawlStageOf,
  brawlWindowSize,
  brawlWindowWidth,
  type BrawlStageLayout,
} from './brawl-stage.ts';
import {
  applyBrawlCues,
  brawlCues,
  brawlShotPoints,
  brawlTimeline,
  type BrawlSides,
  type BrawlStep,
} from './brawl-show.ts';
import { bodyPoint, type Stage } from './fx-window.ts';
import type { Rect } from './visit-windows.ts';

const AREA: Rect = { x: 100, y: 50, width: 1_600, height: 1_000 };
const SELF = { width: 480, height: 300 };

function stagesOf(layout: BrawlStageLayout): Stage[] {
  return layout.rects.map((rect, index) => brawlStageOf(rect, layout.facing[index]));
}

function centerOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function assertInside(rect: Rect, area: Rect): void {
  assert.ok(rect.x >= area.x, `left ${rect.x} < ${area.x}`);
  assert.ok(rect.y >= area.y, `top ${rect.y} < ${area.y}`);
  assert.ok(rect.x + rect.width <= area.x + area.width, `right ${rect.x + rect.width} > ${area.x + area.width}`);
  assert.ok(rect.y + rect.height <= area.y + area.height, `bottom ${rect.y + rect.height} > ${area.y + area.height}`);
}

function roster(n: number, seed: number) {
  const rng = seededRng(seed);
  return Array.from({ length: n }, (_, id) => {
    const fighter = fighterAt(12, rng);
    return { ...fighter, id, name: `p${id}` };
  });
}

test('环形摆位：角度按人数等分，0 号在 6 点钟顺时针', () => {
  assert.deepEqual(brawlAngles(3), [90, 210, 330]);
  assert.deepEqual(brawlAngles(4), [90, 180, 270, 0]);
  assert.deepEqual(brawlAngles(5), [90, 162, 234, 306, 18]);
});

test('环形摆位：3/4/5 人围成一圈，0 号在正下方、左右两侧朝向环心', () => {
  for (const count of [3, 4, 5]) {
    const layout = brawlStageLayout({
      count,
      workArea: AREA,
      anchor: { x: 900, y: 550 },
      selfSize: SELF,
    });
    assert.equal(layout.rects.length, count);
    assert.equal(layout.facing.length, count);
    assert.ok(layout.rects.every((rect) => rect.width === layout.width && rect.height === layout.height));

    const centers = layout.rects.map(centerOf);
    const ring = layout.center;
    assert.ok(centers[0].y > ring.y, '0 号不在 6 点钟');
    assert.ok(Math.abs(centers[0].x - ring.x) <= 1.5, '0 号不在正下方');

    for (let index = 1; index < count; index += 1) {
      const dx = centers[index].x - ring.x;
      if (dx < -1) assert.equal(layout.facing[index], 'right', `第 ${index} 只在左半环应朝右`);
      else assert.equal(layout.facing[index], 'left', `第 ${index} 只应朝左 / 中轴用 left`);
    }
  }
});

test('环形摆位：锚点在工作区四角时整环平移，所有矩形不越界', () => {
  const cases = [
    { x: 900, y: 550 },
    { x: 110, y: 60 },
    { x: 1_680, y: 1_030 },
  ];
  for (const count of [2, 3, 4, 5]) {
    for (const anchor of cases) {
      const layout = brawlStageLayout({ count, workArea: AREA, anchor, selfSize: SELF });
      for (const rect of layout.rects) assertInside(rect, AREA);
    }
  }
});

test('窗口尺寸：人越少越大，5 人也不低于最小可读宽度', () => {
  const w3 = brawlWindowWidth(3, SELF.width);
  const w4 = brawlWindowWidth(4, SELF.width);
  const w5 = brawlWindowWidth(5, SELF.width);
  assert.ok(w3 > w4);
  assert.ok(w4 > w5);
  assert.ok(w5 >= BRAWL_MIN_WINDOW_WIDTH);
  assert.equal(brawlWindowWidth(5, 100), BRAWL_MIN_WINDOW_WIDTH);
});

test('放不下：先平移整环，再让所有窗口等比缩小（不低于 120px）', () => {
  const small: Rect = { x: 0, y: 0, width: 260, height: 200 };
  const layout = brawlStageLayout({ count: 5, workArea: small, anchor: { x: 130, y: 100 }, selfSize: SELF });
  assert.equal(layout.rects.length, 5);
  assert.equal(layout.scaled, true);
  assert.ok(layout.width >= BRAWL_MIN_WINDOW_WIDTH);
  assert.ok(layout.width < brawlWindowSize(5, SELF).width);
  for (const rect of layout.rects) assertInside(rect, small);
});

test('命中坐标：从出手方身体中心到目标身体中心，actor/target 互换后随之对调', () => {
  const layout = brawlStageLayout({ count: 3, workArea: AREA, anchor: { x: 900, y: 550 }, selfSize: SELF });
  const stages = stagesOf(layout);
  const forward = brawlShotPoints(stages, 0, 1);
  const backward = brawlShotPoints(stages, 1, 0);
  if (!forward || !backward) assert.fail('舞台齐全时应当算得出命中坐标');

  assert.deepEqual(forward.from, bodyPoint(stages[0]));
  assert.deepEqual(forward.to, bodyPoint(stages[1]));
  assert.deepEqual(backward.from, forward.to);
  assert.deepEqual(backward.to, forward.from);
  assert.ok(forward.to[0] >= stages[1].x && forward.to[0] <= stages[1].x + stages[1].width);
  assert.ok(forward.to[1] >= stages[1].y && forward.to[1] <= stages[1].y + stages[1].height);

  assert.equal(brawlShotPoints([stages[0], null, stages[2]], 0, 1), null);
});

/** 手喂的一小场：0 号水枪打 1 号、1 号空手被 0 号闪开、0 号淘汰、1 号胜 */
const HP3 = [100, 100, 100];
const EVENTS: BrawlEvent[] = [
  { actor: 0, kind: 'start', hp: HP3 },
  { actor: 0, kind: 'decide', action: { kind: 'weapon', weapon: 'water-gun', target: 1 }, hp: HP3 },
  {
    actor: 0,
    kind: 'hit',
    target: 1,
    weapon: 'water-gun',
    damage: 10,
    crit: false,
    blocked: false,
    hp: [100, 90, 100],
  },
  { actor: 1, kind: 'decide', action: { kind: 'unarmed', target: 0 }, hp: [100, 90, 100] },
  { actor: 1, kind: 'dodge', target: 0, hp: [100, 90, 100] },
  { actor: 0, kind: 'ko', target: 0, hp: [0, 90, 100] },
  { actor: 1, kind: 'end', winner: 1, reason: 'ko', ranking: [1, 2, 0], hp: [0, 90, 100] },
];

test('时间线：步骤数、hp 数组长度、who/target 编号都落在 0..2', () => {
  const steps = brawlTimeline(EVENTS, ['甲', '乙', '丙']);
  // 开场 3 + 两手里各「动作 + 飞行物」4 + 命中/闪避/淘汰 3 + 收场 3
  assert.equal(steps.length, 13);
  for (const step of steps) {
    assert.equal(step.hp.length, 3);
    assert.ok(step.who >= 0 && step.who < 3);
    if (step.target !== undefined) assert.ok(step.target >= 0 && step.target < 3);
  }
  assert.equal(steps.filter((step) => step.anim === '战斗-起手').length, 3);
  assert.equal(steps.filter((step) => step.closing).length, 3);
});

test('时间线：命中 / 闪避 / 淘汰落到具体的 who 与 target', () => {
  const steps = brawlTimeline(EVENTS, ['甲', '乙', '丙']);

  // 0 号水枪打 1 号：出手动作、飞行物、受击都标着 target = 1
  const onOne = steps.filter((step) => step.target === 1);
  assert.ok(onOne.some((step) => step.who === 0 && step.shot !== undefined));
  assert.ok(onOne.some((step) => step.who === 1 && step.anim === '受击-湿身'));
  assert.equal(steps.find((step) => step.shot !== undefined)?.shot?.kind, ATTACK_SHOW['water-gun'].fly?.kind);

  // 1 号空手被 0 号闪开：闪避演在 0 号身上
  assert.ok(steps.some((step) => step.who === 0 && step.target === 0 && step.anim === '战斗-闪避'));
  // 淘汰：倒地演在 0 号身上
  assert.ok(steps.some((step) => step.who === 0 && step.target === 0 && step.anim === '战斗-倒地'));
});

test('时间线：冲刺招排出 out/back 两步，target 指向被打的那只', () => {
  const hp = [100, 100];
  const steps = brawlTimeline(
    [
      { actor: 0, kind: 'start', hp },
      { actor: 0, kind: 'decide', action: { kind: 'skill', skill: 'dragon-palm', target: 1 }, hp },
      { actor: 0, kind: 'end', winner: 0, reason: 'ko', ranking: [0, 1], hp },
    ],
    ['甲', '乙'],
  );
  const dashes = steps.filter((step) => step.dash !== undefined);
  assert.deepEqual(
    dashes.map((step) => step.dash?.dir),
    ['out', 'back'],
  );
  assert.ok(dashes.every((step) => step.who === 0 && step.target === 1));
});

test('执行接口：动画 → 血条 → 飞行物 → 台词，飞行物落点取目标身体中心', () => {
  const layout = brawlStageLayout({ count: 3, workArea: AREA, anchor: { x: 900, y: 550 }, selfSize: SELF });
  const stages = stagesOf(layout);
  const steps = brawlTimeline(EVENTS, ['甲', '乙', '丙']);
  const shotStep = steps.find((step) => step.shot !== undefined);
  if (!shotStep) assert.fail('时间线里没有飞行物');
  const target = shotStep.target;
  if (target === undefined) assert.fail('飞行物没有目标');

  const points = brawlShotPoints(stages, shotStep.who, target);
  if (!points) assert.fail('舞台齐全时应当算得出命中坐标');

  const rich: BrawlStep = { ...shotStep, anim: '战斗-直拳', rate: 1, line: '中！' };
  const cues = brawlCues(rich, stages);
  assert.deepEqual(
    cues.map((cue) => cue.kind),
    ['play', 'arena', 'shoot', 'say'],
  );
  const shoot = cues.find((cue) => cue.kind === 'shoot');
  if (!shoot || shoot.kind !== 'shoot') assert.fail('没有 shoot cue');
  assert.deepEqual(shoot.from, points.from);
  assert.deepEqual(shoot.to, points.to);

  const calls: string[] = [];
  const sides: BrawlSides = {
    side: (id) => ({
      play: (anim, rate) => calls.push(`play:${id}:${anim}:${rate}`),
      say: (line, ms) => calls.push(`say:${id}:${line}:${ms}`),
    }),
    arena: (hp) => calls.push(`arena:${hp.length}`),
    shoot: (shot, from, to) => calls.push(`shoot:${shot.kind}:${from[0]}:${to[0]}`),
  };
  applyBrawlCues(sides, cues);
  assert.deepEqual(
    calls.map((call) => call.split(':')[0]),
    ['play', 'arena', 'shoot', 'say'],
  );
});

test('真实群架：每个带 target 的事件都能在时间线上找到目标，hp 快照长度等于人数', () => {
  const fighters = roster(5, 6);
  const controllers = fighters.map((_, id) => autoBrawlController(rngFrom(`show-ctl:${id}`)));
  const events = brawl(fighters, 'show-seed', controllers);
  const steps = brawlTimeline(
    events,
    fighters.map((fighter) => fighter.name),
  );

  assert.ok(steps.length > events.length);
  for (const step of steps) {
    assert.equal(step.hp.length, 5);
    assert.ok(step.who >= 0 && step.who < 5);
  }
  for (const event of events) {
    if ('target' in event && typeof event.target === 'number') {
      assert.ok(
        steps.some((step) => step.target === event.target),
        `${event.kind} 的目标 ${event.target} 没落到时间线上`,
      );
    }
  }
});
