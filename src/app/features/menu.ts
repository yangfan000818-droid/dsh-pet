import { findPetInstance, readAllConfig } from '../../host/config';
import { MENU_CULTIVATION_GROUP, MENU_VISIT_GROUP, lazyFns } from './context';
import type { FeatureContext } from './context';
import { delay, errorText } from './util';

/** 右键菜单的 owner（插件按它归组、按它投递点击；helper 按它把这组项放根菜单，见 main.ts） */
export const MENU_OWNER = 'dsh-pet-app';
const MENU_LOOK = '看看我在干嘛';
const MENU_DIARY = '宠物日记';
/** 羁绊小窗：有待演的小剧场时，bondMenuLabel() 会变成「羁绊 · 有话想说」 */
const MENU_BOND = '羁绊';
/** 常驻的移动点播：点了就随机飞 / 走一段（动作池里没有同名素材时宿主不播，只记日志） */
const MENU_MOVE = '动一动';
/** 宿主每个 owner 的菜单项上限（src/host/menu.ts 的 ITEMS_MAX，`>` 才拒） */
const MENU_ITEMS_MAX = 24;

/** 右键菜单：要注册的项、注册队列、点击 */
export interface Menu {
  wantedLabels(): string[];
  refreshMenu(force?: boolean): Promise<void>;
  pollMenu(): Promise<void>;
}

/** 一个可点播的移动动作：动画名 + 给 AI 选位置时按飞 / 走哪一类提示 */
interface MoveAction {
  name: string;
  kind: 'fly' | 'walk';
}

export function createMenu(ctx: FeatureContext): Menu {
  const {
    bondMenuLabel,
    brawlActions,
    brawlLiveActions,
    cultivationActions,
    openBond,
    duelChallengeActions,
    lookAtScreen,
    moveWithAi,
    openDiary,
    petId,
    petRequest,
    refreshStatus,
    say,
    visitActions,
  } = lazyFns(ctx);
  const { deps, log } = ctx;
  /**
   * 要注册的菜单项。宿主每个 owner 最多 24 项（`>` 就整份拒了，菜单从此不再更新），
   * 所以这里按优先级兜底截断：固定的四项（看屏幕、日记、动一动、羁绊）+ 修炼（最多 4：信息、渡劫、服丹后渡劫、领悟×2 中的一种组合）
   * 在前，串门项在后——挤不下时先少列几个邻居 / 少几样一起玩和零食，「送客」「切磋」「心魔试炼」「渡劫」这些都要留。
   */
  function wantedLabels(): string[] {
    const labels = [
      MENU_LOOK,
      MENU_DIARY,
      MENU_MOVE,
      // 羁绊排在移动点播之后、修炼之前：和“看看我在干嘛 / 宠物日记 / 动一动”一样是常驻入口
      // （菜单顺序测试也按这个口径）
      bondMenuLabel(),
      ...cultivationActions().keys(),
      // 群架（X27）还在本地演示阶段：先排在串门项前面，方便真机看 3/4/5 人的围圈；
      // B4 接上联机、定下入口位置后再挪到切磋那一档
      ...brawlActions().keys(),
      ...brawlLiveActions().keys(),
      ...visitActions().keys(),
      // 隔空切磋的挑战项排在串门项之后：菜单挤不下时先截掉它们（X15）
      ...duelChallengeActions().keys(),
    ];
    return labels.length > MENU_ITEMS_MAX ? labels.slice(0, MENU_ITEMS_MAX) : labels;
  }

  /**
   * 注册菜单一次排一次队：上一次的 /menu/item 回来以后，下一次才按**那时**的状态重算再发。
   * 不排队的话，两次刷新并发时旧的那份可能后到宿主（历练小窗刚关、「小窗开着」那份还在路上），
   * 菜单就停在旧状态，而 menuLabels 记成了最后回来的那份，之后没有新变化就不会再刷。
   */
  function refreshMenu(force = false): Promise<void> {
    const next = ctx.state.menuQueue.then(() => registerMenu(force));
    ctx.state.menuQueue = next.catch(() => undefined);
    return next;
  }

  async function registerMenu(force: boolean): Promise<void> {
    const labels = wantedLabels();
    if (!force && labels.join('\n') === ctx.state.menuLabels.join('\n')) return;
    try {
      const result = await petRequest('POST', '/menu/item', { owner: MENU_OWNER, labels });
      if (result.ok === true) ctx.state.menuLabels = labels;
      else log(`注册菜单失败：${JSON.stringify(result)}`);
    } catch (error) {
      log(`注册菜单失败：${errorText(error)}`);
    }
  }

  /**
   * 移动点播池：直接读宠物配置的 `animations.moves.actions`（与自动漫游、渲染端同一份），
   * 以后往配置里加移动素材，菜单自动跟着变。读不到时回落到内置的两项。
   */
  function moveActions(): MoveAction[] {
    try {
      const conf = findPetInstance(readAllConfig(deps.configPaths), petId())?.conf;
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
   * 点播移动动画：从移动池里随机挑一个。接了 AI 就先看屏幕挑个位置，用同一个动作过去；
   * AI 不可用或看不了时保持原来的随机移动。宿主按名字找到 moves 动作就边播边走，找不到只回 unknown-animation。
   */
  async function playMove(): Promise<void> {
    const actions = moveActions();
    const rng = deps.moveRng ?? Math.random;
    // rng 理论上是 [0,1)；测试注入 1 时也落在最后一项，不越界
    const index = Math.min(actions.length - 1, Math.max(0, Math.floor(rng() * actions.length)));
    const action = actions[index];
    if (await moveWithAi(action.kind, action.name)) return;
    const result = await petRequest('POST', '/anim', { name: action.name });
    if (result.ok !== true) log(`点播「${action.name}」失败：${JSON.stringify(result)}`);
  }

  async function onMenuClick(label: string): Promise<void> {
    const now = Date.now();
    if (label === MENU_LOOK) {
      await lookAtScreen(true);
    } else if (label === MENU_DIARY) {
      await openDiary(now);
    } else if (label === MENU_BOND || label.startsWith(`${MENU_BOND} ·`)) {
      // 小窗要一直开着等主人选，不能 await：等它关掉再回来会把后面的菜单点击都堵住
      void openBond();
    } else if (label === MENU_MOVE) {
      await playMove();
    } else {
      const action =
        cultivationActions().get(label) ??
        brawlLiveActions().get(label) ??
        brawlActions().get(label) ??
        visitActions().get(label) ??
        duelChallengeActions().get(label);
      if (action) await action();
      // 菜单弹出后邻居走了
      else if (label.startsWith(`${MENU_VISIT_GROUP}/去 `)) await say('它好像已经不在附近了～');
      else if (label.startsWith(`${MENU_CULTIVATION_GROUP}/切磋/`)) await say('它好像已经不在附近了～');
    }
    await refreshStatus(now);
    await refreshMenu();
  }

  /** 长轮询菜单点击（插件单次最多挂 10 秒） */
  async function pollMenu(): Promise<void> {
    while (!ctx.state.disposed) {
      try {
        const url = new URL(deps.petBase + '/menu/events');
        url.searchParams.set('owner', MENU_OWNER);
        url.searchParams.set('wait', '10000');
        const result = (await (await fetch(url, { signal: AbortSignal.timeout(15_000) })).json()) as {
          ok?: boolean;
          reason?: string;
          events?: Record<string, string | null>;
        };
        if (result.ok !== true) {
          // 宿主重启过 / 被清掉：重新注册
          if (result.reason === 'unknown-owner') await refreshMenu(true);
          else await delay(5_000);
          continue;
        }
        for (const [label, pet] of Object.entries(result.events ?? {})) {
          // 不等动作做完就接着轮询：动作可能很慢（敲门要等对方主人点头、看屏幕 / 写日记要等模型生成），
          // 等的话这段时间里后面的点击全被堵住，得等它结束才一起处理。各动作有自己的防重入保护
          // （screenBusy、knockingOn、trip……），并发点进来也乱不了；失败在这里兜底记日志，不能有未处理的拒绝
          if (pet !== null)
            void onMenuClick(label).catch((error: unknown) => log(`菜单项「${label}」没处理成：${errorText(error)}`));
        }
      } catch (error) {
        log(`菜单轮询失败：${errorText(error)}`);
        await delay(5_000);
      }
    }
  }
  return { wantedLabels, refreshMenu, pollMenu };
}
