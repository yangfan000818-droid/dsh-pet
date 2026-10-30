/**
 * X27 群架的菜单入口（B1 本地演示）：挑人数、开一场本机宠物对「影子」的混战。
 *
 * 影子用自家宠物的素材（不给立绘 → 页面画剪影，动作全是自家素材），先把围圈摆位、
 * 打到具体编号、环心记分板在 3 / 4 / 5 人下的观感跑通。联机后影子换成各家宠物
 * （客人窗口）是 B4，这里不碰网络。
 */
import { BRAWL_MAX, BRAWL_MIN, type BrawlFighter } from '../brawl';
import { runBrawl } from '../brawl-run';
import { CLOSE_HOLD_MS, MENU_BRAWL_GROUP, lazyFns } from './context';
import type { FeatureContext } from './context';
import { errorText } from './util';

/** 编号 → 影子名（0 号用本机宠物的名字） */
const SHADOW_NAMES = ['', '影子一', '影子二', '影子三', '影子四'];
/** 影子没在演动作时循环播一段待机：没有立绘，不播就只剩一块剪影 */
const SHADOW_IDLE = '待机呼吸休闲';
/** 编号 → 影子的换色滤镜：和自家宠物同一套素材，靠颜色区分「其他人」 */
const SHADOW_FILTERS = [
  '',
  'hue-rotate(200deg) saturate(1.2)',
  'hue-rotate(120deg) saturate(1.2)',
  'hue-rotate(310deg) saturate(1.2)',
  'hue-rotate(45deg) saturate(1.5)',
];
/** 演出锁的时长：群架可能打上几分钟，先按 10 分钟占住，演完立刻放（实际按 TTL 上限兜底） */
const BRAWL_HOLD_MS = 10 * 60_000;
export interface Brawl {
  /** 菜单里的群架项（「群架/3 人」这类带分组的标签）；修炼关着时为空 */
  brawlActions(): Map<string, () => unknown>;
  runBrawlDemo(count?: number): Promise<void>;
}

export function createBrawl(ctx: FeatureContext): Brawl {
  const { cultivationOn, holdPet, petName, petRequest, playExtra, refreshMenu, releasePet, say } = lazyFns(ctx);
  const { deps, electron, homePet, log } = ctx;
  /** 同一时间只开一场：菜单是长轮询触发的，连点两下会开两组窗口 */
  let running = false;

  /** 现在正打着一场（切磋 / 心魔 / 渡劫 / 逐手局）：群架排队等它演完 */
  function arenaBusy(): boolean {
    return ctx.state.battle !== null || ctx.state.liveBattle !== null || ctx.state.actionPanel !== null;
  }

  async function runBrawlDemo(count = 4): Promise<void> {
    if (running || arenaBusy()) {
      void say('现在正打着呢，等这场演完～');
      return;
    }
    const practice = cultivationOn();
    if (!practice) {
      void say('还没开始修炼，先炼起来吧～');
      return;
    }
    running = true;
    let done = false;
    try {
      const self = practice.fighter(petName());
      const total = Math.max(BRAWL_MIN, Math.min(BRAWL_MAX, Math.round(count)));
      const fighters: BrawlFighter[] = Array.from({ length: total }, (_, id) => ({
        ...self,
        id,
        name: id === 0 ? petName() : (SHADOW_NAMES[id] ?? `影子${id}`),
        weapons: [...self.weapons],
        skills: [...self.skills],
      }));
      const origin = new URL(deps.petBase).origin;
      const box = homePet.box();
      const point = box
        ? { x: box.left + box.size / 2, y: box.top + box.size / 2 }
        : electron.screen.getCursorScreenPoint();
      // 占住宠物：这场演完之前不让随机活动 / 待机动画把它顶掉（和 1v1 的演出锁同一套）
      await holdPet([], BRAWL_HOLD_MS);
      const events = await runBrawl(
        {
          electron,
          pages: { foe: `${origin}/app/foe`, fx: `${origin}/app/fx`, arena: `${origin}/app/brawl-arena` },
          home: homePet.box,
          workArea: () => electron.screen.getDisplayNearestPoint(point).workArea,
          playExtra: (anim, opts) => void playExtra(anim, opts),
          // 宠物贴着屏幕边时，把它挪到环的 6 点钟（演完由 brawl-run 挪回）
          // 一帧到位：line 补间会被开场那几拍的 anim / 冻结打断，宠物就永远挪不到环上
          moveSelf: (x, y) => void petRequest('POST', '/position', { x, y, mode: 'instant' }),
          // anim: false：台词只冒泡，不把这一手正在播的动作顶掉（X2 的坑）
          say: (line, ms) => void say(line, { anim: false, durationMs: ms }),
          log,
        },
        fighters,
        {
          fxBase: `${deps.petBase}/pic/fx/`,
          closeHoldMs: 800,
          idle: SHADOW_IDLE,
          filter: (f) => SHADOW_FILTERS[f.id] ?? '',
        },
      );
      log(`群架演示：${total} 人，${events.length} 个事件`);
      done = true;
    } catch (error) {
      log(`群架演示没演成：${errorText(error)}`);
      void say('这场群架没摆开，等下再试～');
    } finally {
      // 演完按 1v1 的口径留一拍再放；没演成的话立刻放
      releasePet(done ? CLOSE_HOLD_MS : 0);
      running = false;
      await refreshMenu();
    }
  }

  function brawlActions(): Map<string, () => unknown> {
    const actions = new Map<string, () => unknown>();
    if (!cultivationOn()) return actions;
    // 放「群架」子菜单：根菜单只占一项，人数进去再选（3 / 4 / 5 各一个按钮，摆出来就定了）
    for (const n of [3, 4, 5]) {
      actions.set(`${MENU_BRAWL_GROUP}/${n} 人`, () => void runBrawlDemo(n));
    }
    return actions;
  }

  return { brawlActions, runBrawlDemo };
}
