/**
 * 羁绊：好感度、阶段、小剧场与跟班状态（features/bond.ts 接线）。
 *
 * 只存本机，不读时钟、不碰 Electron：所有方法都带 now，由调用方每拍/每次事件喂进来。
 * 好感来源刻意做了每日上限，不能让点按钮刷满：
 *   对话 +1（每天 8 次）、摸摸头 +2（每次隔 10 分钟，每天 5 次）、
 *   喂零食 +3（每天 3 次）、心魔试炼 / 切磋 / 隔空切磋赢一场 +3（每天 4 次）、串门回来 +4（每天 2 次）。
 *
 * 阶段与事件的对应：12 分「熟悉」、36 分「亲近」、80 分「羁绊」；每一段都有一个
 * 小剧场（CG + 选项），分数到了就挂成 pending，主人点「羁绊」时再演，不打断干活。
 *
 * 存在 $DSH_HOME/dsh-pet/bond.json，先写临时文件再改名（同 cultivation.json）。
 * 文件读不了或内容坏了 → 改名为 .bad-<时间>、明确 warn，按第一次建档重建（不静默覆盖）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { diaryDate } from './diary';

/** 好感来源 */
export type BondKind = 'chat' | 'touch' | 'feed' | 'battle' | 'visit';

/** 三种小剧场（stage 1/2/3 各一个） */
export const BOND_SCENE_IDS = ['night-milk', 'rain-blanket', 'star-promise'] as const;
export type BondSceneId = (typeof BOND_SCENE_IDS)[number];

export interface BondChoice {
  id: string;
  label: string;
  /** 选完以后接的话（逐行显示） */
  reply: string[];
  /** 选完额外加的好感（只加一次） */
  bonus?: number;
}

export interface BondScene {
  id: BondSceneId;
  /** 小窗标题 */
  title: string;
  /** 场景图（相对 assets/pic/bond/ 的文件名） */
  image: string;
  /** 开场白（逐行显示） */
  intro: string[];
  choices: BondChoice[];
}

export interface BondStage {
  id: string;
  name: string;
  /** 到这个分数进入这一阶段 */
  at: number;
  /** 阶段说明（小窗里的一行） */
  line: string;
  /** 这个阶段解锁的小剧场；初识没有 */
  scene?: BondSceneId;
  /** 对话里给模型的一句口吻提示 */
  hint: string;
}

/** 阶段表：分数只增不减，阶段只升不降 */
export const BOND_STAGES: readonly BondStage[] = [
  {
    id: 'new',
    name: '初识',
    at: 0,
    line: '还带着一点客气，会偷偷观察你的习惯。',
    hint: '你们刚认识不久，说话客气一点、别太黏人，也别张口就说什么永远。',
  },
  {
    id: 'familiar',
    name: '熟悉',
    at: 12,
    line: '会主动分享看到的事，偶尔撒个小娇。',
    scene: 'night-milk',
    hint: '你们已经熟起来了，可以主动找点话题，偶尔撒个小娇；别每句都提关系。',
  },
  {
    id: 'close',
    name: '亲近',
    at: 36,
    line: '敢闹小脾气，也会在你累的时候安静陪着。',
    scene: 'rain-blanket',
    hint: '你们很亲近了，可以自然撒娇、闹点小脾气，也会主动关心主人累不累。',
  },
  {
    id: 'bonded',
    name: '羁绊',
    at: 80,
    line: '把你放在心尖上，偶尔会说些很认真的话。',
    scene: 'star-promise',
    hint: '你们已经是彼此很重要的人了，说话可以更亲昵、更直接，偶尔说一句很认真的话；但不要每句都提关系。',
  },
];

/** 小剧场：三条，对应三次阶段跨越 */
export const BOND_SCENES: Record<BondSceneId, BondScene> = {
  'night-milk': {
    id: 'night-milk',
    title: '一杯热牛奶',
    image: '场景-热牛奶.png',
    intro: ['夜里，你还在敲键盘。', '它端着一杯热牛奶，在桌边站了好一会儿。', '「主人，先喝一口吧。凉了就不好喝了。」'],
    choices: [
      {
        id: 'thanks',
        label: '接过牛奶，摸摸它的头',
        reply: ['牛奶是温的，杯壁刚好不烫手。', '它眯起眼睛，尾巴轻轻拍了两下桌面。'],
        bonus: 2,
      },
      {
        id: 'ask',
        label: '问它困不困',
        reply: ['「不困呀。主人没睡，我也再陪你一会儿。」', '说完还是偷偷打了个小哈欠。'],
        bonus: 1,
      },
      {
        id: 'work',
        label: '说再忙一会儿',
        reply: ['「那我把杯子放这儿，记得喝。」', '它退到一边，安安静静地不吭声了。'],
      },
    ],
  },
  'rain-blanket': {
    id: 'rain-blanket',
    title: '一半毛毯',
    image: '场景-毛毯.png',
    intro: [
      '窗外下起了雨，屋里比平时冷一点。',
      '它抱着那条印着小鲸鱼的毯子走过来。',
      '「一起盖吧。我查过了，这样最暖和。」',
    ],
    choices: [
      {
        id: 'share',
        label: '把毯子分它一半',
        reply: ['毯子不大，两个人挤在一起刚刚好。', '它靠着你，呼吸慢慢变轻。'],
        bonus: 3,
      },
      {
        id: 'wrap',
        label: '把它裹成一团',
        reply: ['「欸——这样我动不了啦。」', '嘴上抗议，尾巴却卷住了你的手腕。'],
        bonus: 2,
      },
      {
        id: 'rest',
        label: '让它先去睡',
        reply: ['「那你也早点睡。」', '它抱着毯子走到一半，又回头看了你一眼。'],
        bonus: 1,
      },
    ],
  },
  'star-promise': {
    id: 'star-promise',
    title: '窗外的星星',
    image: '场景-星空.png',
    intro: [
      '加班到很晚，窗外的城市只剩零星的灯。',
      '它趴在窗台上，看着远处的夜空。',
      '「主人，你说……我们会一直这样吗？」',
    ],
    choices: [
      {
        id: 'promise',
        label: '说会一直在一起',
        reply: ['它愣了一下，然后把脸埋进你的袖子。', '「那我就记住了。不许反悔。」'],
        bonus: 5,
      },
      {
        id: 'sea',
        label: '说以后带它去看海',
        reply: ['「真的？要坐很久的车吗？」', '它的眼睛一下子亮起来，开始认真地计划要带什么。'],
        bonus: 3,
      },
      {
        id: 'quiet',
        label: '摸摸头，不说话',
        reply: ['它没有再问，只是往你手心里蹭了蹭。', '窗外的灯一盏一盏灭下去，它一直没走。'],
        bonus: 2,
      },
    ],
  },
};

/** 每种来源加多少 */
export const BOND_GAINS: Record<BondKind, number> = { chat: 1, touch: 2, feed: 3, battle: 3, visit: 4 };
/** 每种来源每天最多算几次 */
export const BOND_DAILY_CAPS: Record<BondKind, number> = { chat: 8, touch: 5, feed: 3, battle: 4, visit: 2 };
/** 两次摸摸头之间至少隔这么久（不然点着玩就刷满了） */
export const BOND_TOUCH_GAP_MS = 10 * 60_000;
/** 跟班名字长度上限（按字符数，中文一个字算一个） */
export const COMPANION_NAME_MAX = 8;
/** 跟班默认名字 */
export const COMPANION_DEFAULT_NAME = '咪咪';

/** 小窗里看到的关系状态 */
export interface BondStatus {
  stage: number;
  stageName: string;
  stageLine: string;
  points: number;
  /** 进入下一阶段还要多少分；满阶段 null */
  nextAt: number | null;
  /** 当前阶段内的进度（0–100，满阶段 100） */
  percent: number;
  /** 一起相处了几天（按日记口径，至少 1） */
  days: number;
  /** 等着演的小剧场 */
  pending: BondSceneId | null;
  companion: { enabled: boolean; name: string };
}

/** 加好感的结果 */
export interface BondGain {
  /** 实际加了几分（被上限 / 冷却挡住是 0） */
  added: number;
  /** 被每日上限或冷却挡住了 */
  capped: boolean;
  /** 这次加完新挂上的小剧场（之前没有、现在有） */
  scene: BondSceneId | null;
  /** 这次加了以后升了阶段 */
  stageUp: boolean;
}

/** 选完小剧场的结果 */
export interface BondChoiceResult {
  scene: BondScene;
  choice: BondChoice;
  reply: string[];
  bonus: number;
  /** 选完以后还挂着的小剧场（连续跨阶段时会接着有） */
  next: BondSceneId | null;
}

const dailySchema = z.object({
  date: z.string().default(''),
  chat: z.number().int().min(0).default(0),
  touch: z.number().int().min(0).default(0),
  feed: z.number().int().min(0).default(0),
  battle: z.number().int().min(0).default(0),
  visit: z.number().int().min(0).default(0),
});

const companionSchema = z.object({
  enabled: z.boolean().default(true),
  name: z.string().default(COMPANION_DEFAULT_NAME),
  lastFedAt: z.number().int().nonnegative().default(0),
});

const saveSchema = z.object({
  version: z.literal(1),
  points: z.number().int().min(0),
  stage: z
    .number()
    .int()
    .min(0)
    .max(BOND_STAGES.length - 1),
  pending: z.enum(BOND_SCENE_IDS).nullable().default(null),
  seen: z.array(z.enum(BOND_SCENE_IDS)).max(BOND_SCENE_IDS.length).default([]),
  choices: z.record(z.string(), z.string()).default({}),
  since: z.number().int().nonnegative(),
  lastTouchAt: z.number().int().nonnegative().default(0),
  daily: dailySchema.default({ date: '', chat: 0, touch: 0, feed: 0, battle: 0, visit: 0 }),
  companion: companionSchema.default({ enabled: true, name: COMPANION_DEFAULT_NAME, lastFedAt: 0 }),
});

type BondSave = z.infer<typeof saveSchema>;

/** 把玩家输入的名字清理成可显示的短名字（去掉控制字符，压掉多余空白，按字符截断） */
export function cleanBondName(raw: string): string {
  const cleaned = String(raw ?? '')
    // eslint-disable-next-line no-control-regex -- 名字里混进控制字符会把菜单 / 气泡版面搞乱
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, COMPANION_NAME_MAX).join('');
}

/** 分数落在哪个阶段（不依赖存档里的 stage，读档后重新算一遍） */
export function stageOf(points: number): number {
  let stage = 0;
  for (let i = 0; i < BOND_STAGES.length; i++) {
    if (points >= BOND_STAGES[i].at) stage = i;
  }
  return stage;
}

/** 到分数为止、还没看过的最早一幕（分数一次跨两级时先演早的） */
export function nextSceneOf(points: number, seen: readonly string[]): BondSceneId | null {
  for (const stage of BOND_STAGES) {
    if (!stage.scene) continue;
    if (points >= stage.at && !seen.includes(stage.scene)) return stage.scene;
  }
  return null;
}

export class Bond {
  private points = 0;
  private stage = 0;
  private pending: BondSceneId | null = null;
  private seen = new Set<BondSceneId>();
  private choices: Record<string, string> = {};
  private since: number;
  private lastTouchAt = 0;
  private daily: BondSave['daily'] = { date: '', chat: 0, touch: 0, feed: 0, battle: 0, visit: 0 };
  private companion: BondSave['companion'] = {
    enabled: true,
    name: COMPANION_DEFAULT_NAME,
    lastFedAt: 0,
  };
  private readonly path: string;
  private readonly warn: (message: string) => void;

  /**
   * @param path 存档文件
   * @param now 第一次建档的时间（一起相处的起点）
   * @param warn 读/写失败时的告警出口
   */
  constructor(path: string, now: number, warn: (message: string) => void) {
    this.path = path;
    this.warn = warn;
    this.since = now;
    if (!existsSync(path)) return;
    try {
      const saved = saveSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      this.points = saved.points;
      this.seen = new Set(saved.seen);
      this.choices = saved.choices;
      this.since = saved.since || now;
      this.lastTouchAt = saved.lastTouchAt;
      this.daily = saved.daily;
      this.companion = {
        enabled: saved.companion.enabled,
        name: cleanBondName(saved.companion.name) || COMPANION_DEFAULT_NAME,
        lastFedAt: saved.companion.lastFedAt,
      };
      this.sync();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const bad = `${path}.bad-${Date.now()}`;
      try {
        renameSync(path, bad);
        this.warn(`羁绊存档读不了（${reason}），已改名 ${bad}，从头开始记`);
      } catch (renameError) {
        const renameReason = renameError instanceof Error ? renameError.message : String(renameError);
        this.warn(`羁绊存档读不了（${reason}），改名 ${bad} 也没成（${renameReason}）：文件留着没动，这次从头记`);
      }
      this.points = 0;
      this.stage = 0;
      this.pending = null;
      this.seen.clear();
      this.choices = {};
      this.since = now;
      this.lastTouchAt = 0;
      this.daily = { date: '', chat: 0, touch: 0, feed: 0, battle: 0, visit: 0 };
      this.companion = { enabled: true, name: COMPANION_DEFAULT_NAME, lastFedAt: 0 };
    }
  }

  /** 当前阶段、进度、待演的小剧场、跟班状态 */
  status(now: number): BondStatus {
    const current = BOND_STAGES[this.stage];
    const next = BOND_STAGES[this.stage + 1];
    const percent = next
      ? Math.round(Math.min(1, Math.max(0, (this.points - current.at) / (next.at - current.at))) * 100)
      : 100;
    return {
      stage: this.stage,
      stageName: current.name,
      stageLine: current.line,
      points: this.points,
      nextAt: next ? next.at : null,
      percent,
      days: Math.max(1, Math.floor((now - this.since) / 86_400_000) + 1),
      pending: this.pending,
      companion: { enabled: this.companion.enabled, name: this.companion.name },
    };
  }

  /** 给对话提示词用：关系阶段 + 还没说出口的心事 + 跟班（没有跟班时不写） */
  chatContext(now: number): string {
    const current = BOND_STAGES[this.stage];
    const lines = [
      `【羁绊】你和主人现在是「${current.name}」阶段，一起相处了 ${Math.max(1, Math.floor((now - this.since) / 86_400_000) + 1)} 天。${current.hint}`,
    ];
    if (this.pending) {
      lines.push('你心里有件想跟主人说的心事，等主人点「羁绊」的时候再说，现在不要直接说出来。');
    }
    if (this.companion.enabled) {
      lines.push(`【小跟班】${this.companion.name} 正跟着你；偶尔可以提一句它，但别每句都带。`);
    }
    return lines.join('\n');
  }

  /** 最近看过的一幕（状态页拿它的 CG 当背景；没看过返回 null） */
  lastSeenScene(): BondScene | null {
    let found: BondScene | null = null;
    for (const stage of BOND_STAGES) {
      if (stage.scene && this.seen.has(stage.scene)) found = BOND_SCENES[stage.scene];
    }
    return found;
  }

  /** 当前阶段对应的 CG（还没解锁时用上一阶段看过的；初识没有） */
  stageImage(): BondScene | null {
    const scene = BOND_STAGES[this.stage].scene;
    if (scene && this.seen.has(scene)) return BOND_SCENES[scene];
    return this.lastSeenScene();
  }

  /**
   * 加好感：先滚到当天，再按每日上限 / 摸摸头冷却决定加不加。
   * 分数变了就重算阶段与待演小剧场，并落盘。
   */
  add(kind: BondKind, now: number): BondGain {
    this.rollDay(now);
    const beforeStage = this.stage;
    const beforeScene = this.pending;
    let capped = false;
    if (kind === 'touch' && now - this.lastTouchAt < BOND_TOUCH_GAP_MS) capped = true;
    if (!capped && this.daily[kind] >= BOND_DAILY_CAPS[kind]) capped = true;
    if (capped) return { added: 0, capped: true, scene: null, stageUp: false };
    const added = BOND_GAINS[kind];
    this.points += added;
    this.daily[kind] += 1;
    if (kind === 'touch') this.lastTouchAt = now;
    this.sync();
    this.save();
    const scene = this.pending && this.pending !== beforeScene ? this.pending : null;
    return { added, capped: false, scene, stageUp: this.stage > beforeStage };
  }

  /** 演一幕：必须正是现在挂着的那一幕；选项不合法返回 null（不吞错） */
  choose(sceneId: BondSceneId, choiceId: string): BondChoiceResult | null {
    if (this.pending !== sceneId) return null;
    const scene = BOND_SCENES[sceneId];
    const choice = scene.choices.find((item) => item.id === choiceId);
    if (!choice) return null;
    this.seen.add(sceneId);
    this.choices[sceneId] = choiceId;
    this.points += choice.bonus ?? 0;
    this.sync();
    this.save();
    return { scene, choice, reply: choice.reply, bonus: choice.bonus ?? 0, next: this.pending };
  }

  /** 跟班开关（关掉只是不显示，不影响好感与剧情） */
  setCompanionEnabled(enabled: boolean): void {
    if (this.companion.enabled === enabled) return;
    this.companion.enabled = enabled;
    this.save();
  }

  /** 改跟班名字；空名字不接受，超长按字符截断。返回是否真的改了 */
  renameCompanion(raw: string): boolean {
    const name = cleanBondName(raw);
    if (!name || name === this.companion.name) return false;
    this.companion.name = name;
    this.save();
    return true;
  }

  /** 喂跟班：只有真加了好感才算喂成功（被每日上限挡住时调用方别说「吃到了」） */
  feedCompanion(now: number): BondGain {
    const gain = this.add('feed', now);
    if (gain.added > 0) {
      this.companion.lastFedAt = now;
      this.save();
    }
    return gain;
  }

  companionEnabled(): boolean {
    return this.companion.enabled;
  }

  companionName(): string {
    return this.companion.name;
  }

  /** 重算阶段与待演小剧场（读档后、加分后都走这里） */
  private sync(): void {
    this.stage = Math.max(this.stage, stageOf(this.points));
    this.pending = nextSceneOf(this.points, [...this.seen]);
  }

  /** 跨过凌晨 4 点换日：每日计数清零（同日记口径） */
  private rollDay(now: number): void {
    const date = diaryDate(now);
    if (this.daily.date === date) return;
    this.daily = { date, chat: 0, touch: 0, feed: 0, battle: 0, visit: 0 };
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const save: BondSave = {
        version: 1,
        points: this.points,
        stage: this.stage,
        pending: this.pending,
        seen: [...this.seen],
        choices: this.choices,
        since: this.since,
        lastTouchAt: this.lastTouchAt,
        daily: this.daily,
        companion: this.companion,
      };
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(save, null, 2) + '\n', 'utf8');
      renameSync(tmp, this.path);
    } catch (error) {
      this.warn(`羁绊存档写不了：${this.path}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
}
