# dsh-pet 🐾

<p align="center">
  <a href="https://github.com/yangfan000818-droid/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/yangfan000818-droid/dsh-pet?style=social"></a>
  <a href="https://github.com/yangfan000818-droid/dsh-pet/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/yangfan000818-droid/dsh-pet?color=orange"></a>
  <a href="https://github.com/yangfan000818-droid/dsh-pet"><img alt="repo size" src="https://img.shields.io/github/repo-size/yangfan000818-droid/dsh-pet"></a>
  <a href="https://github.com/yangfan000818-droid/dsh-pet/issues"><img alt="issues" src="https://img.shields.io/github/issues/yangfan000818-droid/dsh-pet"></a>
</p>

<p align="center">
  <img src="assets/preview/daiji-huxi-xiuxian.gif" width="240" alt="待机呼吸休闲" title="待机呼吸休闲">
  <img src="assets/preview/chi-xigua.gif" width="240" alt="吃西瓜" title="吃西瓜">
  <img src="assets/preview/chui-qiqiu.gif" width="240" alt="吹气球" title="吹气球">
</p>

住在桌面上的宠物：陪你上班，看看你的屏幕吐槽两句，提醒你起来走走、喝水、下班；还能带它去同事电脑上串门、在电脑前修炼、和别人家的宠物切磋。macOS 和 Windows 都能用，不用另装别的软件。

> 本项目从 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 分出来，宠物形象和动画素材来自原作者。现在作为独立的桌面应用单独开发，不再依赖 DSH。

## 下载安装

最新版在 [Releases](https://github.com/yangfan000818-droid/dsh-pet/releases/latest)。

### Windows

- **安装包（推荐）**：[dsh-pet-win-x64-setup.exe](https://github.com/yangfan000818-droid/dsh-pet/releases/latest/download/dsh-pet-win-x64-setup.exe)。按向导装，默认只装给当前用户，不用管理员权限；会建桌面和开始菜单快捷方式，在系统「应用」列表里能卸载，卸载不删宠物存档和配置。
- **绿色版**：[dsh-pet-win-x64.zip](https://github.com/yangfan000818-droid/dsh-pet/releases/latest/download/dsh-pet-win-x64.zip)，解压后双击 `dsh-pet.exe`。
- 没有代码签名，第一次运行时 Windows 会提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。
- 有几项功能 Windows 版没有，见 [Windows 版的限制](#windows-版的限制)。

### macOS

暂时没有现成的 mac 包，要自己构建，几条命令就好，见 [从源码构建](#从源码构建)。目前在 Apple Silicon 上实测过。

应用只在菜单栏有图标，不占 Dock；菜单栏里可以勾「开机自启」。

### 第一次用

1. 右键宠物 →「设置」，在「AI 接口」里填接口地址、模型名和密钥，点「测试连接」。对话、提醒、看屏幕、日记、串门聊天、AI 出招都用这一个模型。
2. macOS 上想让它看屏幕，要在「系统设置 → 隐私与安全性 → 屏幕录制」里给 dsh-pet 授权。
3. 串门默认关着，要用就在设置页「局域网串门」里打开；修炼默认开着，不想要可以在「修炼」里关掉。

**模型怎么选**：

- **对话、提醒**：OpenAI 兼容或 Anthropic 接口都可以，云端、本机都行。
- **看屏幕**：要用支持图片输入的模型。云端模型会收到截图，介意的话就用本机模型，例如用 llama.cpp 跑一个视觉模型：

  ```sh
  llama-server -m <模型>.gguf --mmproj <mmproj>.gguf --jinja --host 127.0.0.1 --port 18080
  ```

  接口地址填 `http://127.0.0.1:18080/v1`。Qwen 这类会「思考」的模型记得勾上「关闭模型思考」，否则思考会占满输出、回复为空。模型不支持看图时会自动改成按人设随口说一句，不截图。

## 功能一览

| 功能                       | 说明                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| 看屏幕吐槽                 | 随时或按间隔看一眼屏幕，按人设说一句，配一张表情包                         |
| 知道你在干嘛               | 知道你在不在电脑前、连续用了多久；离开一阵子回来会打招呼                   |
| 久坐 / 喝水 / 下班提醒     | 按在电脑前的时间提醒起来活动、喝水，下班前提醒一次                         |
| 对话                       | 右键「对话」和宠物聊天，按人设回复                                         |
| 宠物日记                   | 第二天按人设把前一天写成日记                                               |
| 羁绊与小跟班               | 小猫咪跟着宠物；聊天、摸摸头、喂零食攒好感，按阶段解锁小剧场               |
| 局域网串门                 | 带宠物去同一网络里别人家做客：两只宠物聊天、一起玩、请吃零食               |
| 修炼                       | 在电脑前攒修为，渡劫突破大境界，领悟招式、收集法宝                         |
| 心魔试炼、切磋、历练       | 和心魔、邻居家的宠物、三王传承里的守护打；可以全自动，也能让 AI 或自己出招 |
| Claude Code 联动（仅 mac） | Claude 等你确认权限、干完一轮活时提醒你                                    |
| 多只宠物、自己做宠物       | 桌面上同时放几只；也能用自己生成的动画做一只新宠物                         |

## 陪伴与提醒

### 看屏幕吐槽

- **手动**：右键「看看我在干嘛」，看一眼屏幕说一句。
- **自动**：设置页「陪伴与提醒」里开着时，按间隔（默认 900 秒）看一次；只在你人在电脑前、一分钟内碰过键鼠时看，离开电脑或正在打斗时跳过。
- 先按屏幕内容说一句，再按这句话从表情包池里挑一张配图，挑不出就随机。
- **隐私**：截图发给设置页里配置的模型接口。填本机地址（`127.0.0.1` / `localhost`）就只留在本机，填云端地址就会把屏幕内容上传给对应服务商，请按需选择。
- **看不了就降级**：模型不支持看图（视觉请求被服务端按 400 / 404 / 415 / 422 拒绝），或者自动触发时没给「屏幕录制」授权，就改成按人设、时间和「主人此刻」随口说一句，不截图。「不支持看图」只记在内存里，保存 AI 设置或重启应用后会重新试。模型没配好时自动触发安静跳过，手动触发会提示去设置。

### 知道你在干嘛、提醒

- 看屏幕和提醒会结合「正在用哪个应用、连续用了多久、离开了多久」；离开一阵子回来会打招呼。Windows 版不知道你在用哪个应用，其余照常。
- **久坐 / 喝水**：按连续使用时间提醒起来活动，按在电脑前的时间提醒喝水；离开电脑 5 分钟以上算起身。
- **下班**：每天下班前提醒一次，下班时间和提前几分钟都能设（默认 18:00、提前 10 分钟、只在工作日）；那会儿不在电脑前就等回来再说。

### 对话

右键「对话」打开输入框和宠物聊天，回复带说话动画和气泡；设置页里能设记住几轮，记忆存在本机的 `memory.json`。开着「说话配表情包」时，看屏幕、对话、提醒说话都会配图。

### 宠物日记

记下每天在电脑前多久、主要用了哪些应用、提醒、Claude 干完的活、看屏幕的吐槽、串门和修炼的事，第二天回到电脑前时让模型按人设写成前一天的日记。

- 右键「宠物日记」先写一篇今天到目前为止的，再用浏览器打开日记本。

### 羁绊与小跟班

右键「羁绊」打开关系小窗：看阶段和好感度，摸摸头、喂零食、给跟班改名，或者让它回家休息。

- **好感来源**：聊天 +1（每天最多 8 次）、摸摸头 +2（每 10 分钟一次，每天 5 次）、喂零食 +3（每天 3 次）、心魔试炼或切磋赢了 +3（每天 4 次）、串门回家 +4（每天 2 次）。
- **阶段**：初识 → 熟悉（12 分）→ 亲近（36 分）→ 羁绊（80 分）。升到新阶段会挂一段带 CG 和选项的小剧场，菜单变成「羁绊 · 有话想说」，点进去再演，不打断手头的事。
- 关系阶段会写进对话提示词，聊起来更有连续感；还有小剧场没演时，它不会提前剧透。
- **小跟班**：默认一只叫「咪咪」的小猫，飘在宠物脚边跟着走；宠物被拖起来甩时会吓一跳，战斗、历练、串门时躲起来。右键「羁绊」里可以关掉或改名。
- 一天从凌晨 4 点算起，在电脑前不到 10 分钟的日子不写。
- 只存本机（`diary/` 目录）。

## 局域网串门

同一局域网里开了串门的 dsh-pet 能互相看到。设置页「局域网串门」一节：总开关默认关，下面能分别开关「允许别人来我家做客」「允许我的宠物出门做客」「串门时用模型聊天」。首次开启时 macOS 会询问是否允许访问本地网络。

**去做客**：

- 右键「串门」子菜单列出附近的邻居，点一个去它家做客。对方主人在右键菜单里点「让它进来」才进门。
- 做客期间你的宠物变半透明，两边的聊天转播回你的屏幕。
- 到点（默认 10 分钟）或你叫它时回家，回来跟你讲讲见闻。

**家里来客**：

- 客人在你屏幕上变成粉色、面朝你的宠物站着，你的宠物走到哪它跟到哪。
- 两只宠物各用自己的人设和模型接着前文聊，主人家的宠物也会主动起话题；关掉模型聊天就只说固定的招呼和道别。
- 点客人一下能摸摸它；右键「和 X 一起玩」让两只宠物一起吃西瓜、放风筝等。
- 送走客人 2 小时内，「串门」子菜单最上面会出现「回访 X 家」。

**零食**：开着串门时，正常用餐时间（早饭、午饭、晚饭）你在电脑前，宠物会分到一份零食，晚上偶尔还有宵夜，零食袋最多装 5 份。家里来客时右键「请 X 吃」请它吃，两边的日记都会记上。

**邻居与熟人**：

- 每台电脑有固定的串门身份（密钥只存本机），重启后还认得对方，抄了名字也冒充不了。
- 来往过的邻居记在本机，下次见面会提到上次聊的。设置页「邻居」能看来往记录、标熟人、忘掉某个邻居、重置自己的串门身份。
- 熟人排在「串门」子菜单前面，来敲门时可以设成直接请进（只在你在电脑前时）；熟人之间还能右键「捎话给 X」写一句话，让宠物带给对方主人。

**不在同一网段**（比如公司里另一层楼，广播过不去）：在设置里填上对方电脑的 IP 就能互相看到，一边填就够。

**网络上传什么**：只传昵称、宠物名、两只宠物说的话、认人用的公钥签名、熟人之间你亲手写的捎话，以及切磋用的名帖和出手（见下一节）。

## 修炼、切磋与历练

修为、属性、法宝、招式与战绩都只存本机，打斗也全在本机算。

### 修炼与渡劫

- 在电脑前就攒修为，从炼气一层一路修到大乘圆满：小境界自动升级。
- 大境界圆满后右键「渡劫」，扛过天雷就突破到下一个大境界，并二选一领悟一门新招式。渡劫前可以先吃破境丹（Claude 干完活偶尔炼成一颗）。
- 渡劫失败只扣一点修为，不掉境界、不丢法宝。

### 心魔试炼

右键「心魔试炼」和自己的心魔打一场，赢了拿修为、有机会掉法宝。随时能打、不限场次，但收益随间隔恢复：离上一场满 10 分钟才是满额，连着打只给一部分。

### 切磋

- **串门切磋**：串门时主客两边都能发起，两台电脑各自算出同一场、各记各的战绩。同一邻居每天只算一场，每天前几场有收益。
- **隔空切磋**：不串门也能向邻居发起挑战，对方点头才打。
- 切磋不比修为：开打时四项属性各取两边中点，法宝和招式的件数按少的一方取齐，境界高低不影响胜负（名帖里仍带真实属性）。
- 网络上只传切磋用的名帖（境界序号、四项属性、法宝和招式编号）、随机数，以及逐手局里每一手的出招。

### 三种出招方式

每次开打前，擂台下面弹出面板选怎么打，10 秒不点按自动：

- **自动**：自家按默认挑法出招，直接看演出。
- **AI 出招**：每轮到自家宠物出手，问设置页配的模型挑法宝或招式；模型想说就喊一句（比如「先用陀螺晕住它！」）。超时或挑了用不了的招，就按默认挑法出。
- **手动**：每轮到自家出手，面板列出这一手能用的法宝和招式（有次数的标剩几次），自己点；20 秒不点就按默认挑法出。

心魔试炼、串门切磋、隔空切磋、历练的守护战都能选。切磋时两边各管各的宠物：发起方先选，对方答应以后（熟人自动应战也一样）在自己的面板里选，两台电脑每一手互传各自的出手；中途掉线两边都不记账。对方的桌宠是旧版本时会提示「对方的桌宠还不会逐手切磋」；对方版本稍旧、由它发起并选了自动的，这一场照旧整场算好，你这边不弹面板。

### 招式与法宝

招式靠渡劫领悟，法宝靠心魔试炼和历练掉落，都在设置页「修炼」里能看到。有几门招式的演出比较特别：

- **降龙十八掌**：冲到对手跟前推掌，金龙虚影扑上去，打完退回原位。
- **送友风**：一阵清风把对方吹得飘起来，下一手出不了招；灵力压不过对方身法时会被站稳（控制类招式都按灵力对身法判定，不是必中）。串门切磋里打中还有几率直接把客人送回家，这一场和这趟串门就此结束。

### 历练：三王传承

右键「修炼/历练」进三王传承：

- 从三道光柱选一王，五层走到底，气血跨场；输了可以自爆催动春秋蝉倒回去（一趟一次）。
- 第四层青铜大殿里能识破白凝冰、改炼定仙游，第五层两种结局各打一位守护。
- 可选「压境入内」照原著封住法宝招式、只用这一王的一转蛊（修为 ×1.5）。
- 选法宝那一页能选出招方式：守护和天骄按选的方式打（手动的按钮在历练小窗里），小怪、精英照旧全自动。
- 走完一趟入账一次；关掉小窗、退出重开都能接着走。

## 设置

右键「设置」打开本机设置页，保存即生效：

- **AI 接口**：OpenAI 兼容 / Anthropic，填好可以「测试连接」。配置里还能用 `chatModel` 给对话单独指定服务商和模型，调用失败会自动回落到默认模型重试一次。
- **宠物**：名字、大小、人设、头顶状态 / 待在原地、说话配表情包、对话记住几轮；也能添加、删除宠物（多开），每只有自己的大小和位置（四角 + 水平 / 垂直边距）。
- **物理手感**：拖拽抛掷的重力、弹性、地面摩擦、总力度、顶部反弹、宠物互撞。
- **陪伴与提醒**：看屏幕间隔（秒）与模型不支持看图时降级成随口说一句，久坐 / 喝水 / 下班 / 回来打招呼。
- **局域网串门**、**邻居**：见上文。
- **修炼**：总开关，和境界、进度、属性、法宝、招式、破境丹、战绩一览。

字体、表情包、动画池等更多选项在配置文件里改，改完右键「重载配置」，见下面的高级配置。

**数据在哪**：

- macOS：`~/Library/Application Support/dsh-pet/dsh-pet/`（宠物配置、记忆、AI 设置、`app-config.json`、修炼存档、日记），日志在 `~/Library/Logs/dsh-pet/app.log`。
- Windows：`%APPDATA%\dsh-pet\dsh-pet\`，日志在 `%APPDATA%\dsh-pet\logs\app.log`。

下文的 `$DSH_HOME/dsh-pet/` 指的就是这个数据目录。

<details>
<summary><b>高级配置：配置文件、额外宠物、工作状态动画</b></summary>

设置页能改的只是一部分：配置文件和包内默认配置 `assets/config.jsonc` 是**同一套格式**，动画池、播放权重、事件动画、刷新周期等都能改，用户配置会**整体覆盖**对应字段的默认值。设置页的「同步」把包内 `config.jsonc` 的原文（含注释与全部高级字段）整份写入用户配置：既回到默认，又留下一份可直接编辑的完整配置。

### 默认宠物（config.jsonc）

应用包内 `assets/config.jsonc` 的 `pets` 数组定义**默认宠物**：

```jsonc
"pets": [
  { "id": "main", "size": 462, "position": { "corner": "top-right", "marginX": 24, "marginY": 100 } }
]
```

- 每只宠物：`id`（标识）／ `size`（宽度 px）／ `position`（corner 四角之一 + marginX/marginY 边距）
- 设置页的修改保存到用户层 `$DSH_HOME/dsh-pet/main-config.jsonc`（**完整宠物列表**，覆盖包内默认）；「同步」把包内 `config.jsonc` 原文整份写入该文件（等价于回落默认，但文件保留下来、可直接编辑）

### 用户配置文件 main-config.jsonc

用户层配置文件位于 `$DSH_HOME/dsh-pet/main-config.jsonc`。**它和包内默认配置是同一套格式**——想改什么直接照着 `assets/config.jsonc` 的结构写即可，写错的字段/缺失的字段回落默认，无需（也无法）写完整份。设置页「同步」可直接生成这份完整文件（原文复制包内 `config.jsonc`，注释齐全）：

| 字段                   | 作用                                                                                    | 格式与默认一致即可         |
| ---------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| `pets`                 | 宠物列表（大小/位置/多开）                                                              | 数组，每项同 `pets[]` 结构 |
| `animations`           | **动画池**：idle / turn / drag / clicks / moves / categories / events（说话、工作状态等事件动画） | 同 `animations` 结构       |
| `animationWeights`     | 动画链播放权重（idle / turn / move）                                                    | 同 `animationWeights` 结构 |
| `notificationsEnabled` | 系统通知总开关（布尔）                                                                  | 同 `notificationsEnabled`  |

> 覆盖语义：用户层给出即**整体替换**该字段（如写了 `animations` 就用你的整份动画池，替代默认），没写的字段回落包内默认。校验在启动时执行——格式错误会写进应用日志（`~/Library/Logs/dsh-pet/app.log`），不会静默运行残缺配置。

### 额外宠物（pet pack）：添加新「种类」

设置页和上面的配置文件都只调整**默认宠物的实例**（数量/大小/位置），动画池始终是全局一份。要添加**全新种类的宠物**（独立动画池 + 自己的素材），在用户数据根下建 `pet/` 目录：

```
$DSH_HOME/dsh-pet/
├─ main-config.jsonc           ← 主宠物配置（现有，不动）
├─ main-animation/webm/*.webm  ← 主宠物素材（现有，只属于 main）
└─ pet/
   ├─ pig-config.json          ← 额外宠物 pig 的配置（命名词干 = 种类名，实例 id 任意）
   └─ pig-animation/*.webm     ← pig 自己的动画素材（直接平铺，仿 main-animation）
```

每只额外宠物 = 一个 `-config.json` + 一个 `-animation/` 目录，同前缀配对；扫描 `pet/` 自动发现，桌面上同时生效。一个 `-config.json` 定义**一个「种类」**（动画池 + 素材目录），`pets` 数组可放该种类的**任意多只实例**（共享动画池与素材）：

```jsonc
// pet/pig-config.json —— 与 main-config.jsonc 同构的完整配置
{
  "notificationsEnabled": true,
  "pets": [
    {
      "id": "pig1",              // 实例 id（可多只；不必等于文件名前缀）
      "size": 420,
      "position": { "corner": "top-right", "marginX": 24, "marginY": 100 }
    },
    { "id": "pig2", "size": 360, "position": { "corner": "top-left", "marginX": 24, "marginY": 100 } }
  ],
  "animations": {
    "idle": ["待机"], "turn": [], "drag": [], "clicks": ["打滚"],
    "moves": { "default": { "minDist": 80, "maxDist": 360, "margin": 20, "leadSec": 2, "tailSec": 2 }, "actions": [] },
    "categories": [],
    "events": {}
  },
  "animationWeights": { "idle": 80, "turn": 0, "move": 0 }
}
```

规则（与主宠物**严格隔离**，绝不混用）：
- **素材只查自己的**：素材目录名 = 文件名前缀（`pet/pig-config.json` → `pet/pig-animation/`），该种类所有实例共用；动画 URL `/thumb/<前缀>/<名>.webm`，查不到即 404——绝不落到 `main-animation` 或包内素材
- **动画池不回落全局**：`animations` / `animationWeights` 必须写全（缺失即配置错误）
- 与主配置同构的约束：`pets` 每只字段完整合法、数组内 id 唯一、`animations` / `animationWeights` 结构校验同一套规则；`notificationsEnabled` 是全局属性，不归宠物文件管（写了忽略、不写不报错）
- 配置非法 / 缺少 `-animation/` 目录 / 实例 id 与主宠物冲突 → 加载时显式报错并跳过（不影响其他宠物）
- 设置页不列出文件宠物（改文件即生效，刷新可见；保存/同步不会把它们写进 `main-config.jsonc`）

### 工作状态动画

`pets[i].workStatusEnabled` 开启后，宠物跟随 Claude Code 等工作状态上报切「思考 / 工作 / 整理 / 等待 / 成功 / 出错」六档动画 + 头顶气泡：非终态动画循环播、气泡常驻；成功 / 出错播一遍、气泡 10 秒自动收起。

- **档位动画**：`animations.events.workStatus` 数组，索引即档位（勿在中间插入新档，只可追加末尾）
- **气泡文案**：`workStatusTexts` 每档可配多句随机，任务详情（todo）优先
- **档位候选数组**：任意档位槽位可写 `string | string[]`——数组 = 档内随机抽 1，循环播放自动轮换、避免连播同一段（说话档位同样适用）

</details>

## 命令行与 Claude Code（仅 macOS）

```sh
mkdir -p ~/.local/bin
ln -s /Applications/dsh-pet.app/Contents/Resources/pet-cli.mjs ~/.local/bin/dsh-pet   # 需要 node 在 PATH 里
dsh-pet say 你好      # 让桌宠说一句
dsh-pet look          # 看一眼屏幕吐槽；模型不支持看图时按人设说一句
dsh-pet activity      # 打印「主人此刻」的采样（调试用）
```

在 `~/.claude/settings.json` 的 `hooks` 里加上 `UserPromptSubmit`、`Notification`、`Stop`、`SessionEnd` 四个事件（已有 hooks 就合并进去），桌宠就能跟着 Claude Code 提醒你：Claude 等你确认权限时提醒；一轮活干了 30 秒以上、干完时叫你去看；开工时不打扰。hook 只读事件名、会话 id 和项目目录，不读你发的内容；桌宠没开时静默跳过，不会卡住 Claude Code。

<details>
<summary>hooks 配置</summary>

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.local/bin/dsh-pet hook",
            "timeout": 5,
            "async": true
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.local/bin/dsh-pet hook",
            "timeout": 5,
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.local/bin/dsh-pet hook",
            "timeout": 5,
            "async": true
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.local/bin/dsh-pet hook",
            "timeout": 5,
            "async": true
          }
        ]
      }
    ]
  }
}
```

</details>

## Windows 版的限制

Windows 版由 CI 构建（`.github/workflows/windows-check.yml` 手动触发：安装依赖 → 测试 → 打包 → 启动冒烟截图 → 安装包静默装、启动、卸载一遍；发版时 `release-app.yml` 把绿色版和安装包挂到 Release）。**没有 Windows 真机，只在 CI 上验证过能装、能启动、`/health` 应答和截到宠物窗口**，日常使用没有实测。

以下功能只在 macOS 版有，Windows 版没有：

- 前台应用采样（`lsappinfo`）：依赖它的「知道你在干嘛」（看屏幕降级时随口说的那句、对话里说你在用哪个应用）和宠物日记里的应用用时记录；没有它时仍能判断你在不在电脑前，只是不知道在用哪个应用；
- `dsh-pet` 命令行（`say` / `look` / `activity` / `hook`）；
- Claude Code hook。

其余应用内功能（桌面宠物、右键菜单、设置页、看屏幕、对话、串门、修炼）两边是同一份代码，但 Windows 上没有真机验证。

## 从源码构建

需要 Node ≥ 22.12 和 pnpm。

```sh
git clone https://github.com/yangfan000818-droid/dsh-pet.git
cd dsh-pet
pnpm install                  # 同时从 npmmirror 下载 Electron 43 到 node_modules/electron/dist
npm run install:mac           # 打包（自动 bundle + build:desktop-core）并替换 /Applications/dsh-pet.app
```

- 只想打包不安装：`npm run dist`，产物 `dist-app/mac-arm64/dsh-pet.app`（Windows 上是 `dist-app/win-unpacked/`；`node scripts/dist.mjs nsis` 另出安装包）。默认用 `node_modules/electron/dist`，需要时可用 `DSH_PET_ELECTRON_DIST` 指定别的 Electron 解压目录。
- 应用是 ad-hoc 签名（没有开发者证书）。自己构建的可以直接打开；别人构建好发给你的，先运行 `xattr -dr com.apple.quarantine /Applications/dsh-pet.app` 再打开。
- 签名只认 bundle id，重新构建后「屏幕录制」授权不用重新给。
- 开发调试可以不打包直接跑：`npm run bundle && npm run build:desktop-core && npm start`（从终端启动时，屏幕录制权限算在终端头上）。
- 测试：`npm test`；类型检查：`npm run typecheck`。

**发版**：改 `package.json` 的 `version`，在 GitHub 上发布同名 tag（如 `v0.4.0`）的 Release 并写好更新日志，`release-app.yml` 会自动构建 Windows 绿色版和安装包、挂到这个 Release 上。

## 自己做一只宠物

本项目的宠物动画是用 AI 视频工具生成、再抠成透明动画的。照下面的流程能换成你自己的宠物：替换 `assets/webm/` 后重新打包，或者做成额外宠物（见[设置](#设置)里的「高级配置」）。

### ① 提示词 → 源视频

用 AI 视频生成工具（如可灵、Runway、豆包等，本项目素材即由豆包生成），按 `prompts/桌面宠物 10 秒动作提示词.md` 的配方，一个动作生成一段 10 秒绿幕视频：

- 视频比例 16:9，背景纯绿幕（#00FF00）
- 人物位置/大小固定（头顶 ~20% 高度、脚底 ~85% 高度）
- 动作全程在画幅内，首尾帧为标准正面站立
- 每段动画按秒分解（0-10s 各阶段动作）

生成结果按动作各存一个 mp4，放入 `video/`。

> **源视频获取**：为控制仓库体积，`video/` 源视频不入 git。原作者仓库的 [Releases](https://github.com/PC2005-cloud/dsh-pet/releases/tag/assets-videos) 提供**打包压缩包**，浏览器直接下载即可：
>
> - `assets-videos.zip` —— 全部源视频压缩包（中文名 mp4，解压后放入 `video/`）
>
> 解压：`Expand-Archive assets-videos.zip`（Windows）或 `unzip assets-videos.zip`，把 mp4 放回 `video/` 即可运行素材链。

### ② 源视频 → 透明动画（素材链）

step02（透明视频）有**两条路线，按需二选一**（默认自动、人人可复现；效果不佳可用 PR 手工抠像覆盖）：

```sh
cd scripts/assets
# 路线 A（默认）：自动绿幕抠像（HSV 色相，无需人工）
python watermark_step01.py   # 水印遮罩填充 → step01/
python chroma_step02.py      # 绿幕抠像转透明 → step02/

# 路线 B（可选）：PR 手工抠像覆盖（针对含第三方物品/自动抠像效果不佳的动作）
#   1. 在 PR 里手工抠像，导出带 alpha 的透明 .mov（如 ProRes 4444 with Alpha）
#   2. 放入 pr/，文件名与动作名一致（如 吃白饭.mov）
python pr_import_step02.py   # pr/*.mov → step02/（透明 webm，覆盖该动作自动抠像结果）

# 后续步骤两条路线共用：
python normalize_step03.py   # 归一化 2160×1215 统一站立居中 → step03/
python encode_thumbs.py      # 转码 640×360 播放变体 → step04/
```

**依赖**：Python 3 + ffmpeg + numpy + scipy（素材链脚本自动用工作区 `.tools/` 下的 ffmpeg）。

> **本项目全部采用路线 B**（全部动作均为 PR 手工抠像）：对"含第三方物品/透明边缘复杂"的动作，自动 HSV 抠像易残边或误抠，PR 手动遮罩更精细。两条路线产出同一级 `step02/`，后续步骤完全一致；`chroma_step02.py` 保留为自动化兜底，任何动作仍可一键自动生成。

### ③ 动画 → 独立应用

```sh
# 把 step04 的播放变体同步进应用包（webm 直接 cp）
cp step04/*.webm assets/webm/   # 播放格式（VP9-alpha）
```

> 中间产物（step01-04）由脚本生成、不入仓库；`video/` 源视频和脚本是成果、入库维护。

## 效果预览

<details>
<summary>展开看全部动画</summary>

全部动画（640×360，应用实际播放用的资源）——GIF 预览存放于仓库 `assets/preview/`（raw 直链渲染，文件名采用拼音便于跨平台）；完整透明视频见 `assets/webm/`（VP9-alpha）：

**待机 / 转向**

<p>
  <img src="assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="待机呼吸休闲" title="待机呼吸休闲">
  <img src="assets/preview/dongzhangxiwang.gif" width="160" alt="东张西望" title="东张西望">
</p>

**移动**

<p>
  <img src="assets/preview/pangxie-zoulu.gif" width="160" alt="螃蟹走路" title="螃蟹走路">
  <img src="assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="原地漂浮踏步" title="原地漂浮踏步">
  <img src="assets/preview/yuandi-zuozhuan-benpao.gif" width="160" alt="原地左转奔跑" title="原地左转奔跑">
  <img src="assets/preview/feilai-feiqu.gif" width="160" alt="飞来飞去" title="飞来飞去">
  <img src="assets/preview/tiaozhe-zou.gif" width="160" alt="跳着走" title="跳着走">
  <img src="assets/preview/gulu-gulu-gundong.gif" width="160" alt="咕噜咕噜滚动" title="咕噜咕噜滚动">
  <img src="assets/preview/xiaosuibu-kuaipao.gif" width="160" alt="小碎步快跑" title="小碎步快跑">
  <img src="assets/preview/ceshen-huabu.gif" width="160" alt="侧身滑步" title="侧身滑步">
  <img src="assets/preview/yujian-feixing.gif" width="160" alt="御剑飞行" title="御剑飞行">
  <img src="assets/preview/qijing-feixing.gif" width="160" alt="骑鲸飞行" title="骑鲸飞行">
  <img src="assets/preview/qi-zixingche.gif" width="160" alt="骑自行车" title="骑自行车">
  <img src="assets/preview/huaban.gif" width="160" alt="滑板" title="滑板">
  <img src="assets/preview/taikongbu.gif" width="160" alt="太空步" title="太空步">
  <img src="assets/preview/lingbo-weibu.gif" width="160" alt="凌波微步" title="凌波微步">
  <img src="assets/preview/dundi.gif" width="160" alt="遁地" title="遁地">
  <img src="assets/preview/dilangzhu-dundi.gif" width="160" alt="地狼蛛遁地" title="地狼蛛遁地">
</p>

**小动作**

<p>
  <img src="assets/preview/youxian-hengga.gif" width="160" alt="悠闲哼歌" title="悠闲哼歌">
  <img src="assets/preview/chaoda-shenlanyao.gif" width="160" alt="超大伸懒腰" title="超大伸懒腰">
  <img src="assets/preview/yuandi-qiaoji-zhuomian-hudong.gif" width="160" alt="原地敲击桌面互动" title="原地敲击桌面互动">
  <img src="assets/preview/yuandi-zhongli-xiadun-yasuo.gif" width="160" alt="原地重力下蹲压缩" title="原地重力下蹲压缩">
  <img src="assets/preview/haqian-liantian.gif" width="160" alt="哈欠连天" title="哈欠连天">
  <img src="assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="原地小憩沉眠" title="原地小憩沉眠">
  <img src="assets/preview/nvpu-quxi-liyi.gif" width="160" alt="女仆屈膝礼仪" title="女仆屈膝礼仪">
  <img src="assets/preview/beixiayitiao-zhamao.gif" width="160" alt="被吓一跳" title="被吓一跳">
  <img src="assets/preview/xiaofudu-yuandi-360du-xuanzhuan-zhanshi.gif" width="160" alt="小幅度原地360度旋转展示" title="小幅度原地360度旋转展示">
  <img src="assets/preview/touchi-lingshi-bei-zhuazhu.gif" width="160" alt="偷吃零食被抓住" title="偷吃零食被抓住">
  <img src="assets/preview/yong-jingyu-weiba-paidadi.gif" width="160" alt="用鲸鱼尾巴拍打地面" title="用鲸鱼尾巴拍打地面">
  <img src="assets/preview/da-keshui-bei-jingxing.gif" width="160" alt="打瞌睡被惊醒" title="打瞌睡被惊醒">
  <img src="assets/preview/zhao-jingzi.gif" width="160" alt="照镜子" title="照镜子">
  <img src="assets/preview/zhengti-huanzhuang-shise.gif" width="160" alt="整体换装试色" title="整体换装试色">
  <img src="assets/preview/qingkuai-jilu.gif" width="160" alt="轻快记录" title="轻快记录">
  <img src="assets/preview/xie-daima.gif" width="160" alt="写代码" title="写代码">
  <img src="assets/preview/yaoshan-naliang.gif" width="160" alt="摇扇纳凉" title="摇扇纳凉">
  <img src="assets/preview/chenjian-shuaya.gif" width="160" alt="晨间刷牙" title="晨间刷牙">
</p>

**玩耍**

<p>
  <img src="assets/preview/yuandi-zhuanxin-wan-mofang.gif" width="160" alt="原地专心玩魔方" title="原地专心玩魔方">
  <img src="assets/preview/yuandi-dunxia-wan-wanju-qiche.gif" width="160" alt="原地蹲下玩玩具汽车" title="原地蹲下玩玩具汽车">
  <img src="assets/preview/jingyu-tu-paopao-texiao.gif" width="160" alt="鲸鱼吐泡泡特效" title="鲸鱼吐泡泡特效">
  <img src="assets/preview/yuandi-tiaoyue-zhuasui-touding-wupin.gif" width="160" alt="原地跳跃抓碎头顶物品" title="原地跳跃抓碎头顶物品">
  <img src="assets/preview/wan-youxi-qijibaituai.gif" width="160" alt="玩游戏气急败坏" title="玩游戏气急败坏">
  <img src="assets/preview/wan-shuiqiang.gif" width="160" alt="玩水枪" title="玩水枪">
  <img src="assets/preview/xiaotiqin-yanzou.gif" width="160" alt="小提琴演奏" title="小提琴演奏">
  <img src="assets/preview/lanjing-xianshi.gif" width="160" alt="蓝鲸现世" title="蓝鲸现世">
  <img src="assets/preview/youya-nvpuwu.gif" width="160" alt="优雅女仆舞" title="优雅女仆舞">
  <img src="assets/preview/qingkuai-yaobaiwu.gif" width="160" alt="轻快摇摆舞" title="轻快摇摆舞">
  <img src="assets/preview/keai-zhaiwu.gif" width="160" alt="可爱宅舞" title="可爱宅舞">
  <img src="assets/preview/chui-qiqiu.gif" width="160" alt="吹气球" title="吹气球">
  <img src="assets/preview/dongwu-huanrao.gif" width="160" alt="动物环绕" title="动物环绕">
  <img src="assets/preview/fang-fengzheng.gif" width="160" alt="放风筝" title="放风筝">
  <img src="assets/preview/chai-liwu.gif" width="160" alt="拆礼物" title="拆礼物">
  <img src="assets/preview/bian-gezi.gif" width="160" alt="变鸽子" title="变鸽子">
  <img src="assets/preview/puke-moshu.gif" width="160" alt="扑克魔术" title="扑克魔术">
  <img src="assets/preview/chou-tuoluo.gif" width="160" alt="抽陀螺" title="抽陀螺">
  <img src="assets/preview/chui-dizi.gif" width="160" alt="吹笛子" title="吹笛子">
  <img src="assets/preview/hudie-mifeng-huanrao-touding-kaihua.gif" width="160" alt="蝴蝶蜜蜂环绕头顶开花" title="蝴蝶蜜蜂环绕头顶开花">
  <img src="assets/preview/lu-mao.gif" width="160" alt="撸猫" title="撸猫">
  <img src="assets/preview/pingkong-shenghua.gif" width="160" alt="凭空生花" title="凭空生花">
  <img src="assets/preview/qi-muma.gif" width="160" alt="骑木马" title="骑木马">
  <img src="assets/preview/sanqiu-paojie.gif" width="160" alt="三球抛接" title="三球抛接">
  <img src="assets/preview/ti-jianzi.gif" width="160" alt="踢毽子" title="踢毽子">
  <img src="assets/preview/xiawuziqi.gif" width="160" alt="下五子棋" title="下五子棋">
  <img src="assets/preview/dangqiuqian.gif" width="160" alt="荡秋千" title="荡秋千">
</p>

**吃什么**

<p>
  <img src="assets/preview/chi-baifan.gif" width="160" alt="吃白饭" title="吃白饭">
  <img src="assets/preview/dakou-chi-lingshi.gif" width="160" alt="大口吃零食" title="大口吃零食">
  <img src="assets/preview/chi-token.gif" width="160" alt="吃Token" title="吃Token">
  <img src="assets/preview/chi-zaocan.gif" width="160" alt="吃早餐" title="吃早餐">
  <img src="assets/preview/chi-wucan.gif" width="160" alt="吃午餐" title="吃午餐">
  <img src="assets/preview/chi-wancan.gif" width="160" alt="吃晚餐" title="吃晚餐">
  <img src="assets/preview/chi-bingqilin-ronghua.gif" width="160" alt="吃冰淇淋融化" title="吃冰淇淋融化">
  <img src="assets/preview/chi-dazhaxie.gif" width="160" alt="吃大闸蟹" title="吃大闸蟹">
  <img src="assets/preview/chi-tanghulu.gif" width="160" alt="吃糖葫芦" title="吃糖葫芦">
  <img src="assets/preview/chi-changshoumian.gif" width="160" alt="吃长寿面" title="吃长寿面">
  <img src="assets/preview/chi-xigua.gif" width="160" alt="吃西瓜" title="吃西瓜">
  <img src="assets/preview/shuan-huoguo.gif" width="160" alt="涮火锅" title="涮火锅">
</p>

**时节**

<p>
  <img src="assets/preview/beiluoye-yanmo.gif" width="160" alt="被落叶淹没" title="被落叶淹没">
  <img src="assets/preview/zhongqiu-shangyue-chi-yuebing.gif" width="160" alt="中秋赏月吃月饼" title="中秋赏月吃月饼">
  <img src="assets/preview/duixueren.gif" width="160" alt="堆雪人" title="堆雪人">
  <img src="assets/preview/fang-yanhua.gif" width="160" alt="放烟花" title="放烟花">
  <img src="assets/preview/chi-zongzi.gif" width="160" alt="吃粽子" title="吃粽子">
  <img src="assets/preview/chi-niangao.gif" width="160" alt="吃年糕" title="吃年糕">
  <img src="assets/preview/chi-qingtuan.gif" width="160" alt="吃青团" title="吃青团">
  <img src="assets/preview/chi-labazhou.gif" width="160" alt="吃腊八粥" title="吃腊八粥">
  <img src="assets/preview/chi-chongyanggao.gif" width="160" alt="吃重阳糕" title="吃重阳糕">
  <img src="assets/preview/shou-hongbao.gif" width="160" alt="收红包" title="收红包">
  <img src="assets/preview/xie-fuzi.gif" width="160" alt="写福字" title="写福字">
  <img src="assets/preview/chuanzhenqiqiao.gif" width="160" alt="穿针乞巧" title="穿针乞巧">
  <img src="assets/preview/wu-shitou.gif" width="160" alt="舞狮头" title="舞狮头">
  <img src="assets/preview/taotang-nanguadeng.gif" width="160" alt="讨糖南瓜灯" title="讨糖南瓜灯">
  <img src="assets/preview/cha-zhuyu-shangju.gif" width="160" alt="插茱萸赏菊" title="插茱萸赏菊">
  <img src="assets/preview/fanghedeng.gif" width="160" alt="放河灯" title="放河灯">
  <img src="assets/preview/menghua-xiaoyouling.gif" width="160" alt="萌化小幽灵" title="萌化小幽灵">
  <img src="assets/preview/zhuangdian-shengdanshu.gif" width="160" alt="装点圣诞树" title="装点圣诞树">
  <img src="assets/preview/fang-kongmingdeng.gif" width="160" alt="放孔明灯" title="放孔明灯">
  <img src="assets/preview/chitangyuan.gif" width="160" alt="吃汤圆" title="吃汤圆">
  <img src="assets/preview/chijiaozi.gif" width="160" alt="吃饺子" title="吃饺子">
</p>

**文字**

<p>
  <img src="assets/preview/shia-chishenme.gif" width="160" alt="是啊，吃什么" title="是啊，吃什么">
  <img src="assets/preview/shendu-sikao-suisuinian.gif" width="160" alt="深度思考碎碎念" title="深度思考碎碎念">
</p>

**点击回应**

<p>
  <img src="assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="点击回应-开心跃动" title="点击回应-开心跃动">
  <img src="assets/preview/dianji-huiying-haixiu-jingya.gif" width="160" alt="点击回应-害羞惊讶" title="点击回应-害羞惊讶">
  <img src="assets/preview/dianji-huiying-aojiao-shengqi-ceshen-zhanshi.gif" width="160" alt="点击回应-傲娇生气" title="点击回应-傲娇生气">
  <img src="assets/preview/dianji-huiying-naoyang-gegexiao.gif" width="160" alt="点击回应-挠痒咯咯笑" title="点击回应-挠痒咯咯笑">
  <img src="assets/preview/dianji-huiying-yuanqi-huishou.gif" width="160" alt="点击回应-元气挥手" title="点击回应-元气挥手">
</p>

**拖拽**

<p>
  <img src="assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="被鼠标拖拽悬空反馈" title="被鼠标拖拽悬空反馈">
</p>


**碎碎念说话动画**（碎碎念 / 对话回复触发，随机抽 1 段）

<p>
  <img src="assets/preview/suisuinian-cazhuo-suisuinian.gif" width="160" alt="碎碎念-擦桌碎碎念" title="碎碎念-擦桌碎碎念">
  <img src="assets/preview/suisuinian-fadai-suisuinian.gif" width="160" alt="碎碎念-发呆碎碎念" title="碎碎念-发呆碎碎念">
  <img src="assets/preview/suisuinian-duiping-suisuinian.gif" width="160" alt="碎碎念-对屏碎碎念" title="碎碎念-对屏碎碎念">
</p>

**工作状态动画**（跟随工作状态上报，六档：思考 / 工作 / 整理 / 等待 / 成功 / 出错）

<p>
  <img src="assets/preview/gongzuozhuangtai-sikao-maopao.gif" width="160" alt="工作状态-思考冒泡" title="工作状态-思考冒泡">
  <img src="assets/preview/gongzuozhuangtai-manglu-dianan.gif" width="160" alt="工作状态-忙碌点按" title="工作状态-忙碌点按">
  <img src="assets/preview/gongzuozhuangtai-qingdian-guidang.gif" width="160" alt="工作状态-清点归档" title="工作状态-清点归档">
  <img src="assets/preview/gongzuozhuangtai-yuandi-duobu-zhangwang.gif" width="160" alt="工作状态-原地踱步张望" title="工作状态-原地踱步张望">
  <img src="assets/preview/gongzuozhuangtai-queyue-qingzhu.gif" width="160" alt="工作状态-雀跃庆祝" title="工作状态-雀跃庆祝">
  <img src="assets/preview/gongzuozhuangtai-chuitou-tanqi-maohan.gif" width="160" alt="工作状态-垂头叹气冒汗" title="工作状态-垂头叹气冒汗">
</p>

> 注：动画为透明背景；GIF 预览中透明部分显示为页面底色，实际 webm 播放为透明。

</details>

## 项目结构

只列代码与素材链相关目录；素材链的 video / scripts/assets / step / pr 见 ② 章节（gitignore 的本地目录不列）：

```
├── README.md          # 说明
├── prompts/           # ① 动画生成提示词配方（绿幕规范 + 按秒分解）
├── docs/              # 任务书与设计文档；screenshots/ 是仓库展示用截图
├── tools/             # 开发工具：DPI 探针、透明 WebM 预览页
├── .github/workflows/ # CI：Windows 打包发版（release-app.yml）与冒烟（windows-check.yml）
├── src/               # ③ 独立应用（Electron）
│   ├── host/          # 本机服务：配置 / 路由 / 碎碎念 / 工作状态
│   ├── shared/        # 主进程与渲染端共用纯逻辑
│   ├── app/           # 独立应用入口与各项功能
│   └── standalone/    # AI 设置页与模型服务
├── lib/               # 构建产物（npm run bundle 生成，不入库）
├── runtime/           # 桌面运行壳（Electron 透明窗）
├── assets/            # webm 动画 / preview GIF / 字体 / 图标 / config.jsonc 默认配置
├── scripts/           # 构建、打包与开发脚本；scripts/assets/ 是素材链脚本（Python）
└── LICENSE            # MIT
```

## 许可

- 代码：MIT
- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**
- **二次创作（二创）约定**：基于本项目的衍生 / 改版 / 换皮作品，在**任何介绍、展示、分发该作品的地方**，须附上原作者 GitHub 地址：<https://github.com/PC2005-cloud/dsh-pet>
