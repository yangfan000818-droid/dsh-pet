/**
 * dev/battle-sim.mjs —— 对战引擎的平衡模拟（开发自测工具，不入 npm 包）：随机生成成千上万对角色对打，
 * 打印胜率表（同境界、境界差、每件法宝和每个招式的持有优势、心魔、渡劫），给 §X0 的平衡断言定调。
 *
 * 用法（strip-types 与 test-register 的说明见 scripts/test-ts-resolver.mjs）：
 *   node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/battle-sim.mjs [--pairs 2000]
 *
 * 角色用 src/app/battle-testkit.ts 的 fighterAt 生成（和平衡断言共用同一份成长近似）。
 * 境界映射：炼气 0–8；筑基 9–11、金丹 12–14、元婴 15–17、化神 18–20、炼虚 21–23、合体 24–26、大乘 27–29。
 * 渡劫雷数（§X4）：进筑基、金丹 3 道，进元婴、化神 6 道，之后 9 道。
 */
import {
  autoController,
  fairSparPair,
  fight,
  rngFrom,
  shadowOf,
  tribulate,
  WEAPONS,
  SKILLS,
  SPAR_DAMAGE_SCALE,
  SPAR_MAX_HIT_SHARE,
} from '../../src/app/battle.ts';
import { fighterAt, seededRng } from '../../src/app/battle-testkit.ts';

const pairs = Number(process.argv.includes('--pairs') ? process.argv[process.argv.indexOf('--pairs') + 1] : 2000);
const rng = Math.random;
const seedOf = (i) => `sim-${i}`;

function fighters(stage) {
  const a = fighterAt(stage, rng);
  const b = fighterAt(stage, rng);
  a.name = '甲';
  b.name = '乙';
  return [a, b];
}

function winRate(make, options) {
  let wins = 0;
  for (let i = 0; i < pairs; i++) if (fight(...make(i), seedOf(i), undefined, options).at(-1).winner === 0) wins++;
  return wins / pairs;
}

function withWeapon(f, id) {
  f.weapons = [id, ...f.weapons.filter((w) => w !== id)];
  return f;
}
function withoutWeapon(f, id) {
  f.weapons = f.weapons.filter((w) => w !== id);
  return f;
}
/** 持有方把一个随机招换成 X（而不是白多一个招），量出来的才是 X 本身的分量 */
function withSkill(f, id) {
  if (f.skills.includes(id)) return f;
  if (f.skills.length === 0) return ((f.skills = [id]), f);
  f.skills[Math.floor(Math.random() * f.skills.length)] = id;
  return f;
}

const dungeonFlag = process.argv.indexOf('--dungeon');
if (dungeonFlag >= 0 && process.argv[dungeonFlag + 1] === 'sanwang') {
  const { advance, autoDecide, choicesOf, startRun, TRAVEL_MS, RUN_TTL_MS } = await import('../../src/app/dungeon.ts');
  const { SANWANG } = await import('../../src/app/dungeon-sanwang.ts');
  const { fighterAt } = await import('../../src/app/battle-testkit.ts');
  const suppressed = process.argv.includes('--suppressed');
  const runs = Number(process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : 400);
  const stage = SANWANG.originStage;
  const tally = { mob: [0, 0], elite: [0, 0], boss: [0, 0] };
  let clear = 0;
  let rewinds = 0;
  let xp = 0;
  let steps = 0;
  let ms = 0;
  const endings = {};
  for (let i = 0; i < runs; i++) {
    const pet = fighterAt(stage, Math.random);
    pet.name = '小鱼';
    let run = startRun(SANWANG, { pet, stage, suppressed, nonce: `sim-${i}`, now: 0 });
    let now = 0;
    let localMs = 0;
    for (let n = 0; n < 200 && run.status !== 'over'; n++) {
      if (choicesOf(SANWANG, run, pet).length === 0) break;
      now = Math.max(now, run.readyAt);
      const decision = autoDecide(SANWANG, run, pet);
      const res = advance(SANWANG, run, pet, decision, now);
      run = res.run;
      const out = res.outcome.result;
      // 奇遇里打起来的那一场（韩不留）打赢时包在 event 的 fought 里，打输时才是 fight 本身
      const fought = out.kind === 'fight' ? out : out.kind === 'event' ? out.fought : undefined;
      if (fought) {
        tally[fought.tier][fought.won ? 0 : 1] += 1;
        localMs += fought.tier === 'boss' ? 60_000 : 10_000;
      } else if (res.outcome.travel) {
        localMs += TRAVEL_MS;
      }
      if (out.kind === 'rewind') rewinds++;
      if (res.outcome.end) {
        xp += res.outcome.end.loot.xp;
        if (res.outcome.end.reason === 'clear') {
          clear++;
          const id = res.outcome.end.ending?.id ?? 'none';
          endings[id] = (endings[id] ?? 0) + 1;
        }
      }
      now += 1;
      steps++;
    }
    ms += Math.min(localMs, RUN_TTL_MS);
  }
  const rate = ([w, l]) => (w + l === 0 ? 'n/a' : ((w / (w + l)) * 100).toFixed(1) + '%');
  console.log(`三王传承${suppressed ? '（压境）' : ''}：${runs} 趟\n`);
  console.log(`小怪胜率 ${rate(tally.mob)}（${tally.mob[0] + tally.mob[1]} 场）`);
  console.log(
    `精英胜率 ${rate(tally.elite)}（${tally.elite[0] + tally.elite[1]} 场；托管的走法只碰「绕开韩不留」失手后的残血场）`,
  );
  console.log(`守护胜率 ${rate(tally.boss)}（${tally.boss[0] + tally.boss[1]} 场）`);
  console.log(`通关率 ${((clear / runs) * 100).toFixed(1)}%`);
  console.log(`春秋蝉用了几成 ${((rewinds / runs) * 100).toFixed(1)}%`);
  console.log(`结局 ${JSON.stringify(endings)}`);
  console.log(`平均修为 ${(xp / runs).toFixed(1)}，平均走 ${(steps / runs).toFixed(1)} 步`);
  console.log(
    `估算一趟 ${(ms / runs / 60_000).toFixed(1)} 分钟（每步赶路 ${TRAVEL_MS / 1000} 秒 + 速战 10 秒 + 守护 1 分钟）`,
  );
  process.exit(0);
}

// X26：真实切磋单独跑，避免拿全伤害托管局判断手动体验。每场双方属性 / 件数拉平，
// 甲分别用托管和「主动伤害技优先」策略，乙始终托管；同一项两种策略共用角色与战斗种子。
if (process.argv.includes('--spar')) {
  const stage = Number(process.argv.includes('--stage') ? process.argv[process.argv.indexOf('--stage') + 1] : 10);
  const options = { damageScale: SPAR_DAMAGE_SCALE, maxHitShare: SPAR_MAX_HIT_SHARE };
  const damageFirst = [
    'abyss-field',
    'ancients',
    'ghost-knock',
    'tide-cannon',
    'blue-whale',
    'ghost-blood',
    'ghost-hand',
    'dragon-palm',
    'myriad-palm',
    'lion-roar',
    'whale-song',
    'dream-chant',
    'farewell-wind',
    'whale-gulp',
    'finger-sword',
    'headless-shadow',
    'ghost-painting',
    'eat-hardship',
  ];
  const putSkill = (f, id) => {
    if (!id || f.skills.includes(id)) return f;
    if (f.skills.length === 0) f.skills = [id];
    else f.skills[f.skills.length - 1] = id;
    return f;
  };
  const sparRate = (id, manual) => {
    let wins = 0;
    for (let i = 0; i < pairs; i++) {
      const [a, b] = fairSparPair(putSkill(fighterAt(stage, seededRng(i)), id), fighterAt(stage, seededRng(i + 500)));
      a.name = '甲';
      b.name = '乙';
      const seed = seedOf(i);
      let controllers;
      if (manual) {
        const decideRng = rngFrom(seed + ':decide');
        const fallback = autoController(decideRng);
        controllers = [
          {
            decide(view) {
              const unused = view.you.skills.filter((skill) => !view.you.used.includes(skill));
              const skill =
                view.you.sealed === 'skill' || view.you.skillUsesLeft === 0
                  ? undefined
                  : damageFirst.find((candidate) => unused.includes(candidate));
              return skill ? { kind: 'skill', skill } : fallback.decide(view);
            },
          },
          autoController(decideRng),
        ];
      }
      if (fight(a, b, seed, controllers, options).at(-1).winner === 0) wins++;
    }
    return wins / pairs;
  };
  console.log(`真实切磋 stage=${stage}，每项 ${pairs} 场；甲手动主动技优先，乙托管\n`);
  console.log(`随机配招：托管 ${sparRate(null, false).toFixed(3)}；主动技优先 ${sparRate(null, true).toFixed(3)}\n`);
  for (const id of Object.keys(SKILLS)) {
    console.log(
      `招式 ${SKILLS[id].name}：托管 ${sparRate(id, false).toFixed(3)}；主动技优先 ${sparRate(id, true).toFixed(3)}`,
    );
  }
  process.exit(0);
}

const HOLDOUT_STAGE = 10; // 筑基中期：有一件多的法宝和一个换招的位置，量持有优势最稳

console.log(`对打 ${pairs} 场一场一种子（--pairs 可调）\n`);

for (const stage of [4, 10, 16, 25]) {
  let timeouts = 0;
  for (let i = 0; i < pairs; i++) if (fight(...fighters(stage), seedOf(i)).at(-1).reason === 'timeout') timeouts++;
  console.log(
    `同境界 stage=${stage}：甲胜率 ${winRate(() => fighters(stage)).toFixed(3)}（封顶判定 ${(timeouts / pairs).toFixed(2)}）`,
  );
}
console.log('');

for (const [hi, lo, label] of [
  [10, 9, '1 个小境界（10 对 9）'],
  [13, 10, '1 个大境界（13 对 10）'],
  [16, 13, '1 个大境界（16 对 13）'],
  [4, 1, '炼气 3 层（4 对 1）'],
]) {
  let wins = 0;
  let fairWins = 0;
  for (let i = 0; i < pairs; i++) {
    const hi0 = fighterAt(hi, rng);
    const lo0 = fighterAt(lo, rng);
    hi0.name = '甲';
    lo0.name = '乙';
    if (fight(hi0, lo0, seedOf(i)).at(-1).winner === 0) wins++;
    // 切磋拉平修为（X20）：属性取中点、法宝招式按少的一方取齐
    const [fairHi, fairLo] = fairSparPair(hi0, lo0);
    if (fight(fairHi, fairLo, seedOf(i)).at(-1).winner === 0) fairWins++;
  }
  console.log(`高 ${label}：高的胜率 ${(wins / pairs).toFixed(3)}；切磋拉平后 ${(fairWins / pairs).toFixed(3)}`);
}
console.log('');

for (const id of Object.keys(WEAPONS)) {
  const rate = winRate(() => {
    const [a, b] = fighters(HOLDOUT_STAGE);
    return [withWeapon(a, id), withoutWeapon(b, id)];
  });
  console.log(`法宝 ${WEAPONS[id].name}：持有方胜率 ${rate.toFixed(3)}`);
}
console.log('');

for (const id of Object.keys(SKILLS)) {
  const rate = winRate(() => {
    const [a, b] = fighters(HOLDOUT_STAGE);
    return [withSkill(a, id), b];
  });
  console.log(`招式 ${SKILLS[id].name}：持有方胜率 ${rate.toFixed(3)}`);
}
// 送友风（串门，X16）：只有串门切磋会打开 farewell；超了 0.65 就降 battle.ts 的 FAREWELL_SEND_CHANCE
{
  const rate = winRate(
    () => {
      const [a, b] = fighters(HOLDOUT_STAGE);
      return [withSkill(a, 'farewell-wind'), b];
    },
    { farewell: true },
  );
  console.log(`招式 送友风（串门）：持有方胜率 ${rate.toFixed(3)}`);
}
console.log('');

for (const stage of [4, 10, 16, 25]) {
  let shadowWins = 0;
  for (let i = 0; i < pairs; i++) {
    const me = fighters(stage)[0];
    if (fight(me, shadowOf(me), seedOf(i)).at(-1).winner === 0) shadowWins++;
  }
  console.log(`心魔 stage=${stage}：本体胜率 ${(shadowWins / pairs).toFixed(3)}`);
}
console.log('');

const strikesOf = (stage) => (stage <= 12 ? 3 : stage <= 18 ? 6 : 9);
for (const stage of [9, 12, 15, 18, 21, 24, 27]) {
  const strikes = strikesOf(stage);
  for (const pill of [false, true]) {
    let ok = 0;
    for (let i = 0; i < pairs; i++) {
      const f = fighterAt(stage, rng);
      if (pill) f.hp = Math.floor(f.hp * 1.2);
      if (tribulate(f, strikes, stage, seedOf(i)).at(-1).winner === 0) ok++;
    }
    console.log(`渡劫 stage=${stage} ${strikes} 道雷${pill ? '（吃丹）' : ''}：成功率 ${(ok / pairs).toFixed(3)}`);
  }
}
