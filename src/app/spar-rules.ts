import { SKILL_IDS, WEAPON_IDS, type Fighter, type FightOptions } from './battle';

/** 一对一切磋的公共配装，不读取修炼存档。 */
export const SPAR_LABEL = '切磋';
export const SPAR_STATS = { hp: 230, power: 20, agility: 20, speed: 20 } as const;
export const SPAR_OPTIONS: FightOptions = {
  damageScale: 0.65,
  maxHitShare: 0.3,
  sparMode: 'rounds',
};

export function sparFighter(name: string): Fighter {
  return { name, ...SPAR_STATS, weapons: [...WEAPON_IDS], skills: [...SKILL_IDS] };
}
