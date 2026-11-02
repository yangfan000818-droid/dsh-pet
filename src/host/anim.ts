/**
 * 播放动画（`POST /dsh-pet-7340/anim`）的**纯决策层**。
 *
 * 用途：宿主侧其他插件想让桌宠播一段动画（"点播"），效果与右键菜单里点「动作」树完全一致
 * ——两端都复用同一个菜单动作处理函数，本模块只负责**判定该不该播、播哪一个**。
 *
 * 两种形态（issue #122 第 1 条）：`name` = 池内的动画名，**名字必须在菜单能点到的集合里**；
 * `url` = 第三方自带的素材地址，**不查池**（素材在别人手里）。两者二选一，由本模块判定。
 *
 * 为什么单独一层：契约就是这几条校验规则。播放端对不存在的动画没有兜底（名字即文件名，
 * 404 → 加载失败 → 表现为"点了没反应"），所以名字校验是硬要求，且必须能脱离 HTTP 单测。
 * 本模块只依赖配置（动画池都在 animations 里，不碰文件系统），可完全离线测。
 *
 * 允许集合 = 右键菜单三级树叶里所有 `anim` 的并集。菜单树的唯一事实来源是
 * src/shared/menu.ts 的 buildMenuTree()，它取这 7 个池：idle / turn / drag / clicks /
 * moves.actions / categories / events。
 * **host 不 import src/shared**（DSH 单文件加载约束，见 index.ts 顶部说明），所以这里按同一
 * 口径自包含实现一份；两边的守卫测试会同时钉住这份口径，任一侧改了池子就会有一边失败。
 */

import { findPetInstance } from './config';

/** 点播失败的分类（路由原样透出给调用方） */
export type AnimFailure = 'bad-request' | 'pet-required' | 'unknown-pet' | 'unknown-animation';

/**
 * 朝向：`left` = 素材原样，`right` = 镜像（渲染端贴 `scaleX(-1)`）。
 * **与 shared/state.ts 的同名联合体是两份**——宿主不 import src/shared（同 `Corner`、`PositionMode`
 * 的处理方式），改动时两边要一起改。
 */
export type PetFacing = 'left' | 'right';

/** 倍速的合法区间（X3 的演出用：让一段素材正好占满时间线上的一步） */
export const ANIM_RATE_MIN = 0.5;
export const ANIM_RATE_MAX = 3;

/** 决策结论：通过则给出最终要写进 S 的内容（`name` 与 `url` **恰好一个**），否则给出显式原因。
 *  `facing` **可选**：undefined = 调用方没指定，渲染端**不动朝向**（不是"回落 left"）。
 *  `rate` **可选**：undefined = 常速；给了就是渲染端这一段要设的 `video.playbackRate`。
 *  `target` **可选**：移动动画的显式终点（宠物中心的归一化坐标），给了就走到那里而不是随机距离。 */
export type AnimDecision =
  | {
      ok: true;
      petId: string;
      name?: string;
      url?: string;
      facing?: PetFacing;
      rate?: number;
      target?: { x: number; y: number };
    }
  | { ok: false; reason: AnimFailure; message: string };

/** 字符串数组收窄（配置里的池子；非数组/空串 → 空数组） */
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/** 朝向收窄：只认两个字面量（大小写、空白、非字符串一律不算），不认识返回 `null` */
const petFacing = (v: unknown): PetFacing | null => (v === 'left' || v === 'right' ? v : null);

/** 移动动作池（`animations.moves.actions[].name`），也是唯一允许带 `target` 的一类动画 */
function moveActionNames(animations: unknown): string[] {
  const a = (animations && typeof animations === 'object' ? animations : {}) as Record<string, unknown>;
  const moves = (a.moves && typeof a.moves === 'object' ? a.moves : {}) as Record<string, unknown>;
  return Array.isArray(moves.actions)
    ? moves.actions
        .map((m) => (m && typeof m === 'object' ? (m as { name?: unknown }).name : undefined))
        .filter((x): x is string => typeof x === 'string' && x !== '')
    : [];
}

/**
 * 该条目的 animations 配置 → 可点播的动画名（去重，保持首次出现顺序）。
 * 池子与顺序对齐 src/shared/menu.ts 的 buildMenuTree()：
 *   待机 → 转向 → 拖拽 → 点击回应 → 移动 → config 随机动作分类 → 事件（数组槽位展平）
 */
export function animationNames(animations: unknown): string[] {
  const a = (animations && typeof animations === 'object' ? animations : {}) as Record<string, unknown>;
  const out: string[] = [];
  const push = (names: string[]): void => {
    for (const n of names) if (!out.includes(n)) out.push(n);
  };

  push(strings(a.idle));
  push(strings(a.turn));
  push(strings(a.drag));
  push(strings(a.clicks));

  // 移动：actions 是 { name, ... } 对象数组，只取 name
  push(moveActionNames(a));

  // config 随机动作分类：每个分类一个 actions 池
  if (Array.isArray(a.categories)) {
    for (const c of a.categories) {
      if (c && typeof c === 'object') push(strings((c as { actions?: unknown }).actions));
    }
  }

  // 事件动画：值是「档位数组」，每档可能是单个名字或候选数组（展平）
  const events = (a.events && typeof a.events === 'object' ? a.events : {}) as Record<string, unknown>;
  for (const key of Object.keys(events)) {
    const pool = events[key];
    if (!Array.isArray(pool)) continue;
    const names: string[] = [];
    for (const slot of pool) {
      if (typeof slot === 'string') names.push(slot);
      else names.push(...strings(slot));
    }
    push(names);
  }

  return out;
}

/**
 * 第三方资源地址规范化：只放行 **http / https 的完整 URL**，其余一律 null（调用方回 bad-request）。
 *
 * 为什么只放行这两种 scheme：桌面端换源是 `el.src = url` **直连**（不经 `/thumb`），`file:` 会让
 * 渲染端能读本地任意文件；`javascript:` / `data:` 更没有理由开这个口。
 *
 * **跨域不在这里解决、也不该在这里解决**：浏览器端素材走 `fetch` + blob，CORS 由浏览器强制，
 * 插件在 JS 里绕不过去。第三方只有两条路——自己配 `Access-Control-Allow-Origin`，或在同一个
 * DSH webServer 上注册自己的路由（同源，天然无 CORS）。宿主**不做代理**，因此也没有 SSRF 面。
 *
 * 与 ./broadcast 共用这一条规则（两个"第三方投喂"端点的 url 参数是同一条口径，不各写一份）。
 */
export function normalizeHttpUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const raw = v.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return raw;
}

/**
 * 把外部给的点播请求与当前配置核对成一个结论。
 *
 * `name` 与 `url` **二选一**（issue #122 第 1 条的"资源注册"）：`url` 是第三方自带的素材地址，
 * 给了它就不查动画池——素材在别人手里，池里当然没有这个名字；`name` 照旧必须是池内的名字。
 * 两个都给 / 都不给都是**意图不明**，直接 bad-request，不替调用方猜一个。
 *
 * @param cfg readAllConfig 的合并成品（所有字段已填满，这里不做兜底解析）
 * @param requested `?pet=` 的原值（**必填**：空串 → `pet-required`）
 * @param name 外部给的动画名（未规范化）
 * @param url 外部给的素材地址（未规范化）
 * @param facing 外部给的朝向（**可选**：没给 → 渲染端不动朝向）
 * @param rate 外部给的倍速（**可选**：没给 → 常速）
 * @param target 外部给的移动终点（**可选**：{x,y} 归一化坐标；只允许移动动作 + name 形态）
 */
export function decideAnim(args: {
  cfg: Record<string, Record<string, unknown>>;
  requested: string;
  name: unknown;
  url: unknown;
  facing?: unknown;
  rate?: unknown;
  target?: unknown;
}): AnimDecision {
  const { cfg, requested } = args;

  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
  if (name && rawUrl) return { ok: false, reason: 'bad-request', message: 'name 与 url 只能给一个' };
  if (!name && !rawUrl) return { ok: false, reason: 'bad-request', message: 'name 或 url 必须给一个' };

  // target **可选**：必须同时有 x/y 两个有限数字，越界夹到 0~1（与 /position 同一口径）。
  // 只跟 name 形态的移动动作一起用——url 是裸地址，渲染端不走菜单语义；非移动动作也不会挪窗口。
  let target: { x: number; y: number } | undefined;
  if (args.target !== undefined && args.target !== null) {
    const t =
      typeof args.target === 'object' && !Array.isArray(args.target)
        ? (args.target as { x?: unknown; y?: unknown })
        : null;
    if (!t || typeof t.x !== 'number' || !Number.isFinite(t.x) || typeof t.y !== 'number' || !Number.isFinite(t.y)) {
      return { ok: false, reason: 'bad-request', message: 'target 必须是 { x, y } 两个有限数字（归一化坐标）' };
    }
    target = { x: Math.min(1, Math.max(0, t.x)), y: Math.min(1, Math.max(0, t.y)) };
  }
  if (rawUrl && target) {
    return { ok: false, reason: 'bad-request', message: 'target 只能跟 name 形态的移动动画一起用' };
  }

  // facing **可选**：没给（undefined / null——调用方复用 body 模板时两种都常见）→ **不动朝向**，
  // 保持宠物当前朝向，而不是"回落 left"。给了就必须合法：非法值不静默忽略（与 /position 的 mode
  // 同一口径，全插件没有"非法值当没传"的先例）。放在宠物解析之前——参数是调用方的错，先纠它。
  let facing: PetFacing | undefined;
  if (args.facing !== undefined && args.facing !== null) {
    const f = petFacing(args.facing);
    if (f === null) return { ok: false, reason: 'bad-request', message: 'facing 必须是 left / right' };
    facing = f;
  }

  // rate **可选**（0.5–3）：没给（undefined / null）→ 常速，叶子里连字段都不写；给了就必须是区间内的
  // 有限数，非法值不静默忽略（与 facing 同一口径）。同样放在宠物解析之前——参数是调用方的错，先纠它。
  let rate: number | undefined;
  if (args.rate !== undefined && args.rate !== null) {
    if (
      typeof args.rate !== 'number' ||
      !Number.isFinite(args.rate) ||
      args.rate < ANIM_RATE_MIN ||
      args.rate > ANIM_RATE_MAX
    ) {
      return { ok: false, reason: 'bad-request', message: `rate 必须是 ${ANIM_RATE_MIN}–${ANIM_RATE_MAX} 的数` };
    }
    rate = args.rate;
  }

  // pet **必填**且必须真实存在（与 /broadcast、/position 同一口径）。收紧前这里是
  // `requested || active || 'main'`——`active` 是"当前桌宠" = **有效宠物列表第一只**，
  // 落点随用户 /pet 操作而变，第三方无从预期，所以整条缺省链已删除（issue #122 第 1 条）。
  const petId = String(requested ?? '').trim();
  if (!petId) return { ok: false, reason: 'pet-required', message: 'pet 必填：要指定操作哪只桌宠' };
  // **一次查找同时给出"存在性"与"所属条目"**（动画池按条目取）：校验与取值用同一份结果，
  // 后面不必再查一次，也就不留"查不到时兜底 main"那种**不可达分支**（老代码允许 pet 缺省，
  // 那时确实可能查不到）。
  const found = findPetInstance(cfg, petId);
  if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };

  // url 形态：地址合法即放行。**不查动画池、也不要求素材真的取得到**——播放端对取不到的地址
  // 没有兜底（浏览器 fetch 失败 / 桌面 video error），会经回执如实报 failed，而不是在这里猜。
  if (rawUrl) {
    const url = normalizeHttpUrl(rawUrl);
    if (url === null) {
      return { ok: false, reason: 'bad-request', message: 'url 必须是 http/https 的完整地址' };
    }
    return { ok: true, petId, url, facing, rate };
  }

  // name 形态：名字必须是该宠物菜单里点得到的动画。播放端"名字即文件名"，播不存在的动画只会静默失败，
  // 所以必须在这里拦住，而不是写进 S 让前端白跑一趟。
  const allowed = animationNames(found.conf.animations);
  if (!allowed.includes(name)) {
    return { ok: false, reason: 'unknown-animation', message: '没有这个动画：' + name };
  }
  if (target && !moveActionNames(found.conf.animations).includes(name)) {
    return { ok: false, reason: 'bad-request', message: 'target 只能用在移动动作上：' + name };
  }

  return { ok: true, petId, name, facing, rate, target };
}
