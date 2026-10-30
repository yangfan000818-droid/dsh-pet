/**
 * X27 群架的本地窗口编排（B1）：把 N 方内核与时间线接到真实窗口上，不联网、不接菜单。
 *
 * 流程（详见 `docs/x27-brawl-design.md` §4）：
 *   1. 用 `brawlStageLayout` 算 N 个窗口矩形；0 号（本机宠物）尽量留在原地——先算半径，
 *      再把环心放到宠物中心上方 radius，让 0 号的矩形中心落回宠物中心，最后仍夹进工作区；
 *   2. 编号 1..N-1 各开一个 `openFoeWindow`，`pin` 住跟随并按矩形 `moveTo`；0 号走 `host.playExtra`；
 *   3. 环心开一块 `openBrawlArena` 记分板；
 *   4. 开 `openFxWindow`，`stages` 按编号返回 `brawlStageOf` 算出的舞台（0 号用本机宠物的真实舞台）；
 *   5. `brawl()` → `brawlTimeline` → 按 `step.at` 依次 `brawlCues` / `applyBrawlCues`；
 *   6. 最后一步演完关掉对手窗口、记分板与特效层，返回事件；任何异常也先清理再抛出。
 *
 * 这个文件不 import 任何 `features/*`：窗口、宠物动画、台词、日志、定时器都由 `BrawlRunHost` 注入。
 */
import { FX_ASSETS, LINE_MS, animLength } from './battle-show';
import { screenUnion } from './battle-dash';
import { brawl, type BrawlController, type BrawlEvent, type BrawlFighter, type BrawlOptions } from './brawl';
import { openBrawlArena, type BrawlArena, type BrawlArenaRow } from './brawl-arena';
import { applyBrawlCues, brawlCues, brawlTimeline, type BrawlSides, type BrawlStep } from './brawl-show';
import { brawlStageLayout, brawlStageOf, type BrawlWindowSizing } from './brawl-stage';
import { openFoeWindow, type FoeWindow } from './foe-window';
import { homeStage, openFxWindow, type FxWindow, type Stage } from './fx-window';
import type { PetBox, Rect, WindowElectron } from './visit-windows';
import { BUBBLE_ROOM, GUEST_TAG_ROOM } from './visit-windows';

/** 和 `battle-show.ts` 的 `ShowTimers` 同形：测试注入假定时器，不真等几十秒 */
export interface BrawlRunTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 本地群架编排要的全部外部能力（窗口、宠物、台词、日志、时钟） */
export interface BrawlRunHost {
  electron: WindowElectron;
  pages: { foe: string; fx: string; arena: string };
  home: () => PetBox | null;
  workArea: () => Rect;
  playExtra: (anim: string, opts: { facing: 'left' | 'right'; rate: number }) => void;
  say: (line: string, ms: number) => void;
  /**
   * 把本机宠物**中心**挪到归一化坐标（口径同 `POST /position`：全部显示器工作区并集的 0–1）。
   * 宠物贴着屏幕边时整环会被夹进来，环的 6 点钟就不再是宠物原来的位置——这一步把它挪到环上。
   * 实现该用一帧到位（`instant`）：`line` 补间会被开场的动画 / 冻结打断，宠物就挪不过去了。
   */
  moveSelf?: (x: number, y: number) => void;
  log: (msg: string) => void;
  timers?: BrawlRunTimers;
}

export interface BrawlRunOptions {
  /** 引擎种子（联机时由各方 nonce 拼出来）；缺省按人数与名字拼一个可复现的 */
  seed?: string;
  /** 每只的控制器；缺省在 `brawl()` 里用 `autoBrawlController` */
  controllers?: readonly BrawlController[];
  /**
   * 已经定下来的整场事件（联机：各家按网络上的选择重放出来的那一串）。
   * 给了就不在这里跑引擎——联机时引擎已经跑过了，再跑一遍只会另开一份随机数。
   */
  events?: readonly BrawlEvent[];
  /** 传给 `brawl()` 的规则选项（切磋节奏 / 出手上限等） */
  brawl?: BrawlOptions;
  /** 2 人局交给现有 1v1：直接返回空事件，由调用方走 `runSparShow`（本函数不实现 1v1） */
  degenerateTo1v1?: boolean;
  /** 对手立绘地址（按编号取；缺省空串，对手页面退回剪影） */
  portrait?: (fighter: BrawlFighter) => string;
  /** 对手动画前缀（按编号取；缺省空串，素材缺了就退回 CSS 动作） */
  prefix?: (fighter: BrawlFighter) => string;
  /** 对手 CSS 滤镜（按编号取；缺省空串；本地演示用它给影子们换色区分） */
  filter?: (fighter: BrawlFighter) => string;
  /** 对手没在演动作时的待机动画（缺省空串：显示立绘 / 剪影） */
  idle?: string;
  /** 对手窗口宽度相对本机宠物的比例（缺省 1，等大） */
  foeScale?: number;
  /** 特效贴图前缀（如 `/dsh-pet-7340/pic/fx/`）；缺省空串，只影响预加载 */
  fxBase?: string;
  /** 最后一步演完后再等这么久才关窗口（缺省 0，立刻收摊） */
  closeHoldMs?: number;
  /** 拿不到本机宠物位置时的兜底窗口尺寸（缺省 320×180） */
  selfSize?: { width: number; height: number };
  /** 环形摆位的尺寸覆盖（基准宽度 / 最小宽度 / 各人数比例） */
  sizing?: BrawlWindowSizing;
  /**
   * 本机宠物是几号（缺省 0）。本地演示里 0 号就是自己；联机时房主 0、客人 1..N-1，
   * 每家都把自己那只摆到环的 6 点钟，其余按编号顺时针排。
   */
  self?: number;
}

const DEFAULT_SELF_SIZE = { width: 320, height: 180 };
/** 环的 6 点钟离宠物原位不到这么多像素就不挪（本来就在环上） */
const SELF_MOVE_TOLERANCE = 24;

const realTimers: BrawlRunTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 按编号排的全场气血 → 记分板的一行行 */
function scoreboardRows(fighters: readonly BrawlFighter[], hp: readonly number[], activeId: number): BrawlArenaRow[] {
  return fighters.map((fighter, id) => {
    const value = hp[id] ?? 0;
    return {
      label: fighter.name,
      hp: value,
      maxHp: fighter.hp,
      dead: value <= 0,
      active: id === activeId,
    };
  });
}

/** 收场时刻：最后一段动画 / 台词播完（口径同 `BattleShow` 的 `last.at + LINE_MS`） */
function timelineEndMs(steps: readonly BrawlStep[]): number {
  let end = 0;
  for (const step of steps) {
    const length = step.anim ? animLength(step.anim, step.rate ?? 1) : 0;
    end = Math.max(end, step.at + length);
  }
  const last = steps[steps.length - 1];
  if (last) end = Math.max(end, last.at + LINE_MS);
  return end;
}

/**
 * 舞台矩形 → 对手窗口矩形：舞台贴窗底，上面留出气泡与名牌的空间。
 * 不把窗口顶夹进工作区——舞台已经由摆位保证在工作区里，夹窗口顶只会把舞台往下推、压扁整环；
 * 窗口顶超出屏幕时只是气泡被裁（素材允许窗口伸出屏幕，见 `enableLargerThanScreen`）。
 */
function foeWindowRect(stage: Rect): Rect {
  const room = BUBBLE_ROOM + GUEST_TAG_ROOM;
  return { x: stage.x, y: stage.y - room, width: stage.width, height: stage.height + room };
}

/**
 * 本地跑一场群架：开窗、演时间线、收窗，返回引擎事件。
 * 2 人时也走这条多窗口路径；`options.degenerateTo1v1` 为 true 时不开任何窗口、直接返回 `[]`。
 */
export function runBrawl(
  host: BrawlRunHost,
  fighters: readonly BrawlFighter[],
  options: BrawlRunOptions = {},
): Promise<BrawlEvent[]> {
  if (options.degenerateTo1v1 === true && fighters.length === 2) {
    host.log('群架：2 人局沿用现有 1v1 切磋，不进混战路径');
    return Promise.resolve([]);
  }
  const timers = host.timers ?? realTimers;
  const ordered = [...fighters].sort((a, b) => a.id - b.id);
  const count = ordered.length;
  const self = options.self ?? 0;
  /** 编号 → 环上第几格（0 格是 6 点钟，本机宠物在那儿） */
  const slot = (id: number): number => (id - self + count) % count;
  const names = ordered.map((fighter) => fighter.name);
  const foes = new Map<number, FoeWindow>();
  let arena: BrawlArena | null = null;
  let fx: FxWindow | null = null;
  /** 宠物被挪到环上以后，演完挪回原位（没挪过就是 null） */
  let sendSelfHome: (() => void) | null = null;
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    const back = sendSelfHome;
    sendSelfHome = null;
    back?.();
    for (const foe of foes.values()) foe.close(0);
    foes.clear();
    arena?.close();
    arena = null;
    fx?.close(0);
    fx = null;
  };

  try {
    // 1. 环形摆位：先算半径，再把环心抬到宠物中心上方 radius，让 0 号矩形中心落回宠物中心
    const area = host.workArea();
    // 对手窗口顶上要留气泡与名牌：环按「工作区上沿再让出这一块」来摆，最上面那几只的台词才不被裁
    const room = BUBBLE_ROOM + GUEST_TAG_ROOM;
    const ringArea: Rect = {
      x: area.x,
      y: area.y + room,
      width: area.width,
      height: Math.max(1, area.height - room),
    };
    const box = host.home();
    const selfSize = box ? { width: box.size, height: (box.size * 9) / 16 } : (options.selfSize ?? DEFAULT_SELF_SIZE);
    const center = box
      ? {
          x: box.left + box.size / 2,
          y: box.top + box.bottomPad + (box.size * 9) / 32,
        }
      : { x: area.x + area.width / 2, y: area.y + area.height / 2 };
    const probe = brawlStageLayout({
      count,
      workArea: ringArea,
      anchor: center,
      selfSize,
      sizing: options.sizing,
    });
    const layout = brawlStageLayout({
      count,
      workArea: ringArea,
      anchor: { x: center.x, y: center.y - probe.radius },
      selfSize,
      sizing: options.sizing,
    });

    // 环被夹进工作区后，6 点钟不一定还是宠物原来的位置（宠物贴着屏幕边时差得很远）。
    // 用户定的规矩是「放不下先挪宠物」，把本机宠物挪到 0 号位，演完再挪回原位。
    const union = screenUnion(host.electron.screen);
    const home = layout.rects[slot(self)];
    if (box && union && host.moveSelf) {
      const target = { x: home.x + home.width / 2, y: home.y + home.height / 2 };
      if (Math.hypot(target.x - center.x, target.y - center.y) > SELF_MOVE_TOLERANCE) {
        const ratio = (point: { x: number; y: number }): { x: number; y: number } => ({
          x: Math.min(1, Math.max(0, (point.x - union.x) / union.width)),
          y: Math.min(1, Math.max(0, (point.y - union.y) / union.height)),
        });
        const from = ratio(center);
        const to = ratio(target);
        sendSelfHome = () => host.moveSelf?.(from.x, from.y);
        host.log(
          `群架：宠物不在环的 6 点钟（差 ${Math.round(Math.hypot(target.x - center.x, target.y - center.y))}px），` +
            `先挪过去（${to.x.toFixed(3)}, ${to.y.toFixed(3)}）`,
        );
        host.moveSelf(to.x, to.y);
      }
    }

    // 2. 除本机那一号以外：各开一个对手窗口，钉住跟随并挪到环上；本机那号仍由宠物自己演
    for (const fighter of ordered) {
      const id = fighter.id;
      if (id === self) continue;
      const foe = openFoeWindow(
        host.electron,
        host.pages.foe,
        {
          name: fighter.name,
          portrait: options.portrait?.(fighter) ?? '',
          prefix: options.prefix?.(fighter) ?? '',
          filter: options.filter?.(fighter) ?? '',
          ...(options.idle === undefined ? {} : { idle: options.idle }),
          // 淘汰的留在环上：倒地停在倒下那一段、淡到 30%（围成一圈的构图不塌）
          holdDown: true,
          ...(options.foeScale === undefined ? {} : { scale: options.foeScale }),
        },
        host.home,
      );
      foes.set(id, foe);
      foe.pin(true);
      foe.moveTo(foeWindowRect(layout.rects[slot(id)]));
      // 围圈：每一只都朝环心（左半环朝右、右半环朝左）
      foe.face(layout.facing[slot(id)]);
    }

    // 3. 环心记分板
    const ring = layout.center;
    arena = openBrawlArena(host.electron, host.pages.arena, () => ({
      x: ring.x,
      y: ring.y,
      width: 0,
      height: 0,
    }));

    // 4. 特效层：stages 按编号取当前舞台；0 号用本机宠物的真实舞台（它没有被缩放成环上的小窗）
    // 开场先朝第一个对手那一侧，之后每次出手再按实际目标转
    const other = ordered.find((fighter) => fighter.id !== self);
    const firstFoe = other ? layout.rects[slot(other.id)] : null;
    let selfFacing: 'left' | 'right' = firstFoe && firstFoe.x + firstFoe.width / 2 < center.x ? 'left' : 'right';
    const stageOf = (id: number): Stage | null => {
      if (id === self) {
        const now = host.home();
        return now ? homeStage(now, selfFacing) : brawlStageOf(layout.rects[0], layout.facing[0]);
      }
      const foe = foes.get(id);
      return foe ? brawlStageOf(foe.bounds(), layout.facing[slot(id)]) : null;
    };
    const stagesNow = (): (Stage | null)[] => ordered.map((_, id) => stageOf(id));
    fx = openFxWindow(
      host.electron,
      host.pages.fx,
      { base: options.fxBase ?? '', names: FX_ASSETS },
      stagesNow,
      host.workArea,
      host.log,
    );

    // 5. 内核 + 时间线，按 at 依次执行
    const seed = options.seed ?? `${count}:${names.join('|')}`;
    const events = options.events ? [...options.events] : brawl(ordered, seed, options.controllers, options.brawl);
    const steps = brawlTimeline(events, names);

    let activeStep: BrawlStep | null = null;
    let activeId = -1;
    const sides: BrawlSides = {
      side(id) {
        if (id === self) {
          return {
            play: (anim, rate) => host.playExtra(anim, { facing: selfFacing, rate }),
            say: (line, ms) => host.say(line, ms),
          };
        }
        const foe = foes.get(id);
        return foe ? { play: (anim, rate) => foe.play(anim, rate), say: (line, ms) => foe.say(line, ms) } : null;
      },
      arena(hp) {
        arena?.update(scoreboardRows(ordered, hp, activeId));
      },
      shoot(shot) {
        // `BrawlSides.shoot` 给的是屏幕坐标，`FxWindow.fireAt` 要的是编号：
        // 用当前这一步的 who / target 桥接（坐标在同一拍由 brawlCues 现算，两边口径一致）
        if (activeStep?.target === undefined) return;
        fx?.fireAt(shot, activeStep.who, activeStep.target);
      },
    };

    return new Promise<BrawlEvent[]>((resolve, reject) => {
      const handles: unknown[] = [];
      let settled = false;
      const finalize = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        for (const handle of handles) timers.clearTimeout(handle);
        handles.length = 0;
        cleanup();
        if (error === undefined) resolve(events);
        else reject(error);
      };
      const orderedSteps = [...steps].sort((a, b) => a.at - b.at);
      for (const step of orderedSteps) {
        handles.push(
          timers.setTimeout(
            () => {
              if (settled) return;
              try {
                activeStep = step;
                activeId = step.who;
                if (step.who === self && step.target !== undefined && step.target !== self) {
                  const all = stagesNow();
                  const from = all[self];
                  const to = all[step.target] ?? null;
                  if (from && to) {
                    selfFacing = to.x + to.width / 2 < from.x + from.width / 2 ? 'left' : 'right';
                  }
                }
                applyBrawlCues(sides, brawlCues(step, stagesNow()));
              } catch (error) {
                finalize(error);
              }
            },
            Math.max(0, step.at),
          ),
        );
      }
      handles.push(
        timers.setTimeout(() => finalize(), Math.max(0, timelineEndMs(orderedSteps) + (options.closeHoldMs ?? 0))),
      );
    });
  } catch (error) {
    cleanup();
    return Promise.reject(error);
  }
}
