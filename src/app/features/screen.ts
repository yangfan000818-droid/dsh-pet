import { findPetInstance, readAllConfig } from '../../host/config';
import { isUnsupportedImageError } from '../../standalone/ai-provider';
import { screenUnion } from '../battle-dash';
import { moveTargetOf, parseMoveAnswer } from '../move-target';
import type { MoveKind } from '../move-target';
import type { Rect } from '../../shared/types';
import type { FeatureContext } from './context';
import { lazyFns } from './context';
import { LINE_RULE } from './speech';
import { errorText } from './util';

/** 看屏幕日记的最小间隔：自动看屏幕改成秒级后，别一小时内就把一天 200 条日记挤满 */
const SCREEN_DIARY_GAP_MS = 3 * 60_000;
const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** 表情包池里的一张（插件 GET /memes 的条目） */
interface Meme {
  name: string;
  desc: string;
}

/** 看屏幕 */
export interface Screen {
  lookAtScreen(manual: boolean): Promise<{ ok: boolean; text?: string; image?: string; reason?: string }>;
  /** AI 看屏幕挑个位置并飞/走/瞬移过去，用调用方指定的移动动作。AI 不可用、看不了、没位置信息或解析失败 → false（调用方自行兜底） */
  moveWithAi(kind: MoveKind, name: string): Promise<boolean>;
}

export function createScreen(ctx: FeatureContext): Screen {
  const { collect, petId, petRequest, say, systemPrompt } = lazyFns(ctx);
  const { deps, log, electron, ai, diary, homePet } = ctx;
  /** 看屏幕配图用的表情包池：与碎碎念同一个开关（whisperImageEnabled）、同一个池（插件的 GET /memes）；没开 / 取不到 → 空 */
  async function memePool(): Promise<Meme[]> {
    try {
      const found = findPetInstance(readAllConfig(deps.configPaths), petId());
      if (found?.conf.whisperImageEnabled !== true) return [];
      const result = await petRequest('GET', '/memes');
      if (result.ok !== true || !Array.isArray(result.memes)) {
        log(`取表情包失败：${JSON.stringify(result)}`);
        return [];
      }
      return result.memes as Meme[];
    } catch (error) {
      log(`取表情包失败：${errorText(error)}`);
      return [];
    }
  }

  /** 让模型按这句话从池里挑最搭的一张；它说都不搭、答的不在池里或调用失败 → null */
  async function chooseMeme(text: string, pool: Meme[]): Promise<Meme | null> {
    if (!ai.isReady()) return null;
    try {
      const list = pool.map((meme) => `${meme.name}：${meme.desc}`).join('\n');
      const answer = await collect(
        ai.stream({
          provider: ai.currentSelection().provider,
          model: ai.currentSelection().model,
          system: '你在给一句话挑一张配图的表情包。只回答表情包的名称，不加任何别的字；都不搭就回答：无',
          messages: [
            { role: 'user', content: [{ type: 'text', text: `这句话：${text}\n\n表情包（名称：描述）：\n${list}` }] },
          ],
        }),
      );
      // 模型常会带上引号 / 句号或多说几个字：精确命中优先，否则取答案里出现的最长名称（防「大的要来啦」误中短名）
      const exact = pool.find((meme) => meme.name === answer.replace(/[「」『』"'“”‘’。.\s]/g, ''));
      if (exact) return exact;
      const hits = pool.filter((meme) => answer.includes(meme.name)).sort((a, b) => b.name.length - a.name.length);
      return hits[0] ?? null;
    } catch (error) {
      log(`挑表情包失败：${errorText(error)}`);
      return null;
    }
  }

  /**
   * 给看屏幕说的话配图：先按话挑最搭的一张，挑不出就随机一张；池为空（含没开配图）不配。
   * 话先说、图后配：试过先抽图再把图的描述写进看屏幕指令，本机小模型会顺着表情包名字发挥
   * （「大的要来啦」→「大事要来啦，主人快躲开」），看屏幕就成了看表情包。
   */
  async function memeFor(text: string): Promise<Meme | null> {
    const pool = await memePool();
    if (pool.length === 0) return null;
    const chosen = await chooseMeme(text, pool);
    const meme = chosen ?? pool[Math.floor(Math.random() * pool.length)];
    log(`看屏幕配图：${meme.name}（${chosen ? '按话挑' : '随机'}）`);
    return meme;
  }

  /** 降级成原来的碎碎念：调插件的 /whisper（按人设 + 时间 + 主人此刻生成一句，不截图） */
  async function whisperFallback(): Promise<{ ok: boolean; text?: string; image?: string; reason?: string }> {
    try {
      const result = await petRequest('POST', '/whisper');
      if (result.ok === true && typeof result.text === 'string') {
        return { ok: true, text: result.text, ...(typeof result.image === 'string' ? { image: result.image } : {}) };
      }
      log(`碎碎念降级失败：${JSON.stringify(result)}`);
      return { ok: false, reason: typeof result.reason === 'string' ? result.reason : 'whisper-failed' };
    } catch (error) {
      log(`碎碎念降级失败：${errorText(error)}`);
      return { ok: false, reason: 'error' };
    }
  }

  /** 读当前宠物的配置（固定 / 锁定屏幕）；读不到就当没有这些开关 */
  function petConf(): Record<string, unknown> | null {
    try {
      return findPetInstance(readAllConfig(deps.configPaths), petId())?.conf ?? null;
    } catch (error) {
      log(`读配置失败（按未固定处理）：${errorText(error)}`);
      return null;
    }
  }

  /**
   * 让模型按截图挑九宫格位置。菜单点播时模式固定（飞/走）；看屏幕后自动移动用 auto，
   * 让模型自己说「飞N / 走N」，没说方式时按距离决定。
   */
  function movePrompt(kind: MoveKind | 'auto'): string {
    const grid = '九宫格编号：1=左上，2=上，3=右上，4=左，5=中间，6=右，7=左下，8=下，9=右下。';
    const intro = '这是主人此刻的电脑屏幕截图（画面里那个小女仆就是你自己，别管她）。';
    if (kind === 'fly') {
      return `${intro}看看主人在做什么，挑一个你想飞过去看看的位置。${grid}只回答一个数字（1–9），不要回答别的字。`;
    }
    if (kind === 'walk') {
      return `${intro}看看主人在做什么，挑一个你想走过去看看的位置。${grid}只回答一个数字（1–9），不要回答别的字。`;
    }
    return `${intro}看看主人在做什么，挑一个你感兴趣、想过去看看的位置，并决定飞过去还是走过去（远就飞，近就走）。${grid}只回答两个字：飞N 或 走N（N 是 1–9），不要回答别的字。`;
  }

  /**
   * 用一张已经截好的屏幕图让 AI 选位置，并真的发 /anim（带 target）。
   * 独立于看屏幕的吐槽调用：同一个 prompt 里同时要台词和坐标会让小模型把两件事说串。
   * @param respectFixed 宠物固定时不动（看屏幕后自动移动用；菜单点播是主人明确要它走，照走）
   * @param name 菜单指定的移动动作；不传时按目标远近在「飞来飞去 / 螃蟹走路」里二选一
   */
  async function askMoveTarget(
    image: string,
    area: Rect,
    kind: MoveKind | 'auto',
    respectFixed: boolean,
    name?: string,
  ): Promise<boolean> {
    const box = homePet.box();
    if (!box) return false;
    const conf = petConf();
    if (respectFixed && conf?.fixedEnabled === true) return false;
    // 锁在当前屏幕时把九宫格落到宠物自己那块屏上：看屏幕看的是鼠标那块屏，
    // 但 /anim target 会被渲染端的锁定挡在屏缝外，落到别的屏上只会原地播动作。
    const current = { x: box.left + box.size / 2, y: box.top + (box.size * 9) / 32 };
    const moveArea = conf?.confineToScreen === true ? electron.screen.getDisplayNearestPoint(current).workArea : area;
    let answer: string;
    try {
      answer = await collect(
        ai.streamVision({
          system: '你只按用户要求回答，不加解释。',
          prompt: movePrompt(kind),
          image,
        }),
      );
    } catch (error) {
      log(`AI 选位置失败：${errorText(error)}`);
      return false;
    }
    const pick = parseMoveAnswer(answer, kind);
    if (!pick) {
      log(`AI 选位置没听懂（回答不是九宫格编号）`);
      return false;
    }
    const union = screenUnion(electron.screen);
    if (!union) return false;
    const target = moveTargetOf({
      cell: pick.cell,
      kind: pick.kind,
      area: moveArea,
      union,
      size: box.size,
      current,
    });
    if (!target) return false;
    const animName = name ?? (target.kind === 'fly' ? '飞来飞去' : '螃蟹走路');
    try {
      const result = await petRequest('POST', '/anim', { name: animName, target: { x: target.x, y: target.y } });
      if (result.ok !== true) {
        log(`AI 选好位置但点播失败（${animName}）：${JSON.stringify(result)}`);
        return false;
      }
    } catch (error) {
      log(`AI 选好位置但点播失败（${animName}）：${errorText(error)}`);
      return false;
    }
    return true;
  }

  /** 菜单点播「动一动」（按移动池随机）：AI 看屏幕并过去；没接 AI / 看不了 → false，调用方退回随机移动 */
  async function moveWithAi(kind: MoveKind, name: string): Promise<boolean> {
    if (!ai.isReady() || !ai.canSeeScreen()) return false;
    // 菜单点播不主动弹系统授权框：没授权就退回原来的随机移动
    if (electron.systemPreferences.getMediaAccessStatus('screen') !== 'granted') return false;
    const box = homePet.box();
    if (!box) return false;
    // 锁在当前屏幕时看宠物所在那块屏，否则看鼠标所在的那块（与「看看我在干嘛」同一块）
    const confine = petConf()?.confineToScreen === true;
    const point = confine
      ? { x: box.left + box.size / 2, y: box.top + (box.size * 9) / 32 }
      : electron.screen.getCursorScreenPoint();
    const display = electron.screen.getDisplayNearestPoint(point);
    const sources = await electron.desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 1280 } })
      .catch((error: unknown) => {
        log(`截图失败（AI 选位置）：${errorText(error)}`);
        return [];
      });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) return false;
    const image = 'data:image/jpeg;base64,' + source.thumbnail.toJPEG(70).toString('base64');
    return askMoveTarget(image, display.workArea, kind, false, name);
  }

  async function lookAtScreen(
    manual: boolean,
  ): Promise<{ ok: boolean; text?: string; image?: string; reason?: string }> {
    if (ctx.state.screenBusy) return { ok: false, reason: 'busy' };
    ctx.state.screenBusy = true;
    try {
      // 模型没配好：自动触发安静跳过；手动触发提示去配（不降级成碎碎念——碎碎念同样要模型）
      if (!ai.isReady()) {
        if (manual) await say('先在 AI 设置里把模型配好，我才能看屏幕哦～');
        return { ok: false, reason: 'not-ready' };
      }
      // 记住「当前这套设置不支持看图」：之后到点不再发视觉请求，直接降级成碎碎念
      if (!ai.canSeeScreen()) return await whisperFallback();
      // 自动触发不主动弹系统授权框：没授权就降级成碎碎念；手动触发才去调 getSources（首次会弹授权）
      if (!manual && electron.systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        return await whisperFallback();
      }
      // 没授权时 getSources 直接抛「Failed to get sources.」（不是返回空列表），按没授权处理；
      // 授权了还失败才算真错误，交给下面的 catch
      const sources = await electron.desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 1280 } })
        .catch((error: unknown) => {
          if (electron.systemPreferences.getMediaAccessStatus('screen') === 'granted') throw error;
          return [];
        });
      if (electron.systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        if (!manual) return await whisperFallback();
        await say('先在系统设置里给我开「屏幕录制」权限，再重开我哦～');
        void electron.shell.openExternal(SCREEN_SETTINGS_URL);
        return { ok: false, reason: 'no-permission' };
      }
      // 看鼠标所在的那块屏幕
      const display = electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint());
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      if (!source || source.thumbnail.isEmpty()) return { ok: false, reason: 'capture-failed' };
      const image = 'data:image/jpeg;base64,' + source.thumbnail.toJPEG(70).toString('base64');
      const text = await collect(
        ai.streamVision({
          system: systemPrompt(),
          prompt:
            '这是主人此刻的电脑屏幕截图（画面里那个小女仆就是你自己，别管她）。看看主人在做什么，随口吐槽或关心一句。' +
            '不要复述屏幕上的具体文字、聊天内容、人名、账号或数字，不要描述截图本身。' +
            LINE_RULE,
          image,
        }),
      );
      if (!text) return { ok: false, reason: 'empty' };
      const meme = await memeFor(text);
      // 插件拒绝说话（生成失败等）：如实报失败，别让调用方以为说出来了
      // 正在演一场（心魔）时也不联动说话动画：手动看屏幕照样能看，只是别顶掉演出的动画
      if (
        !(await say(text, {
          image: meme?.name,
          ...(ctx.state.battle || ctx.state.liveBattle || ctx.state.actionPanel ? { anim: false } : {}),
        }))
      )
        return { ok: false, text, reason: 'say-failed' };
      const now = Date.now();
      if (now - ctx.state.lastScreenDiaryAt >= SCREEN_DIARY_GAP_MS) {
        diary.note(now, 'screen', `看了一眼主人的屏幕，说：「${text}」`);
        ctx.state.lastScreenDiaryAt = now;
      }
      // 看完屏幕顺手按内容挪个位置：固定宠物 / 演出中不动；选位置失败不影响这次看屏幕
      if (!ctx.state.battle && !ctx.state.liveBattle && !ctx.state.actionPanel) {
        await askMoveTarget(image, display.workArea, 'auto', true);
      }
      return { ok: true, text, ...(meme ? { image: meme.name } : {}) };
    } catch (error) {
      log(`看屏幕失败：${errorText(error)}`);
      // 识别出不支持看图的那一拍当场降级，别让这一拍空掉；401 / 429 / 超时 / 网络错误照旧
      if (isUnsupportedImageError(error)) return await whisperFallback();
      if (manual) await say('刚才没看清，等会儿再看～');
      return { ok: false, reason: 'error' };
    } finally {
      ctx.state.screenBusy = false;
      ctx.state.lastScreenAt = Date.now();
    }
  }
  return { lookAtScreen, moveWithAi };
}
