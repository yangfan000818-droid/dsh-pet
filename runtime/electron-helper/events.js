/**
 * dsh-pet desktop helper —— 事件联动（碎碎念 / 广播 / 工作状态）。
 *
 * 展示与 tick 回调经 PetSprite.prototype 挂载（运行时可解析，顺序无碍）；
 * startLoops 是全部轮询的组装入口（boot 后调用）。依赖 constants.js / sprite.js。
 */
'use strict';

// ---- 工作状态联动（DSH 会话状态，每只宠物按 workStatusEnabled 门控；容器 1s 轮询，ts 变化才递增 tick）----
// 气泡驻留语义与浏览器一致：thinking/working/result/waiting（"事情还没完"）常驻直到状态切走；
//   success/error（"这事结束了"）10s 自动收起；state=null（空闲/回合被打断）收起气泡回待机。
// 动画循环语义：进行中档位循环播（switchTo once=false），终态档位播一遍回 idle 链；
//   回空闲时把正在循环的那段改成"播完即停"（见下面空闲分支），否则 ended 永不触发、链回不去。
PetSprite.prototype.onWorkTick = function onWorkTick(snapshot, tick) {
  if (!this.pet.workStatusEnabled) return; // 未启用工作状态联动 -> 该宠物完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevWorkTick) return;
  this.prevWorkTick = tick;
  // 占用锁（issue #122 第 4 项）：锁生效时不响应工作状态——它是**自动**来源（任务事件驱动），
  // 没有"用户手动要"这条路。判在 tick 消费**之后**：占用期间的变化当过去了，解冻时由
  // applyFreeze 的 resumeWorkStatusAnim() 重新对齐**当前**状态，所以不会停在旧档位上。
  // 宿主侧不挡这个全局段：sections.workStatus 是所有宠物共用一份，宿主"跳过写入"会连带静音
  // 别的宠物（issue #122 要的是"只控制指定 main"），所以按宠物在渲染端忽略。
  if (this.frozen) return;
  const state = snapshot && snapshot.state ? snapshot.state : null;
  this.workState = state; // 当前工作状态：互动/事件动画播完恢复档位循环用（与浏览器 workStatusRef 同用途）
  const stateChanged = this.prevWorkState !== state;
  this.prevWorkState = state;
  if (!state) {
    // 回空闲：把正在**循环播**的进行中档位动画改成"播完即停"（与浏览器 src/client/pet.ts 的空闲分支
    // 同一处修复）。进行中档位走 switchTo(name, false)（el.loop=true、el.onended=null），ended 永不
    // 触发；而这里不切动画（原设计"由常规动画链回待机"），链因此拿不到推进信号 —— 宠物会一直卡在
    // 那段工作动画上。只把当前段改成播完即停：它结束后走 handleEnded → resumeWorkStatusAnim() 返回
    // false → playIdle；工作期间的原生 loop 不受影响。
    if (S.poolIncludes(this.animations.events?.workStatus ?? [], this.anim)) {
      const frontEl = this.front === 0 ? this.videoA : this.videoB;
      if (frontEl) {
        frontEl.loop = false;
        frontEl.onended = () => this.handleEnded();
      }
    }
    // 空闲：收起常驻气泡
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = null;
    this.workOn = false;
    this.workText = null;
    this.renderBubble();
    return;
  }
  const pool = this.animations.events?.workStatus;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.workStatus，无法播放工作状态动画');
    return;
  }
  const idx = S.WORK_STATUS_INDEX[state];
  const slot = pool[idx];
  if (slot === undefined) {
    console.error('[dsh-pet] work-status 档位索引越界：state=' + state + ' idx=' + idx);
    return;
  }
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' workStatus pet=' +
      this.pet.id +
      ' state=' +
      state +
      ' -> [' +
      idx +
      '] ' +
      name,
  );
  this.stopMove();
  // 气泡文本：任务详情（todo/write 提供）优先，否则从条目级 workStatusTexts[档位]（数组）随机抽一句；
  // 整字段/整档缺失 = 不弹文本，只播动画（与浏览器同一语义）。
  const textGroup = Array.isArray(this.pet.workStatusTexts) ? this.pet.workStatusTexts[idx] : undefined;
  const configuredText =
    Array.isArray(textGroup) && textGroup.length > 0
      ? textGroup[Math.floor(Math.random() * textGroup.length)]
      : undefined;
  this.workText = (snapshot && snapshot.task) || configuredText || null;
  const terminal = state === 'success' || state === 'error';
  // 气泡点亮/收起只在状态变化时动作：同状态后续 tick（todo 文案更新、其它会话事件搅动 ts）
  // 不重新点亮**已自动收起的终态气泡**——否则"任务完成"的气泡会被后续 ts 变化反复弹回（Bug 2，
  // 与浏览器 workBubbleOn 同一语义）。
  if (stateChanged) {
    this.workOn = true;
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = terminal
      ? window.setTimeout(() => {
          this.workOn = false;
          this.renderBubble();
        }, BUBBLE_DURATION_MS)
      : null; // 非终态：常驻，不设自动收起
  }
  this.renderBubble();
  // 循环语义（与浏览器 setOnce 一致）：终态播一遍回 idle；非终态多候选档位播一遍 →
  // ended 由 sprite.handleEnded 轮换到下一候选（长时间状态不单段重复）；非终态单候选档位无限循环。
  const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
  if (terminal || rotating) this.playOnce(name);
  else this.switchTo(name, false); // 进行中循环播（单动画/单候选档位）
};

// ---- 碎碎念 / 命令气泡 / 对话回复 / 清空（**四合一**）：不再各自轮询 ----
// 改造前这里是两个循环（startWhisperLoop 按 eventsRefreshSec.whisper 轮询 /whisper、
// startBroadcastLoop 1s 轮询 /broadcast）。现在三者都写进 S 的 pets.<id>.say，由上面的
// /state 统一轮询分发到对应宠物（见 applySayLeaf）——本窗口只装一只宠物，按 id 命中即可。

// 收起说话气泡（POST /bubble/clear 的落点）。**只动气泡**：正在播的动画、
// 工作状态气泡都不碰——气泡与动作是两把锁、分别释放（issue #122 第 5 条）。
// 与浏览器端 clearWhisperBubble 同一语义。
PetSprite.prototype.clearWhisper = function clearWhisper() {
  if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
  this.whisperTimer = null;
  this.whisperOn = false;
  this.whisperView = null;
  this.whisperImage = '';
  this.whisperUrl = '';
  this.renderBubble();
};

// 碎碎念展示（本宠物）：随机抽 events.whisper 动画 + 弹文本气泡（与工作状态气泡同一套定时语义）
// image：host 随机抽定的配图名称（未开配图/池为空则空串，与浏览器端同一契约）
// url：配图的另一种形态——第三方自带的完整地址（POST /broadcast 的 url 参数，issue #122 第 1 条）。
//   与 image **二选一**（host 判定层保证），由字段名区分，不靠嗅探。
// duration / anim：POST /broadcast 的两个新参数（issue #122 第 5 条）。两者**互相独立**：
//   - anim === false 时整段跳过动画联动——不查池、不换源，也不 stopMove()
//     （stopMove 属于"开始播这段动画"的一部分，不是弹气泡的副作用）。
//     于是配置里缺 events.whisper 时，只弹气泡这条路照样走得通。
//   - duration === 0 表示"这一条不显示"：**不动当前已在显示的气泡**
//     （要收起它请用 POST /bubble/clear，两件事不重叠）。
PetSprite.prototype.showWhisper = function showWhisper(text, image, url, duration, anim) {
  let name = null;
  if (anim !== false) {
    const pool = this.animations.events?.whisper;
    if (!pool || pool.length === 0) {
      console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画');
      return;
    }
    // 整池随机抽 1 槽（避开当前正播动画，避免连续重复）；槽位若为数组候选再档内随机（与浏览器一致）
    name = S.pickSlot(S.pick(pool, this.anim), this.anim);
  }
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' whisper pet=' +
      this.pet.id +
      (name === null ? ' （不联动动画）' : ' -> [' + name + ']') +
      ' 「' +
      text +
      '」' +
      (image ? ' [' + image + ']' : ''),
  );
  // 先起动画：它与气泡时长是两个独立参数（duration=0 时动画照播、只是不弹泡）
  if (name !== null) {
    this.stopMove();
    this.playOnce(name);
  }
  if (duration === 0) return;
  this.whisperOn = true;
  this.whisperView = S.whisperBubbleView({ ok: true, text, ts: 0 });
  this.whisperImage = typeof image === 'string' ? image : '';
  this.whisperUrl = typeof url === 'string' ? url : '';
  this.renderBubble();
  // 气泡定时消失（与动画解耦，与工作状态气泡同一语义；重复触发先清旧定时器）
  if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
  this.whisperTimer = window.setTimeout(() => {
    this.whisperOn = false;
    this.renderBubble();
  }, duration ?? BUBBLE_DURATION_MS);
};

// ---------- 轮询组装（容器统一拉取/触发，与浏览器 PetMulti 同一套路径；boot 成功后调用） ----------

// ---------- 统一轮询（GET /state，长轮询）：与浏览器同一份数据来源与渲染入口 ----------
// 每个叶子 = { counter, data }：首拉只记基线（不渲染），之后 counter 变了才渲染。
// 各功能逐个接入，旧的独立轮询循环随迁随删。
let stateBaseline = null;
/** 我手里这份 S 的版本号（undefined = 首拉，不带参数 → 立刻拿全量） */
let stateSince;
/** 宿主支持长轮询吗？响应带 counter = 支持；不带 = 老宿主（会立刻返回全量，必须退避） */
let stateLongPoll = true;

/** 说话叶子 → 对应宠物播说话动画 + 气泡（碎碎念/命令气泡/对话回复/清空四合一）。
 *  `kind: 'clear'`（POST /bubble/clear）= 收起气泡；其余 = 弹一个气泡。
 *  petId 由路径解析出来（pets.<id>.say）；本窗口只装一只宠物，按 id 命中即可。 */
function applySayLeaf(petId, leaf) {
  const said = S.readSay(leaf);
  if (!said) return;
  for (const s of sprites) {
    if (s.pet.id !== petId) continue;
    if (said.kind === 'clear') s.clearWhisper();
    else s.showWhisper(said.text, said.image, said.url, said.duration, said.anim);
  }
}

/** 工作状态叶子 → 各宠物切档位动画 + 气泡（含回到空闲：state=null 用于收起常驻气泡） */
function applyWorkStatusLeaf(leaf) {
  const snap = S.toWorkStatus(leaf.data);
  if (!snap) return;
  workTick++;
  for (const s of sprites) s.onWorkTick(snap, workTick);
}

/** 点播动画叶子 → 对应宠物播该动画（其他插件经 POST /anim 写进 S）。
 *  两种形态（issue #122 第 1 条）：
 *    name = 池内名字，复用**右键菜单同一个处理函数** onMenuAction，所以镜像修正 / 移动类走真实
 *      位移 / 其余播一遍的语义与菜单点一下完全一致，这里不重写一遍；
 *    url  = 第三方自带的完整地址，**不走 onMenuAction**（裸地址没有菜单语义），只换源播一次。
 *  `facing`（可选）= 调用方显式指定的朝向：**换源之前**赋给 sprite——switchTo 是在 onReady 里按
 *  this.facing 贴 scaleX(-1) 的，晚一步就赶不上这一趟。没给就一个字都不动（保持宠物当前朝向，
 *  而不是回落 left）；给了就跳过"文字类动画点播前强制朝左"那条修正（显式值优先）。
 *  `rate`（可选）= 调用方显式指定的倍速（宿主已卡在 0.5–3）：跟着换源一起写进那一段视频元素，
 *  这一段播完或被打断就随下一次换源恢复常速（见 sprite.switchTo）。没给 = 常速。
 *  petId 由路径解析出来（pets.<id>.anim）；本窗口只装一只宠物，按 id 命中即可。 */
function applyAnimLeaf(petId, leaf) {
  const hit = S.readAnim(leaf);
  if (!hit) return;
  for (const s of sprites) {
    if (s.pet.id !== petId) continue;
    const explicitFacing = hit.facing !== undefined;
    if (explicitFacing) s.facing = hit.facing; // 必须在换源前：switchTo 里按它贴 scaleX(-1)
    if (hit.url !== undefined) s.playUrlOnce(hit.url, hit.playbackId, hit.rate);
    else if (hit.name !== undefined)
      s.onMenuAction(
        {
          label: hit.name,
          anim: hit.name,
          playbackId: hit.playbackId,
          rate: hit.rate,
          ...(hit.target ? { target: hit.target } : {}),
        },
        explicitFacing,
      );
  }
}

/** 位置指令叶子 → 对应宠物挪过去（其他插件经 POST /position 写进 S）。
 *  复用 sprite.moveToCenter（instant / spring / line 三条路都在那儿），与 /anim 同一族：只分发，
 *  不重写运动学。petId 由路径解析出来（pets.<id>.position）；本窗口只装一只宠物，按 id 命中即可。 */
function applyPositionLeaf(petId, leaf) {
  const hit = S.readPosition(leaf);
  if (!hit) return;
  for (const s of sprites) {
    if (s.pet.id === petId) s.moveToCenter(hit.x, hit.y, hit.mode, hit.duration);
  }
}

/** 抛掷指令叶子 → 对应宠物按给定角度/力度飞出去（其他插件经 POST /throw 写进 S）。
 *  初速换算在 shared（S.throwVelocity），下游全是既有抛掷物理（重力/反弹/摩擦/落地 Q 弹）。 */
function applyThrowLeaf(petId, leaf) {
  const hit = S.readThrow(leaf);
  if (!hit) return;
  for (const s of sprites) {
    if (s.pet.id === petId) s.throwWith(hit.angle, hit.power);
  }
}

/** 占用锁叶子 → 对应宠物冻结 / 解冻（其他插件经 POST /lock 写进 S，issue #122 第 4 项）。
 *  与上面四个**指令**不同，这是**状态**：sprite 读它决定要不要冻结自己（随机链停、暂停自播、
 *  忽略自动来源），并按叶子里的 expiresAt **自己**定时解除——宿主侧过期是懒判的，不会推"锁没了"。
 *  petId 由路径解析（pets.<id>.lock）；本窗口只装一只宠物，按 id 命中即可。 */
function applyLockLeaf(petId, leaf) {
  const hit = S.readLock(leaf);
  if (!hit) return;
  for (const s of sprites) {
    if (s.pet.id === petId) s.setLock(hit);
  }
}

/** 第三方菜单快照叶子 → 灌进各宠物（右键菜单据此拼「更多」）。
 *  与上面那些"指令"不同，这是**当前状态**：注册/覆盖时写一次，所有窗口共用同一份快照。 */
function applyMenuLeaf(leaf) {
  const items = S.readMenuItems(leaf ? leaf.data : null);
  for (const s of sprites) s.menuItems = items;
}

/** 跑一拍 /state。返回 true = "按长轮询命中"（宿主支持长轮询，可以立刻再请求） */
async function pollStateOnce() {
  try {
    const s = await S.fetchState(
      STATE_URL,
      stateLongPoll && stateSince !== undefined ? { since: stateSince, timeoutMs: STATE_WAIT_MS } : undefined,
    );
    if (!s) return false;
    // 响应带 counter = 宿主支持长轮询；不带 = 老宿主（不认识 since/timeout，会立刻返回全量），
    // 这时必须退回固定间隔轮询，否则这个循环就是忙等。
    stateLongPoll = typeof s.counter === 'number';
    if (stateLongPoll) stateSince = s.counter;
    if (stateBaseline === null) {
      stateBaseline = S.flattenCounters(s); // 首拉：只记基线，不渲染（避免启动/重载时重放旧气泡）
      // 第三方菜单项是**当前状态**不是事件：首拉就要装上，否则 helper 重启后要等下次注册才出现
      applyMenuLeaf(s.sections ? s.sections.menu : null);
      return true;
    }
    for (const change of S.takeChanged(s, stateBaseline)) {
      if (change.leaf.data === null) continue;
      if (change.path === 'sections.workStatus') applyWorkStatusLeaf(change.leaf);
      else if (change.path === 'sections.menu') applyMenuLeaf(change.leaf);
      else if (change.path.startsWith('pets.') && change.path.endsWith('.say')) {
        // 宠物 id **允许含点号**：按前缀/后缀切片，绝不 split('.')
        applySayLeaf(change.path.slice('pets.'.length, -'.say'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.anim')) {
        // 点播动画：同样按前缀/后缀切片（counter 每次写入都递增，连点两次也会分发两次）
        applyAnimLeaf(change.path.slice('pets.'.length, -'.anim'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.position')) {
        // 位置指令：同样按前缀/后缀切片，绝不 split('.')
        applyPositionLeaf(change.path.slice('pets.'.length, -'.position'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.throw')) {
        // 抛掷指令：同上
        applyThrowLeaf(change.path.slice('pets.'.length, -'.throw'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.lock')) {
        // 占用锁：同上切片，绝不 split('.')。它是**状态**不是指令（见 applyLockLeaf）
        applyLockLeaf(change.path.slice('pets.'.length, -'.lock'.length), change.leaf);
      }
    }
    return true;
  } catch {
    /* 轻量轮询失败静默：下一拍再试 */
    return false;
  }
}

function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;

  // 统一轮询：**自调度长轮询**（请求 → 处理 → 立刻再请求）。宿主在版本没变时挂起，所以
  // 空闲时是 1 请求/秒（与改造前一致），叶子一变立刻收到——不需要"前端动作后叫醒一拍"了
  // （动作端点都会写叶子 → 版本变 → 挂着的这一拍自己就返回）。本窗口只装一只宠物，
  // 所以每个窗口各跑一份；全局计数器意味着任意写入会唤醒所有窗口（有意为之，见 host ./state）。
  const stateLoop = async () => {
    const hit = await pollStateOnce();
    setTimeout(() => void stateLoop(), hit && stateLongPoll ? 0 : 1000);
  };
  void stateLoop();
}
