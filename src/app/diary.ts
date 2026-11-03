/**
 * 宠物日记：白天记账（在电脑前多久、用了哪些应用、发生了哪些事），再让模型按人设写成一篇日记。
 *
 * 每天一份 `diary/YYYY-MM-DD.json`（记账 + 写好的日记），只存本机；`diary/index.html` 由全部日记生成，
 * 右键「宠物日记」用默认浏览器打开它。一天从凌晨 4 点算起：熬夜到一两点仍记在前一天。
 *
 * 日记在第二天主人回到电脑前时补写（那时这一天才完整）；右键随时可以先写一篇「到目前为止」的，
 * 这种写在当天结束之前的日记，第二天照样按完整的一天重写。
 *
 * 不读时钟、不碰 Electron：`features.ts` 每拍喂 now 与在场快照，模型调用也在那边。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { durationText } from './activity';
import type { ActivitySnapshot } from './activity';

const MIN = 60_000;
/** 一天从几点算起 */
const DAY_START_HOUR = 4;
/** 一天最多记多少件事（看屏幕一天可能几十次，防文件无限长） */
const MAX_EVENTS = 200;
/** 在电脑前不到这么久的一天不写日记 */
const MIN_PRESENT_MS = 10 * MIN;
/** 写进指令的看屏幕吐槽至多几条（均匀挑；其余事件一天就几件，全写） */
const MAX_SCREEN_LINES = 10;
/** 记账每拍都在变：至多每分钟存一次盘（记事件时立即存） */
const SAVE_EVERY_MS = MIN;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

const daySchema = z.object({
  /** 本地日期 YYYY-MM-DD（凌晨 4 点前算前一天） */
  date: z.string(),
  firstSeenAt: z.number().nullable(),
  lastSeenAt: z.number().nullable(),
  presentMs: z.number(),
  /** 前台应用 → 在电脑前用它的毫秒数 */
  apps: z.record(z.string(), z.number()),
  events: z.array(
    z.object({
      at: z.number(),
      // pomodoro：番茄钟已去掉、不再记，留着是为了旧日子的记录照样读得出来
      // cultivate：修炼（升级、突破、掉丹、调息）
      kind: z.enum([
        'return',
        'pomodoro',
        'sit',
        'water',
        'off-work',
        'claude',
        'screen',
        'visit',
        'snack',
        'cultivate',
      ]),
      text: z.string(),
    }),
  ),
  diary: z.object({ text: z.string(), writtenAt: z.number() }).optional(),
});

export type DiaryDay = z.infer<typeof daySchema>;
export type DiaryEventKind = DiaryDay['events'][number]['kind'];

/** 日记归属的日期：凌晨 4 点前算前一天 */
export function diaryDate(now: number): string {
  const date = new Date(now);
  if (date.getHours() < DAY_START_HOUR) date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 「10 月 23 日 星期五」 */
export function dateLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return `${month} 月 ${day} 日 星期${WEEKDAYS[new Date(year, month - 1, day).getDay()]}`;
}

/** 这一天结束的时刻（次日凌晨 4 点） */
function dayEnd(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day + 1, DAY_START_HOUR).getTime();
}

export class Diary {
  private day: DiaryDay;
  private lastTick: number | null = null;
  private savedAt = 0;
  private readonly dir: string;
  private readonly warn: (message: string) => void;

  /**
   * @param dir 日记目录（不存在就建）
   * @param warn 日记文件读不了时的告警出口（那一天按空的重新记）
   */
  constructor(dir: string, now: number, warn: (message: string) => void) {
    this.dir = dir;
    this.warn = warn;
    mkdirSync(dir, { recursive: true });
    // 白天重启应用：接着今天的账记
    this.day = this.load(diaryDate(now)) ?? emptyDay(diaryDate(now));
  }

  /** 每拍记账：累计在电脑前的时间与前台应用；过了凌晨 4 点就把前一天存盘、换新的一天 */
  tick(now: number, snap: ActivitySnapshot | null): void {
    const date = diaryDate(now);
    if (date !== this.day.date) {
      this.save(now);
      this.day = this.load(date) ?? emptyDay(date);
    }
    // 采样间隔被系统睡眠拉长时不把整段睡眠算进在电脑前的时间
    const dt = this.lastTick === null ? 0 : Math.min(Math.max(0, now - this.lastTick), MIN);
    this.lastTick = now;
    if (snap?.present) {
      if (this.day.firstSeenAt === null) this.day.firstSeenAt = now;
      this.day.lastSeenAt = now;
      this.day.presentMs += dt;
      if (snap.frontApp) this.day.apps[snap.frontApp] = (this.day.apps[snap.frontApp] ?? 0) + dt;
    }
    if (now - this.savedAt >= SAVE_EVERY_MS) this.save(now);
  }

  /** 记一件事（text 是给模型看的一句话） */
  note(now: number, kind: DiaryEventKind, text: string): void {
    if (this.day.events.length >= MAX_EVENTS) return;
    this.day.events.push({ at: now, kind, text });
    this.save(now);
  }

  /** 退出前存盘 */
  flush(now: number): void {
    this.save(now);
  }

  /** 今天最近记下的几件事（对话的生活上下文；按时间正序，最多 limit 条） */
  recentEvents(now: number, limit = 3): string[] {
    const date = diaryDate(now);
    const day = date === this.day.date ? this.day : this.load(date);
    if (!day) return [];
    return day.events.slice(-Math.max(0, Math.floor(limit))).map((event) => event.text);
  }

  /**
   * 最近一篇已写好的日记（不含今天）截断成一行，给对话当长期记忆。
   * 只取历史日记正文，不读今天尚未写好的记录；没有日记时返回空串。
   */
  lastDiaryLine(now: number, maxChars = 100): string {
    const today = diaryDate(now);
    const latest = this.dates()
      .filter((date) => date < today)
      .pop();
    if (!latest) return '';
    const day = this.load(latest);
    const text = day?.diary?.text.trim();
    if (!text) return '';
    const clipped = text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
    return `${dateLabel(latest)}：${clipped}`;
  }

  /** 该补写日记的那一天：今天之前最近的一份记账，在电脑前够久，还没写过或只写了半天；没有则 null */
  pending(now: number): string | null {
    const today = diaryDate(now);
    const latest = this.dates()
      .filter((date) => date < today)
      .pop();
    if (!latest) return null;
    const day = this.load(latest);
    if (!day || day.presentMs < MIN_PRESENT_MS) return null;
    return day.diary && day.diary.writtenAt >= dayEnd(latest) ? null : latest;
  }

  /** 让模型写日记的指令；这一天没记账或在电脑前太短时为 null */
  instruction(date: string): string | null {
    const day = this.dayOf(date);
    return day && day.presentMs >= MIN_PRESENT_MS ? diaryInstruction(day) : null;
  }

  /** 存下这一天的日记并重新生成日记本页面 */
  write(date: string, text: string, now: number): void {
    const day = this.dayOf(date);
    if (!day) throw new Error(`${date} 没有记账，写不了日记`);
    day.diary = { text, writtenAt: now };
    this.saveDay(day);
    if (day === this.day) this.savedAt = now;
    const days = this.dates()
      .map((d) => this.dayOf(d))
      .filter((d): d is DiaryDay => d !== null);
    writeAtomic(this.indexPath(), renderDiaryIndex(days));
  }

  /** 日记本页面（写过至少一篇日记后才存在） */
  indexPath(): string {
    return join(this.dir, 'index.html');
  }

  hasIndex(): boolean {
    return existsSync(this.indexPath());
  }

  private dayOf(date: string): DiaryDay | null {
    return date === this.day.date ? this.day : this.load(date);
  }

  private dates(): string[] {
    return readdirSync(this.dir)
      .filter((name) => DAY_FILE.test(name))
      .map((name) => name.slice(0, 10))
      .sort();
  }

  private load(date: string): DiaryDay | null {
    const path = join(this.dir, `${date}.json`);
    if (!existsSync(path)) return null;
    try {
      return daySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      this.warn(`日记文件读不了，这一天重新记：${path}（${error instanceof Error ? error.message : String(error)}）`);
      return null;
    }
  }

  private save(now: number): void {
    this.saveDay(this.day);
    this.savedAt = now;
  }

  private saveDay(day: DiaryDay): void {
    writeAtomic(join(this.dir, `${day.date}.json`), JSON.stringify(day, null, 2) + '\n');
  }
}

/** 写日记的指令：这一天的账 + 写法要求 */
export function diaryInstruction(day: DiaryDay): string {
  const lines: string[] = [];
  if (day.firstSeenAt !== null && day.lastSeenAt !== null) {
    lines.push(
      `主人 ${clock(day.firstSeenAt)} 第一次坐到电脑前，最后一次在电脑前是 ${clock(day.lastSeenAt)}，` +
        `一共在电脑前 ${durationText(day.presentMs)}。`,
    );
  }
  const apps = Object.entries(day.apps)
    .filter(([, ms]) => ms >= MIN)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (apps.length > 0) {
    lines.push(`用得最多的应用：${apps.map(([name, ms]) => `${name}（${durationText(ms)}）`).join('、')}。`);
  }
  const screens = day.events.filter((event) => event.kind === 'screen');
  const keep = new Set(evenly(screens, MAX_SCREEN_LINES));
  for (const event of day.events) {
    if (event.kind !== 'screen' || keep.has(event)) lines.push(`${clock(event.at)} ${event.text}`);
  }
  return (
    `下面是你在${dateLabel(day.date)}陪着主人时记下的事：\n${lines.map((line) => `- ${line}`).join('\n')}\n\n` +
    '以你自己的口吻写一篇这一天的日记：主人这一天忙了些什么、你看到的好玩的事、你的心情。' +
    '150 到 300 字，分两三段；称呼主人只用「主人」或「你」，不用「他」「她」；' +
    '不要标题、不要列清单、不加引号，不提你是 AI；只写上面记下的事，不要编造具体的事情。'
  );
}

/** 日记本页面：写过日记的日子，新的在上面 */
export function renderDiaryIndex(days: DiaryDay[]): string {
  const articles = days
    .filter((day) => day.diary)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((day) => {
      const paragraphs = day
        .diary!.text.split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('');
      return `<article><h2>${escapeHtml(dateLabel(day.date))}</h2>${paragraphs}<p class="facts">${escapeHtml(facts(day))}</p></article>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>宠物日记</title><style>
:root{color-scheme:light dark;--ink:#203b4b;--muted:#526a78;--paper:#fff;--water:#edf5fa;--line:#cbdce5}
@media(prefers-color-scheme:dark){:root{--ink:#dce8ef;--muted:#9fb3bf;--paper:#16232b;--water:#0e171d;--line:#2b3d48}}
body{margin:0;background:var(--water);color:var(--ink);font:16px/1.8 "PingFang SC","Microsoft YaHei UI",sans-serif}
main{max-width:680px;margin:40px auto;padding:0 16px 40px}h1{font-size:28px;margin:0 0 24px}
article{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:20px 24px;margin-bottom:20px}
h2{font-size:17px;margin:0 0 10px}p{margin:0 0 10px}.facts{font-size:13px;color:var(--muted);margin:14px 0 0}
</style></head><body><main><h1>宠物日记</h1>
${articles}
</main></body></html>
`;
}

/** 日记下面那行小字：在电脑前多久、番茄钟几个（只有去掉番茄钟之前的日子有）、Claude 干完几次活 */
function facts(day: DiaryDay): string {
  const count = (kind: DiaryEventKind) => day.events.filter((event) => event.kind === kind).length;
  const parts = [`在电脑前 ${durationText(day.presentMs)}`];
  if (count('pomodoro') > 0) parts.push(`番茄钟 ${count('pomodoro')} 个`);
  if (count('claude') > 0) parts.push(`Claude 干完 ${count('claude')} 次活`);
  return parts.join(' · ');
}

function emptyDay(date: string): DiaryDay {
  return { date, firstSeenAt: null, lastSeenAt: null, presentMs: 0, apps: {}, events: [] };
}

/** 均匀挑至多 count 个（保持原顺序） */
function evenly<T>(list: T[], count: number): T[] {
  if (list.length <= count) return list;
  return Array.from({ length: count }, (_, i) => list[Math.floor((i * list.length) / count)]);
}

/** 先写临时文件再改名：不会留下写了一半的文件 */
function writeAtomic(path: string, content: string): void {
  writeFileSync(`${path}.tmp`, content, 'utf8');
  renameSync(`${path}.tmp`, path);
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
