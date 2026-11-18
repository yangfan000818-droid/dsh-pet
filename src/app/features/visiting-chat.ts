import { notesAllowed } from '../neighbors';
import { findSnack } from '../snacks';
import type { Snack } from '../snacks';
import {
  findPlayThing,
  GUEST_ANSWERS,
  GUEST_ASK,
  guestPrompt,
  HOST_ASK,
  HOST_OPENERS,
  hostPrompt,
  MEMORY_HINT,
  NUDGE_GAP_MS,
  openerGap,
  QUIET_MS,
  talkGap,
  tripRounds,
} from '../visit-talk';
import type { PlayThing } from '../visit-talk';
import { AWAY_OPACITY, RELAY_OPACITY, fadeHome } from '../visit-windows';
import { cleanText, LINE_MAX, SPAR_LIVE_MODE, tripRequest } from '../visit';
import type { HostEvent, TripReply } from '../visit';
import { lazyFns } from './context';
import type { FeatureContext, HomeReason, Hosting, Trip } from './context';
import { errorText } from './util';

/** 做客时转播回自家的气泡显示多久（窗口同时调亮这么久） */
const RELAY_MS = 8_000;
/** 转播的气泡每条至少显示这么久才换下一条：对方回话快时，自己说的那句也看得清 */
const RELAY_MIN_MS = 4_000;
/** 捎到的话转播回自家显示多久 */
const NOTE_RELAY_MS = 15_000;

/** 串门的聊天与转播：主人家起话题、摸一下 / 一起玩 / 请吃零食、做客时聊天与报平安 */
export interface VisitingChat {
  openTopic(current: Hosting): Promise<void>;
  pokeGuest(current: Hosting): void;
  playTogether(thing: PlayThing): Promise<void>;
  treatGuest(snack: Snack): void;
  talk(current: Trip): Promise<void>;
  pingTrip(current: Trip): Promise<void>;
  relay(text: string, durationMs?: number, holdMs?: number): void;
  showRelay(text: string, durationMs: number): void;
}

export function createVisitingChat(ctx: FeatureContext): VisitingChat {
  const { comeHome, compose, petRequest, say, startGuestSpar, visitLine, notesOn } = lazyFns(ctx);
  const { deps, log, electron, diary, pouch, neighbors } = ctx;

  /** 主人家起个新话题：自家宠物说出来，攒着等客人报平安时捎过去，客人那边会回一句 */
  async function openTopic(current: Hosting): Promise<void> {
    current.openerTimer = null;
    if (ctx.state.hosting !== current || !deps.appConfig().visit.chat) return;
    const quiet = Date.now() - current.lastLineAt;
    if (quiet < QUIET_MS) {
      current.openerTimer = setTimeout(() => void openTopic(current), QUIET_MS - quiet);
      return;
    }
    current.openers += 1;
    const { owner, pet } = current.visitor;
    const memory = current.memory;
    // 生成不了就不起话题（没有兜底句：固定的开场白聊不下去）；头一回起话题时提醒可以提上次聊的
    const ask = current.openers === 1 && memory ? `${HOST_ASK.opener}${MEMORY_HINT}` : HOST_ASK.opener;
    const text = cleanText(await compose(hostPrompt(owner, pet, current.lines, ask, memory), ''), LINE_MAX);
    if (ctx.state.hosting !== current || !text) return;
    current.lines.push(`你：${text}`);
    current.lastLineAt = Date.now();
    ctx.state.visitHost?.tell({ type: 'line', text });
    // 正在演一场（切磋）时起话题：不联动说话动画（带 anim 的气泡会顶掉演出的动画）
    await say(text, ctx.state.battle || ctx.state.liveBattle ? { anim: false } : undefined);
    if (ctx.state.hosting === current && current.openers < HOST_OPENERS) {
      current.openerTimer = setTimeout(() => void openTopic(current), openerGap(false));
    }
  }

  /** 主人摸了客人一下（客人窗口里它自己先笑了）：隔一会儿才捎一次，客人家那边回句话 */
  function pokeGuest(current: Hosting): void {
    if (ctx.state.hosting !== current || Date.now() - current.lastNudgeAt < NUDGE_GAP_MS) return;
    current.lastNudgeAt = Date.now();
    current.lines.push(`（主人摸了摸 ${current.visitor.pet}）`);
    ctx.state.visitHost?.tell({ type: 'poke' });
  }

  /** 和客人一起玩：两只宠物同时播同一段动画（自家宠物转身面朝客人），客人家那边说一句 */
  async function playTogether(thing: PlayThing): Promise<void> {
    const current = ctx.state.hosting;
    // 正在演一场（切磋）：一起玩的动画会把演出的动画顶掉，先不玩
    if (!current || ctx.state.battle || ctx.state.liveBattle) return;
    current.window.play(thing.anim);
    current.lines.push(`（一起${thing.label}）`);
    if (Date.now() - current.lastNudgeAt >= NUDGE_GAP_MS) {
      current.lastNudgeAt = Date.now();
      ctx.state.visitHost?.tell({ type: 'play', what: thing.label });
    }
    try {
      // 客人站左边就朝左（素材原样朝左），站右边朝右
      const result = await petRequest('POST', '/anim', { name: thing.anim, facing: current.window.side });
      if (result.ok !== true) log(`串门：一起玩没播成：${JSON.stringify(result)}`);
    } catch (error) {
      log(`串门：一起玩没播成：${errorText(error)}`);
    }
  }

  /** 请客人吃零食：从零食袋里拿一份，客人窗口吃起来，客人家那边说一句、记进它的日记 */
  function treatGuest(snack: Snack): void {
    const current = ctx.state.hosting;
    // 正在演一场（切磋）：吃东西的动画会把演出的动画顶掉，先不吃
    if (!current || ctx.state.battle || ctx.state.liveBattle || !pouch.take(snack.label)) return;
    const { owner, pet } = current.visitor;
    current.window.play(snack.anim);
    current.lines.push(`（请 ${pet} 吃了${snack.label}）`);
    ctx.state.visitHost?.tell({ type: 'gift', what: snack.label });
    diary.note(Date.now(), 'visit', `请 ${owner} 家的 ${pet} 吃了${snack.label}`);
  }

  async function talk(current: Trip): Promise<void> {
    current.talkTimer = null;
    if (ctx.state.trip !== current) return;
    const quiet = Date.now() - current.lastLineAt;
    if (current.rounds > 0 && quiet < QUIET_MS) {
      current.talkTimer = setTimeout(() => void talk(current), QUIET_MS - quiet);
      return;
    }
    const first = current.rounds === 0;
    current.rounds += 1;
    // 头一句打招呼时有上次见面的备忘，就提醒可以提一句
    const greet = first && current.memory;
    await chatTrip(
      current,
      first ? (greet ? `${GUEST_ASK.greet}${MEMORY_HINT}` : GUEST_ASK.greet) : GUEST_ASK.follow,
      first ? `${current.host.pet}，我来串门啦～` : '你家真舒服呀～',
    );
    // 不用模型聊天时只打个招呼
    const { chat, stayMin } = deps.appConfig().visit;
    if (ctx.state.trip === current && current.rounds < (chat ? tripRounds(stayMin) : 1)) {
      current.talkTimer = setTimeout(() => void talk(current), talkGap());
    }
  }

  /**
   * 主人家可能在自家切磋还没播完时请回客人：先记下，等这边收场再回家。
   */
  async function requestHome(current: Trip, reason: HomeReason): Promise<void> {
    if (
      reason === 'sent-home' &&
      (ctx.state.battle !== null || ctx.state.liveBattle !== null || ctx.state.spar?.stage === 'showing')
    ) {
      current.pendingHome = 'sent-home';
      return;
    }
    await comeHome(reason);
  }

  /** 做客时说一句（按趟串行）：生成、转播回自家、说给对方听，记下对方的回话 */
  function chatTrip(current: Trip, ask: string, fallback: string): Promise<void> {
    const next = current.queue.then(async () => {
      if (ctx.state.trip !== current) return;
      const { owner, pet } = current.host;
      const text = cleanText(
        await visitLine(guestPrompt(owner, pet, current.lines, ask, current.memory), fallback),
        LINE_MAX,
      );
      if (ctx.state.trip !== current) return;
      current.lastLineAt = Date.now();
      relay(`（在 ${owner} 家）${text}`);
      let result: TripReply | null = null;
      try {
        result = await tripRequest(current.host, '/v1/chat', { token: current.token, text });
      } catch (error) {
        // 没送到：不算失联（报平安那条负责判断），下一句照常
        log(`串门：说话没送到：${errorText(error)}`);
      }
      if (ctx.state.trip !== current || !result) return;
      if (!result.ok) {
        const reason = result.reason === 'sent-home' ? 'sent-home' : 'lost';
        await requestHome(current, reason);
        return;
      }
      current.lines.push(`你：${text}`, `${pet}：${result.reply || '……'}`);
      current.lastLineAt = Date.now();
      if (result.reply) relay(`${pet}：${result.reply}`);
    });
    current.queue = next.catch(() => undefined);
    return next;
  }

  /** 主人家捎来的事：它家宠物起的话题记下、转播；话题、摸一下、一起玩、请吃零食都回一句（一趟最多回 GUEST_ANSWERS 次） */
  function onHostEvent(current: Trip, event: HostEvent): void {
    const { owner, pet } = current.host;
    let ask: string;
    if (event.type === 'line') {
      current.lines.push(`${pet}：${event.text}`);
      current.lastLineAt = Date.now();
      relay(`${pet}：${event.text}`);
      ask = GUEST_ASK.answer;
    } else if (event.type === 'note') {
      // 主人家托自家宠物带回给它主人的话：只转播给主人看，不回话、不进提示词。
      // 收的条件和发的一样（notesAllowed）：没验上主人家的身份、不是熟人、关了捎话，都直接丢
      if (!notesAllowed(neighbors, current.host.id, current.verified, notesOn())) {
        log(`串门：${owner} 家捎来的话没认上，丢了`);
        return;
      }
      relay(`（${owner} 托我带回来的话）${event.text}`, NOTE_RELAY_MS, NOTE_RELAY_MS);
      diary.note(Date.now(), 'visit', `${owner} 托我带回一句话`);
      return;
    } else if (event.type === 'play') {
      // 只认自己也有的项目：对方捎来的名字不进提示词
      const thing = findPlayThing(event.what);
      if (!thing) return;
      current.lines.push(`（一起${thing.label}）`);
      relay(`（在 ${owner} 家和 ${pet} 一起${thing.label}）`);
      ask = GUEST_ASK.play(thing.label);
    } else if (event.type === 'gift') {
      const snack = findSnack(event.what);
      if (!snack) return;
      current.lines.push(`（${pet} 请你吃了${snack.label}）`);
      current.treats.push(snack.label);
      relay(`（在 ${owner} 家吃到了${snack.label}）`);
      ask = GUEST_ASK.treat(snack.label);
    } else if (event.type === 'spar-invite') {
      // 主人家邀战（X5）：和修炼无关，客人直接应战（没开修炼也能打）；
      // 逐手局（X19）带 SPAR_LIVE_MODE，客人应战后在自己的出招面板里选自家方式；旧主人家邀的全自动局不弹面板
      void startGuestSpar({ live: event.mode === SPAR_LIVE_MODE });
      return;
    } else {
      ask = GUEST_ASK.poke;
    }
    if (!deps.appConfig().visit.chat || current.answers >= GUEST_ANSWERS) return;
    current.answers += 1;
    void chatTrip(current, ask, '嘿嘿～');
  }

  /**
   * 做客时把聊天转播回自家：自家宠物冒气泡（不走 say：say 会先叫它回家），这几秒窗口调亮看得清。
   * 一条接一条排着放，每条至少显示 holdMs 才许被下一条顶掉（聊天是 RELAY_MIN_MS；
   * 捎到的话要显示满自己的时长）；排到时已经回家了就不放。
   * @param durationMs 气泡显示多久（捎到的话比聊天久，默认 RELAY_MS）
   */
  function relay(text: string, durationMs = RELAY_MS, holdMs = RELAY_MIN_MS): void {
    const now = Date.now();
    const wait = Math.max(0, ctx.state.relayFreeAt - now);
    ctx.state.relayFreeAt = now + wait + holdMs;
    setTimeout(() => {
      if (ctx.state.trip) showRelay(text, durationMs);
    }, wait);
  }

  function showRelay(text: string, durationMs: number): void {
    // 切磋演出期间（battle 在跑、人在别人家）转播的台词只出气泡，不改亮度：
    // 开演时 fadeHome(1)，收摊后由 startGuestSpar 退回 AWAY_OPACITY
    if (!(ctx.state.trip !== null && (ctx.state.battle !== null || ctx.state.liveBattle !== null))) {
      fadeHome(electron, RELAY_OPACITY);
      if (ctx.state.relayTimer !== null) clearTimeout(ctx.state.relayTimer);
      ctx.state.relayTimer = setTimeout(() => {
        ctx.state.relayTimer = null;
        if (ctx.state.trip) fadeHome(electron, AWAY_OPACITY);
      }, durationMs);
    }
    void petRequest('POST', '/broadcast', { text, anim: false, duration: durationMs })
      .then((result) => {
        if (result.ok !== true) log(`串门：转播没显示出来：${JSON.stringify(result)}`);
      })
      .catch((error: unknown) => log(`串门：转播没显示出来：${errorText(error)}`));
  }

  /** 每 PING_MS 报一次平安，顺便看到点没有 */
  async function pingTrip(current: Trip): Promise<void> {
    if (ctx.state.trip !== current || current.pinging) return;
    if (Date.now() - current.since >= deps.appConfig().visit.stayMin * 60_000) {
      await comeHome('time-up');
      return;
    }
    current.pinging = true;
    try {
      const result = await tripRequest(current.host, '/v1/ping', { token: current.token });
      if (ctx.state.trip !== current) return;
      if (!result.ok) {
        const reason = result.reason === 'sent-home' ? 'sent-home' : 'lost';
        await requestHome(current, reason);
        return;
      }
      current.failures = 0;
      for (const event of result.events) onHostEvent(current, event);
    } catch (error) {
      current.failures += 1;
      if (current.failures >= 3 && ctx.state.trip === current) {
        log(`串门：和 ${current.host.owner} 家连不上了：${errorText(error)}`);
        await comeHome('lost');
      }
    } finally {
      current.pinging = false;
    }
  }
  return { openTopic, pokeGuest, playTogether, treatGuest, talk, pingTrip, relay, showRelay };
}
