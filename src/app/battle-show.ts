/**
 * 对战演出（修炼路线 X3、X7）：把引擎的事件序列排成一条时间线，再按时间线把动画、飞行物、台词、气血条播出去。
 *
 * 分两半：
 *   - `timeline(events, names, rng, skillSets)` 是**纯函数**：只算「什么时候、哪一边、播什么、放什么飞行物、说什么」，
 *     不碰 Electron、不读时钟、不碰坐标（坐标在特效窗口那边按两只的舞台矩形算），可离线单测；
 *   - `BattleShow` 是个小执行器：构造时注入「自家宠物播动画 / 说话」「对手窗口播动画 / 说话」「擂台更新气血」
 *     「特效窗口放一发」这几只手，按时间线跑，支持 `skip()`（快进）和 `dispose()`。`features.ts` 只负责把真实的函数传进来。
 *
 * X7 把「出手」和「命中」分开了（2026-10-26 真机切磋录屏：特效烤在出手方整段素材里，水柱在窗口边上被一刀切断、
 * 鲸尾原地罩在出手方身上、两只中间的空隙从来没有东西飞过；对面按时间表播「受击」看着像自己突然头晕）。三层：
 *   1. **出手方做动作**：`ATTACK_SHOW` 里每招专属的出手素材（手里可以拿着道具，飞出去的那部分不画）；
 *   2. **飞行物单独画**：`Shot`（贴图、轨迹、飞行时间、个数、间隔、命中贴图、miss）由特效窗口画出来——
 *      从出手方手里的 `hand` 出发，飞到对方身上；
 *   3. **命中时刻对方才反应**：命中时刻 `impact = 放出 + 飞行时间` 是程序算出来的（不再估素材里的打击时刻），
 *      对方按这一招的受击方式（`Fly.react`：湿身、炸黑、砸头……）在 `impact − 前摇` 起播，结算台词与掉血都在 `impact`。
 *
 * **衔接**（用户要求「从出招到道具、特效到受击衔接丝滑」）：所有素材都从标准站姿开始、回到标准站姿结束，
 * 所以只要同一只宠物的一段动画**不被下一段从中间切断**，整场就是无缝的。时间线给两只各记一个「忙到几点」：
 *   - 出手类（主攻、无影手的连拳、灵兽、第六感的反劈）都排在自己上一段播完之后；
 *   - 下一格等两只都回到站姿（再喘一口气 `GAP_MS`）才开始；
 *   - 受击必须对准命中，不能往后挪：同一格里第二下命中时同一段受击还在播，就不重新起播（只画命中特效、掉血）。
 *
 * 节奏：出手动作在 `cursor` 起播，按素材时长算 `rate`（倍速）正好占满 `SLOT_MS`（超出 `/anim` 的合法区间就夹住）；
 * 离手时刻 `release = cursor + 原速出手时刻 ÷ 倍速`（见 `RELEASE`）；这一格第 k 段伤害的飞行物在
 * `release + k × BEAT_MS` 放出，一发里第 i 个再晚 `i × 间隔`。
 *
 * 作用在自己身上的那些照旧播原来的整段素材（没有飞行物）：凭空生花（回血）、假死遁、化鸽遁（闪避）、泡泡护体（挡下）。
 * 会心一击照旧不播：它只是 `hit` 结算的字段，没有独立的出手时刻，台词已解说。
 * 渡劫（X7 第二步）：每道雷是一发从天上来的 `sky` 飞行物——乌云淡入、闪电劈到头顶，渡劫者在劈中那一刻播触电。
 *
 * 台词气泡**一律不联动说话动画**（`anim: false` 由调用方保证——X2 真机踩过：带 anim 的气泡会顶掉
 * 正在播的动画），时长给成一步那么长（`LINE_MS`），下一句自然顶替上一句。
 */
import { MOVES, WEAPONS, type Action, type BattleEvent, type MoveId, type SkillId } from './battle';
import { lineOf } from './battle-lines';
import { ANIM_RATE_MAX, ANIM_RATE_MIN } from '../host/anim';

/** 开场（两边起手）一格 */
export const OPEN_MS = 2_400;
/** 出手动作的窗口：4 秒的出手素材按它算倍速（§X3：一个出手事件约 2.4 秒） */
export const SLOT_MS = 2_400;
/** 同一格里多段伤害错开这么久（台词一句顶一句，飞行物一发接一发） */
export const BEAT_MS = 800;
/** 手喂的事件序列里没有出手格子时，受击比结算晚这么久（只有这种兜底情况才用） */
export const REACT_MS = 900;
/**
 * 反应素材的倍速窗口：受击 / 闪避 / 泡泡这些整段素材按它算倍速（4 秒的素材 ≈ 2.2 倍速）。
 * 倍速固定（不随命中时刻变），前摇换算才稳定。
 */
export const REACT_WINDOW_MS = 1_800;
/** 收场（赢的庆祝、输的倒地）一格 */
const CLOSE_MS = 3_000;
/** 两只都回到站姿以后，下一格再等这么久（喘口气，别一段接一段连成一片） */
const GAP_MS = 150;
/** 第六感：反击方挨完那一下、回到站姿后再反劈（至少比命中晚这么久） */
const SIXTH_SENSE_AFTER_MS = 300;
/** 灵兽助阵每场几次（同引擎 battle.ts 的 beastLeft） */
const BEAST_TIMES = 3;
/** 渡劫：乌云淡入多久以后闪电劈下来 */
const CLOUD_MS = 600;
/** 渡劫：闪电从云底劈到头顶的时长（页面里同名常量画闪两下） */
const BOLT_MS = 120;
/**
 * 演出台词的显示时长：和一步的时长相当（X2 的坑：气泡压着后面的动画不好看，
 * 短到一步长就正好被下一句顶替）
 */
export const LINE_MS = SLOT_MS;

/** 弹弓一发打两颗时，第二颗晚这么久飞出 */
const TWIN_GAP_MS = 70;
/** 睡着 / 冻住跳过那一拍再演一遍的素材（和鲸歌、雪球的受击同一段） */
const SLEEP_ANIM = '受击-犯困';
const FREEZE_ANIM = '受击-冻僵';
/** 魂牵梦绕把人牵进梦里：跳过那一拍再演一遍入梦（X9） */
const DREAM_ANIM = '受击-入梦';
/** 被送友风吹得飘起来（X16）：`skip.cause = 'float'` 那一拍重播这一段；串门里送走也用它 */
const FLOAT_ANIM = '受击-飘起';
/**
 * 魂牵梦绕的四句咒（原著里配着「幽魂魔尊」那一段的原文）：
 * 「魂牵梦绕风云荡，星圆土方三界坛。生死轮回一门开，再启杀劫洗铅华。」
 */
const DREAM_CHANT = '魂牵梦绕风云荡，星圆土方三界坛。生死轮回一门开，再启杀劫洗铅华。';
/** 挨打（正面挨一下：拳、牌、拳影、掌劈、灵兽一撞）与挡下的反应素材 */
const HIT_ANIM = '受击-正面';
const BUBBLE_ANIM = '招式-泡泡护体';
/** 闪避（没有化鸽遁时） */
const DODGE_ANIM = '战斗-闪避';
/** 化鸽遁（素材名照 §2.3：招式-<名>） */
const DOVE_ANIM = '招式-化鸽遁';
/** 假死遁 */
const PLAY_DEAD_ANIM = '招式-假死遁';

/**
 * 素材时长（算 `rate` 与「忙到几点」用）：战斗-受击 / 倒地、修炼-突破、招式-假死遁是 5 秒，修炼-打坐 6 秒；
 * 没列的（X7 的出手 / 受击素材、其余整段素材）都是 4 秒。素材重做后改这里就行。
 */
const ANIM_MS: Record<string, number> = {
  '战斗-倒地': 5_000,
  '修炼-打坐': 6_000,
  '修炼-突破': 5_000,
  // 渡劫失败那一下（X4）：动画池里的现有素材，4.9 秒（名字形态播，见 TRIBULATION_LOSS_ANIM）
  '工作状态-垂头叹气冒汗': 5_000,
  '招式-假死遁': 5_000,
  // 送友风把人吹得飘起来的那一段是 5 秒
  '受击-飘起': 5_000,
  // 白凝冰的绝招是 5 秒（YA 素材清单里唯一一段 5 秒的对手动作）
  '对手-白凝冰-绝招': 5_000,
};
/** 表里没列的都是 4 秒 */
const DEFAULT_ANIM_MS = 4_000;

/**
 * 反应素材的前摇（**原速**毫秒）：起播后多久，观众才看得出「挨了 / 躲了」。起播时刻 = 命中时刻 − 前摇 ÷ 反应倍速。
 * 挨打类取实测的起动时刻（逐帧和第 0 帧比轮廓，变化超过身体面积 4% 的第一帧），让动作**从命中那一刻**开始——
 * 早了像未卜先知（2026-10-25 用户反馈「攻击刚出来就挨了」）。闪避类要在飞行物到之前已经躲开一半，
 * 泡泡要先吹好再被撞凹，所以取素材里「躲开 / 隐身 / 被撞凹」那一刻。素材重做后按同法重量。
 */
const REACTION_WINDUP_MS: Record<string, number> = {
  '受击-正面': 250,
  '受击-湿身': 83,
  '受击-炸黑': 83,
  '受击-冻僵': 83,
  '受击-挠痒': 167,
  '受击-犯困': 125,
  '受击-墨汁': 125,
  // 入梦：低下头、眨眼的那一刻（实测 292ms）
  '受击-入梦': 292,
  // 飘起：第 1 帧就开始飘（实测 42ms）
  '受击-飘起': 42,
  '受击-震耳': 250,
  '受击-绊脚': 292,
  '受击-砸头': 292,
  '修炼-触电': 83,
  '招式-假死遁': 167,
  '战斗-闪避': 500,
  '招式-化鸽遁': 700,
  '招式-泡泡护体': 1_400,
  // 对手动作（Y2）：受击前摇按 YA 素材「量出来的时刻」；熔岩鳄、他派蛊师复用狮獒 / 韩不留
  '对手-野狗-受击': 125,
  '对手-红蛋人-受击': 125,
  '对手-狮獒-受击': 292,
  '对手-韩不留-受击': 83,
  '对手-铁若男-受击': 208,
  '对手-白凝冰-受击': 208,
};

/** 没量过的对手动作的兜底前摇（新对手先用它；CSS 兜底的那一下也用同一个口径） */
const FOE_WINDUP_MS = 150;

/** 飞行轨迹（§X7）：直飞 / 抛物线 / 贴地 / 慢飘 / 高抛砸落 / 天雷（乌云 + 闪电，渡劫用）/ 回旋（银托盘，X8） */
export type FxTrack = 'line' | 'thrust' | 'arc' | 'ground' | 'float' | 'slam' | 'bolt' | 'boomerang' | 'surge';

/**
 * 特效贴图名（`assets/pic/fx/<名>.png`）：§X7 的素材清单。
 * 素材由主会话生成，代码里只按名字引用；缺了的那一张只是画不出来（§2.3 的素材缺失口径）。
 */
export type FxAssetName =
  // 飞行物
  | '毽子'
  | '扑克牌'
  | '水弹'
  | '彩球'
  | '陀螺'
  | '水浪'
  | '烟花弹'
  | '声波'
  | '蓝鲸'
  | '灵兽'
  | '拳风'
  | '拳影'
  | '手刀'
  | '闪电'
  | '乌云'
  // X16：降龙十八掌的金龙、送友风的清风
  | '金龙'
  | '清风'
  // X21：万我大手印的巨掌、前有古人的古人虚影（逆流护身印的袍子直接画在动作素材里）
  | '巨掌'
  | '古人虚影'
  // X22：鬼手、无头鬼影、鬼敲门的门、鬼画的符、鬼血的血珠
  | '鬼手'
  | '无头鬼影'
  | '门'
  | '符画'
  | '血珠'
  // X8
  | '雪球'
  | '羽毛'
  | '托盘'
  | '星星糖'
  | '音符'
  | '墨汁'
  | '水母'
  | '灵光'
  // 历练（Y2）：一转蛊和对手招式的飞行物
  | '犬影'
  | '纸鹤'
  | '爆蛋'
  | '金针'
  | '金色飞刀'
  | '冰刃'
  | '碧光'
  // 命中
  | '命中-星'
  | '命中-水花'
  | '命中-烟花'
  | '命中-纸牌'
  | '命中-羽毛'
  | '命中-彩星'
  | '命中-旋风'
  | '命中-声震'
  | '命中-巨浪'
  | '命中-泡泡'
  | '命中-斩'
  | '命中-电光'
  | '命中-雪花'
  | '命中-墨汁'
  | '命中-魂碎'
  | '剑光'
  | '命中-剑痕'
  // X16：降龙十八掌的命中（龙吟）
  | '命中-龙吟';

/** 各轨迹的飞行时间（`bolt` = 乌云淡入 + 闪电劈下） */
const FLIGHT_MS: Record<FxTrack, number> = {
  line: 380,
  // 剑光：原著「剑光之快，匪夷所思」，几乎是一闪就到（X9 的五指拳心剑）
  thrust: 160,
  arc: 620,
  ground: 520,
  float: 900,
  slam: 700,
  bolt: CLOUD_MS + BOLT_MS,
  // 回旋：擦过正面的那一刻；绕到背后再磕一下、飞回手里见 BOOMERANG_*_MS
  boomerang: 340,
  // 降龙十八掌的金龙从掌心冲出去到扑在对方身上，约 200ms（X16）
  surge: 200,
};

/** 银托盘：放出后多久绕到背后磕第二下（第二段的命中时刻） */
const BOOMERANG_SECOND_MS = 720;
/** 银托盘：放出后多久飞回手里——兜底值，素材量过接住时刻（RELEASE 的 catchMs）就按它算 */
const BOOMERANG_TOTAL_MS = 1_150;

/** 一发飞行物与它打中以后的样子（§X7 第三步那张表里「飞行物 / 轨迹 / 命中 / 受击」那几列） */
export interface Fly {
  /** 飞行物贴图名（`assets/pic/fx/<名>.png`） */
  kind: FxAssetName;
  track: FxTrack;
  /** 命中那一下的贴图 */
  hitFx: FxAssetName;
  /** 挨打方的反应素材：不给 = `战斗-受击`（被挡下照旧换泡泡、被闪避照旧闪避） */
  react?: string;
  /** 一发里齐发几个（默认 1）；多段法宝（扑克牌两张、三球三个）的「个数」由引擎的段数承担，不在这里 */
  count?: number;
  /**
   * 齐发时逐发的间隔（真实毫秒：水枪对准出手素材里三下扳机的间隔）；多段法宝是**逐段**的间隔——
   * 扑克牌、三球是一把撒出去的，几段紧挨着飞（不再隔一个 `BEAT_MS`），对方只演一次反应
   */
  gapMs?: number;
  /** 多段法宝逐段的色相步进（三球的三个球 0 / 120 / 240） */
  hueStep?: number;
  /** 反向（鲸吞，X8）：从对方身上吸出来、飞回出手方嘴边；对方在被吸的那一刻（放出时）就起反应 */
  reverse?: boolean;
}

/** 出手 → 动作 + 飞行物（§X7 第三步那张表；演出口径归演出，图鉴里不再存素材名） */
export interface AttackShow {
  /** 出手方播的出手素材（每招专属：手里可以有道具，飞出去的那部分不画） */
  action: string;
  /** 飞行物：不给 = 作用在自己身上的整段素材（回血那类），没有飞行物 */
  fly?: Fly;
  /**
   * 冲刺（X16）：出手方在 `outMs` 里冲到对手身前（停在离对方约半个身位处），
   * 出完招再在 `backMs` 里退回开场的位置。位移靠挪窗口，不画在素材里。
   * 这一批只给降龙十八掌用；鲸尾、直拳这些照旧原地出招。
   */
  dash?: { outMs: number; backMs: number };
}

/**
 * 出手 → 动作 + 飞行物（§X7 第三步）。键是 `Action` 的编号（空手 = unarmed），外加三种不是 `decide` 的追加出手：
 * `spirit-beast`（beast）、`sixth-sense`（counter）、`shadow-fists`（combo 且出手方有无影手）。
 */
export const ATTACK_SHOW: Record<string, AttackShow> = {
  unarmed: { action: '战斗-直拳', fly: { kind: '拳风', track: 'line', hitFx: '命中-星' } },
  'water-gun': {
    action: '出手-水枪',
    fly: { kind: '水弹', track: 'line', hitFx: '命中-水花', react: '受击-湿身', count: 3, gapMs: 225 },
  },
  poker: { action: '出手-扑克牌', fly: { kind: '扑克牌', track: 'line', hitFx: '命中-纸牌', gapMs: 150 } },
  shuttlecock: { action: '战斗-踢', fly: { kind: '毽子', track: 'arc', hitFx: '命中-羽毛', react: '受击-砸头' } },
  snowball: { action: '出手-雪球', fly: { kind: '雪球', track: 'arc', hitFx: '命中-雪花', react: '受击-冻僵' } },
  duster: {
    action: '出手-鸡毛掸子',
    fly: { kind: '羽毛', track: 'line', hitFx: '命中-羽毛', react: '受击-挠痒', count: 4, gapMs: 70 },
  },
  tray: { action: '出手-托盘', fly: { kind: '托盘', track: 'boomerang', hitFx: '命中-星' } },
  slingshot: { action: '出手-弹弓', fly: { kind: '星星糖', track: 'line', hitFx: '命中-星' } },
  juggle: {
    action: '出手-三球',
    fly: { kind: '彩球', track: 'arc', hitFx: '命中-彩星', react: '受击-砸头', hueStep: 120, gapMs: 160 },
  },
  top: { action: '出手-陀螺', fly: { kind: '陀螺', track: 'ground', hitFx: '命中-旋风', react: '受击-绊脚' } },
  'whale-tail': { action: '出手-鲸尾', fly: { kind: '水浪', track: 'ground', hitFx: '命中-巨浪', react: '受击-湿身' } },
  // 烟花筒是朝上放的：先往上冲一段、划个弧再落到对面头顶（`line` 会显得一出手就往下打）
  firework: { action: '出手-烟花', fly: { kind: '烟花弹', track: 'arc', hitFx: '命中-烟花', react: '受击-炸黑' } },
  'lion-roar': {
    action: '战斗-吼',
    fly: { kind: '声波', track: 'line', hitFx: '命中-声震', react: '受击-震耳', count: 3, gapMs: 180 },
  },
  'blue-whale': {
    action: '出手-召唤蓝鲸',
    fly: { kind: '蓝鲸', track: 'slam', hitFx: '命中-巨浪', react: '受击-湿身' },
  },
  'whale-song': {
    action: '出手-鲸歌',
    fly: { kind: '音符', track: 'float', hitFx: '命中-泡泡', react: '受击-犯困', count: 3, gapMs: 260 },
  },
  ink: { action: '出手-墨汁', fly: { kind: '墨汁', track: 'line', hitFx: '命中-墨汁', react: '受击-墨汁' } },
  'whale-gulp': {
    action: '出手-鲸吞',
    fly: { kind: '灵光', track: 'line', hitFx: '灵光', count: 6, gapMs: 110, reverse: true },
  },
  // 万我（X9）：没有飞行物，只演结印；魂影和魂碎在 `mirror` 事件时由特效窗口画
  'myriad-self': { action: '出手-万我' },
  // 魂牵梦绕（X9）：魂丝化成灵光一串飘过去，命中那一刻对方被牵进梦里
  'dream-chant': {
    action: '出手-魂牵梦绕',
    fly: { kind: '灵光', track: 'float', hitFx: '命中-魂碎', react: '受击-入梦', count: 8, gapMs: 90 },
  },
  // 五指拳心剑（X9）：右拳举过头顶，拳心射出一道剑光——原著「剑光之快，匪夷所思」，几乎是闪就到
  'finger-sword': { action: '出手-拳心剑', fly: { kind: '剑光', track: 'thrust', hitFx: '命中-剑痕' } },
  // 降龙十八掌（X16）：冲过去推掌，金龙从掌心扑到对方身上（画在特效层，比宠物大）；不出飞行物道具
  'dragon-palm': {
    action: '出手-降龙',
    dash: { outMs: 260, backMs: 320 },
    fly: { kind: '金龙', track: 'surge', hitFx: '命中-龙吟' },
  },
  // 送友风（X16）：挥手道别，清风慢慢飘过去；被打中的人飘起来（skip.cause = 'float'）
  'farewell-wind': {
    action: '出手-送友风',
    fly: { kind: '清风', track: 'float', hitFx: '命中-旋风', react: FLOAT_ANIM },
  },
  // 万我大手印（X21）：双掌前推，巨掌从天上压下来，对方被压得蹲身
  'myriad-palm': {
    action: '出手-大手印',
    fly: { kind: '巨掌', track: 'slam', hitFx: '命中-巨浪', react: '受击-碾压' },
  },
  // 逆流护身印（X21）：双掌对空虚抓，白袍披身；没有飞行物，反弹由 `reverse` 事件演
  'reverse-seal': { action: '出手-护身印' },
  // 前有古人（X21）：合掌，背后光阴长河；古人虚影在 `ancient` 事件时自己冲出去
  ancients: { action: '出手-古人' },
  // 吃苦吃亏（X21）：张口一吸；咬一口时对方播 `受击-被吃`
  'eat-hardship': { action: '出手-吃苦' },
  // 鬼手（X22）：一条手臂向左伸出、五指张开抓过去，掐住对方
  'ghost-hand': {
    action: '出手-鬼手',
    fly: { kind: '鬼手', track: 'thrust', hitFx: '命中-斩', react: '受击-掐住' },
  },
  // 无头鬼影（X22）：背后浮起没有头的黑影，冲过去取首级；这一下打死的不画假死
  'headless-shadow': {
    action: '出手-鬼影',
    fly: { kind: '无头鬼影', track: 'line', hitFx: '命中-魂碎', react: '受击-断头' },
  },
  // 鬼敲门（X22）：抬手在看不见的门上敲两下；伤害在对方下一次出手时由 `knock` 事件结算
  'ghost-knock': { action: '出手-敲门' },
  // 鬼画（X22）：指尖在胸前画符；符纹在 `paint` 事件时飞过去贴在对方身上
  'ghost-painting': { action: '出手-鬼画' },
  // 鬼血（X22）：指尖一抹，几颗血珠浮起打向对方
  'ghost-blood': {
    action: '出手-鬼血',
    fly: { kind: '血珠', track: 'line', hitFx: '命中-墨汁', count: 3, gapMs: 90 },
  },
  // 回血：作用在自己身上，照旧播整段素材，没有飞行物
  bloom: { action: '招式-凭空生花' },
  // 三种追加出手
  'spirit-beast': { action: '出手-召唤灵兽', fly: { kind: '灵兽', track: 'float', hitFx: '命中-泡泡' } },
  'sixth-sense': { action: '出手-第六感', fly: { kind: '手刀', track: 'line', hitFx: '命中-斩' } },
  'shadow-fists': { action: '战斗-连拳', fly: { kind: '拳影', track: 'line', hitFx: '命中-星', count: 5, gapMs: 100 } },
};

/**
 * 凭空生花：素材里花在手心绽开那一刻（**原速**毫秒，逐帧看的 0.5 秒还没花、1.0 秒已经开满）。
 * 气血条和「气血 +N」等到这一刻再刷——一出招就回满会像血条抢在动画前面。
 */
const BLOOM_HEAL_MS = 1_000;

/** 回血那一步在动作起播后多久（按动画倍速压缩） */
function healOffset(): number {
  return Math.round(BLOOM_HEAL_MS / actionRate(ATTACK_SHOW.bloom.action));
}

/**
 * 招式表（Y0 的 `MOVES`）的演出：宠物用的一转蛊复用现有出手素材；对手招式换成它自己的皮
 * （`foe` 决定播「出手」还是「绝招」，一场一次的那招是绝招），飞行物优先用 YA 的新贴图。
 */
export interface MoveShow {
  /** 宠物自己用这招时播的出手素材（一转蛊） */
  action?: string;
  /** 对手用这招时播它自己的哪个动作；不给 = 出手 */
  foe?: '出手' | '绝招';
  /** 飞行物：不给 = 没有（作用在自己身上的招） */
  fly?: Fly;
}

export const MOVE_SHOW: Record<MoveId, MoveShow> = {
  // 一转蛊（宠物用；同一段出手素材也用在对手的皮上）
  'gu-dogs': {
    action: '出手-召唤灵兽',
    // 按狗数齐发：每段一只，同一时刻放出（gapMs = 0），不是一串连发
    fly: { kind: '犬影', track: 'line', hitFx: '命中-斩', gapMs: 0 },
  },
  'gu-crane': { action: '出手-扑克牌', fly: { kind: '纸鹤', track: 'line', hitFx: '命中-羽毛' } },
  'gu-egg': { action: '出手-雪球', fly: { kind: '爆蛋', track: 'arc', hitFx: '命中-烟花', react: '受击-炸黑' } },
  // 对手招式
  'dog-bite': { foe: '出手', fly: { kind: '犬影', track: 'line', hitFx: '命中-斩', gapMs: 120 } },
  'egg-burst': { foe: '出手', fly: { kind: '爆蛋', track: 'arc', hitFx: '命中-烟花', react: '受击-炸黑' } },
  'mastiff-maul': { foe: '出手', fly: { kind: '拳风', track: 'line', hitFx: '命中-星' } },
  'han-dogs': { foe: '出手', fly: { kind: '犬影', track: 'line', hitFx: '命中-斩', gapMs: 90 } },
  'moon-blade': { foe: '出手', fly: { kind: '剑光', track: 'line', hitFx: '命中-剑痕' } },
  'gold-needle': { foe: '出手', fly: { kind: '金针', track: 'line', hitFx: '命中-斩', gapMs: 120 } },
  // 一场一次：金色飞刀、北冥冰魄爆发都按「绝招」播（对手素材清单里只有白凝冰有绝招，其余退回 CSS 动作）
  'gold-blade': { foe: '绝招', fly: { kind: '金色飞刀', track: 'thrust', hitFx: '命中-斩' } },
  'ice-blade': { foe: '出手', fly: { kind: '冰刃', track: 'line', hitFx: '命中-雪花', gapMs: 100 } },
  frost: { foe: '出手', fly: { kind: '雪球', track: 'line', hitFx: '命中-雪花' } },
  bingpo: { foe: '绝招', fly: { kind: '冰刃', track: 'slam', hitFx: '命中-雪花' } },
};

/** 渡劫的一道雷（X7 第二步）：乌云 + 闪电从渡劫者头顶劈下，劈中播触电 */
export const TRIBULATION_FLY: Fly = { kind: '闪电', track: 'bolt', hitFx: '命中-电光', react: '修炼-触电' };

/** 这套表要用到的全部贴图（特效窗口开窗时预加载）：从表里取，不另抄一份清单；乌云是天雷那一发顺带画的 */
export const FX_ASSETS: FxAssetName[] = Array.from(
  new Set<FxAssetName>([
    ...[
      ...Object.values(ATTACK_SHOW).map((show) => show.fly),
      ...Object.values(MOVE_SHOW).map((show) => show.fly),
      TRIBULATION_FLY,
    ].flatMap((fly) => (fly ? [fly.kind, fly.hitFx] : [])),
    // 魂屑（X9）：万我的 `mirror` 事件和魂牵梦绕的命中都用它，不在出手表的飞行物里
    '命中-魂碎',
    '乌云',
    // 定仙游的碧芒（Y2 素材清单）：不在出手表里，开窗时一并预取
    '碧光',
  ]),
);

/**
 * 对战（心魔 / 切磋）里对手窗口可能播到的全部动画：开演前让客人窗口先取到页面里（`GuestWindow.preload`），
 * 换源时不用等网络——不然出手动作比特效窗口里的飞行物晚上屏。从表里取，不另抄一份清单。
 */
export const SHOW_ANIMS: string[] = Array.from(
  new Set([
    '战斗-起手',
    '战斗-胜利',
    '战斗-倒地',
    HIT_ANIM,
    BUBBLE_ANIM,
    DODGE_ANIM,
    DOVE_ANIM,
    PLAY_DEAD_ANIM,
    ...Object.values(ATTACK_SHOW).flatMap((show) => [show.action, ...(show.fly?.react ? [show.fly.react] : [])]),
    // 一转蛊复用现有出手素材（Y2）：预取清单也要带上
    ...Object.values(MOVE_SHOW).flatMap((show) => (show.action ? [show.action] : [])),
  ]),
);

/**
 * 出手素材的出手时刻（**原速**毫秒）与出手那一刻手（道具口）的位置（640×360 舞台坐标、素材朝左）——主会话逐帧量好的。
 * 量法：逐帧找人物最靠左的不透明点，手臂（脚、尾巴、枪口、筒口）伸到最远、或道具刚离手的那一帧算出手。
 * 素材重做后按同法重量，改这张表即可。
 */
export const RELEASE: Record<string, { ms: number; hand: [number, number]; catchMs?: number }> = {
  '战斗-直拳': { ms: 1_660, hand: [180, 222] },
  '出手-水枪': { ms: 1_450, hand: [184, 212] },
  '出手-扑克牌': { ms: 1_500, hand: [196, 170] },
  '战斗-踢': { ms: 1_460, hand: [232, 284] },
  // 雪球在素材里举过头顶才离手：出手点就是它离手那一帧的位置（之后的雪球从素材里擦掉了）
  '出手-雪球': { ms: 1_970, hand: [105, 95] },
  // 掸子挥到最远那一刻，羽毛从掸子头飞出去
  '出手-鸡毛掸子': { ms: 1_830, hand: [60, 220] },
  // catchMs：素材里伸手接住飞回来的托盘那一刻（回旋飞回手里对准它，见 boomerangTotalMs）
  '出手-托盘': { ms: 1_400, hand: [180, 210], catchMs: 2_950 },
  '出手-弹弓': { ms: 1_575, hand: [180, 188] },
  // 正面唱歌：音符从嘴边飘出去
  '出手-鲸歌': { ms: 1_200, hand: [300, 205] },
  '出手-墨汁': { ms: 1_750, hand: [222, 160] },
  // 鲸吞：灵光飞回嘴边（这是终点，不是起点）
  '出手-鲸吞': { ms: 1_000, hand: [258, 200] },
  '出手-三球': { ms: 2_050, hand: [202, 184] },
  '出手-陀螺': { ms: 1_250, hand: [185, 280] },
  '出手-鲸尾': { ms: 2_450, hand: [50, 300] },
  '出手-烟花': { ms: 1_750, hand: [152, 112] },
  '战斗-吼': { ms: 1_150, hand: [205, 212] },
  '出手-召唤蓝鲸': { ms: 1_960, hand: [192, 194] },
  '出手-召唤灵兽': { ms: 1_250, hand: [160, 185] },
  '战斗-连拳': { ms: 1_000, hand: [204, 232] },
  '出手-第六感': { ms: 1_850, hand: [206, 216] },
  // 魂牵梦绕：双手捧在胸前念咒，魂丝从两手之间飘出去（X9）
  '出手-魂牵梦绕': { ms: 1_600, hand: [305, 200] },
  // 五指拳心剑：拳头举到头顶上方、停住的那一刻，剑光从拳心射出（实测 2.3 秒起拳心停在 272,92）（X9）
  '出手-拳心剑': { ms: 2_300, hand: [272, 92] },
  // 降龙十八掌：推掌伸到最远那一帧（X16）
  '出手-降龙': { ms: 2_250, hand: [190, 219] },
  // 送友风：挥手后往外一送那一刻，清风从这里飘出去（X16）
  '出手-送友风': { ms: 2_750, hand: [228, 222] },
  // X21：四门的出手时刻与手位（量法同上面：大手印双掌向左侧推到位 / 护身印胸前合掌 / 古人双手伸到最远 / 吃苦张口一吸）
  '出手-大手印': { ms: 1_250, hand: [222, 222] },
  '出手-护身印': { ms: 1_500, hand: [282, 232] },
  '出手-古人': { ms: 2_250, hand: [195, 205] },
  '出手-吃苦': { ms: 1_250, hand: [255, 152] },
  // X22：鬼手掐到最远的那一帧 / 鬼影指向定住 / 敲门抬手叩下 / 鬼画指尖在胸前停住 / 鬼血指尖一抹
  '出手-鬼手': { ms: 917, hand: [188, 229] },
  '出手-鬼影': { ms: 2_000, hand: [230, 200] },
  '出手-敲门': { ms: 1_500, hand: [280, 200] },
  '出手-鬼画': { ms: 1_500, hand: [280, 200] },
  '出手-鬼血': { ms: 1_500, hand: [280, 200] },
  // 对手动作（Y2）：离手时刻与手的位置按 YA 素材「量出来的时刻」填；熔岩鳄、他派蛊师复用狮獒 / 韩不留，
  // 调用方把它们的动画前缀传成被复用的那只
  '对手-野狗-出手': { ms: 1_833, hand: [0, 250] },
  '对手-红蛋人-出手': { ms: 1_292, hand: [94, 168] },
  '对手-狮獒-出手': { ms: 2_292, hand: [112, 167] },
  '对手-韩不留-出手': { ms: 1_167, hand: [198, 196] },
  '对手-铁若男-出手': { ms: 1_208, hand: [130, 204] },
  '对手-白凝冰-出手': { ms: 1_417, hand: [200, 140] },
  // 白凝冰的绝招（北冥冰魄爆发）以手的位置为准，冰枪已从素材里擦掉，交给特效层画
  '对手-白凝冰-绝招': { ms: 2_583, hand: [196, 160] },
};

/** 对手动作的兜底出手时刻：新对手还没量过时先用它，量好了再往 RELEASE 里加 */
const FOE_RELEASE: { ms: number; hand: [number, number] } = { ms: 1_500, hand: [180, 200] };

/** 一段出手素材的出手时刻（对手的动作用统一兜底） */
function releaseOf(action: string): { ms: number; hand: [number, number]; catchMs?: number } | undefined {
  return RELEASE[action] ?? (action.startsWith('对手-') ? FOE_RELEASE : undefined);
}

/** 一段素材按这个倍速播完要多久 */
export function animLength(anim: string, rate: number): number {
  return Math.round((ANIM_MS[anim] ?? DEFAULT_ANIM_MS) / rate);
}

/**
 * 个别出手素材不压进 `SLOT_MS`、播得舒展一点：银托盘要等回旋飞一圈回到手里，2.4 秒压得太赶（回程只剩 0.2 秒）
 */
const ACTION_WINDOW_MS: Record<string, number> = { '出手-托盘': 3_000 };

/** 出手素材的倍速（多数压进 `SLOT_MS`，个别见 `ACTION_WINDOW_MS`） */
export function actionRate(action: string): number {
  return rateFor(action, ACTION_WINDOW_MS[action] ?? SLOT_MS);
}

/** 离手比动作起播晚多久：原速的出手时刻 ÷ 倍速（倍速把素材压进格子，离手的真实时刻也跟着压缩） */
export function releaseOffset(action: string): number {
  const entry = releaseOf(action);
  return entry ? Math.round(entry.ms / actionRate(action)) : 0;
}

/** 银托盘放出后多久飞回手里：素材里接住的那一刻 − 离手那一刻（都按倍速换算） */
function boomerangTotalMs(action: string): number {
  const entry = releaseOf(action);
  return entry?.catchMs ? Math.round((entry.catchMs - entry.ms) / actionRate(action)) : BOOMERANG_TOTAL_MS;
}

/**
 * 一段素材要正好占满 `windowMs`，该开几倍速。
 * 夹到 `/anim` 允许的 0.5–3（`ANIM_RATE_MIN` / `ANIM_RATE_MAX`）：越界宿主直接回 bad-request，
 * 那一下就没动画了，所以宁可让那一段短一点、被下一步顶掉。
 */
export function rateFor(anim: string, windowMs: number): number {
  const rate = (ANIM_MS[anim] ?? DEFAULT_ANIM_MS) / windowMs;
  return Math.min(ANIM_RATE_MAX, Math.max(ANIM_RATE_MIN, Number(rate.toFixed(3))));
}

/** 反应素材的倍速（固定按 `REACT_WINDOW_MS` 算） */
function reactRate(anim: string): number {
  return rateFor(anim, REACT_WINDOW_MS);
}

/** 反应起播比命中时刻提前多久（原速前摇 ÷ 倍速） */
export function windupOf(anim: string): number {
  const windup = REACTION_WINDUP_MS[anim] ?? (anim.startsWith('对手-') ? FOE_WINDUP_MS : 0);
  return Math.round(windup / reactRate(anim));
}

/** 一发飞行物（X7）：执行器到点交给特效窗口，坐标由窗口按两只的舞台矩形算（时间线只算时刻） */
export interface Shot {
  /** 飞行物贴图名（`assets/pic/fx/<名>.png`） */
  kind: FxAssetName;
  /** 轨迹 */
  track: FxTrack;
  /** 飞行时间：命中时刻 = 放出 + 这个 */
  flightMs: number;
  /** 一次放几个 */
  count: number;
  /** 齐发时逐发的间隔 */
  gapMs: number;
  /** 命中那一下的贴图 */
  hitFx: FxAssetName;
  /** 出手那一刻手的位置（640×360 舞台坐标、素材朝左；特效窗口按出手方朝向决定要不要镜像 x） */
  hand: [number, number];
  /** 这一发的色相（三球的三个球） */
  hue?: number;
  /** 被闪避：从对方身边掠过去（偏开一点）、淡出，不画命中特效 */
  miss?: boolean;
  /** 被泡泡护体挡下：打在泡泡朝着来路的那一侧（天雷打在泡泡顶上），不打在身上 */
  blocked?: boolean;
  /** 从天上来（渡劫的雷）：目标就是这一步的 `who` 自己，起点在它头顶上方 */
  sky?: boolean;
  /** 被墨汁糊了眼打歪（X8 `miss` 事件）：远远地从对方头顶飞过去，不画命中特效、对方不反应 */
  wild?: boolean;
  /** 打在水母分身上（X8 `decoy` 事件）：对方原地留一只水母替身挨这一下，碎成泡泡 */
  decoy?: boolean;
  /** 打碎万我的一重魂影（X9 `mirror` 事件）：飞行物飞过去、命中画魂屑，不画替身（魂影只在出手素材里） */
  mirror?: boolean;
  /** 反向（鲸吞）：从对方身上飞回出手方嘴边 */
  reverse?: boolean;
  /** 这一下带着降龙十八掌的后劲（X16）：命中处多打一发小一号的命中-龙吟 */
  surge?: true;
  /** 银托盘的回旋（X8）：第二段绕到背后磕的时刻、飞回手里的时刻，以及第二段的结果 */
  boomerang?: { secondMs: number; totalMs: number; second: 'hit' | 'blocked' | 'decoy' | 'miss' | 'none' };
}

/**
 * 时间线上的一步。`who` 是引擎那边的序号（0 = 发起这场的一方 = 自家宠物，1 = 对手）。
 * `anim`、`line`、`shot` 都可以没有：那一步只是刷新气血条（命中那一刻掉血）。`closing` = 收场那几步
 * （结果动画和结果台词）——快进直接跳到它们。
 */
export interface Step {
  /** 距离开打的毫秒数 */
  at: number;
  who: 0 | 1;
  anim?: string;
  /** 这段素材的来处：不给（默认）= §2.3 的新素材，走 `/anim` 的 url 形态；`'pool'` = 动画池里的现有素材，走 name 形态 */
  from?: 'pool';
  /** 播这段动画的倍速（timeline 按素材时长算好，执行器原样传给 /anim 的 rate） */
  rate?: number;
  line?: string;
  /** 这一步放出的飞行物（X7） */
  shot?: Shot;
  /** 冲刺（X16）：这一步让 `who` 在 `ms` 里冲到对手身前（out）或退回原位（back） */
  dash?: { dir: 'out' | 'back'; ms: number };
  /** 这一步之后的气血（擂台照它刷新） */
  hp: [number, number];
  closing?: boolean;
}

/**
 * 换边（X12）：把每一步的「谁」和两条气血对调，其余字段（`at`、`anim`、`from`、`rate`、`line`、`shot`、
 * `closing`）原样保留。`Shot` 的字段都相对出手方，所以不用改。返回新数组，不动入参。
 *
 * 作客的一方在引擎里是 1 号（主人家是 0 号）；时间线必须先按引擎序号排（名字、招式表都照引擎来），
 * 再把画面换成本地视角——反着传名字 / 招式表的话，台词和化鸽遁这些按序号查的东西就对不上了。
 */
export function swapSides(steps: Step[]): Step[] {
  return steps.map((step) => ({
    ...step,
    who: (step.who ^ 1) as 0 | 1,
    hp: [step.hp[1], step.hp[0]] as [number, number],
  }));
}

/** 这些事件是打在对方身上的，要对方播挨打（凭空生花是回血，不算挨打） */
function isDamageOnFoe(event: BattleEvent): boolean {
  if (event.kind === 'hit' || event.kind === 'combo' || event.kind === 'counter' || event.kind === 'beast') return true;
  return event.kind === 'skill' && event.damage !== undefined;
}

/**
 * 这一手在演出表里的条目：法宝 / 招式查 `ATTACK_SHOW`；招式表（Y0 的 `move`）查 `MOVE_SHOW`。
 * 对手用招式表里的招时换成它自己的皮（`<前缀>-出手` / `<前缀>-绝招`），没有对手窗口时退回空手。
 */
function showOf(action: Action, who: 0 | 1, prefix?: string): AttackShow {
  if (action.kind === 'move') {
    const show = MOVE_SHOW[action.move];
    if (who === 1 && prefix) {
      const kind = show.foe ?? (MOVES[action.move].uses === 1 ? '绝招' : '出手');
      return { action: `${prefix}-${kind}`, ...(show.fly ? { fly: show.fly } : {}) };
    }
    if (show.action) return { action: show.action, ...(show.fly ? { fly: show.fly } : {}) };
    return ATTACK_SHOW.unarmed;
  }
  const key = action.kind === 'weapon' ? action.weapon : action.kind === 'skill' ? action.skill : 'unarmed';
  // 演出表里没有的招式（以后新增、还没来得及配演出）先按空手演：保证这场演得完、不报错
  return ATTACK_SHOW[key] ?? ATTACK_SHOW.unarmed;
}

/**
 * 一次出手放几段伤害：法宝看 `hits`；驭犬蛊的段数 = 那一群狗（`Fighter.pack`，引擎不把 pack 写进事件，
 * 这里从这一格后面的命中 / 闪避 / 替挡数出来）；其余一招一发。
 */
function hitsOf(action: Action, events: BattleEvent[], decideIndex: number): number {
  if (action.kind === 'weapon') return WEAPONS[action.weapon].hits;
  if (action.kind !== 'move' || !MOVES[action.move].packHits) return 1;
  let hits = 0;
  for (let j = decideIndex + 1; j < events.length; j += 1) {
    const kind = events[j].kind;
    // 狗全部放完以后才是追击 / 灵兽 / 收场，那些不算段数
    if (kind === 'decide' || kind === 'end' || kind === 'combo' || kind === 'beast' || kind === 'counter') break;
    if (
      kind === 'hit' ||
      kind === 'dodge' ||
      kind === 'miss' ||
      kind === 'decoy' ||
      kind === 'mirror' ||
      kind === 'guard'
    )
      hits += 1;
  }
  return Math.max(1, hits);
}

/**
 * 对手的皮：挨打的反应一律换成它的「受击」（闪避单独一段、假死换倒地）；没给前缀时原样。
 * 起手 / 胜利 / 倒地这些不在这里换，由排它们的地方直接拼前缀。
 */
function foeSkinOf(anim: string, who: 0 | 1, prefix?: string): string {
  if (who !== 1 || !prefix) return anim;
  // 已经是这只的皮（出手 / 闪避 / 受击……）就不再套一层前缀
  if (anim.startsWith(`${prefix}-`)) return anim;
  if (anim === DODGE_ANIM || anim === DOVE_ANIM) return `${prefix}-闪避`;
  if (anim === PLAY_DEAD_ANIM) return `${prefix}-倒地`;
  return `${prefix}-受击`;
}

/** 闪避动画：真有化鸽遁才是「化成一只鸽子」，否则通用闪避 */
function dodgeAnimOf(who: 0 | 1, skillSets?: [SkillId[], SkillId[]]): string {
  return skillSets?.[who]?.includes('dove') ? DOVE_ANIM : DODGE_ANIM;
}

/** 这一边有没有这门被动招式（`skillSets` 没传当作没有：只是少一段动画，台词和气血照旧） */
function hasSkill(who: 0 | 1, id: SkillId, skillSets?: [SkillId[], SkillId[]]): boolean {
  return skillSets?.[who]?.includes(id) ?? false;
}

/** 这一拍有没有被泡泡护体挡下（`skill` / `skip` 这些事件不带 blocked） */
function blockedHere(event: BattleEvent): boolean {
  return 'blocked' in event && event.blocked;
}

/** 这一格里的挨打反应有没有被紧随其后的假死遁顶掉（假死遁自己播，不重复挨一下） */
function playDeadAfter(events: BattleEvent[], index: number): boolean {
  const next = events[index + 1];
  return next !== undefined && next.kind === 'play-dead';
}

/** 渡劫（X4）失败那一下：动画池里的现有素材（名字形态播，不是 §2.3 的新素材） */
export const TRIBULATION_LOSS_ANIM = '工作状态-垂头叹气冒汗';
/** 渡劫（X4）成功那一下 */
export const TRIBULATION_WIN_ANIM = '修炼-突破';
/** 渡劫开场的服丹（§2.3 的 url 形态素材） */
export const TRIBULATION_PILL_ANIM = '修炼-服丹';

/**
 * `timeline` 的额外选项。
 * @param tribulation 渡劫这一场：没有对手窗口（`ShowSides.foe = null`），开场不吃丹就不播起手式、
 *   吃丹先播一段 `修炼-服丹`；收场用 `修炼-突破` / `工作状态-垂头叹气冒汗`（渡劫没有「打赢对手」那句
 *   台词，结果感言由调用方按人设说一句，见 features.ts）。引擎的事件里 `actor` 恒为 0（天雷不算一方），
 *   所以这几步都排在自家宠物那一边。
 *   `strikes` = 这一场该有几道雷（`tribulationPlan` 给的）：台词报「第 i/N 道」的 N。
 *   没扛住时事件里只有前几道雷，不传就会报成「第 2/2 道」那种偏小的数。
 */
export interface TimelineOptions {
  tribulation?: { pill: boolean; strikes?: number };
  /**
   * 对手的皮（Y2 历练）：给了以后对手那一边的动画一律换成 `<前缀>-<动作>`——起手、出手、绝招、
   * 受击、闪避、倒地、胜利。素材缺了由对手窗口退回 CSS 动作，时间线不查文件。
   */
  foe?: { prefix: string };
  /**
   * 逐手出招（X17）：第 i 个 `decide` 事件换成这句台词（AI 给的），替掉这一手模板解说里该方的那句。
   * 键是 `events` 里的下标；重算前缀时同一句要一直在表里。
   */
  decideLines?: ReadonlyMap<number, string>;
}

/** 这一格的出手（`decide` 排出来的；`closeSlot` 作废）。只有带飞行物的出手才会排出来 */
interface Slot {
  /** 出手方 */
  who: 0 | 1;
  show: AttackShow;
  /** 这一格的飞行物 */
  fly: Fly;
  /** 一次出手放几段伤害 */
  hits: number;
  /** 离手的那一刻（动作起播 + 原速出手时刻 ÷ 倍速） */
  release: number;
  /** 这一格里已经用掉几段 */
  segments: number;
  /**
   * 主攻那几段里由哪一段（从 1 数）决定对方的反应：有一段打中就是第一段打中的（受击 / 泡泡），全被躲开才是第一段闪避；
   * 其余几段只飞过去（打中的画命中特效、躲开的掠过），不另起反应——一把撒出去的扑克牌不会让对方先躲再挨、来回抽搐
   */
  primary: number;
  /** 主攻几段之间的间隔（多段法宝紧挨着飞；单段是 0） */
  gap: number;
  /** 这一格最后还有一下灵兽没出（引擎：带灵兽的一方前 3 次法宝 / 空手出手之后追加一击，对方还站着就一定出） */
  beast: boolean;
  /** 银托盘：第一段放出的时刻（第二段的命中按它算） */
  boomerangLaunch?: number;
  /** 冲刺（X16）：退回原位的那一步已经排过了（一格只退一次） */
  dashBack?: boolean;
}

/**
 * 引擎事件 → 时间线。
 * @param events `fight()` / `tribulate()` 的事件序列
 * @param names 两边的名字（给 `lineOf`：[0] = 自家宠物，[1] = 对手）
 * @param rng 解说台词的随机数（注入序列才测得准）
 * @param skillSets 双方的招式表：闪避那句和闪避动画要看有没有化鸽遁，连击那一拍有没有无影手也看它
 * @param options 见 `TimelineOptions`（渡劫用）
 */
export function timeline(
  events: BattleEvent[],
  names: [string, string],
  rng: () => number,
  skillSets?: [SkillId[], SkillId[]],
  options?: TimelineOptions,
): Step[] {
  const steps: Step[] = [];
  const start = events.find((event) => event.kind === 'start');
  const base: [number, number] = start ? start.hp : [0, 0];
  const tribulation = options?.tribulation;
  /** 对手的皮（Y2）：给了就把对手那一边的动画名换成它的前缀 */
  const foePrefix = options?.foe?.prefix;
  /** 这场一共几道雷（渡劫台词报「第 i/N 道」用）：优先按 plan 给的雷数，没传就按事件里数得着的算（躲开的也算一道） */
  const strikeTotal = tribulation
    ? (tribulation.strikes ?? events.filter((event) => event.kind === 'strike' || event.kind === 'dodge').length)
    : 0;
  /** 渡劫：到第几道雷了（劈中的按引擎的 index，躲开的接着数） */
  let bolt = 0;
  /** 两只各自「忙到几点」：最后一段动画播完的时刻（出手类排在它之后，免得把上一段从中间切断） */
  const busy: [number, number] = [0, 0];
  /** 两只正在播的反应（同一格里再挨一下时同一段还在播，就不重新起播） */
  const reacting: [{ anim: string; until: number } | null, { anim: string; until: number } | null] = [null, null];
  /** 两边灵兽还剩几次（同引擎：有灵兽助阵的一方 3 次） */
  const beastLeft: [number, number] = [0, 1].map((who) =>
    hasSkill(who as 0 | 1, 'spirit-beast', skillSets) ? BEAST_TIMES : 0,
  ) as [number, number];

  /** 排一段动画，顺手记下这只忙到几点 */
  const pushAnim = (step: Step & { anim: string; rate: number }): void => {
    steps.push(step);
    busy[step.who] = Math.max(busy[step.who], step.at + animLength(step.anim, step.rate));
  };

  if (tribulation) {
    // 渡劫：没有对手，开场只有吃丹那一段（不吃丹就直接等第一道雷）
    if (tribulation.pill) {
      pushAnim({
        at: 0,
        who: 0,
        anim: TRIBULATION_PILL_ANIM,
        rate: rateFor(TRIBULATION_PILL_ANIM, OPEN_MS),
        line: '吃一颗破境丹，气色立马好起来',
        hp: base,
      });
    }
  } else {
    // 开场：两边各一段起手式（`start` 事件本身不再另排一步）
    for (const who of [0, 1] as const) {
      const anim = who === 1 && foePrefix ? `${foePrefix}-起手` : '战斗-起手';
      pushAnim({ at: 0, who, anim, rate: rateFor(anim, OPEN_MS), hp: base });
    }
  }
  let cursor = OPEN_MS;
  /** 这一格里已经排了几件事（决定后面的错开多远） */
  let beat = 0;
  /** 这一格的出手（null = 没有出手格子：那一拍没有飞行物，台词与反应照旧排在 `at` 附近） */
  let slot: Slot | null = null;
  /** 上一个事件之后的气血（飞行物放出、反应起播那一刻血还没掉，擂台照这个刷） */
  let before: [number, number] = base;
  /** 最近一段伤害命中的时刻（第六感贴着自己挨的那一下再反劈、假死遁对准致命那一下）；还没有命中过是 null */
  let lastImpact: number | null = null;
  /** 逐手出招（X17）：这一手被 AI 的台词顶掉了模板解说的那一方；下一个 decide / end 清掉 */
  let overrideActor: 0 | 1 | null = null;
  /** 这一手的台词：有 AI 台词时不再出这一手的模板解说（挨打方的反应台词照旧） */
  const sayOf = (event: BattleEvent): string | undefined => {
    if (overrideActor !== null && event.actor === overrideActor) return undefined;
    return lineOf(event, names, rng, skillSets) ?? undefined;
  };

  /** 一格用完：下一件事另起一格——至少隔一个 `SLOT_MS`（多段台词再长一点），并且等两只都回到站姿 */
  const closeSlot = (): void => {
    if (beat > 0) {
      cursor = Math.max(cursor + Math.max(SLOT_MS, beat * BEAT_MS), busy[0] + GAP_MS, busy[1] + GAP_MS);
    }
    beat = 0;
    slot = null;
  };

  /**
   * 这一格里下一段伤害的飞行物：时刻与这一发的内容。主攻的第 k 段（从 0 数）在 `release + k × gap`，
   * 追击（combo）接在主攻最后一段之后、每次再隔一个 `BEAT_MS`；`reacts` = 这一段要不要让对方起反应（见 `Slot.primary`）
   */
  const takeSegment = (current: Slot): { at: number; reacts: boolean; extra: { count: number; hue?: number } } => {
    current.segments += 1;
    const k = current.segments - 1;
    const fly = current.fly;
    const main = k < current.hits;
    // 多段法宝（扑克牌两张、三球三个）的「个数」由引擎的段数承担：每段一个，各自可被闪避，
    // 三球的色相也逐段轮（0 / 120 / 240）；单段出手（空手、水枪、狮子吼……）的「个数」才是这一发的齐发数，
    // 追击（combo）那一发只放一个
    const count = current.hits > 1 || !main ? 1 : (fly.count ?? 1);
    const hue = current.hits > 1 && main && fly.hueStep !== undefined ? (k * fly.hueStep) % 360 : undefined;
    const lastMain = current.release + (current.hits - 1) * current.gap;
    return {
      at: main ? current.release + k * current.gap : lastMain + (k - current.hits + 1) * BEAT_MS,
      reacts: !main || current.segments === current.primary,
      extra: { count, ...(hue === undefined ? {} : { hue }) },
    };
  };

  /** 放一发：排一步 `shot`，返回它的命中时刻（= 放出 + 飞行时间） */
  const pushShot = (
    at: number,
    who: 0 | 1,
    action: string | null,
    fly: Fly,
    hp: [number, number],
    extra: {
      count?: number;
      gapMs?: number;
      hue?: number;
      miss?: boolean;
      blocked?: boolean;
      sky?: boolean;
      wild?: boolean;
      decoy?: boolean;
      mirror?: boolean;
      surge?: boolean;
      boomerang?: Shot['boomerang'];
    } = {},
  ): number => {
    const shot: Shot = {
      kind: fly.kind,
      track: fly.track,
      flightMs: FLIGHT_MS[fly.track],
      count: extra.count ?? fly.count ?? 1,
      gapMs: extra.gapMs ?? fly.gapMs ?? 0,
      hitFx: fly.hitFx,
      hand: [...((action && releaseOf(action)?.hand) || [0, 0])] as [number, number],
      ...(extra.hue === undefined ? {} : { hue: extra.hue }),
      ...(extra.miss ? { miss: true } : {}),
      ...(extra.blocked ? { blocked: true } : {}),
      ...(extra.sky ? { sky: true } : {}),
      ...(extra.wild ? { wild: true } : {}),
      ...(extra.mirror ? { mirror: true } : {}),
      ...(extra.decoy ? { decoy: true } : {}),
      ...(extra.surge ? { surge: true as const } : {}),
      ...(fly.reverse ? { reverse: true } : {}),
      ...(extra.boomerang ? { boomerang: extra.boomerang } : {}),
    };
    steps.push({ at, who, shot, hp });
    // 命中按第一发到达算（水枪三发、声波三道）；反向的鲸吞按最后一颗灵光飞回嘴边算（那一刻回血）
    return at + shot.flightMs + (fly.reverse ? (shot.count - 1) * shot.gapMs : 0);
  };

  /**
   * 放这一格里下一段的飞行物，返回放出 / 命中时刻与这一段要不要让对方起反应。
   * 银托盘（回旋）只在第一段放一发，带上第二段的结果（往后找）；第二段不另放，命中 = 放出 + BOOMERANG_SECOND_MS
   */
  const launchSegment = (
    current: Slot,
    index: number,
    hp: [number, number],
    flags: {
      miss?: boolean;
      blocked?: boolean;
      wild?: boolean;
      decoy?: boolean;
      mirror?: boolean;
      twin?: boolean;
      surge?: boolean;
    },
  ): { launch: number; impact: number; reacts: boolean } => {
    const segment = takeSegment(current);
    const k = current.segments - 1;
    const { twin, ...rest } = flags;
    if (current.fly.track === 'boomerang' && k < current.hits) {
      if (k === 0) {
        current.boomerangLaunch = segment.at;
        const second = secondOf(events, index);
        const totalMs = Math.max(BOOMERANG_SECOND_MS + 200, boomerangTotalMs(current.show.action));
        const boomerang = { secondMs: BOOMERANG_SECOND_MS, totalMs, second };
        const impact = pushShot(segment.at, current.who, current.show.action, current.fly, hp, { ...rest, boomerang });
        return { launch: segment.at, impact, reacts: segment.reacts };
      }
      const launch = current.boomerangLaunch ?? segment.at;
      return { launch, impact: launch + BOOMERANG_SECOND_MS, reacts: segment.reacts };
    }
    const impact = pushShot(segment.at, current.who, current.show.action, current.fly, hp, {
      ...segment.extra,
      ...rest,
      // 弹弓一发打两颗：两颗星星糖几乎一起飞出去
      ...(twin ? { count: 2, gapMs: TWIN_GAP_MS } : {}),
    });
    return { launch: segment.at, impact, reacts: segment.reacts };
  };

  /**
   * 对准命中时刻起播一段反应（受击 / 泡泡 / 闪避 / 触电 / 假死）：起播 = impact − 前摇，倍速固定。
   * 这只上一段反应还没播完：不另起（这一下只画特效、掉血、出台词），免得把它从中间切断；
   * 只有假死遁（`force`）照样起播——装死倒下那一下必须演出来。
   */
  const pushReaction = (
    impact: number,
    who: 0 | 1,
    anim: string,
    hp: [number, number],
    line?: string,
    force = false,
  ): void => {
    const skinned = foeSkinOf(anim, who, foePrefix);
    const at = impact - windupOf(skinned);
    const current = reacting[who];
    if (!force && current && at < current.until) {
      if (line !== undefined) steps.push({ at, who, line, hp });
      return;
    }
    const rate = reactRate(skinned);
    pushAnim({ at, who, anim: skinned, rate, ...(line === undefined ? {} : { line }), hp });
    reacting[who] = { anim: skinned, until: at + animLength(skinned, rate) };
  };

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    // start 已经换成开场那两步；台词由 lineOf 决定（它说 null 的事件就只是没字，不是没画面）
    if (event.kind === 'start') continue;

    if (event.kind === 'decide') {
      closeSlot();
      const override = options?.decideLines?.get(i);
      overrideActor = override === undefined ? null : event.actor;
      const show = showOf(event.action, event.actor, foePrefix);
      const hits = hitsOf(event.action, events, i);
      const release = cursor + releaseOffset(show.action);
      pushAnim({ at: cursor, who: event.actor, anim: show.action, rate: actionRate(show.action), hp: event.hp });
      // 冲刺（X16）：出掌前 outMs 冲过去，正好在离手那一刻到对手身前（渡劫没有对手，不冲）
      if (show.dash && !tribulation) {
        steps.push({
          at: Math.max(cursor, release - show.dash.outMs),
          who: event.actor,
          dash: { dir: 'out', ms: show.dash.outMs },
          hp: event.hp,
        });
      }
      // 魂牵梦绕（X9）：原著那四句咒先念出来，命中那一刻再接结算台词（一句顶一句，正好铺满这一格）
      if (event.action.kind === 'skill' && event.action.skill === 'dream-chant' && override === undefined) {
        steps.push({ at: cursor, who: event.actor, line: DREAM_CHANT, hp: event.hp });
      }
      // 逐手出招（X17）：AI 想说就说一句，替掉这一手模板解说里自家宠物的那句
      if (override !== undefined) {
        steps.push({ at: cursor, who: event.actor, line: override, hp: event.hp });
      }
      if (show.fly) {
        slot = {
          who: event.actor,
          show,
          fly: show.fly,
          hits,
          release,
          segments: 0,
          primary: primaryOf(events, i, hits),
          gap: hits > 1 ? (show.fly.gapMs ?? 150) : 0,
          beast: event.action.kind !== 'skill' && beastLeft[event.actor] > 0,
        };
      }
      before = event.hp;
      continue;
    }

    if (event.kind === 'end') {
      closeSlot();
      if (tribulation) {
        // 渡劫：只有自家这一边（引擎把「没扛住」的 end 排在 actor 1，这里统一排到 0），
        // 成功播 修炼-突破、失败播 工作状态-垂头叹气冒汗（池里的现有素材，名字形态）。
        // 结果不配「谁赢了」那种台词：结果感言由调用方按人设说一句（§X4 每次渡劫只 +1 次模型调用）。
        const win = event.winner === 0;
        const anim = win ? TRIBULATION_WIN_ANIM : TRIBULATION_LOSS_ANIM;
        pushAnim({
          at: cursor,
          who: 0,
          anim,
          ...(win ? {} : { from: 'pool' as const }),
          rate: rateFor(anim, CLOSE_MS),
          hp: event.hp,
          closing: true,
        });
        continue;
      }
      if (event.reason === 'farewell') {
        // 串门里被送友风送走（X16）：不演胜利 / 倒地，被送走的那位飘起来（命中时已经开始飘的接着播），
        // 胜负那句台词照旧。主人家这一侧送客、客人家那一侧等 sent-home，都由调用方按这一条收场。
        const winner = event.winner;
        const loser = (winner ^ 1) as 0 | 1;
        const from = steps.length;
        pushReaction(cursor, loser, FLOAT_ANIM, event.hp);
        for (const step of steps.slice(from)) step.closing = true;
        overrideActor = null;
        const line = sayOf(event);
        if (line) steps.push({ at: cursor, who: winner, line, hp: event.hp, closing: true });
        continue;
      }
      const winner = event.winner;
      const loser = (winner ^ 1) as 0 | 1;
      for (const [who, action] of [
        [winner, '胜利'],
        [loser, '倒地'],
      ] as const) {
        const anim = who === 1 && foePrefix ? `${foePrefix}-${action}` : `战斗-${action}`;
        pushAnim({ at: cursor, who, anim, rate: rateFor(anim, CLOSE_MS), hp: event.hp, closing: true });
      }
      overrideActor = null;
      const line = sayOf(event);
      if (line) steps.push({ at: cursor, who: winner, line, hp: event.hp, closing: true });
      continue;
    }

    if (tribulation && (event.kind === 'dodge' || (event.kind === 'skill' && event.heal !== undefined))) {
      // 渡劫里的躲闪 = 这一道雷被躲开了（引擎只记 dodge、没有 strike）：照样一格，乌云聚起、闪电劈到身边的地上，
      // 闪避对准劈下的那一刻；两道雷之间的回血（凭空生花）自己占一格。都排在上一段播完之后，不切断触电
      closeSlot();
      const line = sayOf(event);
      if (event.kind === 'dodge') {
        bolt += 1;
        const impact = pushShot(cursor, event.actor, null, TRIBULATION_FLY, before, { sky: true, miss: true });
        const said = line === undefined ? undefined : `第 ${bolt}/${strikeTotal} 道：${line}`;
        pushReaction(impact, event.actor, dodgeAnimOf(event.actor, skillSets), event.hp, said);
      } else {
        pushAnim({
          at: cursor,
          who: event.actor,
          anim: ATTACK_SHOW.bloom.action,
          rate: rateFor(ATTACK_SHOW.bloom.action, SLOT_MS),
          hp: before,
        });
        // 血条和「气血 +N」等花绽开那一刻再刷（用户反馈：血条先回、动画后播）
        steps.push({
          at: cursor + healOffset(),
          who: event.actor,
          ...(line === undefined ? {} : { line }),
          hp: event.hp,
        });
      }
      beat += 1;
      before = event.hp;
      continue;
    }

    if (event.kind === 'strike') {
      // 渡劫（X7 第二步）：一道雷一格。乌云在 `cursor` 淡入，闪电劈到渡劫者头顶的那一刻（impact）
      // 播触电（被泡泡挡下就播泡泡护体，命中特效照样画在泡泡上），台词「第 i/N 道」也在 impact。
      closeSlot();
      bolt = event.index + 1;
      const blocked = blockedHere(event);
      const impact = pushShot(cursor, event.actor, null, TRIBULATION_FLY, before, { sky: true, blocked });
      let line = sayOf(event);
      // 渡劫的台词报第几道雷（设计 §4.6：气泡显示「第 3 道天雷」）
      if (tribulation && line) line = `第 ${event.index + 1}/${strikeTotal} 道：${line}`;
      // 致命那道雷后面紧跟假死遁：倒下由假死遁自己演，不再触电（两段顶在一起只会打断它）
      if (!playDeadAfter(events, i)) {
        pushReaction(impact, event.actor, blocked ? BUBBLE_ANIM : (TRIBULATION_FLY.react ?? HIT_ANIM), before);
      }
      steps.push({ at: impact, who: event.actor, ...(line === undefined ? {} : { line }), hp: event.hp });
      lastImpact = impact;
      beat += 1;
      before = event.hp;
      continue;
    }

    // 结算事件：`at` 是这一拍的老时刻（没有飞行物的那几类——skip、回血——照它走）
    const at = cursor + beat * BEAT_MS;
    const line = sayOf(event);
    const hpBefore = before;
    before = event.hp;
    beat += 1;

    if (event.kind === 'dodge') {
      // 自己躲开：飞行物掠过去（`miss`，不画命中特效），闪避动画对准它掠过的时刻（提前躲开一半）
      const anim = foeSkinOf(dodgeAnimOf(event.actor, skillSets), event.actor, foePrefix);
      const current = slot;
      if (!current) {
        // 这一格没有出手（手喂的事件序列）：只是自己一闪，照旧排在 `at`
        pushAnim({
          at,
          who: event.actor,
          anim,
          rate: reactRate(anim),
          ...(line === undefined ? {} : { line }),
          hp: event.hp,
        });
        continue;
      }
      // 灵兽那一下被躲开（引擎只记一条 dodge）：它是这一格的最后一件事。灵兽照样召出来冲过去，只是扑了个空
      const beast = current.beast && current.who !== event.actor && lastOfSlot(events, i);
      const append = ATTACK_SHOW['spirit-beast'];
      if (beast && append.fly) {
        current.beast = false;
        beastLeft[current.who] -= 1;
        const moment = Math.max(at, busy[current.who]);
        pushAnim({
          at: moment,
          who: current.who,
          anim: append.action,
          rate: rateFor(append.action, SLOT_MS),
          hp: hpBefore,
        });
        const launch = moment + releaseOffset(append.action);
        const impact = pushShot(launch, current.who, append.action, append.fly, hpBefore, { miss: true });
        pushReaction(impact, event.actor, anim, event.hp, line);
        continue;
      }
      const segment = launchSegment(current, i, hpBefore, { miss: true });
      if (segment.reacts) pushReaction(segment.impact, event.actor, anim, event.hp, line);
      else if (line !== undefined) steps.push({ at: segment.impact, who: event.actor, line, hp: event.hp });
      continue;
    }

    if (event.kind === 'play-dead') {
      // 自己装死：对准致命那一下的命中时刻倒下（那一下的受击已经被 playDeadAfter 省掉）；
      // 手喂的序列里没有命中时刻就排在这一拍
      if (lastImpact !== null && lastImpact >= cursor) {
        // 同一只前面还排着反击 / 连拳时等那段演完再倒，免得装死那一下被从中间切断（X20）
        const skinned = foeSkinOf(PLAY_DEAD_ANIM, event.actor, foePrefix);
        const impact = Math.max(lastImpact, busy[event.actor] + windupOf(skinned));
        pushReaction(impact, event.actor, PLAY_DEAD_ANIM, event.hp, line, true);
      } else {
        const anim = foeSkinOf(PLAY_DEAD_ANIM, event.actor, foePrefix);
        pushAnim({
          at,
          who: event.actor,
          anim,
          rate: reactRate(anim),
          ...(line === undefined ? {} : { line }),
          hp: event.hp,
        });
      }
      continue;
    }

    if (event.kind === 'guard') {
      // 替挡（Y0 定仙游结局）：飞行物在挨打方身前停住（`Shot.blocked`，特效层不用改），
      // 命中画雪花，挨打方不播受击，只出一句「谁挡在前面」的台词。
      const current = slot;
      if (!current) {
        if (line !== undefined) steps.push({ at, who: event.actor, line, hp: event.hp });
        continue;
      }
      const segment = launchSegment(current, i, hpBefore, { blocked: true });
      const fired = steps[steps.length - 1];
      if (fired?.shot) fired.shot.hitFx = '命中-雪花';
      steps.push({ at: segment.impact, who: event.actor, ...(line === undefined ? {} : { line }), hp: event.hp });
      lastImpact = segment.impact;
      continue;
    }

    if (event.kind === 'miss' || event.kind === 'decoy' || event.kind === 'mirror') {
      // 致盲打空（actor = 攻击方）/ 水母分身、万我魂影替挨（actor = 挨打方）：照样占这一格的一段、放一发——
      // 打空的远远飞过去、对方不反应；替身那一下碎掉（水母碎成泡泡、魂影碎成魂屑），本体侧身躲开（闪避对准命中）
      const attacker = event.kind === 'miss' ? event.actor : ((event.actor ^ 1) as 0 | 1);
      const current = slot;
      if (!current || current.who !== attacker) {
        if (line !== undefined) steps.push({ at, who: event.actor, line, hp: event.hp });
        continue;
      }
      const shot = launchSegment(
        current,
        i,
        hpBefore,
        event.kind === 'miss' ? { wild: true } : event.kind === 'decoy' ? { decoy: true } : { mirror: true },
      );
      if (event.kind !== 'miss' && shot.reacts) pushReaction(shot.impact, event.actor, DODGE_ANIM, event.hp, line);
      else if (line !== undefined) steps.push({ at: shot.impact, who: event.actor, line, hp: event.hp });
      continue;
    }

    if (
      event.kind === 'skip' &&
      (event.cause === 'sleep' || event.cause === 'freeze' || event.cause === 'dream' || event.cause === 'float')
    ) {
      // 睡着 / 冻住 / 入梦 / 飘起来跳过的那一拍：再演一遍犯困 / 冻僵 / 入梦 / 飘起（一眼看得出它为什么不动）
      const anim = foeSkinOf(
        event.cause === 'sleep'
          ? SLEEP_ANIM
          : event.cause === 'freeze'
            ? FREEZE_ANIM
            : event.cause === 'float'
              ? FLOAT_ANIM
              : DREAM_ANIM,
        event.actor,
        foePrefix,
      );
      pushAnim({
        at: Math.max(at, busy[event.actor]),
        who: event.actor,
        anim,
        rate: reactRate(anim),
        ...(line === undefined ? {} : { line }),
        hp: event.hp,
      });
      continue;
    }

    // 没有伤害、但有飞行物的主动招式（鲸歌、墨汁）也走下面这一支：放一发、对方按招式反应
    const castOnFoe =
      event.kind === 'skill' &&
      event.damage === undefined &&
      event.heal === undefined &&
      ATTACK_SHOW[event.skill]?.fly !== undefined;
    if (isDamageOnFoe(event) || castOnFoe) {
      const shooter = event.actor;
      const victim = (event.actor ^ 1) as 0 | 1;
      const react = !playDeadAfter(events, i);
      const blocked = blockedHere(event);
      // 灵兽与第六感各有自己的出手（动作 + 飞行物），排在出手方上一段播完之后：
      // 灵兽等主攻的动作收势再召唤，第六感等自己挨完那一下回到站姿再反劈（「先挨后反」）
      const append: AttackShow | null =
        event.kind === 'beast'
          ? ATTACK_SHOW['spirit-beast']
          : event.kind === 'counter'
            ? ATTACK_SHOW['sixth-sense']
            : null;
      if (event.kind === 'beast' && slot?.beast) {
        slot.beast = false;
        beastLeft[shooter] -= 1;
      }
      /** 这一下：放出时刻、命中时刻、用的哪种飞行物、要不要让对方起反应 */
      let shot: { launch: number; impact: number; fly: Fly; reacts: boolean };
      /** 冲刺（X16）：这一下打中以后多久退回原位（只给主攻那一下，一格退一次） */
      let dashBackMs: number | null = null;
      /** 另起一段出手动作再放一发（灵兽、第六感、无影手）：排在出手方上一段播完之后 */
      const separate = (show: AttackShow & { fly: Fly }, earliest: number): typeof shot => {
        const moment = Math.max(earliest, busy[shooter]);
        pushAnim({ at: moment, who: shooter, anim: show.action, rate: rateFor(show.action, SLOT_MS), hp: hpBefore });
        const launch = moment + releaseOffset(show.action);
        const impact = pushShot(launch, shooter, show.action, show.fly, hpBefore, blocked ? { blocked: true } : {});
        return { launch, impact, fly: show.fly, reacts: react };
      };
      const fists =
        event.kind === 'combo' && hasSkill(shooter, 'shadow-fists', skillSets) ? ATTACK_SHOW['shadow-fists'] : null;
      if (append?.fly) {
        const earliest = event.kind === 'counter' ? (lastImpact ?? at) + SIXTH_SENSE_AFTER_MS : at;
        shot = separate({ ...append, fly: append.fly }, earliest);
      } else if (slot && fists?.fly) {
        // 无影手的追击：等主攻的动作收势，再播「战斗-连拳」，拳影按连拳自己的出手时刻齐发
        const segment = takeSegment(slot);
        shot = separate({ ...fists, fly: fists.fly }, segment.at);
      } else if (slot) {
        // 这一格的主攻（含没有无影手的追击：手还伸着，再放一发同一格攻击的飞行物）
        const twin = (event.kind === 'hit' || event.kind === 'combo') && event.twin === true;
        const surge = (event.kind === 'hit' || event.kind === 'combo') && event.surge === true;
        const segment = launchSegment(slot, i, hpBefore, {
          ...(blocked ? { blocked: true } : {}),
          ...(twin ? { twin: true } : {}),
          ...(surge ? { surge: true } : {}),
        });
        shot = { launch: segment.launch, impact: segment.impact, fly: slot.fly, reacts: react && segment.reacts };
        if (slot.show.dash && !slot.dashBack) dashBackMs = slot.show.dash.backMs;
      } else {
        // 手喂的事件序列里这一格没有出手：台词与受击照老口径排在 `at` 附近
        if (line !== undefined) steps.push({ at, who: shooter, line, hp: event.hp });
        if (react) pushReaction(at + REACT_MS, victim, blocked ? BUBBLE_ANIM : HIT_ANIM, event.hp);
        continue;
      }
      lastImpact = shot.impact;
      // 冲刺（X16）：打中以后退回开场的位置（退回的位移也是挪窗口，不画在素材里）
      if (dashBackMs !== null && slot) {
        slot.dashBack = true;
        steps.push({
          at: shot.impact,
          who: shooter,
          dash: { dir: 'back', ms: dashBackMs },
          hp: event.hp,
        });
      }
      // 挡下的那一下改播挨打方自己的泡泡护体；其余按这一招的受击方式（湿身、炸黑、砸头、冻僵……）。
      // 鲸吞是反向的：灵光从对方身上被吸走的那一刻（放出时）对方就起反应，飞回嘴边那一刻回血
      const reactAnim = blocked ? BUBBLE_ANIM : (shot.fly.react ?? HIT_ANIM);
      if (shot.reacts) pushReaction(shot.fly.reverse ? shot.launch : shot.impact, victim, reactAnim, hpBefore);
      // 掉血与结算台词都在命中那一刻（鲸吞的伤害和回血一起，在灵光飞回嘴边时结算）
      steps.push({ at: shot.impact, who: shooter, ...(line === undefined ? {} : { line }), hp: event.hp });
      continue;
    }

    // 逆流护身印（X21）：白袍把这一下弹回去——只刷台词与血条。攻击方刚出完手、下一手就在眼前，
    // 排整段受击会把它的出手从中间切断；这一步靠台词「原样打回」和血条变化交代
    if (event.kind === 'reverse') {
      steps.push({ at, who: event.actor, ...(line === undefined ? {} : { line }), hp: event.hp });
      continue;
    }

    // 前有古人（X21）：古人虚影从出手方冲出去补一击，命中那一刻对方受击
    if (event.kind === 'ancient') {
      const fly: Fly = { kind: '古人虚影', track: 'thrust', hitFx: '命中-斩' };
      const impact = pushShot(at, event.actor, '出手-古人', fly, hpBefore);
      pushReaction(impact, (event.actor ^ 1) as 0 | 1, HIT_ANIM, event.hp);
      steps.push({ at: impact, who: event.actor, ...(line === undefined ? {} : { line }), hp: event.hp });
      continue;
    }

    // 吃苦吃亏（X21）：咬一口时对方播 `受击-被吃`；吃泡泡 / 魂影只刷血条与台词
    if (event.kind === 'devour') {
      if (event.what === 'bite') pushReaction(at, (event.actor ^ 1) as 0 | 1, '受击-被吃', event.hp);
      steps.push({ at, who: event.actor, ...(line === undefined ? {} : { line }), hp: event.hp });
      continue;
    }

    // 鬼敲门（X22）：门后的人浑身一震——只刷台词与血条。敲门声在它自己出手的那一瞬结算，
    // 排整段受击会把它紧接着的出手切断
    if (event.kind === 'knock') {
      steps.push({ at, who: event.actor, ...(line === undefined ? {} : { line }), hp: event.hp });
      continue;
    }

    // 鬼画（X22）：符纹从指尖飞过去贴在对方身上（封被动；没被动可封时这一下带伤害，走下面的正常分支）
    if (event.kind === 'skill' && event.paint) {
      const fly: Fly = { kind: '符画', track: 'line', hitFx: '命中-魂碎' };
      const impact = pushShot(at, event.actor, '出手-鬼画', fly, hpBefore);
      steps.push({ at: impact, who: event.actor, ...(line === undefined ? {} : { line }), hp: event.hp });
      continue;
    }

    // 回血（凭空生花）：血条和「气血 +N」等花绽开那一刻再刷，不能一出招就回满
    if (event.kind === 'skill' && event.heal !== undefined) {
      steps.push({
        at: cursor + healOffset(),
        who: event.actor,
        ...(line === undefined ? {} : { line }),
        hp: event.hp,
      });
      continue;
    }

    // skip（被定住 / 晕了）、替挡（Y0 的 guard）：只有台词、没有飞行物；气血条照 `event.hp` 刷新
    if (line !== undefined) steps.push({ at, who: event.actor, line, hp: event.hp });
  }
  return steps.sort((a, b) => a.at - b.at);
}

/**
 * 逐手演出（X17）的时间线：每算到下一个决策点，就把新多出来的那段事件交给 `push`，
 * 它照**同一个随机序列**重算整场前缀，只返回新多出来的步骤（绝对时刻照 `timeline` 的口径）。
 *
 * 重算前缀必须先复现之前消耗过的解说随机数，否则已经播过的台词会换成另一句；
 * 所以这里把每次调用 `timeline` 取到的数按序号缓存，重放时原样吐回去，只有新事件才往后取。
 */
export class LiveTimeline {
  private readonly cache: number[] = [];
  private cursor = 0;
  private seen: Step[] = [];
  private readonly names: [string, string];
  private readonly rng: () => number;
  private readonly skillSets?: [SkillId[], SkillId[]];
  private readonly options?: TimelineOptions;

  constructor(
    names: [string, string],
    rng: () => number,
    skillSets?: [SkillId[], SkillId[]],
    options?: TimelineOptions,
  ) {
    this.names = names;
    this.rng = rng;
    this.skillSets = skillSets;
    this.options = options;
  }

  /** 追加到下一个决策点的事件前缀（整段事件），返回这一段新排出来的步骤 */
  push(events: BattleEvent[]): Step[] {
    this.cursor = 0;
    const next = timeline(events, this.names, this.replay, this.skillSets, this.options);
    const tail = next.slice(this.seen.length);
    this.seen = next;
    return tail;
  }

  /** 已经排好的全部步骤（快进时整场交给 BattleShow 跳收场） */
  steps(): Step[] {
    return this.seen;
  }

  /** 每一步按序号取随机数：序号在缓存里就重放，不在才向源随机数要一个新的 */
  private readonly replay = (): number => {
    if (this.cursor < this.cache.length) return this.cache[this.cursor++]!;
    const value = this.rng();
    this.cache.push(value);
    this.cursor += 1;
    return value;
  };
}

/** 速战（Y2）开场：两边各起手一拍，压到这么短（4 秒素材按它算倍速，正好播完，不切给下一段） */
export const QUICK_OPEN_MS = 1_400;
/** 速战收场最早在这个时刻（中间只演一下，留点喘息，整场约 9 秒） */
const QUICK_CLOSE_MS = 6_600;
/** 速战收场最晚在这个时刻（加上最后一句 `LINE_MS` 正好 10 秒） */
const QUICK_MAX_CLOSE_MS = 10_000 - LINE_MS;

/**
 * 速战（Y2）：小怪、精英的一场约 10 秒。只排开场两边起手、伤害最大的一下（出手 + 飞行物 + 受击）、
 * 收场（赢的胜利、输的倒地），气血条照这几步走到引擎的最终值。
 *
 * 做法是把「最大那一下」前后的引擎事件裁成一小段，交给 `timeline` 排，再把非开场的时间整体前移
 * （飞行物、受击、台词之间的相对时刻不变），最后把收场几步拉到 `QUICK_CLOSE_MS` 附近。
 * 收场几步照旧标 `closing`，`BattleShow.skip()` 直接跳到它们。
 */
export function quickTimeline(
  events: BattleEvent[],
  names: [string, string],
  rng: () => number,
  skillSets?: [SkillId[], SkillId[]],
  options?: TimelineOptions,
): Step[] {
  const startEvent = events.find((event) => event.kind === 'start');
  let endEvent: Extract<BattleEvent, { kind: 'end' }> | undefined;
  for (const event of events) if (event.kind === 'end') endEvent = event;
  if (!startEvent || !endEvent) return timeline(events, names, rng, skillSets, options);

  /** 选伤害最大、且前面有同一个出手方的 `decide` 的那一下；反击 / 灵兽是追加伤害，不选 */
  let chosen = -1;
  let chosenDecide = -1;
  let chosenDamage = -1;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const damage =
      event.kind === 'hit' || event.kind === 'combo'
        ? event.damage
        : event.kind === 'skill' && event.damage !== undefined
          ? event.damage
          : -1;
    if (damage <= chosenDamage) continue;
    let decideIndex = -1;
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = events[j];
      if (prev.kind === 'decide' && prev.actor === event.actor) {
        decideIndex = j;
        break;
      }
      if (prev.kind === 'decide' || prev.kind === 'end') break;
    }
    if (decideIndex < 0) continue;
    chosen = i;
    chosenDecide = decideIndex;
    chosenDamage = damage;
  }
  // 只把最大那一下裁出来：开场 + 它的 decide + 伤害 + 收场；一下都没打中（全躲开）就只演开场和收场
  const raw = timeline(
    chosen < 0 ? [startEvent, endEvent] : [startEvent, events[chosenDecide], events[chosen], endEvent],
    names,
    rng,
    skillSets,
    options,
  );
  const shift = QUICK_OPEN_MS - OPEN_MS;
  const closing = raw.filter((step) => step.closing);
  const latest = closing.reduce((max, step) => Math.max(max, step.at), 0);
  const closeAt = Math.min(QUICK_MAX_CLOSE_MS, Math.max(QUICK_CLOSE_MS, latest));
  const steps = raw.map((step): Step => {
    if (step.at === 0 && step.anim) {
      return { ...step, rate: rateFor(step.anim, QUICK_OPEN_MS) };
    }
    if (step.closing) return { ...step, at: step.at + (closeAt - latest) };
    return { ...step, at: Math.max(QUICK_OPEN_MS, step.at + shift) };
  });
  return steps.sort((a, b) => a.at - b.at);
}

/**
 * 主攻那几段里由哪一段（从 1 数）决定对方的反应（见 `Slot.primary`）：第一段打中的（含被泡泡挡下），全被躲开就第一段。
 * 主攻的段是 decide 之后的前 `hits` 个 hit / dodge（反击、假死夹在中间不算段；碰到追击、下一格就停）。
 */
function primaryOf(events: BattleEvent[], decideIndex: number, hits: number): number {
  let segment = 0;
  for (let j = decideIndex + 1; j < events.length && segment < hits; j += 1) {
    const event = events[j];
    if (event.kind === 'decide' || event.kind === 'end' || event.kind === 'combo') break;
    if (event.kind === 'hit' || (event.kind === 'skill' && event.damage !== undefined)) return segment + 1;
    if (event.kind === 'dodge' || event.kind === 'miss' || event.kind === 'decoy' || event.kind === 'mirror')
      segment += 1;
  }
  return 1;
}

/**
 * 银托盘第二段（飞回来从背后磕的那一下）的结果：从第一段往后找这一格的下一段（反击、假死夹在中间跳过；
 * 碰到追击、下一格、收场就停）。对方第一段就倒下了、根本没有第二段是 `none`
 */
function secondOf(events: BattleEvent[], index: number): 'hit' | 'blocked' | 'decoy' | 'miss' | 'none' {
  for (let j = index + 1; j < events.length; j += 1) {
    const event = events[j];
    if (event.kind === 'decide' || event.kind === 'end' || event.kind === 'combo') return 'none';
    if (event.kind === 'hit') return event.blocked ? 'blocked' : 'hit';
    if (event.kind === 'decoy') return 'decoy';
    if (event.kind === 'dodge' || event.kind === 'miss') return 'miss';
  }
  return 'none';
}

/** 这一件事是不是这一格的最后一件（后面紧跟下一格的 decide、收场，或者事件序列到头了） */
function lastOfSlot(events: BattleEvent[], index: number): boolean {
  const next = events[index + 1];
  return next === undefined || next.kind === 'decide' || next.kind === 'end';
}

/** 一边的手：播一段素材（带倍速）、说一句台词 */
export interface ShowSide {
  /**
   * 播一段素材。`from` = `'pool'` 时是动画池里的现有素材（走 `/anim` 的 name 形态），
   * 没给就是 §2.3 的新素材（url 形态）。`rate` 是 timeline 按素材时长算好的倍速。
   */
  play(anim: string, rate: number, from?: 'pool'): void;
  say(line: string, durationMs: number): void;
}

/** 执行器要注入的几只手：`foe` 为 null = 没有对手窗口（X4 渡劫） */
export interface ShowSides {
  /** 自家宠物 */
  self: ShowSide;
  /** 对手（心魔窗口 / 客人窗口） */
  foe: ShowSide | null;
  /** 擂台的气血条 */
  arena(hp: [number, number]): void;
  /** 特效窗口放一发（X7）：`who` 是出手方（天雷是渡劫者自己），坐标由特效窗口按两只的舞台矩形算 */
  shoot(shot: Shot, who: 0 | 1): void;
  /**
   * 冲刺（X16）：让 `who` 在 `ms` 里冲到对手身前（out）或退回原位（back）。
   * 自家宠物走 `/position` 的 `line`，对手窗口由主进程按帧 `setBounds`；没有对手窗口时不接这只手。
   */
  dash?(who: 0 | 1, dir: 'out' | 'back', ms: number): void;
  /**
   * 演出收尾 / 快进：把冲刺的窗口挪回开场位置、恢复跟随。
   * `force` = 快进 / 收摊（立刻复位）；不给 = 自然演完（已经在退回的路上就让它退完）。
   */
  dashEnd?(force?: boolean): void;
}

/** 可注入的定时器（测试里用 mock.timers 拨时间，不真等） */
export interface ShowTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: ShowTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 按时间线跑一场。`run()` 在演完（自然播完 / 快进 / dispose 都算）时 resolve，
 * 调用方接着算奖励、说赛后感言。
 *
 * `animLeadMs`：两边各自把「播动画」提前这么多发出去（[自家, 对手]）。动画要走一趟本机服务 / 换视频源才上屏，
 * 飞行物与气泡几乎是立刻的——不提前的话「手还没伸出去，东西先飞了」。提前量是真机录屏量出来的。
 */
export class BattleShow {
  private readonly steps: Step[];
  private readonly sides: ShowSides;
  private readonly timers: ShowTimers;
  private readonly animLeadMs: [number, number];
  /** 挂着的定时器句柄（快进 / dispose 要全停掉） */
  private pending: unknown[] = [];
  private done: (() => void) | null = null;
  private ended = false;
  /** 冲刺已经收过尾（快进 / 收摊先复位过一次）：finish 不再重复喊 */
  private dashClosed = false;

  constructor(steps: Step[], sides: ShowSides, timers: ShowTimers = realTimers, animLeadMs: [number, number] = [0, 0]) {
    this.steps = steps;
    this.sides = sides;
    this.timers = timers;
    this.animLeadMs = animLeadMs;
  }

  run(): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.steps.length === 0) {
      this.finish();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.done = resolve;
      for (const step of this.steps) {
        if (step.anim) {
          const lead = this.animLeadMs[step.who];
          this.pending.push(this.timers.setTimeout(() => this.playAnim(step), Math.max(0, step.at - lead)));
        }
        this.pending.push(this.timers.setTimeout(() => this.playRest(step), step.at));
      }
      // 最后一步（收场）把台词显示完才收尾
      const last = this.steps[this.steps.length - 1];
      this.pending.push(this.timers.setTimeout(() => this.finish(), last.at + LINE_MS));
    });
  }

  /** 快进：停掉剩下的步骤，直接播收场（结果动画、结果台词、气血条的最终值） */
  skip(): void {
    if (this.ended) return;
    this.clearPending();
    // 冲刺还没退回来：先复位（回到开场站位、恢复对手窗口的跟随），别把宠物留在对手身前
    this.sides.dashEnd?.(true);
    this.dashClosed = true;
    const closing = this.steps.filter((step) => step.closing);
    for (const step of closing) {
      this.playAnim(step);
      this.playRest(step);
    }
    // 时间线没有收场那几步（比如事件序列被截断）：至少把气血条推到最终值
    if (closing.length === 0) this.sides.arena(this.steps[this.steps.length - 1]?.hp ?? [0, 0]);
    this.finish();
  }

  /** 收摊（退出、被别的事打断）：不再播任何步骤，run() 立即结束 */
  dispose(): void {
    this.clearPending();
    this.sides.dashEnd?.(true);
    this.dashClosed = true;
    this.finish();
  }

  private sideOf(step: Step): ShowSide | null {
    return step.who === 0 ? this.sides.self : this.sides.foe;
  }

  private playAnim(step: Step): void {
    if (this.ended || !step.anim) return;
    // 没有对手窗口：那几步只是没画面
    this.sideOf(step)?.play(step.anim, step.rate ?? 1, step.from);
  }

  private playRest(step: Step): void {
    if (this.ended) return;
    this.sides.arena(step.hp);
    // 飞行物：谁放的那一步就交给特效窗口（窗口没开成时那边自己什么都不做）
    if (step.shot) this.sides.shoot(step.shot, step.who);
    if (step.dash) this.sides.dash?.(step.who, step.dash.dir, step.dash.ms);
    if (step.line) this.sideOf(step)?.say(step.line, LINE_MS);
  }

  private clearPending(): void {
    for (const handle of this.pending.splice(0)) this.timers.clearTimeout(handle);
  }

  private finish(): void {
    if (this.ended) return;
    // 自然演完时兜一下：冲刺的窗口跟随要恢复（已经在退回的路上就让它退完，见 dashEnd）
    if (!this.dashClosed) this.sides.dashEnd?.(false);
    this.ended = true;
    const resolve = this.done;
    this.done = null;
    resolve?.();
  }
}
