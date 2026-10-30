/**
 * X27 群架联机的「定手」驱动（B4）：把拿到手的每一手喂给引擎，逐段重放出整场事件。
 *
 * 规则（`docs/x27-brawl-design.md` §3.2 / §3.3）：网络只传每手的选择，不传事件。
 * 轮到谁，谁把 `{ target, action }` 交给网络；房主校验后广播回来，各家按同一顺序
 * 重放引擎。这里只管「已知哪些选择、下一步该谁、本机该交什么」，收发由接线方做。
 *
 * 退场（认输 / 掉线）：接线方收到 `out(id)` 后，这个编号之后的选择不再等网络，
 * 改用由种子派生的自动控制补上——各家套同一份规则，结果照样一致。
 */
import type { Action } from './battle';
import {
  brawlUntilDecision,
  type BrawlAction,
  type BrawlDecisionNeed,
  type BrawlEvent,
  type BrawlFighter,
  type BrawlOptions,
  type BrawlView,
} from './brawl';

/** 网络交来的一手（`index` 是全场第几手，从 0 起） */
export interface BrawlLiveMove {
  index: number;
  actor: number;
  target: number;
  action: Action;
}

export interface BrawlLiveOptions {
  /** 参战方（编号从 0 连续） */
  fighters: readonly BrawlFighter[];
  /** 引擎种子（各家 nonce 拼出来的那一份） */
  seed: string;
  /** 本机编号 */
  self: number;
  /**
   * 轮到本机时选一手。返回 `null` 表示这一手还没定（手动面板开着等玩家点）：
   * 定手停在这里，等接线方把这一手交出去、网络广播回来再继续。
   */
  choose: (view: BrawlView) => BrawlAction | null;
  /** 把本机这一手交给网络；不是自己的轮次不会被调 */
  submit: (target: number, action: Action) => void;
  brawl?: BrawlOptions;
}

export interface BrawlLive {
  /** 已经定下来的整场事件（重放结果） */
  events(): BrawlEvent[];
  /** 下一处缺的那一手：`null` 说明整场已经定完 */
  pending(): BrawlDecisionNeed | null;
  done(): boolean;
  /** 收到别人的一手：序号接得上、出手人对得上才收下 */
  push(move: BrawlLiveMove): boolean;
  /** 某方退场：之后它的选择由本地按种子自动补 */
  out(id: number): void;
  /** 本机的某一手被拒（或发丢了）：允许再交一次 */
  retry(): void;
  /** 推进到下一处「等别人」为止；没有可推进的就什么也不做 */
  pump(): void;
}

export function createBrawlLive(options: BrawlLiveOptions): BrawlLive {
  const { fighters, seed, self } = options;
  /** 按编号攒下已定的一手手（引擎按每人自己的顺序取） */
  const delivered: BrawlAction[][] = fighters.map(() => []);
  const gone = new Set<number>();
  /** 退场清单：喂给引擎的那份（`at` = 这人已经出过几手，各家算出来一样） */
  const forfeits: Array<{ id: number; at: number }> = [];
  let events: BrawlEvent[] = [];
  let need: BrawlDecisionNeed | null = null;
  let done = false;
  /** 本机这一手交出去了，等网络广播回来 */
  let submitted = false;

  const known = (): number => delivered.reduce((sum, list) => sum + list.length, 0);

  const replay = (): void => {
    const result = brawlUntilDecision(
      fighters,
      seed,
      delivered,
      forfeits.length === 0
        ? options.brawl
        : { ...options.brawl, forfeits: [...(options.brawl?.forfeits ?? []), ...forfeits] },
    );
    events = result.events;
    need = result.need;
    done = result.need === null;
  };

  const pump = (): void => {
    replay();
    if (done || !need) return;
    if (need.id !== self) return;
    if (gone.has(self)) {
      // 本机已经退场：这一手（以及后面的）由自动补，别再往外发
      return;
    }
    if (submitted) return;
    const action = options.choose(need.view);
    // 手动：玩家还没点，这一手先不定；接线方交出去以后会经网络广播回来
    if (!action) return;
    submitted = true;
    options.submit(action.target, action);
  };

  return {
    events: () => events,
    pending: () => need,
    done: () => done,
    push(move) {
      if (done) return false;
      if (move.index !== known()) return false;
      if (!need) replay();
      if (!need || move.actor !== need.id) return false;
      if (move.actor < 0 || move.actor >= delivered.length) return false;
      // 线上把目标单列（`parseSparAction` 的口径不带目标），喂给引擎时拼回 `BrawlAction`
      delivered[move.actor].push({ ...move.action, target: move.target });
      if (move.actor === self) submitted = false;
      pump();
      return true;
    },
    out(id) {
      if (id < 0 || id >= delivered.length || gone.has(id)) return;
      gone.add(id);
      if (id === self) submitted = false;
      // 退场落在「这人下一手」：他已经出过几手就是引擎那边的第几手
      forfeits.push({ id, at: delivered[id].length });
      pump();
    },
    retry() {
      submitted = false;
      pump();
    },
    pump,
  };
}
