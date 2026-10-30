/**
 * 特效窗口（修炼路线 X7）：一只透明、置顶、不可聚焦、整窗鼠标穿透的大窗，盖住两只宠物，
 * 把「出手」和「命中」之间那段空隙画出来——飞行物从出手方手里的 `hand` 出发，飞到对方身上，
 * 到达那一刻画命中特效（对方的受击 / 泡泡 / 闪避由时间线按同一时刻起播）。渡劫的天雷也在这里画：
 * 乌云在渡劫者头顶淡入，闪电从云底劈到头顶。
 *
 * 坐标全在主进程算好再送进页面（页面只用 `style` 与 `src`，一律 `JSON.stringify` 成字面量）：
 *   - 两只的舞台矩形：自家宠物从 `PetBox` 推（口径同 `guestBounds`：舞台顶 = box.top + bottomPad、
 *     画布高 = 宽 × 9/16）、对手从它窗口的 bounds 推（口径同客人页面：画布宽 = 窗口宽、高 = 宽 × 9/16、
 *     贴窗口底——客人页面的 `#tag` 负 margin 精确抵消了透明边）；
 *   - 起点 = 出手方舞台上的 `hand`（素材统一画成朝左，出手方朝右时 x 按舞台镜像）；
 *   - 终点 = 对方身体中心（站姿包围盒 x 212–426、y 62–332 的中心），`ground` 两头都落在脚底线上；
 *     天雷的终点是头顶、起点在头顶正上方。
 *
 * 页面脚本写成静态字符串（同 `arenaPage`），**不要把模块里的函数 `toString()` 内联进来**
 * （X3 的 `shadowPixels` 坑：模块级常量带不进页面，逐帧 `ReferenceError`）。
 *
 * 窗口没开成（建窗失败、页面没加载好）：`fire` 什么都不做，只在第一次打一行 warn——
 * 时间线、台词、气血条、对方的反应照常走，只是那一下没有飞行物（§2.3 的素材缺失口径）。
 */
import { CANVAS_H, FEET_Y } from '../shared/constants';
import type { FxAssetName, Shot } from './battle-show';
import type { PetBox, Rect } from './visit-windows';

/** 舞台的横向基准：素材与手的位置都在 640×360 的舞台上（高用 `shared/constants` 的 `CANVAS_H`） */
const CANVAS_W = 640;
/** 站姿包围盒（素材里的身体）：x 212–426、y 62–332，它的中心就是飞行物的落点 */
const BODY = { x0: 212, x1: 426, y0: 62, y1: 332 };
/** 天雷劈中的位置：头顶往下一点（舞台坐标 y） */
const HEAD_Y = BODY.y0 + 24;
/** 乌云的中心在舞台顶上方这么多（占舞台高的比例） */
const CLOUD_ABOVE = 0.45;
/** 泡泡护体的半径（舞台坐标：素材里泡泡大约罩住 x 205–435、y 40 往下） */
const BUBBLE_R = 115;
/** 泡泡顶（舞台坐标 y） */
const BUBBLE_TOP = 40;
/** 窗口横向比两只舞台的外沿各多让开这么多（贴图不贴边、`miss` 飞过去也要看得见） */
const SIDE_ROOM = 24;
/**
 * 上方多让出的余量（占舞台高的比例）：`arc` / `slam` 的顶点在两点连线之上约 0.35 / 0.6 × 距离，
 * 天雷的乌云也悬在舞台顶上方（§X7「上方多让出半个舞台高」，多给一点免得贴图被裁）。
 */
const TOP_ROOM = 0.75;
/** 轨迹顶点比两点连线高出多少（占两点距离的比例）：抛物线、高抛砸落、贴地的小土坡 */
const LIFT: Partial<Record<Shot['track'], number>> = { arc: 0.35, slam: 0.6, ground: 0.06 };
/** 命中特效一放一收的时长（§X7：约 350ms） */
const HIT_MS = 350;
/** 闪电从出现到命中的时长（同 battle-show.ts 的 BOLT_MS） */
const BOLT_MS = 120;
/**
 * 心魔的配色矩阵（SVG feColorMatrix，sRGB）：和 visit-windows.ts 的 `shadowPixels` 同一套数——
 * 灰度（Rec.601）→ 压暗到 0.45 → 乘偏紫系数 [0.95, 0.8, 1.15]。心魔放出去的飞行物和它的命中特效
 * 用它，手里那只（已经被心魔窗口调暗的）气球交给特效窗口时颜色才接得上（2026-10-26 真机：暗气球一出手变鲜红）。
 */
export const SHADOW_MATRIX: number[] = [0.95, 0.8, 1.15].flatMap((tint) => [
  ...[0.299, 0.587, 0.114].map((weight) => Number((weight * 0.45 * tint).toFixed(5))),
  0,
  0,
]);

/** 一只宠物在屏幕上的画布矩形（舞台）：宽 = 宠物宽、高 = 宽 × 9/16 */
export interface Stage {
  /** 画布左上角（屏幕坐标） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 这一段素材播的时候朝哪边（素材统一画成朝左，`right` = 整段镜像，手的位置也跟着翻） */
  facing: 'left' | 'right';
}

/** 开窗时送进页面的贴图清单 */
export interface FxAssets {
  /** `/dsh-pet-7340/pic/fx/` 这样的前缀（页面拼 `<前缀><名>.png`） */
  base: string;
  /** 要预加载的贴图名（飞行物 + 命中特效） */
  names: FxAssetName[];
}

/** 送进页面的一发（窗口内坐标；`pieces` 是这一发里的几个物件，各自错开起飞） */
export interface FxSpec {
  kind: FxAssetName;
  hitFx: FxAssetName;
  track: Shot['track'];
  flightMs: number;
  /** 往右飞：贴图水平镜像（素材统一画成朝左飞） */
  mirror: boolean;
  /** 起点 / 终点（窗口内坐标）；天雷的起点是乌云中心 */
  from: [number, number];
  to: [number, number];
  /** 飞行物贴图的边长（窗口内像素，长边；按目标舞台高算好） */
  size: number;
  /** 命中特效的边长 */
  hitSize: number;
  /** 命中特效画在哪（窗口内坐标）：一般就是终点；贴地的那几招底边贴着脚底线往上冒 */
  hitAt: [number, number];
  /** 自转速度（度 / 秒） */
  spin: number;
  /**
   * 轨迹顶点比两点连线高出的像素（`arc` / `slam` / `ground`；其余 0）。按距离算，再夹到窗口里剩下的上方空间——
   * 宠物贴着屏幕顶时特效窗口被工作区截住，蓝鲸高抛会飞出窗口被切掉（2026-10-26 真机）
   */
  lift: number;
  /** 边飞边放大：起飞时的缩放（到达时是 1）；不放大就是 1 */
  grow: number;
  /** 被闪避：飞过终点再走 40% 的距离淡出，不画命中特效 */
  miss: boolean;
  /** 这一发里的几个物件：起飞延迟（ms）与色相（度） */
  pieces: Array<{ delay: number; hue: number }>;
  /** 天雷：乌云的边长（只有 `bolt` 有） */
  cloud?: number;
  /** 用心魔的配色画（飞行物和命中特效都是）：心魔放出来的那几发 */
  shadow?: boolean;
  /** 带着降龙十八掌的后劲（X16）：命中处多打一发小一号的命中-龙吟 */
  surge?: boolean;
  /** 后劲那一发小龙吟的边长（后劲固定用 `命中-龙吟`，不管这一手本来是什么贴图） */
  surgeSize?: number;
  /** 水母分身（X8）：挨打方原地留一只水母替身（这个边长），飞行物打在它身上、它碎成泡泡 */
  decoy?: number;
  /**
   * 银托盘的回旋（X8，`track = 'boomerang'`）：`flightMs` 时擦过对方正面（第一段），`secondMs` 时绕到背后
   * 再磕一下（第二段，打在 `behind`），`totalMs` 时飞回出手方手里（`from`）。`second` = 第二段的结果
   */
  boomerang?: {
    secondMs: number;
    totalMs: number;
    behind: [number, number];
    second: 'hit' | 'blocked' | 'decoy' | 'miss' | 'none';
  };
  /**
   * 静止贴图（X24）：不飞，就铺在 `from`（= `to`）那里 ms 毫秒，淡入淡出；`shake` 是左右抖动的像素，
   * `spin` 是慢慢转的速度（度 / 秒）。白袍、门、贴在身上的符纹用它
   */
  hold?: { ms: number; shake: number; spin: number; squash: number };
}

/**
 * 贴图大小（长边占**目标舞台高**的比例）、自转速度（度/秒）与边飞边放大的起始缩放。
 * 舞台高里身体约占 3/4，0.12 大约是身体高的六分之一。
 */
const FX_SIZE: Record<FxAssetName, { size: number; spin?: number; grow?: number }> = {
  毽子: { size: 0.16, spin: 300 },
  扑克牌: { size: 0.13, spin: 900 },
  水弹: { size: 0.16 },
  彩球: { size: 0.09, spin: 400 },
  陀螺: { size: 0.14, spin: 1_080 },
  水浪: { size: 0.32 },
  烟花弹: { size: 0.24 },
  // 狮子吼的声波是一圈冲出去的冲击波：在嘴边很小、飞到对方时明显散开变大（约 2.9 倍）
  声波: { size: 0.52, grow: 0.2 },
  蓝鲸: { size: 0.7 },
  灵兽: { size: 0.32 },
  拳风: { size: 0.18, grow: 0.7 },
  拳影: { size: 0.18 },
  手刀: { size: 0.24 },
  闪电: { size: 0.12 },
  乌云: { size: 0.45 },
  '命中-星': { size: 0.36 },
  '命中-水花': { size: 0.42 },
  '命中-烟花': { size: 0.5 },
  '命中-纸牌': { size: 0.42 },
  '命中-羽毛': { size: 0.42 },
  '命中-彩星': { size: 0.4 },
  '命中-旋风': { size: 0.4 },
  '命中-声震': { size: 0.26 },
  '命中-巨浪': { size: 0.65 },
  '命中-泡泡': { size: 0.42 },
  '命中-斩': { size: 0.42 },
  '命中-电光': { size: 0.42 },
  雪球: { size: 0.12, spin: 240 },
  羽毛: { size: 0.13, spin: 420 },
  托盘: { size: 0.22, spin: 1_200 },
  星星糖: { size: 0.1, spin: 600 },
  音符: { size: 0.14 },
  墨汁: { size: 0.17 },
  水母: { size: 0.42 },
  灵光: { size: 0.08 },
  '命中-雪花': { size: 0.44 },
  '命中-墨汁': { size: 0.46 },
  '命中-魂碎': { size: 0.44 },
  // 剑光是细长的一条：长边 0.36 个舞台高，飞起来才看得清是一道光（165ms 就到对面）
  剑光: { size: 0.36 },
  '命中-剑痕': { size: 0.58 },
  // X16 降龙十八掌：金龙比宠物大（长边约 0.9 个舞台高，从掌心冲出来时还小、扑到身上时涨到满），
  // 送友风的清风慢慢飘；命中-龙吟是龙吟的冲击波
  金龙: { size: 0.9, grow: 0.55 },
  清风: { size: 0.5 },
  '命中-龙吟': { size: 0.56 },
  // X21：万我大手印的巨掌罩住对方（X24 从 0.62 放到 0.8，原来像在头边挥手）；古人虚影要看得清是谁
  // （X24 从 0.42 放到 0.62）；逆流护身印的白袍铺在出手方身上，约一身高
  巨掌: { size: 0.8, grow: 0.45 },
  古人虚影: { size: 0.62 },
  逆流袍: { size: 0.72 },
  // X22：鬼手、无头鬼影都比宠物大一点（掐住 / 罩住对方），门立得比人高、符画按巴掌大、血珠按道具大小
  鬼手: { size: 0.4 },
  无头鬼影: { size: 0.52 },
  门: { size: 0.78 },
  符画: { size: 0.5 },
  血珠: { size: 0.12 },
  // X25：鲸息是掌间那颗水球（约身体高的一半），鲸波是横向水浪；
  // 深渊符阵铺在两只脚下、深渊黑雾横着盖过擂台（静止贴图，大小按长边算）
  鲸息: { size: 0.36 },
  鲸波: { size: 0.9 },
  深渊符阵: { size: 1.5 },
  深渊黑雾: { size: 1.5 },
  // 历练（Y2）：一转蛊和对手招式的飞行物
  犬影: { size: 0.28 },
  纸鹤: { size: 0.18 },
  爆蛋: { size: 0.16 },
  金针: { size: 0.1 },
  金色飞刀: { size: 0.22 },
  冰刃: { size: 0.18 },
  碧光: { size: 0.32 },
};

/** 自家宠物的画布矩形（口径同 `guestBounds`：舞台顶 = box.top + bottomPad、画布高 = 宽 × 9/16） */
export function homeStage(box: PetBox, facing: 'left' | 'right'): Stage {
  return {
    x: box.left,
    y: box.top + box.bottomPad,
    width: box.size,
    height: (box.size * 9) / 16,
    facing,
  };
}

/**
 * 对手（心魔窗口 / 客人窗口）的画布矩形（口径同客人页面）：画布宽 = 窗口宽、高 = 宽 × 9/16、贴窗口底。
 * 客人窗口比自家宠物小一号还是等大都在 `bounds` 里，舞台跟着缩，手的位置和落点才不偏。
 */
export function foeStage(bounds: Rect, facing: 'left' | 'right'): Stage {
  const height = (bounds.width * 9) / 16;
  return { x: bounds.x, y: bounds.y + bounds.height - height, width: bounds.width, height, facing };
}

/** 夹一道：装得下就夹进区间，装不下（比工作区还大）就贴着起点（`enableLargerThanScreen` 允许超出去） */
function clamp(value: number, size: number, start: number, extent: number): number {
  if (size >= extent) return start;
  return Math.round(Math.min(Math.max(value, start), start + extent - size));
}

/**
 * 特效窗口的位置（§X7）：两只舞台的并集，上方多让出余量给 `arc` / `slam` / 乌云，左右各多一点，夹进工作区。
 * 只有一边（渡劫没有对手、对手窗口还没开）就按那一只排；谁都不知道在哪时回 null（这一场不放特效）。
 */
export function fxBounds(self: Stage | null, foe: Stage | null, workArea: Rect): Rect | null {
  const stages = [self, foe].filter((stage): stage is Stage => !!stage && stage.width > 0 && stage.height > 0);
  if (stages.length === 0) return null;
  const left = Math.min(...stages.map((stage) => stage.x));
  const right = Math.max(...stages.map((stage) => stage.x + stage.width));
  const top = Math.min(...stages.map((stage) => stage.y));
  const bottom = Math.max(...stages.map((stage) => stage.y + stage.height));
  // 上方余量按高一些的那只的画布高算（够 arc 的顶点，slam 的高抛和乌云也放得下）
  const room = Math.round(Math.max(...stages.map((stage) => stage.height)) * TOP_ROOM);
  const width = Math.round(right - left + 2 * SIDE_ROOM);
  const height = Math.round(bottom - top + room + SIDE_ROOM);
  return {
    x: clamp(left - SIDE_ROOM, width, workArea.x, workArea.width),
    y: clamp(top - room, height, workArea.y, workArea.height),
    width,
    height,
  };
}

/** 舞台坐标（640×360、素材朝左）→ 屏幕坐标：按画布等比缩放，`facing = 'right'` 时 x 按舞台水平镜像 */
function toScreen(stage: Stage, x: number, y: number): [number, number] {
  const sx = stage.facing === 'right' ? CANVAS_W - x : x;
  return [stage.x + (sx * stage.width) / CANVAS_W, stage.y + (y * stage.height) / CANVAS_H];
}

/** 手的位置换算到屏幕坐标（素材整段镜像时手也跟着翻） */
export function handPoint(stage: Stage, hand: [number, number]): [number, number] {
  return toScreen(stage, hand[0], hand[1]);
}

/** 身体中心（站姿包围盒的中心，屏幕坐标） */
export function bodyPoint(stage: Stage): [number, number] {
  return toScreen(stage, (BODY.x0 + BODY.x1) / 2, (BODY.y0 + BODY.y1) / 2);
}

/** 脚底线（屏幕坐标 y）：`ground` 两头都落在这里 */
export function feetPoint(stage: Stage): number {
  return stage.y + (stage.height * FEET_Y) / CANVAS_H;
}

/**
 * 静止贴图（X24）：铺在出手方（白袍）/ 对方（贴住的符纹）/ 两只中间（门），按那一边的身高算大小。
 * 不飞、不画命中特效，到 `ms` 自己淡出。
 */
function holdSpec(
  shot: Shot,
  who: 0 | 1,
  stages: [Stage | null, Stage | null],
  bounds: Rect,
  shadow: boolean,
): FxSpec | null {
  const hold = shot.hold;
  if (!hold) return null;
  const anchor = hold.anchor ?? 'self';
  const self = stages[who];
  const foe = stages[(who ^ 1) as 0 | 1];
  if ((anchor !== 'foe' && !self) || (anchor !== 'self' && !foe)) return null;
  let center: [number, number];
  let basis: number;
  if (anchor === 'mid' && self && foe) {
    const a = bodyPoint(self);
    const b = bodyPoint(foe);
    center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    basis = Math.max(self.height, foe.height);
  } else {
    const stage = (anchor === 'self' ? self : foe) as Stage;
    center = bodyPoint(stage);
    basis = stage.height;
  }
  const size = Math.max(8, Math.round(FX_SIZE[shot.kind].size * basis));
  // `dy` 按舞台高往下挪：白袍铺在身体上而不是连头一起盖住
  const drop = Math.round((hold.dy ?? 0) * basis);
  const at: [number, number] = [Math.round(center[0] - bounds.x), Math.round(center[1] + drop - bounds.y)];
  return {
    kind: shot.kind,
    hitFx: shot.kind,
    track: shot.track,
    flightMs: hold.ms,
    mirror: false,
    from: at,
    to: at,
    size,
    hitSize: 0,
    hitAt: at,
    spin: 0,
    lift: 0,
    grow: 1,
    miss: false,
    pieces: [{ delay: 0, hue: 0 }],
    ...(shadow ? { shadow: true } : {}),
    hold: { ms: hold.ms, shake: Math.round(hold.shake ?? 0), spin: hold.spin ?? 0, squash: hold.squash ?? 1 },
  };
}

/**
 * 一发飞行物的几何（纯函数，可测）：两只的舞台 → 窗口内坐标的 `FxSpec`。
 * @param shot 时间线那一步带的飞行物
 * @param who 出手方（0 = 自家宠物，1 = 对手）；天雷（`sky`）是渡劫者自己
 * @param stages 两只现在的舞台（拿不到出手方或对方时回 null：那一下不放特效）
 * @param bounds 特效窗口的位置（送进页面的是窗口内坐标）
 */
export function fxSpec(
  shot: Shot,
  who: 0 | 1,
  stages: [Stage | null, Stage | null],
  bounds: Rect,
  shadow = false,
): FxSpec | null {
  if (shot.hold) return holdSpec(shot, who, stages, bounds, shadow);
  let start: [number, number];
  let end: [number, number];
  let target: Stage;
  let behind: [number, number] | null = null;
  if (shot.sky) {
    // 天雷：落在渡劫者头顶，乌云悬在正上方
    const self = stages[who];
    if (!self) return null;
    target = self;
    // 被泡泡挡下就劈在泡泡顶上；被躲开就劈在身后的地上
    const head = toScreen(self, (BODY.x0 + BODY.x1) / 2, shot.blocked ? BUBBLE_TOP : HEAD_Y);
    end = shot.miss ? toScreen(self, BODY.x1 + 30, FEET_Y) : head;
    start = [head[0], self.y - self.height * CLOUD_ABOVE];
  } else {
    const from = stages[who];
    const to = stages[(who ^ 1) as 0 | 1];
    if (!from || !to) return null;
    target = to;
    const hand = handPoint(from, shot.hand);
    const body = bodyPoint(to);
    // 贴地的两头都落在脚底线上（陀螺贴地转过去、水浪拍地），抛物线（毽子、三球）从头顶砸下来，
    // 其余从手里飞到对方身上；鲸吞反过来，从对方身上吸出来、飞回出手方嘴边
    const ground = shot.track === 'ground';
    if (shot.reverse) {
      start = body;
      end = hand;
    } else {
      start = ground ? [hand[0], feetPoint(from)] : hand;
      end = ground
        ? [body[0], feetPoint(to)]
        : shot.track === 'arc'
          ? toScreen(to, (BODY.x0 + BODY.x1) / 2, HEAD_Y)
          : body;
    }
    const toward = Math.sign(end[0] - start[0]) || 1;
    if (shot.reverse || shot.decoy) {
      // 鲸吞的终点就是嘴；分身原地挨打（本体侧身躲开），终点就是原来的身体中心
    } else if (shot.blocked) {
      // 打在泡泡朝着来路的那一侧（素材里泡泡也是那一侧被撞凹）
      end = [end[0] - toward * ((BUBBLE_R * to.width) / CANVAS_W), end[1]];
    } else if (shot.wild) {
      // 被墨汁糊了眼打歪：远远地从对方头顶斜上方飞过去
      end = [end[0] + toward * to.width * 0.5, end[1] - to.height * 0.55];
    } else if (shot.miss) {
      // 被躲开：直飞的从头顶上方掠过、抛物线落到身后、贴地的从脚边滚过去（不穿身而过）
      if (shot.track === 'arc') end = [end[0] + toward * to.width * 0.3, end[1]];
      else if (!ground) end = [end[0], end[1] - to.height * 0.32];
    }
    if (shot.track === 'boomerang') {
      // 回旋：绕到对方背后再磕一下的那一点（身体中心往远侧挪三成舞台宽、略高一点）
      behind = [body[0] + toward * to.width * 0.3, body[1] - to.height * 0.06];
    }
  }
  const pieces: Array<{ delay: number; hue: number }> = [];
  for (let i = 0; i < Math.max(1, shot.count); i += 1) {
    pieces.push({ delay: i * Math.max(0, shot.gapMs), hue: shot.hue ?? 0 });
  }
  const art = FX_SIZE[shot.kind];
  // 金龙比宠物大：按两只里大一点的那只算（切磋时客人小一号，不能把龙画得比出手方还小）
  const basis = shot.track === 'surge' ? Math.max(target.height, stages[who]?.height ?? 0) : target.height;
  const px = (ratio: number): number => Math.max(8, Math.round(ratio * basis));
  const size = px(art.size);
  // 分身 / 魂影挨的那一下：水母碎成泡泡、魂影碎成魂屑（不画法宝自己的命中特效）
  const hitFx: FxAssetName = shot.decoy ? '命中-泡泡' : shot.mirror ? '命中-魂碎' : shot.hitFx;
  const hitSize = px(FX_SIZE[hitFx].size);
  const local = (point: [number, number]): [number, number] => [
    Math.round(point[0] - bounds.x),
    Math.round(point[1] - bounds.y),
  ];
  // 贴地的命中特效（巨浪、旋风）底边贴着脚底线往上冒，不埋进地里
  const hitAt: [number, number] = shot.track === 'ground' ? [end[0], end[1] - hitSize * 0.42] : end;
  // 顶点在两点中间：中点（窗口内）往上最多到贴图整个露在窗口里
  const from = local(start);
  const to = local(end);
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const room = Math.max(0, (from[1] + to[1]) / 2 - size * 0.6);
  const lift = Math.round(Math.min((LIFT[shot.track] ?? 0) * dist, room));
  return {
    kind: shot.kind,
    hitFx,
    track: shot.track,
    flightMs: shot.flightMs,
    // 素材统一画成朝左飞：往右飞（目标在自己右边）时页面水平镜像
    mirror: end[0] > start[0],
    from,
    to,
    size,
    hitSize,
    hitAt: local(hitAt),
    spin: art.spin ?? 0,
    lift,
    grow: art.grow ?? 1,
    miss: shot.miss === true || shot.wild === true,
    pieces,
    ...(shot.track === 'bolt' ? { cloud: px(FX_SIZE.乌云.size) } : {}),
    ...(shadow ? { shadow: true } : {}),
    ...(shot.surge ? { surge: true as const, surgeSize: px(FX_SIZE['命中-龙吟'].size * 0.6) } : {}),
    ...(shot.decoy ? { decoy: px(FX_SIZE.水母.size) } : {}),
    ...(behind && shot.boomerang
      ? {
          boomerang: {
            secondMs: shot.boomerang.secondMs,
            totalMs: shot.boomerang.totalMs,
            behind: local(behind),
            second: shot.boomerang.second,
          },
        }
      : {}),
  };
}

/** 用到的 BrowserWindow 成员（只声明用到的：静态 `import 'electron'` 会让 tsc 整仓找不到类型） */
export interface FxWindowLike {
  isDestroyed(): boolean;
  setBounds(rect: Rect): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  setAlwaysOnTop(flag: boolean, level: 'floating' | 'pop-up-menu'): void;
  setVisibleOnAllWorkspaces(visible: boolean, options: { visibleOnFullScreen: boolean }): void;
  loadURL(url: string): Promise<void>;
  showInactive(): void;
  destroy(): void;
  webContents: { executeJavaScript(code: string): Promise<unknown> };
}

export interface FxElectron {
  BrowserWindow: { new (options: Record<string, unknown>): FxWindowLike };
}

export interface FxWindow {
  /** 放一发（时间线到点交给这里）；窗口没开成、拿不到舞台时什么都不做 */
  fire(shot: Shot, who: 0 | 1): void;
  /** 重摆位置（宠物走位了、对手窗口挪了）：正在飞的跟着挪同样的位移，才不会在屏幕上跳一下 */
  place(): void;
  /** 过一会儿关掉（先让最后那一下的命中特效放完） */
  close(afterMs: number): void;
  /** 钉住 / 放开（X16 冲刺）：钉住时窗口不跟着两只的实时位置重摆，飞行物照样按实时舞台算 */
  pin(on: boolean): void;
}

/**
 * 开特效窗口（一场开始时开、演完 / 快进 / dispose / 客人走时关）。
 * @param electron 只用到 BrowserWindow
 * @param pageUrl 本机服务的 `GET /app/fx`
 * @param assets 贴图前缀与清单（页面加载完先预加载）
 * @param stages 取两只现在的舞台（`[自家, 对手]`；没有对手时那一项是 null）
 * @param workArea 取夹进去的工作区（按自家宠物所在的那块屏）
 * @param warn 窗口没开成 / 页面没加载好：只打第一次的一行日志
 * @param options.foeShadow 对手是心魔：它放出来的（`who` = 1）用心魔的配色画
 */
export function openFxWindow(
  electron: FxElectron,
  pageUrl: string,
  assets: FxAssets,
  stages: () => [Stage | null, Stage | null],
  workArea: () => Rect,
  warn: (message: string) => void,
  options: { foeShadow?: boolean } = {},
): FxWindow {
  const first = fxBounds(stages()[0], stages()[1], workArea());
  if (!first) {
    // 连窗口都摆不了（还没收到自家宠物的位置）：这一场没有特效层，其余照常
    warn('特效：还不知道宠物在哪，这一场不放特效');
    return { fire: () => undefined, place: () => undefined, close: () => undefined, pin: () => undefined };
  }
  let bounds = first;
  const win = new electron.BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 飞行物是逐帧画出来的：被宠物窗口挡住时也不能停
      backgroundThrottling: false,
    },
  });
  // 层级要**高于**宠物窗口（helper 与客人窗口都用 `floating`），飞行物才从两只身上飞过去
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 纯显示：整窗鼠标穿透，点它跟点桌面一样（不抢主人干活）
  win.setIgnoreMouseEvents(true);
  let ready = false;
  let warned = false;
  let pinned = false;
  let closing: ReturnType<typeof setTimeout> | null = null;
  const queued: string[] = [];
  const warnOnce = (message: string): void => {
    if (warned) return;
    warned = true;
    warn(message);
  };
  const run = (code: string): void => {
    if (win.isDestroyed()) return;
    if (!ready) {
      queued.push(code);
      return;
    }
    void win.webContents.executeJavaScript(code).catch(() => warnOnce('特效：页面没加载好，这一场不放特效'));
  };
  /** 挪窗口：位置变了才挪，并告诉页面「正在飞的跟着挪同样的位移」 */
  const move = (next: Rect): void => {
    if (next.x === bounds.x && next.y === bounds.y && next.width === bounds.width && next.height === bounds.height)
      return;
    const dx = bounds.x - next.x;
    const dy = bounds.y - next.y;
    bounds = next;
    if (win.isDestroyed()) return;
    win.setBounds(bounds);
    if (dx !== 0 || dy !== 0) run(`fx.shift(${dx}, ${dy})`);
  };
  void win
    .loadURL(pageUrl)
    .then(() => {
      if (win.isDestroyed()) return;
      win.showInactive();
      ready = true;
      // 预加载贴图（缺了的那张画不出来，其余照常：§2.3 的素材缺失口径）
      run(`fx.init(${JSON.stringify(assets)})`);
      for (const code of queued.splice(0)) run(code);
    })
    .catch(() => {
      warnOnce('特效：窗口没开成，这一场不放特效');
      if (!win.isDestroyed()) win.destroy();
    });
  return {
    fire(shot, who) {
      if (!pinned) {
        const next = fxBounds(stages()[0], stages()[1], workArea());
        if (next) move(next);
      }
      const spec = fxSpec(shot, who, stages(), bounds, options.foeShadow === true && who === 1);
      if (!spec) return;
      run(`fx.fire(${JSON.stringify(spec)})`);
    },
    place() {
      if (pinned) return;
      const next = fxBounds(stages()[0], stages()[1], workArea());
      if (next) move(next);
    },
    pin(on) {
      pinned = on;
    },
    close(afterMs) {
      if (closing) clearTimeout(closing);
      closing = setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, afterMs);
    },
  };
}

/**
 * 特效窗口的页面（静态字符串；贴图清单与每一发的几何由主进程经 `executeJavaScript` 送进来，
 * 页面只用 `style` 与 `src`，没有别的通道）。轨迹、自转、多发错开、色相、朝右镜像、命中特效、
 * `miss` 掠过、天雷都在这里。
 *
 * 朝向：贴图画成朝左飞（前进方向是 −x）。要让它对准切线 (dx, dy)，先在贴图自己的坐标里转 θ、再镜像：
 * 不镜像时 θ = atan2(−dy, −dx)（往正左飞 θ = 0）；镜像（往右飞）时 θ = atan2(−dy, dx)。
 */
export const fxPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>特效</title>
<style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;pointer-events:none}
/* 一个物件一张图：方框 + object-fit 保住长宽比（长边 = 边长）；位置靠 transform 逐帧写（窗口内坐标） */
.sp{position:absolute;left:0;top:0;object-fit:contain;transform-origin:50% 50%;will-change:transform,opacity}
/* 闪电：从云底拉伸到头顶，拉伸方向是竖的 */
.bolt{position:absolute;left:0;top:0;object-fit:fill;transform-origin:50% 0;will-change:transform,opacity}
</style></head>
<body>
<svg width="0" height="0" style="position:absolute"><filter id="shadow" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${SHADOW_MATRIX.join(' ')} 0 0 0 1 0"/></filter></svg>
<script>
'use strict';
// 页面里只有这些局部量：不依赖任何模块作用域（X3 的 shadowPixels 坑：别把模块里的函数 toString 进来）
var HIT_MS = ${HIT_MS};
var BOLT_MS = ${BOLT_MS};
var FX = { src: {}, items: [], raf: null, last: 0 };

/** 贴图节点：hue 是这一发的色相（三球的三个球），shadow = 用心魔的配色 */
function piece(src, size, hue, shadow) {
  var node = document.createElement('img');
  node.className = 'sp';
  node.src = src;
  node.alt = '';
  node.draggable = false;
  node.style.width = size + 'px';
  node.style.height = size + 'px';
  node.style.opacity = '0';
  var filter = (hue ? 'hue-rotate(' + hue + 'deg) ' : '') + (shadow ? 'url(#shadow)' : '');
  if (filter) node.style.filter = filter;
  document.body.appendChild(node);
  return node;
}

/** 写一帧：平移到中心点、镜像、竖向压扁（俯视贴图铺地用）、转角、缩放（顺序见文件头的朝向说明） */
function place(node, size, mirror, x, y, angle, scale, alpha, squash) {
  var half = size / 2;
  node.style.transform =
    'translate(' + (x - half).toFixed(1) + 'px,' + (y - half).toFixed(1) + 'px)' +
    ' scale(' + (mirror ? -1 : 1) + ',1)' +
    (squash && squash !== 1 ? ' scale(1,' + squash.toFixed(3) + ')' : '') +
    ' rotate(' + angle.toFixed(4) + 'rad)' +
    ' scale(' + scale.toFixed(3) + ')';
  node.style.opacity = alpha.toFixed(3);
}

/** 两点之间的轨迹：t ∈ [0,1]（可以 >1，给 miss 飞过去用）；返回 [x, y, vx, vy]（速度方向给切线） */
function path(s, t) {
  var dx = s.to[0] - s.from[0];
  var dy = s.to[1] - s.from[1];
  var dist = Math.sqrt(dx * dx + dy * dy) || 1;
  var x = s.from[0] + dx * t;
  var y = s.from[1] + dy * t;
  var vy = dy;
  if (s.track === 'arc' || s.track === 'ground') {
    // 抛物线 / 贴地的小土坡：顶点高出两点连线 lift（主进程按距离算好、夹进窗口）
    y -= s.lift * 4 * t * (1 - t);
    vy -= s.lift * 4 * (1 - 2 * t);
  } else if (s.track === 'float') {
    // 慢飘：上下摆动
    y += Math.sin(t * Math.PI * 2.5) * dist * 0.05;
    vy += Math.cos(t * Math.PI * 2.5) * dist * 0.05 * Math.PI * 2.5;
  } else if (s.track === 'slam') {
    // 高抛砸落：先跃起再扎下来，贴图随切线转
    y -= s.lift * Math.sin(t * Math.PI);
    vy -= s.lift * Math.PI * Math.cos(t * Math.PI);
  }
  return [x, y, dx, vy];
}

/** 贴图对准切线的角度（贴图画成朝左飞） */
function tangent(mirror, vx, vy) {
  return mirror ? Math.atan2(-vy, vx) : Math.atan2(-vy, -vx);
}

/** 命中特效在终点一放一收（约 350ms）淡出 */
function burst(name, x, y, size, shadow) {
  var src = FX.src[name];
  if (!src) return;
  var node = piece(src, size, 0, shadow);
  place(node, size, false, x, y, 0, 0.55, 1);
  requestAnimationFrame(function () {
    node.style.transition = 'transform ' + HIT_MS + 'ms ease-out, opacity ' + HIT_MS + 'ms ease-in';
    place(node, size, false, x, y, 0, 1.25, 0);
    setTimeout(function () {
      node.remove();
    }, HIT_MS + 50);
  });
}

/** 天雷的一帧：乌云淡入悬着，最后 BOLT_MS 闪电从云底拉到头顶，到达后闪一下、乌云淡出 */
function sky(item, used) {
  var s = item.spec;
  var strike = s.flightMs - BOLT_MS;
  // 乌云：前 300ms 淡入，命中后 400ms 淡出
  var cloudAlpha = used < 300 ? used / 300 : used < s.flightMs ? 1 : Math.max(0, 1 - (used - s.flightMs) / 400);
  place(item.cloud, s.cloud, false, s.from[0], s.from[1], 0, 1, cloudAlpha);
  var dx = s.to[0] - s.from[0];
  var dy = s.to[1] - (s.from[1] + s.cloud * 0.25);
  var len = Math.sqrt(dx * dx + dy * dy) || 1;
  var width = s.size;
  // 闪电：从出现到命中拉满长度，命中后再亮 160ms（中间暗一下，像闪了两下）
  var shown = used >= strike && used < s.flightMs + 160 && !(used > s.flightMs + 50 && used < s.flightMs + 90);
  var grow = Math.min(1, Math.max(0, (used - strike) / BOLT_MS));
  item.node.style.width = width + 'px';
  item.node.style.height = (len * grow).toFixed(1) + 'px';
  item.node.style.transform =
    'translate(' + (s.from[0] - width / 2).toFixed(1) + 'px,' + (s.from[1] + s.cloud * 0.25).toFixed(1) + 'px)' +
    ' rotate(' + Math.atan2(-dx, dy).toFixed(4) + 'rad)';
  item.node.style.opacity = shown ? '1' : '0';
  if (used >= s.flightMs && !item.hit) {
    item.hit = true;
    burst(s.hitFx, s.hitAt[0], s.hitAt[1], s.hitSize, s.shadow);
  }
  return used < s.flightMs + 400;
}

/** 二次贝塞尔：a → b，控制点 c */
function bez(a, c, b, u) {
  var v = 1 - u;
  return [v * v * a[0] + 2 * v * u * c[0] + u * u * b[0], v * v * a[1] + 2 * v * u * c[1] + u * u * b[1]];
}

/** 银托盘的一帧：擦过正面 → 绕过头顶到背后再磕一下 → 高高地飞回手里；两个命中点各按结果放特效 */
function boomerang(item, used) {
  var s = item.spec;
  var b = s.boomerang;
  var t1 = s.flightMs;
  var pos;
  if (used < t1) {
    pos = [s.from[0] + (s.to[0] - s.from[0]) * (used / t1), s.from[1] + (s.to[1] - s.from[1]) * (used / t1)];
  } else if (used < b.secondMs) {
    var over = [(s.to[0] + b.behind[0]) / 2, Math.min(s.to[1], b.behind[1]) - s.size * 2.2];
    pos = bez(s.to, over, b.behind, (used - t1) / (b.secondMs - t1));
  } else {
    var high = [(b.behind[0] + s.from[0]) / 2, Math.min(b.behind[1], s.from[1]) - s.size * 2.6];
    pos = bez(b.behind, high, s.from, Math.min(1, (used - b.secondMs) / (b.totalMs - b.secondMs)));
  }
  if (used >= t1 && !item.hit) {
    item.hit = true;
    if (!s.miss) burst(s.hitFx, s.hitAt[0], s.hitAt[1], s.hitSize, s.shadow);
  }
  if (used >= b.secondMs && !item.hit2) {
    item.hit2 = true;
    if (b.second === 'hit' || b.second === 'blocked') burst(s.hitFx, b.behind[0], b.behind[1], s.hitSize, s.shadow);
    else if (b.second === 'decoy') burst('命中-泡泡', b.behind[0], b.behind[1], s.hitSize, s.shadow);
  }
  place(item.node, s.size, s.mirror, pos[0], pos[1], (((s.spin * used) / 1000) * Math.PI) / 180, 1, Math.min(1, used / 40));
  return used < b.totalMs;
}

function loop(now) {
  var dt = now - FX.last;
  FX.last = now;
  for (var i = FX.items.length - 1; i >= 0; i--) {
    var item = FX.items[i];
    var s = item.spec;
    item.left += dt;
    var used = item.left - item.delay;
    if (used < 0) continue; // 还没起飞（齐发时逐发错开）
    if (s.hold) {
      // 静止贴图（X24）：原地淡入、抖 / 慢慢转，到点淡出；不飞、不画命中特效
      var fadeIn = Math.min(1, used / 200);
      var fadeOut = s.hold.ms - used < 220 ? Math.max(0, (s.hold.ms - used) / 220) : 1;
      var wobble = s.hold.shake ? Math.sin(used / 45) * s.hold.shake : 0;
      var held = s.hold.spin ? ((s.hold.spin * used) / 1000) * Math.PI / 180 : 0;
      place(item.node, s.size, false, s.from[0] + wobble, s.from[1], held, 1, Math.min(fadeIn, fadeOut), s.hold.squash);
      if (used >= s.hold.ms) {
        item.node.remove();
        FX.items.splice(i, 1);
      }
      continue;
    }
    if (s.boomerang) {
      if (!boomerang(item, used)) {
        item.node.remove();
        FX.items.splice(i, 1);
      }
      continue;
    }
    if (item.jelly) {
      // 分身：飞行物到之前 300ms 水母在原地浮现，挨了这一下碎成泡泡
      var appear = (used - (s.flightMs - 300)) / 150;
      place(item.jelly, s.decoy, false, s.hitAt[0], s.hitAt[1], 0, 1, Math.max(0, Math.min(1, appear)) * 0.85);
    }
    if (s.track === 'bolt') {
      if (!sky(item, used)) {
        item.node.remove();
        item.cloud.remove();
        FX.items.splice(i, 1);
      }
      continue;
    }
    if (used >= s.flightMs) {
      if (s.miss) {
        // 被闪避：飞过终点再走 40% 的距离淡出，不画命中特效
        var over = (used - s.flightMs) / (s.flightMs * 0.4);
        if (over >= 1) {
          item.node.remove();
          FX.items.splice(i, 1);
          continue;
        }
        var p = path(s, 1 + over * 0.4);
        place(item.node, s.size, s.mirror, p[0], p[1], tangent(s.mirror, p[2], p[3]), 1, 1 - over);
        continue;
      }
      item.node.remove();
      if (item.jelly) item.jelly.remove();
      FX.items.splice(i, 1);
      burst(s.hitFx, s.hitAt[0], s.hitAt[1], s.hitSize, s.shadow);
      // 降龙十八掌的后劲（X16）：命中处再打一发小一号的龙吟（固定用龙吟，不跟着这一手的命中贴图）
      if (s.surge) setTimeout(function () { burst('命中-龙吟', s.hitAt[0], s.hitAt[1], s.surgeSize || s.hitSize * 0.6, s.shadow); }, 90);
      continue;
    }
    var t = used / s.flightMs;
    var pt = path(s, t);
    // 自转的贴图（毽子、扑克牌、陀螺……）只转不对切线；其余对准切线飞
    var angle = s.spin ? (((s.spin * used) / 1000) * Math.PI) / 180 : tangent(s.mirror, pt[2], pt[3]);
    var scale = s.grow + (1 - s.grow) * t;
    place(item.node, s.size, s.mirror, pt[0], pt[1], angle, scale, Math.min(1, used / 40));
  }
  FX.raf = FX.items.length > 0 ? requestAnimationFrame(loop) : null;
}

window.fx = {
  /** 贴图清单：base 是 /dsh-pet-7340/pic/fx/ 这样的前缀，names 是这一场用得到的贴图名 */
  init(assets) {
    var base = String(assets.base || '');
    var names = assets.names || [];
    for (var i = 0; i < names.length; i++) {
      var name = String(names[i]);
      var probe = new Image();
      // 取不到（404）也只是这一发画不出来，其余照常；先解码好，第一次飞出来不会半透明地闪一下
      probe.src = base + encodeURIComponent(name) + '.png';
      probe.decode().catch(() => undefined);
      FX.src[name] = probe.src;
    }
  },
  /** 放一发 */
  fire(spec) {
    var src = FX.src[spec.kind];
    if (!src) return;
    var pieces = spec.pieces && spec.pieces.length ? spec.pieces : [{}];
    for (var i = 0; i < pieces.length; i++) {
      // 每个物件一份几何：窗口挪了各自跟着挪，不会重复位移
      var box = {
        kind: spec.kind,
        hitFx: spec.hitFx,
        track: spec.track,
        flightMs: Number(spec.flightMs),
        mirror: !!spec.mirror,
        miss: !!spec.miss,
        size: Number(spec.size),
        hitSize: Number(spec.hitSize),
        spin: Number(spec.spin) || 0,
        lift: Number(spec.lift) || 0,
        grow: Number(spec.grow) || 1,
        cloud: Number(spec.cloud) || 0,
        shadow: !!spec.shadow,
        surge: !!spec.surge,
        surgeSize: Number(spec.surgeSize) || 0,
        decoy: Number(spec.decoy) || 0,
        boomerang: spec.boomerang
          ? {
              secondMs: Number(spec.boomerang.secondMs),
              totalMs: Number(spec.boomerang.totalMs),
              behind: [spec.boomerang.behind[0], spec.boomerang.behind[1]],
              second: String(spec.boomerang.second),
            }
          : null,
        hold: spec.hold
          ? {
              ms: Number(spec.hold.ms) || 0,
              shake: Number(spec.hold.shake) || 0,
              spin: Number(spec.hold.spin) || 0,
              squash: Number(spec.hold.squash) || 1,
            }
          : null,
        from: [spec.from[0], spec.from[1]],
        to: [spec.to[0], spec.to[1]],
        hitAt: [spec.hitAt[0], spec.hitAt[1]],
      };
      var item = { spec: box, delay: Number(pieces[i].delay) || 0, left: 0, hit: false, hit2: false, node: null, cloud: null, jelly: null };
      if (box.track === 'bolt') {
        item.node = piece(src, box.size, 0);
        item.node.className = 'bolt';
        item.cloud = piece(FX.src['乌云'] || src, box.cloud, 0);
      } else {
        item.node = piece(src, box.size, Number(pieces[i].hue) || 0, box.shadow);
      }
      if (box.decoy && i === 0 && FX.src['水母']) item.jelly = piece(FX.src['水母'], box.decoy, 0, box.shadow);
      FX.items.push(item);
    }
    if (FX.raf === null) {
      FX.last = performance.now();
      FX.raf = requestAnimationFrame(loop);
    }
  },
  /** 窗口挪了：正在飞的跟着挪同样的位移（不然会在屏幕上跳一下） */
  shift(dx, dy) {
    for (var i = 0; i < FX.items.length; i++) {
      var s = FX.items[i].spec;
      s.from = [s.from[0] + dx, s.from[1] + dy];
      s.to = [s.to[0] + dx, s.to[1] + dy];
      s.hitAt = [s.hitAt[0] + dx, s.hitAt[1] + dy];
      if (s.boomerang) s.boomerang.behind = [s.boomerang.behind[0] + dx, s.boomerang.behind[1] + dy];
    }
  },
};
</script></body></html>
`;
