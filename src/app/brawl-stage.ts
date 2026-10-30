/**
 * X27 群架的环形摆位（纯函数，不碰 Electron）。
 *
 * 设计见 `docs/x27-brawl-design.md` §4.1：
 *   - 编号 0（本机宠物）在正下方 6 点钟，其余按编号顺时针等分（3 人 120°、4 人 90°、5 人 72°）；
 *   - 人越少窗口越大：3 人接近 1v1 尺寸，5 人缩到最小档，但宽不低于 120px；
 *   - 放不下时先平移整环（必要时移动环心），再让所有窗口等比缩小，绝不减少人数。
 *
 * 这里只算矩形与朝向。舞台（`Stage`）由窗口矩形底部按 9/16 推出：见 `brawlStageOf`。
 */
import type { Stage } from './fx-window';
import type { Rect } from './visit-windows';

/** 最小可读窗口宽度（§4.1：再小就看不清了） */
export const BRAWL_MIN_WINDOW_WIDTH = 120;

/** 各人数相对 1v1 单只窗口的宽度比例：人越少越大 */
export const BRAWL_WINDOW_SCALES: Readonly<Record<number, number>> = {
  2: 1,
  3: 0.9,
  4: 0.75,
  5: 0.6,
};

export interface BrawlWindowSizing {
  /** 基准宽度（默认取本机宠物窗口宽） */
  baseWidth?: number;
  /** 最小可读宽度（默认 `BRAWL_MIN_WINDOW_WIDTH`） */
  minWidth?: number;
  /** 覆盖默认的按人数比例表 */
  scales?: Partial<Record<number, number>>;
}

export interface BrawlStageInput {
  /** 人数 2–5 */
  count: number;
  /** 当前屏幕的工作区 */
  workArea: Rect;
  /** 环心（本机宠物原窗口中心，屏幕坐标）；放不下时整环会平移，实际环心见返回值 */
  anchor: { x: number; y: number };
  /** 本机宠物窗口尺寸：用来推基准宽度与宽高比 */
  selfSize: { width: number; height: number };
  sizing?: BrawlWindowSizing;
}

export interface BrawlStageLayout {
  count: number;
  /** 按编号 0..count-1 的窗口矩形 */
  rects: Rect[];
  /** 与 `rects` 同序的朝向：左半环朝右、右半环朝左、正上 / 正下暂用 `left` */
  facing: Array<'left' | 'right'>;
  /** 平移后的实际环心 */
  center: { x: number; y: number };
  /** 实际半径（屏幕像素） */
  radius: number;
  /** 这一档实际使用的窗口宽高（所有窗口一致） */
  width: number;
  height: number;
  /** 是否为了放进工作区而缩过窗口 */
  scaled: boolean;
}

function checkCount(count: number): number {
  if (!Number.isInteger(count) || count < 2 || count > 5) {
    throw new Error('群架人数必须在 2–5 之间');
  }
  return count;
}

/**
 * 按人数算窗口宽度。基准宽度默认是本机宠物窗口宽；5 人档也不会低于最小可读宽度。
 */
export function brawlWindowWidth(count: number, selfWidth: number, sizing: BrawlWindowSizing = {}): number {
  const n = checkCount(count);
  const base = sizing.baseWidth ?? selfWidth;
  const min = sizing.minWidth ?? BRAWL_MIN_WINDOW_WIDTH;
  const scale = sizing.scales?.[n] ?? BRAWL_WINDOW_SCALES[n] ?? 1;
  return Math.max(min, Math.round(base * scale));
}

/** 按人数算窗口尺寸：宽度见 `brawlWindowWidth`，高度照本机宠物窗口的宽高比等比推 */
export function brawlWindowSize(
  count: number,
  selfSize: { width: number; height: number },
  sizing: BrawlWindowSizing = {},
): { width: number; height: number } {
  const width = brawlWindowWidth(count, selfSize.width, sizing);
  const aspect = selfSize.width > 0 && selfSize.height > 0 ? selfSize.height / selfSize.width : 9 / 16;
  return { width, height: Math.max(1, Math.round(width * aspect)) };
}

/** 编号 0..count-1 的角度（度）：90° = 6 点钟，按屏幕顺时针递增 */
export function brawlAngles(count: number): number[] {
  const n = checkCount(count);
  return Array.from({ length: n }, (_, index) => (90 + (index * 360) / n) % 360);
}

/** 夹进区间；区间反了（工作区比窗口还小）时取中点，调用方另行保证尺寸 */
function clampTo(value: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) / 2;
  return Math.min(Math.max(value, lo), hi);
}

/** 夹一个矩形坐标：装得下就夹进区间，装不下就贴住起点 */
function clampStart(value: number, start: number, extent: number, size: number): number {
  if (size >= extent) return start;
  return Math.min(Math.max(value, start), start + extent - size);
}

/**
 * 环形摆位主函数。
 *
 * 半径先按工作区能容纳的最大环算（窗口四角不越界），再取「相邻窗口留出间距」与「用上工作区
 * 约三成短边」两者较大的一个；窗口本身放不下时先等比缩小（不低于最小可读宽度）。
 */
export function brawlStageLayout(input: BrawlStageInput): BrawlStageLayout {
  const count = checkCount(input.count);
  const area = input.workArea;
  const sizing = input.sizing ?? {};
  const minWidth = sizing.minWidth ?? BRAWL_MIN_WINDOW_WIDTH;
  const aspect =
    input.selfSize.width > 0 && input.selfSize.height > 0 ? input.selfSize.height / input.selfSize.width : 9 / 16;

  let { width, height } = brawlWindowSize(count, input.selfSize, sizing);
  let scaled = false;

  // 窗口本身比工作区大：等比缩小，但不低于最小可读宽度。
  if (width > area.width || height > area.height) {
    const fit = Math.min(area.width / width, area.height / height);
    const floor = Math.min(1, minWidth / width);
    const factor = Math.max(floor, Math.min(1, fit));
    if (factor < 1) {
      width = Math.max(1, Math.floor(width * factor));
      height = Math.max(1, Math.round(width * aspect));
      scaled = true;
    }
  }
  if (width > area.width || height > area.height) {
    throw new Error(`工作区放不下 ${minWidth}px 的最小窗口`);
  }

  const radians = brawlAngles(count).map((deg) => (deg * Math.PI) / 180);
  const cos = radians.map((rad) => Math.cos(rad));
  const sin = radians.map((rad) => Math.sin(rad));
  const cosRange = Math.max(...cos) - Math.min(...cos);
  const sinRange = Math.max(...sin) - Math.min(...sin);

  // 环的外接矩形 = 2r × 角度跨度 + 一个窗口，先反推半径上限
  const rMaxX = cosRange > 1e-9 ? (area.width - width) / cosRange : Infinity;
  const rMaxY = sinRange > 1e-9 ? (area.height - height) / sinRange : Infinity;
  const rMax = Math.max(0, Math.min(rMaxX, rMaxY));

  // 理想半径：相邻窗口至少隔开约一个窗口大小，同时用上工作区短边的一部分，不留大片空桌面
  const spacing = (Math.max(width, height) * 1.15) / (2 * Math.sin(Math.PI / count));
  const spacious = Math.min(area.width, area.height) * 0.28;
  const radius = Math.min(rMax, Math.max(spacing, spacious));

  const dxs = cos.map((c) => c * radius);
  const dys = sin.map((s) => s * radius);
  const minDx = Math.min(...dxs);
  const maxDx = Math.max(...dxs);
  const minDy = Math.min(...dys);
  const maxDy = Math.max(...dys);

  // 先平移整环：把环心夹进「所有窗口都在工作区内」的区间
  const cx = clampTo(input.anchor.x, area.x + width / 2 - minDx, area.x + area.width - width / 2 - maxDx);
  const cy = clampTo(input.anchor.y, area.y + height / 2 - minDy, area.y + area.height - height / 2 - maxDy);

  const rects = radians.map((_, index) => {
    const x = clampStart(Math.round(cx + dxs[index] - width / 2), area.x, area.width, width);
    const y = clampStart(Math.round(cy + dys[index] - height / 2), area.y, area.height, height);
    return { x, y, width, height };
  });

  // 朝向环心：左半环朝右、右半环朝左；正好在环心中轴（正上 / 正下）暂用 left
  const facing = dxs.map((dx): 'left' | 'right' => (dx < -1e-6 ? 'right' : 'left'));

  return {
    count,
    rects,
    facing,
    center: { x: cx, y: cy },
    radius,
    width,
    height,
    scaled,
  };
}

/**
 * 窗口矩形 → 舞台矩形（口径同 `foeStage`：画布宽 = 窗口宽、高 = 宽 × 9/16、贴窗口底）。
 * 环形摆位出来的窗口可以直接用这个函数交给 `brawlShotPoints`。
 */
export function brawlStageOf(rect: Rect, facing: 'left' | 'right'): Stage {
  const height = (rect.width * 9) / 16;
  return { x: rect.x, y: rect.y + rect.height - height, width: rect.width, height, facing };
}
