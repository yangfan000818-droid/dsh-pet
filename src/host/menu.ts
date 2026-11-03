/**
 * 第三方右键菜单注册表（进程内存态，DSH 重启即清空；不落盘）。
 *
 * 用途：别的插件想在桌宠右键菜单里加自己的入口，就走这里注册；用户点了之后，注册方用它自己的
 * owner 去查"我这一项被点了没有、是哪只宠物上点的"。
 *
 * 数据形状（两层，没有第三层）：
 *
 *   owners: Map<owner, Map<label, petId | null>>
 *           键 = owner（身份键，同时也是一级分组名）
 *           值 = label → 触发它的宠物 id；null = 没点过
 *
 * 语义要点（实现前先读完，都是刻意的）：
 *  - **注册 = 整体覆盖**：该 owner 的菜单项 = 本次 labels 事件（不在列表里的项连同触发标记一起
 *    丢弃）。没有单独的删除接口——注销就再注册一个空列表？不，空列表按非法处理（400），
 *    所以"不想要了"只能注册一份新的（或等进程重启）。这是有意的：菜单项生命周期与插件一致。
 *  - **同 owner 内 label 唯一**：重复 label 去重（保留第一次出现的顺序）。
 *  - **点击是闩锁不是队列**：同一项连点两次，查询只看到"点过"一次；不计数、不排序。
 *  - **查询即清空**（读取即消费）：返回后把这些标记全部清成 null。没有确认、没有重投——
 *    查询方没处理完就崩了，这次触发就丢了（对"用户点了一下菜单"这种一次性触发是合理取舍）。
 *  - **一个 owner 只该有一个消费者**：两个进程同时查会互抢（谁先返回谁拿到标记）。
 *
 * 限额（防本机进程把菜单/内存刷爆）：
 *  - owner ≤ 64 字符、label ≤ 32 字符（都允许中文，trim 后非空，禁控制字符）
 *  - 每 owner ≤ 24 项、全局 ≤ 32 个 owner
 */

/** owner 长度上限 */
const OWNER_MAX = 64;
/** 单个菜单项 label 长度上限（面板宽 150–240px，再长会被省略号截断） */
const LABEL_MAX = 32;
/** 每 owner 菜单项上限 */
const ITEMS_MAX = 24;
/** 全局 owner 上限 */
const OWNERS_MAX = 32;
/** 长轮询等待上限（与 /state 同一量级：调用方一次最多挂这么久） */
export const MENU_WAIT_MAX_MS = 10_000;

/** 控制字符（换行/制表等会把菜单布局搞炸，一律拒绝） */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** 一条菜单项快照（写进 /state 的 sections.menu，两端据此拼「更多」） */
export interface MenuItemSnapshot {
  owner: string;
  label: string;
}

/** 注册结果：业务失败按插件口径回 `{ ok:false, reason, message }`（HTTP 200），不是 400 */
export type MenuRegisterResult = { ok: true } | { ok: false; reason: string; message: string };

/** 校验一个显示用字符串：必须是 string、trim 后非空、不超长、无控制字符 */
function displayText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > max || CONTROL_CHARS.test(text)) return null;
  return text;
}

export class MenuRegistry {
  // 用 declare + 构造器赋值（不用类字段初始化器）：类字段会降级出 @oxc-project/runtime 外部
  // helper，而它是未声明的依赖，会被 prepack 门禁拦下（同 src/host/state.ts 的约定）。
  /** owner → (label → 触发它的 petId；null = 未触发) */
  declare private readonly owners: Map<string, Map<string, string | null>>;
  /** owner → 挂在该 owner 上的长轮询唤醒回调 */
  declare private readonly waiters: Map<string, Set<() => void>>;

  constructor() {
    this.owners = new Map();
    this.waiters = new Map();
  }

  /**
   * 注册（整体覆盖）：`{ owner, labels: string[] }`。
   *
   * 覆盖的粒度是 **owner 的全部菜单项**，不是逐项 upsert：这样注册方每次都能用一份完整列表
   * 描述"我现在有什么"，不必关心上次注册了什么，也不会留下已下线的僵尸项。
   */
  register(raw: unknown): MenuRegisterResult {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: 'bad-request', message: 'body 必须是 { owner, labels }' };
    }
    const body = raw as Record<string, unknown>;
    const owner = displayText(body.owner, OWNER_MAX);
    if (owner === null) {
      return { ok: false, reason: 'invalid-owner', message: `owner 必须是 1–${OWNER_MAX} 字符的字符串（禁控制字符）` };
    }

    const rawLabels = body.labels;
    if (!Array.isArray(rawLabels) || rawLabels.length === 0) {
      return { ok: false, reason: 'invalid-labels', message: 'labels 必须是非空数组' };
    }
    if (rawLabels.length > ITEMS_MAX) {
      return { ok: false, reason: 'too-many-items', message: `每个 owner 最多 ${ITEMS_MAX} 项` };
    }

    const labels: string[] = [];
    for (const rawLabel of rawLabels) {
      const label = displayText(rawLabel, LABEL_MAX);
      if (label === null) {
        return {
          ok: false,
          reason: 'invalid-label',
          message: `每个 label 必须是 1–${LABEL_MAX} 字符的字符串（禁控制字符）`,
        };
      }
      if (!labels.includes(label)) labels.push(label); // 同 owner 内去重（保留首次出现的位置）
    }

    if (!this.owners.has(owner) && this.owners.size >= OWNERS_MAX) {
      return { ok: false, reason: 'too-many-owners', message: `最多 ${OWNERS_MAX} 个 owner` };
    }
    this.owners.set(owner, new Map(labels.map((label) => [label, null] as const)));
    return { ok: true };
  }

  /**
   * 清掉一个 owner 的全部菜单项（连它上面未取走的触发标记一起丢）。
   *
   * 幂等：owner 本来就不存在 → `removed: 0`，仍算成功——调用方重试注销时不该看到错误。
   * 挂在该 owner 上的长轮询会被叫醒，醒来后查不到 owner → `null`（路由回 `ok:false` +
   * `unknown-owner`），调用方据此知道要重新注册。
   */
  clear(rawOwner: unknown): { ok: true; removed: number } | { ok: false; reason: string; message: string } {
    const owner = displayText(rawOwner, OWNER_MAX);
    if (owner === null) {
      return { ok: false, reason: 'invalid-owner', message: `owner 必须是 1–${OWNER_MAX} 字符的字符串（禁控制字符）` };
    }
    const items = this.owners.get(owner);
    if (!items) return { ok: true, removed: 0 };
    const removed = items.size;
    this.owners.delete(owner);
    const waiters = this.waiters.get(owner);
    this.waiters.delete(owner);
    if (waiters) for (const wake of [...waiters]) wake();
    return { ok: true, removed };
  }

  /** 全量快照（写进 state；顺序 = 注册顺序 + 列表顺序，两端渲染顺序与它一致） */
  snapshot(): MenuItemSnapshot[] {
    const out: MenuItemSnapshot[] = [];
    for (const [owner, items] of this.owners) {
      for (const label of items.keys()) out.push({ owner, label });
    }
    return out;
  }

  /**
   * 渲染端上报一次点击：把该项标成"被 petId 点了"，并叫醒该 owner 上挂着的长轮询。
   *
   * `delivered = false`（项不存在：菜单刚好被覆盖/还没注册）**不算错误**——渲染端拿着的是
   * 上一拍 /state 的快照，这一拍菜单已经变了，属于正常竞态，路由仍回 200。
   */
  click(raw: unknown): { ok: true; delivered: boolean } {
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const owner = typeof body.owner === 'string' ? body.owner : '';
    const label = typeof body.label === 'string' ? body.label : '';
    const pet = typeof body.pet === 'string' ? body.pet.trim() : '';
    const items = this.owners.get(owner);
    if (!items || !items.has(label) || pet === '') return { ok: true, delivered: false };
    items.set(label, pet);
    const waiters = this.waiters.get(owner);
    if (waiters) for (const wake of [...waiters]) wake();
    return { ok: true, delivered: true };
  }

  /**
   * 查询触发：返回 `{ label: petId | null }` 全量映射，**返回即清空**这些标记。
   *
   * `waitMs > 0` 且当下没有任何触发 → 挂起等待（该 owner 被点/超时/被覆盖都会唤醒），
   * 超时后照常返回全 null 的映射。owner 不存在 → null（路由回 404，调用方据此知道要重新注册）。
   */
  async poll(owner: string, waitMs: number): Promise<Record<string, string | null> | null> {
    const items = this.owners.get(owner);
    if (!items) return null;

    if (waitMs > 0 && !hasFired(items)) {
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(owner) ?? new Set<() => void>();
        this.waiters.set(owner, set);
        const hold: { timer?: ReturnType<typeof setTimeout> } = {};
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (hold.timer !== undefined) clearTimeout(hold.timer);
          set.delete(finish);
          if (set.size === 0 && this.waiters.get(owner) === set) this.waiters.delete(owner);
          resolve();
        };
        hold.timer = setTimeout(finish, Math.min(waitMs, MENU_WAIT_MAX_MS));
        set.add(finish);
      });
    }

    // 等待期间可能被整体覆盖（注册新的 labels）——重新取一次，别拿旧 Map 的结果
    const current = this.owners.get(owner);
    if (!current) return null;
    const out: Record<string, string | null> = {};
    for (const [label, pet] of current) {
      out[label] = pet;
      current.set(label, null); // 读取即消费
    }
    return out;
  }
}

/** 该 owner 当前有没有任意一项被点过 */
function hasFired(items: Map<string, string | null>): boolean {
  for (const pet of items.values()) if (pet !== null) return true;
  return false;
}
