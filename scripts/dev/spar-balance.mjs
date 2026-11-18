// node --experimental-strip-types --import ./scripts/test-register.mjs scripts/dev/spar-balance.mjs [seeds=2000] [all|rounds]
// 每个种子交换双方位置；镜像按种子计样本，不把交换后的同一局当独立样本。
import fs from 'node:fs';
import { autoController, fight, legalActions, rngFrom, WEAPON_IDS } from '../../src/app/battle.ts';
import { roundsAutoAction } from '../../src/app/battle-live.ts';
import { SPAR_OPTIONS, sparFighter } from '../../src/app/spar-rules.ts';

const n = Number(process.argv[2] ?? 2000);
if (!Number.isInteger(n) || n < 1) throw new Error('seeds must be a positive integer');
const selection = process.argv[3] ?? 'all';
if (selection !== 'all' && selection !== 'rounds') throw new Error('mode must be all or rounds');
const modes = selection === 'rounds' ? ['rounds'] : ['legacy', 'opening', 'rounds'];
const scripts = {
  race: { skills: ['blue-whale', 'abyss-field', 'headless-shadow'], weapon: 'juggle' },
  counter: { skills: ['reverse-seal', 'abyss-field', 'bloom'], weapon: 'duster' },
  control: { skills: ['whale-song', 'blue-whale', 'finger-sword'], weapon: 'juggle' },
  guard: { skills: ['shadow-step', 'abyss-field', 'headless-shadow'], weapon: 'top' },
};
const unarmed = { kind: 'unarmed' };
function controller(name, seed) {
  if (name === 'live-auto') return { decide: (v) => roundsAutoAction(v, seed, v.round) };
  if (name === 'engine-auto') return autoController(rngFrom(seed + ':decide'));
  const [style, preferredWeapon] = name.split(':');
  const script = scripts[style];
  let index = 0;
  return {
    decide(v) {
      if (v.round !== undefined && (v.you.status?.skip || v.you.status?.charge)) return unarmed;
      const legal = legalActions(v);
      const has = (id) => legal.find((a) => a.kind === 'skill' && a.skill === id);
      const weapon = (id) => legal.find((a) => a.kind === 'weapon' && a.weapon === id) ?? unarmed;
      if (style === 'guide' || style === 'heal' || style === 'finish') {
        const me = v.self;
        const foe = me ^ 1;
        const bloom = style !== 'finish' && has('bloom');
        if (bloom && v.hp[me] * 10 <= v.maxHp[me] * 8) return bloom;
        const sword = style !== 'heal' && has('finger-sword');
        if (sword && v.hp[foe] * 10 <= v.maxHp[foe] * 4) return sword;
        const mirror = style === 'guide' && has('myriad-self');
        if (mirror && !v.foe.skills.includes('ghost-eye')) return mirror;
        return weapon(preferredWeapon ?? 'firework');
      }
      if (!script) return weapon(style);
      while (index < script.skills.length && v.you.sealed !== 'skill') {
        const action = has(script.skills[index++]);
        if (action) return action;
      }
      return weapon(preferredWeapon ?? script.weapon);
    },
  };
}

const comparisonPairs = [
  ['guide', 'guide'],
  ['race', 'race'],
  ['counter', 'counter'],
  ['control', 'control'],
  ['guide', 'race'],
  ['guide', 'counter'],
];
const weapons = ['firework', ...WEAPON_IDS.filter((id) => id !== 'firework')];
const roundsPairs = [
  ...comparisonPairs,
  ...[
    'control',
    'guard',
    'guard:tray',
    'counter:slingshot',
    'firework',
    'heal',
    'finish',
    'guide:tray',
    'guide:top',
    'guide:slingshot',
    'live-auto',
    'engine-auto',
  ].map((b) => ['guide', b]),
  ...weapons.flatMap((a, i) => weapons.slice(i + 1).map((b) => [a, b])),
];
const fighters = [sparFighter('甲'), sparFighter('乙')];
const results = [];
const games = n * 2;
for (const mode of modes) {
  const options =
    mode === 'rounds' ? SPAR_OPTIONS : { ...SPAR_OPTIONS, sparMode: mode === 'opening' ? mode : undefined };
  for (const [a, b] of mode === 'rounds' ? roundsPairs : comparisonPairs) {
    let wins = 0,
      draws = 0,
      rounds = 0,
      firstN = 0,
      firstWins = 0,
      firstDraws = 0;
    for (let i = 0; i < n; i++) {
      const seed = `spar-regression-${i}`;
      for (const side of [0, 1]) {
        const engines = [controller(a, seed), controller(b, seed)];
        if (side === 1) engines.reverse();
        const events = fight(...fighters, seed, engines, options);
        const end = events.at(-1);
        wins += Number(!end.draw && end.winner === side);
        draws += Number(!!end.draw);
        if (mode === 'rounds') {
          rounds += events.filter((e) => e.kind === 'round-end').length;
        } else if (events.find((e) => e.kind === 'decide').actor === side) {
          firstN++;
          firstWins += Number(!end.draw && end.winner === side);
          firstDraws += Number(!!end.draw);
        }
      }
    }
    const row = {
      mode,
      a,
      b,
      seeds: n,
      games,
      winRate: wins / games,
      drawRate: draws / games,
      score: (wins + draws * 0.5) / games,
      meanRounds: mode === 'rounds' ? rounds / games : null,
      aFirstWin: firstN ? firstWins / firstN : null,
      aFirstDraw: firstN ? firstDraws / firstN : null,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
}
const file = process.env.SPAR_BALANCE_OUTPUT;
if (file) fs.writeFileSync(file, JSON.stringify({ seeds: n, results }, null, 2));
