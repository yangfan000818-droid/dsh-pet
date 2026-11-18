import type { BattleEvent } from '../battle';
import type { FeatureContext } from './context';

/**
 * 切磋与修炼解绑后的结算：只看引擎的 end 事件和邻居簿，不碰 Cultivation。
 * 平局（独立切磋的 rounds 模式）不记胜负、不给胜利羁绊，日记照记。
 */
export type SparOutcome = 'win' | 'loss' | 'draw';

/** 引擎 end 事件 → 本地这一侧的结果；`draw` 是切磋新加的平局标记，winner 仍只是占位 */
export function sparOutcome(end: BattleEvent | undefined, local: 0 | 1): SparOutcome {
  if (end?.kind !== 'end') return 'loss';
  if (end.draw) return 'draw';
  return end.winner === local ? 'win' : 'loss';
}

/** 「赢了 / 输了 / 打平了」：日记、转播、感言共用 */
export function outcomeWord(outcome: SparOutcome): string {
  return outcome === 'win' ? '赢了' : outcome === 'loss' ? '输了' : '打平了';
}

/** 一场切磋的日记正文（平局也照记，避免被当成赢了或输了） */
export function sparDiaryText(
  owner: string,
  pet: string,
  outcome: SparOutcome,
  kind: 'spar' | 'duel' = 'spar',
): string {
  return `和 ${owner} 家的 ${pet} ${kind === 'duel' ? '隔空' : ''}切磋，${outcomeWord(outcome)}`;
}

/** 打完转播给主人看的一句结果（串门做客 / 隔空挑战方共用） */
export function sparResultLine(outcome: SparOutcome, kind: 'spar' | 'duel' = 'spar'): string {
  const prefix = kind === 'duel' ? '这场隔空切磋' : '这场';
  if (outcome === 'win') return `（切磋）${prefix}我赢啦！`;
  if (outcome === 'loss') return `（切磋）${prefix}输了，下次再战～`;
  return `（切磋）${prefix}打平啦～`;
}

export interface SettleSparOptions {
  /** spar = 串门切磋（recordSpar），duel = 隔空切磋（dueled，会顺带记邻居） */
  kind: 'spar' | 'duel';
  /** 有稳定邻居 id 才写得进邻居簿；没有 id（没验上身份）就只记日记 */
  neighborId?: string | null;
  names: { owner: string; pet: string };
  outcome: SparOutcome;
  /** 邻居簿这一笔要不要记（客人侧只有验证过身份才记）；默认 true */
  recordNeighbor?: boolean;
  /** 赢了给羁绊奖励；认输 / 迟到这类不算打赢，调用方传 false */
  bond?: boolean;
  /** 日记正文（平局也照记） */
  diary: string;
  now?: number;
}

/**
 * 记一场切磋的账：邻居战绩 + 胜利羁绊 + 日记。
 * 平局不记胜负也不给胜利奖；修炼经验和全局战绩在这里完全不碰。
 */
export function settleSpar(ctx: FeatureContext, options: SettleSparOptions): void {
  const now = options.now ?? Date.now();
  if (options.outcome !== 'draw') {
    if (options.recordNeighbor !== false && options.neighborId) {
      if (options.kind === 'spar') ctx.neighbors.recordSpar(options.neighborId, options.outcome === 'win');
      else ctx.neighbors.dueled(options.neighborId, options.names, options.outcome === 'win', now);
    }
    if (options.outcome === 'win' && options.bond !== false) ctx.fns.bondReward('battle');
  }
  ctx.diary.note(now, 'cultivate', options.diary);
}
