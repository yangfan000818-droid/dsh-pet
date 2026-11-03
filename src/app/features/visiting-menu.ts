import type { NeighborBook } from '../neighbors';
import { notesAllowed, orderNeighbors } from '../neighbors';
import { PLAY_THINGS } from '../visit-talk';
import { NOTE_GAP_MS, NOTE_MAX, sendNote } from '../visit';
import type { NoteReply } from '../visit';
import { MENU_CULTIVATION_GROUP, MENU_VISIT_GROUP, lazyFns } from './context';
import type { FeatureContext } from './context';
import { errorText } from './util';

/** 插件每个 owner 最多 24 项（`>` 就整份拒掉、菜单从此不再更新）：根上固定 5 项，修炼最多 5 项
 * （信息 + 历练 + 渡劫 + 服丹后渡劫 + 心魔试炼／快进；待选二选一那两项只在没圆满时出现），邻居最多列这么多
 * （回访占名额）：满打满算 23 项，给隔空切磋留 1 项。家里有客时换成送客 + 切磋 + 一起玩 + 请吃零食 + 熟人 + 捎话，
 * 至多 17 项，加上固定项和修炼的项会超 24：wantedLabels 按优先级兜底截断，先少的是尾巴上的零食和捎话。 */
const MENU_NEIGHBORS_MAX = 13;

/** 串门的右键项与捎话 */
export interface VisitingMenu {
  visitActions(): Map<string, () => unknown>;
  notesOn(): boolean;
}

export function createVisitingMenu(ctx: FeatureContext): VisitingMenu {
  const {
    answerDuel,
    comeHome,
    cultivationOn,
    goVisit,
    inviteSpar,
    letIn,
    playTogether,
    relay,
    say,
    sendGuestHome,
    startGuestSpar,
    treatGuest,
  } = lazyFns(ctx);
  const { deps, log, diary, pouch, neighbors, noteOpener } = ctx;

  /**
   * 串门相关的右键项（随状态变）：label → 点了做什么。
   * 有人敲门、家里有客、自己在外时放对应的应答项；都没有、又允许出门时放「串门」子菜单列附近的邻居
   * （敲门等答复期间不列，免得一边敲门一边又出门）。
   */
  function visitActions(): Map<string, () => unknown> {
    const actions = new Map<string, () => unknown>();
    // 隔空切磋（X15）：有人挑战、等主人答复时，两项应答和敲门的「让进 / 不让进」同一优先级
    const waiting = ctx.state.duelWait;
    if (waiting) {
      actions.set(`${MENU_CULTIVATION_GROUP}/应战：${waiting.visitor.owner} 家的 ${waiting.visitor.pet}`, () =>
        answerDuel(true),
      );
      actions.set(`${MENU_CULTIVATION_GROUP}/不应战`, () => answerDuel(false));
      return actions;
    }
    const knocking = ctx.state.visitHost?.knocking();
    const guest = ctx.state.visitHost?.guest();
    const { enabled, visiting } = deps.appConfig().visit;
    if (knocking) {
      actions.set(`让 ${knocking.pet} 进来`, () => letIn(true));
      actions.set(`不让 ${knocking.pet} 进来`, () => letIn(false));
    } else if (guest) {
      actions.set(`请 ${guest.pet} 回家`, sendGuestHome);
      // 切磋（X5）：开着修炼、没在打、客人是验证过身份的（奖励与邻居簿都靠 id 记）时才有
      if (
        cultivationOn() &&
        guest.id &&
        !ctx.state.spar &&
        !ctx.state.battle &&
        !ctx.state.liveBattle &&
        !ctx.state.actionPanel
      )
        actions.set(`${MENU_VISIT_GROUP}/和客人切磋`, () => void inviteSpar());
      for (const thing of PLAY_THINGS) actions.set(`和 ${guest.pet} 一起玩/${thing.label}`, () => playTogether(thing));
      for (const snack of pouch.kinds()) actions.set(`请 ${guest.pet} 吃/${snack.label}`, () => treatGuest(snack));
      // 只对验证过身份的客人提供熟人开关：陌生人没身份可标，冒名的也不能被拉成熟人
      const guestId = guest.id;
      if (guestId) actions.set(friendLabel(neighbors, guestId, guest.owner), () => toggleFriend(neighbors, guestId));
      // 捎话也只对熟客开（托它带回去给它的主人）；客人带 id 就是敲门签名验上了
      if (notesAllowed(neighbors, guestId, guestId !== undefined, notesOn()))
        actions.set(`捎话给 ${guest.owner}`, () => void fireNote(noteViaGuest()));
    } else if (ctx.state.trip) {
      actions.set(`从 ${ctx.state.trip.host.owner} 家回来`, () => comeHome('called'));
      // 切磋（X5）：开着修炼、没在打时才有（在别人家做客，对面是主人家的宠物）
      if (cultivationOn() && !ctx.state.spar && !ctx.state.battle && !ctx.state.liveBattle && !ctx.state.actionPanel)
        actions.set(`${MENU_VISIT_GROUP}/找主人家的宠物切磋`, () => void startGuestSpar());
      const hostId = ctx.state.trip.host.id;
      // 只对验证过身份的主人家提供熟人开关（trip.verified：见 startTrip）；捎话也只对熟人家开
      if (ctx.state.trip.verified)
        actions.set(friendLabel(neighbors, hostId, ctx.state.trip.host.owner), () => toggleFriend(neighbors, hostId));
      if (ctx.state.trip.verified && notesAllowed(neighbors, hostId, true, notesOn()))
        actions.set(`捎话给 ${ctx.state.trip.host.owner}`, () => void fireNote(noteToHost()));
    } else if (enabled && visiting && ctx.state.knockingOn === null) {
      const ordered = orderNeighbors(ctx.state.neighborhood?.list() ?? [], neighbors, ctx.state.lastGuest, Date.now());
      // 回访项也算在 MENU_NEIGHBORS_MAX 里：放了回访，列表就少列一位
      const nearby = ordered.list.slice(0, MENU_NEIGHBORS_MAX - (ordered.revisit ? 1 : 0));
      if (ordered.revisit) {
        const revisit = ordered.revisit;
        actions.set(`${MENU_VISIT_GROUP}/回访 ${revisit.owner} 家`, () => goVisit(revisit.id));
      }
      for (const neighbor of nearby) {
        // 熟人加个后缀，一眼能认出来
        const suffix = neighbors.get(neighbor.id)?.friend === true ? '（熟人）' : '';
        let label = `${MENU_VISIT_GROUP}/去 ${neighbor.owner} 家${suffix}`;
        for (let n = 2; actions.has(label); n += 1)
          label = `${MENU_VISIT_GROUP}/去 ${neighbor.owner} 家${suffix}（${n}）`;
        actions.set(label, () => goVisit(neighbor.id));
      }
      // 没有邻居也留个入口：不然开了串门，右键里一点痕迹都没有
      if (nearby.length === 0 && !ordered.revisit) {
        actions.set(`${MENU_VISIT_GROUP}/附近还没有邻居`, () =>
          say('附近还没发现开着串门的桌宠～同一网络里的同事也打开串门就能看到啦'),
        );
      }
    }
    return actions;
  }

  /** 捎话开关现在的值（「捎话给 X」菜单项和收捎话都用） */
  function notesOn(): boolean {
    return deps.appConfig().visit.notes;
  }

  /**
   * 捎话不等小窗：小窗最长开 2 分钟，等它的话调用方（菜单点击的处理）会被拖住很久。
   * 失败路径都在动作里处理过，这里只兜底记日志，不许出现未处理的 Promise 拒绝。
   */
  function fireNote(sending: Promise<void>): Promise<void> {
    return sending.catch((error: unknown) => log(`串门：捎话出错：${errorText(error)}`));
  }

  /** 出门在熟人家：主人写一句话，捎给对方主人；结果转播回自家（不说 say：那会先把宠物叫回家） */
  async function noteToHost(): Promise<void> {
    const current = ctx.state.trip;
    if (!current) return;
    const owner = current.host.owner;
    const text = await noteOpener.ask(owner);
    if (text === null || ctx.state.trip !== current) return;
    const now = Date.now();
    if (current.notesSent >= NOTE_MAX || (current.notesSent > 0 && now - current.lastNoteAt < NOTE_GAP_MS)) {
      relay('（捎话：发太多了，等一会儿再捎）');
      return;
    }
    let result: NoteReply | null = null;
    try {
      result = await sendNote(current.host, { token: current.token, text });
    } catch (error) {
      log(`串门：捎话没送到：${errorText(error)}`);
    }
    if (ctx.state.trip !== current) return;
    if (result?.ok) {
      current.notesSent += 1;
      current.lastNoteAt = Date.now();
      diary.note(Date.now(), 'visit', `帮主人给 ${owner} 捎了句话`);
      relay('（捎话：捎到啦～）');
      return;
    }
    relay(`（捎话：${noteFailText(owner, result)}）`);
  }

  /** 家里来了熟客：主人写一句话，托客人带回去给它的主人 */
  async function noteViaGuest(): Promise<void> {
    const current = ctx.state.hosting;
    if (!current) return;
    const { owner, pet } = current.visitor;
    const text = await noteOpener.ask(owner);
    if (text === null) return;
    const now = Date.now();
    if (current.notesSent >= NOTE_MAX || (current.notesSent > 0 && now - current.lastNoteAt < NOTE_GAP_MS)) {
      void say('捎话发太多了，等一会儿再捎～');
      return;
    }
    // 攒着等客人下次报平安时捎过去（旧客人会丢掉不认识的 note 事件）；日记只记捎过，不记内容
    if (!ctx.state.visitHost?.tell({ type: 'note', text })) return;
    current.notesSent += 1;
    current.lastNoteAt = Date.now();
    diary.note(Date.now(), 'visit', `帮主人给 ${owner} 捎了句话`);
    void say(`好啦，这句话我让 ${pet} 带给 ${owner}～`);
  }

  /** 熟人开关的菜单文案（X 是对方主人的昵称） */
  function friendLabel(book: NeighborBook, id: string, owner: string): string {
    return book.get(id)?.friend === true ? `${owner} 不再是熟人` : `把 ${owner} 设为熟人`;
  }

  /** 点一下菜单项：是熟人的取消，不是的设为 */
  function toggleFriend(book: NeighborBook, id: string): void {
    book.setFriend(id, book.get(id)?.friend !== true);
  }

  /** 捎话没捎成的经过（noteToHost 转播给主人用） */
  function noteFailText(owner: string, result: NoteReply | null): string {
    switch (result && !result.ok ? result.reason : 'unreachable') {
      case 'not-friend':
        return `${owner} 那边没把我们当熟人`;
      case 'too-many':
        return '发太多了，等一会儿再捎';
      case 'old-host':
        return '对方的版本太旧，捎不了话';
      case 'sent-home':
      case 'not-visiting':
        return '已经回家了';
      default:
        return '没送到，再试一次';
    }
  }

  return { visitActions, notesOn };
}
