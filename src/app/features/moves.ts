import { findPetInstance, readAllConfig } from '../../host/config';
import type { ConfigPaths } from '../../host/config';
import type { MoveKind } from '../move-target';
import { errorText } from './util';

/** 一个可点播的移动动作：动画名 + 给 AI 选位置时按飞 / 走哪一类提示 */
export interface MoveAction {
  name: string;
  kind: MoveKind;
}

/**
 * 移动点播池：直接读宠物配置的 `animations.moves.actions`（与自动漫游、渲染端同一份），
 * 以后往配置里加移动素材，右键「动一动」和看屏幕后的自动移动都自动跟着变。
 * 读不到时回落到内置的两项。
 */
export function moveActions(configPaths: ConfigPaths, petId: string, log: (message: string) => void): MoveAction[] {
  try {
    const conf = findPetInstance(readAllConfig(configPaths), petId)?.conf;
    const animations = conf?.animations as
      { moves?: { default?: Record<string, unknown>; actions?: Array<Record<string, unknown>> } } | undefined;
    const moves = animations?.moves;
    if (Array.isArray(moves?.actions)) {
      const defaults = moves.default ?? {};
      const list: MoveAction[] = [];
      for (const action of moves.actions) {
        const name = typeof action?.name === 'string' ? action.name : '';
        if (!name) continue;
        const params = {
          ...defaults,
          ...(action.params && typeof action.params === 'object' ? action.params : {}),
        };
        // 飞行类按配置的上下位移认；瞬移也是送到远处，AI 选位置时按 fly 提示
        const flying = params.teleport === true || Number(params.minRise) > 0 || Number(params.maxRise) > 0;
        list.push({ name, kind: flying ? 'fly' : 'walk' });
      }
      if (list.length > 0) return list;
    }
  } catch (error) {
    log(`读移动动作池失败，按内置两项处理：${errorText(error)}`);
  }
  return [
    { name: '螃蟹走路', kind: 'walk' },
    { name: '飞来飞去', kind: 'fly' },
  ];
}

/**
 * 从移动池里随机挑一个。`kind` 给了就只在那一类（飞 / 走）里挑，挑不到返回 null；
 * rng 理论上是 [0,1)，测试注入 1 时也落在最后一项，不越界。
 */
export function pickMoveAction(actions: MoveAction[], rng: () => number, kind?: MoveKind): MoveAction | null {
  const pool = kind ? actions.filter((action) => action.kind === kind) : actions;
  if (pool.length === 0) return null;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)));
  return pool[index];
}
