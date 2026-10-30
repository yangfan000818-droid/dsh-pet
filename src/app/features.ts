/**
 * 独立应用的扩展功能编排（只在 `src/app/main.ts` 里启动，DSH 内运行时不存在）。
 *
 * 纯逻辑都在旁边的模块里（activity / reminders / claude-hooks / status，各有单测）；这里只做接线：
 *   - 每 TICK_MS 采样一次：系统空闲秒数与锁屏（Electron powerMonitor）+ 前台应用（`lsappinfo`，无需授权）；
 *   - 根据采样推进久坐 / 喝水 / 下班提醒、回来打招呼、定时看屏幕；
 *   - 看屏幕是唯一的自动说话节拍：模型不支持看图或没授权屏幕录制时，降级成按人设随口说一句；
 *   - 把 Claude Code 与串门合成为一个外部工作状态（桌宠只有一个外部槽）；
 *   - 把一天里的事记进宠物日记（diary.ts），第二天回到电脑前时补写前一天的日记；
 *   - 修炼（cultivation.ts）：在电脑前就涨修为，久坐提醒后离开会「调息」，Claude 干完活偶尔炼出破境丹；
 *     升级冒泡、记日记，右键「修炼」看境界和进度，圆满时点「渡劫」：扛天雷（X4）——成功进下一个大境界、
 *     挂 10 分钟两项「领悟」二选一（没人挑就随机定一个），失败只扣修为（封顶 300，不设冷却）；有丹能先吃一颗；
 *     右键「心魔试炼」打一场：心魔是暗色的客人窗口（visit-windows.ts），两边按引擎事件依次出招、
 *     挨打、闪避（battle-show.ts 排时间线与执行器），头顶两条气血条（arena-window.ts），
 *     演完照结果拿奖励、说一句赛后感言；渡劫复用同一套演出，只是没有对手窗口；
 *   - 局域网串门（visit.ts 管网络、visit-windows.ts 管窗口、visit-talk.ts 管怎么聊）：设置里开了才发信标、开接待端口；
 *     出门时自家宠物变半透明、把别人家的聊天转播回来，客人来了在自家宠物旁边开个小窗（能摸、能一起玩）；
 *     两边接着前文聊、主人家也会起话题；串门的台词只按人设生成，不带「主人此刻」；
 *     串门进行中两边都能发起切磋（X5，visit.ts 的先承诺后揭示协议）：两边的屏幕上都演全套——主人家对客人窗口、
 *     客人对主人家的窗口（复用 X3 的演出执行器、擂台与特效层）；解说台词用同一对随机数排，动作、飞行物、
 *     气血两边一致；奖励与战绩各记各的；
 *     开着串门时，用餐时间宠物也分到一份零食（snacks.ts，晚上偶尔有宵夜），家里来客时请它吃；
 *     熟人之间还能捎话（note-window.ts 的小输入窗）：主人的话经宠物带给对方主人，原文不进提示词与日记；
 *   - 右键菜单根上注册「看看我在干嘛 / 宠物日记」与串门的项（「串门」子菜单列附近的邻居，
 *     有人敲门时的应答项、送客 / 回家项），并长轮询点击。
 *
 * 驱动桌宠一律走插件自己的 HTTP 路由（/broadcast、/work-status、/menu/*），与第三方调用者同一契约，
 * 不碰插件内部状态——以后合并上游时这里不受插件内部重构影响。
 *
 * 说话的文本由本机模型按人设生成（人设 + 时间 + 「主人此刻」），模型不可用时用固定兜底句；
 * 看屏幕看不了时明确说看不了（手动触发时）或安静跳过（自动触发、模型没配好时）；
 * 模型不支持看图、或自动触发时没授权屏幕录制，则改调插件的 /whisper，按人设随口说一句。
 *
 * R1 拆开以后：各块在 `features/` 下，这里只建共享上下文、把各块的函数挂上去，再返回 AppFeatures。
 */
import { ActivityTracker } from './activity';
import { ClaudeSessions } from './claude-hooks';
import type { ClaudeHookPayload } from './claude-hooks';
import { Diary } from './diary';
import { HealthReminders, OffWorkReminder } from './reminders';
import { SnackPouch } from './snacks';
import { NeighborBook } from './neighbors';
import { createNoteOpener } from './note-window';
import { loadVisitIdentity, resetVisitIdentity } from './visit-identity';
import { watchHomePet } from './visit-windows';
import { createAdventureGlue } from './features/adventure-glue';
import type { AppFeatures, FeatureContext, FeatureDeps, FeatureState, FeatureFunctions } from './features/context';
import { createDiaryGlue } from './features/diary-glue';
import { createDuel } from './features/duel';
import { createMenu, MENU_OWNER } from './features/menu';
import { createPetIo } from './features/pet-io';
import { createPractice } from './features/practice';
import { createScreen } from './features/screen';
import { createSpar, SPAR_WAIT_MS } from './features/spar';
import { createSpeech } from './features/speech';
import { createTicks } from './features/ticks';
import { createTrial } from './features/trial';
import { createVisiting } from './features/visiting';
import { createVisitingChat } from './features/visiting-chat';
import { createVisitingMenu } from './features/visiting-menu';
import { errorText } from './features/util';

export type { AppFeatures, FeatureDeps, FeatureElectron } from './features/context';
export { MENU_OWNER };

export function startAppFeatures(deps: FeatureDeps): AppFeatures {
  const { electron, ai, log } = deps;
  /** 切磋等客人应战 / 亮随机数的时限（§X5：30 秒没来按客人认输；测试里调短） */
  const sparWaitMs = deps.sparWaitMs ?? SPAR_WAIT_MS;
  const tracker = new ActivityTracker();
  const claude = new ClaudeSessions();
  const health = new HealthReminders(() => deps.appConfig());
  const offWork = new OffWorkReminder(() => deps.appConfig().offWork);
  const diary = new Diary(deps.diaryDir, Date.now(), log);
  const pouch = new SnackPouch(deps.snackPath, log);
  /** 邻居簿：只记验证过身份的（记录只存本机） */
  const neighbors = new NeighborBook(deps.neighborsPath, (message) => log(`串门：${message}`));
  const homePet = watchHomePet(electron);
  /** 捎话的小输入窗（同一时间只开一个） */
  const noteOpener = createNoteOpener(electron, `${new URL(deps.petBase).origin}/app/note`, () => homePet.box());
  /** 共享状态：闭包里原来那些会变的 let 全在这里，各块经 ctx.state 读写 */
  const state: FeatureState = {
    diaryCheckedFor: null,
    disposed: false,
    lastStatus: null,
    adventure: null,
    lastScreenAt: Date.now(),
    menuLabels: [],
    menuQueue: Promise.resolve(),
    tickTimer: null,
    speaking: Promise.resolve(),
    generating: false,
    screenBusy: false,
    lastSpokeAt: 0,
    lastScreenDiaryAt: 0,
    visitIdentity: loadVisitIdentity(deps.identityPath, (message) => log(`串门：${message}`)),
    neighborhood: null,
    visitHost: null,
    hostPort: 0,
    visitSwitching: false,
    visitBroken: false,
    knockingOn: null,
    trip: null,
    hosting: null,
    lastGuest: null,
    relayTimer: null,
    relayFreeAt: 0,
    showLock: null,
    showLockRelease: null,
    cultivation: null,
    battle: null,
    trialWindowGroups: new Set(),
    tribulationFx: null,
    liveBattle: null,
    forfeitNow: null,
    actionPanel: null,
    duelPrompt: null,
    adventureTurn: null,
    liveTurn: null,
    meditateAt: 0,
    spar: null,
    sparWindows: new Set(),
    duel: null,
    duelWait: null,
    duelAccepted: null,
  };
  const fns = {} as FeatureFunctions;
  const ctx: FeatureContext = {
    deps,
    log,
    electron,
    ai,
    tracker,
    claude,
    health,
    offWork,
    diary,
    pouch,
    neighbors,
    homePet,
    noteOpener,
    sparWaitMs,
    state,
    fns,
  };

  // 入口先把上下文建好，再把各块的函数挂上去；块与块之间经 ctx.fns 调，不互相 import
  Object.assign(fns, createPetIo(ctx));
  Object.assign(fns, createSpeech(ctx));
  Object.assign(fns, createScreen(ctx));
  Object.assign(fns, createTicks(ctx));
  Object.assign(fns, createDiaryGlue(ctx));
  Object.assign(fns, createPractice(ctx));
  Object.assign(fns, createAdventureGlue(ctx));
  Object.assign(fns, createTrial(ctx));
  Object.assign(fns, createSpar(ctx));
  Object.assign(fns, createDuel(ctx));
  Object.assign(fns, createVisiting(ctx));
  Object.assign(fns, createVisitingChat(ctx));
  Object.assign(fns, createVisitingMenu(ctx));
  Object.assign(fns, createMenu(ctx));

  void fns.refreshMenu(true).then(() => fns.pollMenu());
  void fns
    .tick()
    .catch((error: unknown) => log(`采样失败：${errorText(error)}`))
    .finally(fns.schedule);

  return {
    activityContext: fns.activityContext,
    activity: () => tracker.snapshot(),
    async handleClaudeHook(payload: ClaudeHookPayload) {
      const speech = claude.handle(payload, Date.now());
      await fns.refreshStatus(Date.now());
      if (speech?.kind === 'done') {
        diary.note(Date.now(), 'claude', `主人交给 Claude 的活（项目 ${speech.project}）干完了`);
        // 修炼：一轮活干完了（干满 30 秒才报「done」，口径在 claude-hooks），有机会炼成一颗破境丹
        const practice = fns.cultivationOn();
        if (practice) fns.onCultivation(Date.now(), practice.onClaudeDone(Date.now()));
        void fns.speak(
          `主人交给 Claude 的活（项目 ${speech.project}）刚刚干完了。叫主人去看看结果。`,
          `${speech.project} 那边干完活啦，去看看吧～`,
        );
      } else if (speech?.kind === 'permission') {
        void fns.speak(
          `Claude（项目 ${speech.project}）在等主人确认一个操作。提醒主人去确认。`,
          'Claude 在等你确认哦～',
        );
      }
    },
    say: fns.say,
    whisper: () => fns.petRequest('POST', '/whisper'),
    lookAtScreen: fns.lookAtScreen,
    neighbors: {
      identityId: () => state.visitIdentity.id,
      list: () => neighbors.list(),
      setFriend: (id, friend) => neighbors.setFriend(id, friend),
      forget: (id) => neighbors.forget(id),
      clear: () => neighbors.clear(),
      resetIdentity() {
        if (state.hosting || state.trip || state.knockingOn) return false;
        resetVisitIdentity(deps.identityPath);
        state.visitIdentity = loadVisitIdentity(deps.identityPath, (message) => log(`串门：${message}`));
        // 关掉信标和接待，下一拍 syncVisit 用新身份重开；别的电脑要重新认这台电脑了
        if (state.neighborhood) {
          state.neighborhood.stop();
          state.neighborhood = null;
          log('串门：信标关了（要换新身份重开）');
        }
        if (state.visitHost) void fns.closeHost();
        log('串门：换了新的串门身份');
        return true;
      },
    },
    cultivation: { view: () => state.cultivation?.view() ?? null },
    battle: {
      // 出招面板（心魔 / 切磋）与历练小窗里的手动出招（X18）共用一个本机接口
      choose: (pick) =>
        state.actionPanel?.choose(pick) ?? state.duelPrompt?.choose(pick) ?? state.adventureTurn?.choose(pick) ?? false,
      state: () => state.actionPanel?.state() ?? state.duelPrompt?.state() ?? state.adventureTurn?.state() ?? null,
    },
    dispose() {
      state.disposed = true;
      if (state.tickTimer !== null) clearTimeout(state.tickTimer);
      noteOpener.dispose();
      // 正在切磋：定时器、擂台、演出（或转播）都收掉
      fns.cancelSpar();
      // 正在演一场：停掉剩下的步骤、立刻收窗口（不留下空转的心魔与擂台）
      state.battle?.dispose();
      state.battle = null;
      // 逐手出招（X17）：等着的 AI / 手动选择作废，面板与窗口一起关
      state.liveBattle?.dispose();
      state.liveBattle = null;
      state.forfeitNow = null;
      state.actionPanel?.close();
      state.actionPanel = null;
      state.duelPrompt?.close();
      state.duelPrompt = null;
      state.adventureTurn = null;
      fns.closeTrial(0);
      fns.closeTribulationFx(0);
      // 历练：小窗和这一场的窗口都关掉；run 已经在存档里，不补结算
      state.adventure?.dispose();
      fns.closeAdventureShows(0);
      // 在别人家做客：告个辞（不等）；家里的客人窗口关掉
      void fns.comeHome('called');
      if (state.hosting && state.hosting.openerTimer !== null) clearTimeout(state.hosting.openerTimer);
      state.hosting?.window.close(0);
      state.neighborhood?.stop();
      void state.visitHost?.close();
      homePet.dispose();
      diary.flush(Date.now());
    },
  };
}
