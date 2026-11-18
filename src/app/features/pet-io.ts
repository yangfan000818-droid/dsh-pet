import { flattenPetList, readAllConfig } from '../../host/config';
import { LOCK_MAX_TTL_MS } from '../../host/lock';
import { LINE_MS } from '../battle-show';
import type { Step } from '../battle-show';
import type { FeatureContext } from './context';
import { errorText } from './util';

/** 演出占着宠物的锁比时间线多留这么久：演完还要停 CLOSE_HOLD_MS 才放，定时器也会有点漂 */
const SHOW_LOCK_SPARE_MS = 30_000;

/** 桌宠路由、占锁：发插件请求、演出的占用锁 */
export interface PetIo {
  petId(): string;
  petRequest(method: string, path: string, body?: unknown): Promise<Record<string, unknown>>;
  holdPet(steps: Step[], durationMs?: number): Promise<void>;
  releasePet(afterMs: number, held?: Promise<void>): void;
}

export function createPetIo(ctx: FeatureContext): PetIo {
  const { deps, log } = ctx;
  let latestHold: Promise<void> | undefined;
  /** 当前目标宠物：main（没有就取第一只）；配置读不到时按 main */
  function petId(): string {
    try {
      const pets = flattenPetList(readAllConfig(deps.configPaths));
      const target = pets.find((pet) => String(pet.id) === 'main') ?? pets[0];
      return target ? String(target.id) : 'main';
    } catch {
      return 'main';
    }
  }

  /** 发一个插件请求；演出占着宠物时带上那把锁（见 holdPet），锁没了就不带它重发一次 */
  async function petRequest(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const lockId = ctx.state.showLock;
    const result = await petFetch(method, path, body, lockId);
    if (lockId === null || result.reason !== 'lock-lost') return result;
    // 演出的锁没了（用户点了 / 拖了宠物，或者到期了）：接下来照没锁的老样子演，这一下不带锁重发
    if (ctx.state.showLock === lockId) ctx.state.showLock = null;
    log(`演出的占用锁没了（${String(result.cause)}），接着不占着宠物演`);
    return petFetch(method, path, body, null);
  }

  async function petFetch(
    method: string,
    path: string,
    body: unknown,
    lockId: string | null,
  ): Promise<Record<string, unknown>> {
    const url = new URL(deps.petBase + path);
    url.searchParams.set('pet', petId());
    if (lockId !== null) url.searchParams.set('lock', lockId);
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return { ok: true };
    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * 开演前占住自家宠物（见 showLock）：锁的时长按这一场的时间线算，再留出收场的余量。
   * 上一场刚演完、锁还没放：续上同一把（续不上就重新拿）。拿不到只记一行，照没锁的老样子演。
   * @param durationMs 逐手出招（X17）事先不知道一场多久：给一个够用的时长，别让手还没出完锁就到期
   */
  function holdPet(steps: Step[], durationMs?: number): Promise<void> {
    if (ctx.state.showLockRelease !== null) clearTimeout(ctx.state.showLockRelease);
    ctx.state.showLockRelease = null;
    const showMs = durationMs ?? (steps.length ? steps[steps.length - 1].at + LINE_MS : 0);
    const ttl = Math.min(LOCK_MAX_TTL_MS, showMs + SHOW_LOCK_SPARE_MS);
    // 上一场可能快进到收场了，但它的锁还在路上；等到手后再续，避免发出两次新建请求。
    const held = latestHold ? latestHold.then(() => acquire(ttl)) : acquire(ttl);
    latestHold = held;
    return held;
  }

  async function acquire(ttl: number): Promise<void> {
    let failure = '';
    for (const lockId of ctx.state.showLock === null ? [null] : [ctx.state.showLock, null]) {
      try {
        const result = await petFetch('POST', '/lock', lockId === null ? { ttl } : { lockId, ttl }, null);
        if (result.ok === true && typeof result.lockId === 'string') {
          ctx.state.showLock = result.lockId;
          return;
        }
        failure = JSON.stringify(result);
      } catch (error) {
        failure = errorText(error);
      }
    }
    ctx.state.showLock = null;
    log(`演出占不住宠物：${failure}`);
  }

  /** 快进时锁可能仍在路上；它到手后再释放，已被下一场接管则不动。 */
  function releasePet(afterMs: number, held?: Promise<void>): void {
    const owner = held ?? latestHold;
    const release = (): void => {
      if (latestHold !== owner) return;
      if (ctx.state.showLockRelease !== null) clearTimeout(ctx.state.showLockRelease);
      ctx.state.showLockRelease = setTimeout(() => {
        ctx.state.showLockRelease = null;
        if (latestHold !== owner) return;
        const lockId = ctx.state.showLock;
        if (lockId === null) return;
        ctx.state.showLock = null;
        petFetch('POST', '/lock/release', { lockId }, null)
          .then((result) => {
            if (result.ok !== true) log(`演出放开宠物失败：${JSON.stringify(result)}`);
          })
          .catch((error: unknown) => log(`演出放开宠物失败：${errorText(error)}`));
      }, afterMs);
    };
    if (held) void held.then(release, release);
    else release();
  }
  return { petId, petRequest, holdPet, releasePet };
}
