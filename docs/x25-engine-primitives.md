# X25-A 引擎三原语（蓄力 / 领域 / 瞬影）任务书

2026-10-29。用户拍板做 X25（跨媒介名场面招式），先做引擎三原语。调研与候选池见
[skills-cross-media-research.md](skills-cross-media-research.md)。本任务书只管**引擎与最小演出**，
新动作素材、新特效贴图、分镜打磨留到 X25-B。

## 1. 范围

三招各带一个新原语，先让规则、事件、测试、AI 跑通；演出先用现成素材占位（见 §6）。
不做：`dreamina` 素材、图鉴长文案、设置面板、新轨迹类型。

| 招式 | id | 类别 | 原语 |
| --- | --- | --- | --- |
| 鲸派气功 | `tide-cannon` | 主动 | 蓄力 |
| 深渊领域 | `abyss-field` | 主动 | 领域 |
| 瞬影 | `shadow-step` | 主动 | 瞬影 |

三招都是一场一次（现有主动招的默认口径），都进 `SKILLS` 图鉴、`ACTIVE_SKILLS`、`SKILL_IDS`。

## 2. 规则

### 2.1 鲸派气功（蓄力）

**聚气这一拍**

- 出招：`me.charge = 1`，事件 `{ actor, kind: 'skill', skill: 'tide-cannon', charging: true, hp }`，这一拍**不造成伤害**。
- 蓄力期间（`me.charge > 0`）自己受到的伤害 ×0.7（向下取整），在 `applyDamage` 里做，泡泡护体现在减伤之后照常挡。
- 被控跳过（`skip`）的那一拍蓄力保持，减伤也保持。

**释放**

- 下一次**真正出手**时，在调 `controllers[self].decide` **之前**拦截：
  - `me.charge = 0`；
  - 立刻推一条 `{ actor, kind: 'decide', action: { kind: 'skill', skill: 'tide-cannon' }, autoRelease: true, hp }`（不经过 `legalize`，因为这门主动招已经 `used`）；
  - 伤害 `TIDE_BASE + floor(power × POWER_FACTOR) + floor(foe 气血上限 × HP_BONUS × TIDE_HP_SHARE)`，直接走 `scaleDamage` + `applyDamage`（必中：不判闪避，也不吃魂影 / 替挡，泡泡护体照挡；和 `ancient` 的口径一致）；
  - 事件 `{ actor, kind: 'skill', skill: 'tide-cannon', release: true, damage, hp }`；打死对方照常补 `play-dead`；
  - 这一手不再做别的动作，`takeAction` 直接返回这个 action。
- 释放前被鬼敲门等打死的，自然没有释放。

常量（放 `battle.ts` 现有常量区）：`TIDE_BASE = 58`、`TIDE_HP_SHARE = 0.6`、`CHARGE_GUARD = 0.7`
（任务书原写 56，X25-A 收尾按 `battle-sim` 收进 44%–61% 时调到 58）。

### 2.2 深渊领域（领域）

**起手**：`me.field = FIELD_TURNS`，事件 `{ actor, kind: 'skill', skill: 'abyss-field', hp }`。

**领域在的时候**（`me.field > 0`）：

- **禁闪避**：自己打出的攻击一律必中（`attack` 里 `sure` 的条件加 `me.field > 0`；`sure` 同时让魂影不能替，和现有必中口径一致）。
- **暗流**：对方**真正出手**时（`takeAction` 开头，被控跳过不算），先挨 `scaleDamage(FIELD_TICK, foe)` 一下（走 `applyDamage`，泡泡照挡、可能触发假死遁），事件 `{ actor: 领域主人, kind: 'field', damage, hp }`。
- 自己的**每一次攻击**（`attack` 正常走完、有出手的）之后 `me.field -= 1`。放非攻击的招（回血等）、被控跳过都不减。
- 领域不叠加：再放一次也只重置成 `FIELD_TURNS`（同一场也只能放一次，实际不会发生）。

常量：`FIELD_TURNS = 3`、`FIELD_TICK = 15`
（任务书原写 2 / 5，X25-A 收尾按 `battle-sim` 收进平衡带时调大——领域期间三次攻击必中，暗流三次共 45）。

### 2.3 瞬影（闪避 + 必中）

**起手**：`me.blink = true`，事件 `{ actor, kind: 'skill', skill: 'shadow-step', hp }`。

**瞬影在的时候**：

- 挨到的**普通攻击**（法宝 / 招式表 / 徒手的那条 `attack` 路径，含多段）和**灵兽**那一口，全部按闪避处理：`{ actor: 挨打方, kind: 'dodge', hp }`，不掉血、不消耗泡泡 / 魂影 / 替挡；`blink` **不因挨打消失**。
- **优先级最高**：必中（烟花、托盘末段、领域、睡着）也打不中瞬影；领域和瞬影同时存在时，挨打方有瞬影就闪。
- 自己**下一次真正出手的攻击**必中（`sure`），这一手打完 `blink = false`。放非攻击的招不解散瞬影。
- 反击（第六感）、天雷不做特殊处理，按原规则走。

## 3. 事件与类型

- `skill` 事件加两个可选标：`charging?: true`、`release?: true`。
- `decide` 事件加 `autoRelease?: true`。
- 新增事件：`{ actor: 0 | 1; kind: 'field'; damage: number; hp: [number, number] }`（`actor` 是领域主人）。
- 对白（`battle-lines.ts`）：
  - `tide-cannon` 聚气两句、释放两句（释放句带 `-{d}`）；
  - `abyss-field` 两句；
  - `shadow-step` 两句；
  - `field` 两句（`{a}` 是领域主人，句子里写 `{b}` 挨打，带 `-{d}`）。
- `BATTLE_VERSION` 7 → 8（图鉴内容变了，名帖对端必须同版本）。

## 4. AI 选择（`autoController` 里）

按现有顺序插在合适的优先级（都在 `unused` 过滤里）：

- `tide-cannon`：对方气血 > 60% 时聚气。
- `abyss-field`：开场无条件展开（压住对方的闪避，之后三次攻击必中）。
- `shadow-step`：自己气血 < 50% 时用。

## 5. 演出（X25-B 已接正式素材）

- `ATTACK_SHOW`：`tide-cannon: { action: '出手-聚气' }`、`abyss-field: { action: '出手-领域' }`、`shadow-step: { action: '出手-瞬影' }`。
- `RELEASE`：`出手-鲸派`（1.83 秒、手位 [200, 199]）、`出手-领域`（2.17 秒按地、手位 [192, 268]）。
- 时间线（`battle-show.ts`）：
  - `decide` 带 `autoRelease` 时**不**播动作（释放由下一步自己排），避免聚气动作闪一下又被顶掉。
  - `skill === 'tide-cannon' && release`：在 `at` 播 `出手-鲸派`，`at + releaseOffset('出手-鲸派')` 放飞行物 `{ kind: '鲸波', track: 'line', hitFx: '命中-水花' }`，命中那一刻排受击与台词。
  - `skill === 'tide-cannon' && charging`：聚气动作压进一格（2.4 秒）演完，在 `cursor + SLOT_MS` 铺一张 `鲸息`（1.2 秒，掌间留一颗储气球），再刷台词。
  - `skill === 'abyss-field'`：单掌按地那一刻（`cursor + releaseOffset('出手-领域')`）铺 `深渊符阵`（竖压 0.36 铺地、缓转 8°/秒）与 `深渊黑雾`，各留 18 秒（撑满自己三次攻击、约三个来回）。
  - `field`：对方每次出手前压一下 `深渊黑雾`（`anchor: 'foe'`，0.9 秒，抖 3px）；`at` 早于上一格演完时压到 `cursor + SLOT_MS`。
  - `shadow-step`：只播动作与台词（残影画在素材里），不加特效。
  - `FX_ASSETS` 补上 `鲸息`、`鲸波`、`深渊符阵`、`深渊黑雾`。
- 静止贴图的竖压扁：`Shot.hold.squash`（X25 新增，1 = 不压），`fx-window.ts` 的 `holdSpec` 与页面 `place()` 透传。

## 6. 测试

- `battle.test.ts`：
  - 蓄力：聚气拍无伤且置 `charging`；下一拍自动释放、伤害落在公式上、`decide` 带 `autoRelease`；聚气期间受到的伤害 ×0.7；被控跳过一拍后仍释放；聚气期间被打死则没有释放。
  - 领域：起手置位；对方出手前吃 `FIELD_TICK`；领域期间自己的攻击 `sure`（对方身法拉满也不闪）；三次攻击后领域消失。
  - 瞬影：起手后挨打只出 `dodge`、不掉血；必中攻击也不中；自己下一次攻击必中；放非攻击招不解散。
  - 三招都只出现一次（`used` 口径）。
- `battle-show.test.ts`：四条时间线——聚气有动作 + 储气球、释放有动作 + 飞行物 + 受击、领域铺符阵与黑雾并逐次压黑雾、瞬影只有动作与台词。
- 现有 1263 条测试全绿；有因为 `BATTLE_VERSION`、图鉴快照、`SKILL_IDS` 数量变化而必须改的断言，改的时候说明理由。
- `battle-sim.mjs` 跑一遍，把改动前后的胜率表贴进回报（目标：各对位变化 ≤ 5 个百分点）。

## 7. 验收

- `npx prettier --check .`（`src/app/main.ts` 的存量格式问题不用管）、`npm run typecheck`、`npm run lint`、`npm test` 全过。
- 不提交、不 push、不碰 `/Applications`、不动用户存档目录。
- 回报：改动文件清单、三招的实际数值与胜率表、测试结果、和任务书的偏差及理由、遗留问题。
