// 移动几何与角落定位：纯计算（无 DOM / ref），可独立单测。
// 坐标语义：移动规划归一化为视口比例（ratio），px 换算由调用方（rAF 驱动 / customPos）完成；
// 角落定位返回宠物根节点左上角的像素坐标（浏览器 overlay 用 CSS 同语义，桌面模式用它摆放 sprite）。
import { randomBetween } from './pickers';
import { rectAtPoint } from './displays';
import type { Corner, Rect } from './types';

/** 一次移动的几何参数（比例坐标） */
export interface MovePlan {
  startRatio: number;
  startYRatio: number;
  targetRatio: number;
  /** 终点 y 比例。只走横线时与 startYRatio 相同（飞行才可能不同） */
  targetYRatio: number;
  totalRatio: number;
  /** y 方向总位移（比例，正 = 向下）。横向移动恒为 0 */
  totalYRatio: number;
}

/** 计算一次移动的起点/终点比例坐标；目标越出视口边缘（含边距）时返回 null。
 *  sideAllow = 左右透明边余量（视频画布内宠物身体居中、两侧透明）：边界按"身体"贴边而不是
 *  按"整个视频盒"贴边——宠物能走到屏幕边缘，但身体永不越界（不会漫游到屏幕外丢失）。
 *
 *  minRise/maxRise 给了非零值时是**飞行**：y 方向随机位移（正 = 向上），身体上下缘也参与边界
 *  判定，贴边时自动收短；横向仍按 dir 走。不写时 y 恒定，行为与旧版逐位一致。
 *  targetX/targetY 给了（两个都给）时直接以该点为终点：不再随机距离 / 垂直区间，其余边界规则不变。
 *
 *  areas 传入时（桌面多显示器）边界改判**工作区并集**而不是视口外接矩形：落点的身体两侧
 *  各留 margin 后仍须落在某块屏上。缝隙两侧都有屏 ⇒ 可自由走过去（允许骑缝）；外接矩形里的
 *  空洞没有屏 ⇒ 走不进去。不传时按 W/H 单矩形判定，浏览器 overlay 行为逐位不变。 */
export const planMove = (o: {
  cx: number;
  cy: number;
  W: number;
  H: number;
  dir: 1 | -1;
  minDist: number;
  maxDist: number;
  margin: number;
  halfW: number;
  /** 可选：身体相对视频盒左/右各留多少像素（默认 0 = 旧行为，按视频盒贴边） */
  sideAllow?: number;
  /** 可选：显示器工作区列表（与 cx/cy 同坐标系）。给了就按并集判定落点可达性 */
  areas?: Rect[];
  /** 可选：垂直位移区间（px，正 = 向上，负 = 向下）；缺省 / 0 = 只走横线。
   *  飞行类动作用它，让宠物斜着或上下穿屏。 */
  minRise?: number;
  maxRise?: number;
  /** 可选：身体中心到身体上 / 下缘的距离（px）。有垂直位移时用于防止身体飞出屏幕；
   *  缺省 0 = 只按中心点判定（旧行为）。 */
  halfBodyTop?: number;
  halfBodyBottom?: number;
  /** 可选：显式目标中心（px，与 cx/cy 同坐标系）。两个都给时跳过随机距离与垂直区间，
   *  直接走到该点（AI 看屏幕选的位置）；缺一个就仍按随机走。 */
  targetX?: number;
  targetY?: number;
}): MovePlan | null => {
  const side = o.sideAllow ?? 0;
  const targetX = o.targetX;
  const targetY0 = o.targetY;
  const explicit = targetX !== undefined && targetY0 !== undefined;
  const distance = randomBetween(o.minDist, o.maxDist);
  const target = explicit ? targetX : o.cx + o.dir * distance;
  const rise = explicit ? 0 : randomBetween(o.minRise ?? 0, o.maxRise ?? 0);
  const halfBodyTop = o.halfBodyTop ?? 0;
  const halfBodyBottom = o.halfBodyBottom ?? 0;
  // 垂直方向贴边时收短（而不是取消整次移动）：飞向上沿/下沿时能飞多少飞多少，
  // 从屏幕角落点「飞行」也不至于原地干站着。横向仍沿用旧行为（出界即取消）。
  let targetY = explicit ? targetY0 : o.cy - rise;
  if (targetY !== o.cy) {
    if (o.areas && o.areas.length > 0) {
      // 终点本身在某块屏上（含跨屏缝飞到相邻屏）→ 用那块屏的上下界；终点落进空洞时退回
      // 「目标 x、当前高度」所在的屏，把垂直位移收到屏内，而不是取消整次移动。
      const area =
        rectAtPoint(o.areas, target, targetY) ?? rectAtPoint(o.areas, target, o.cy) ?? rectAtPoint(o.areas, o.cx, o.cy);
      if (area) {
        targetY = Math.min(
          Math.max(targetY, area.y + o.margin + halfBodyTop),
          area.y + area.height - o.margin - halfBodyBottom,
        );
      }
    } else {
      targetY = Math.min(Math.max(targetY, o.margin + halfBodyTop), o.H - o.margin - halfBodyBottom);
    }
  }
  if (o.areas && o.areas.length > 0) {
    // 身体左右缘各外扩 margin 后都得落在某块屏上（可以分属不同屏 = 允许骑缝行走）
    const bodyHalf = o.halfW - side;
    const xs = [target - bodyHalf - o.margin, target + bodyHalf + o.margin];
    if (targetY !== o.cy) {
      // 垂直移动时上下缘也要在屏内：四个角都查，避免飞进多屏之间的空洞
      const ys = [targetY - halfBodyTop - o.margin, targetY + halfBodyBottom + o.margin];
      for (const x of xs) for (const y of ys) if (!rectAtPoint(o.areas, x, y)) return null;
    } else {
      for (const x of xs) if (!rectAtPoint(o.areas, x, o.cy)) return null;
    }
  } else {
    // margin 语义 =「身体到屏幕边缘的安全距」：盒中心可到 margin + halfW - side（身体左缘 = margin）
    const leftBound = o.margin + o.halfW - side;
    const rightBound = o.W - o.margin - o.halfW + side;
    if (target < leftBound || target > rightBound) return null;
    if (targetY !== o.cy) {
      if (targetY < o.margin + halfBodyTop) return null;
      if (targetY > o.H - o.margin - halfBodyBottom) return null;
    }
  }
  return {
    startRatio: o.cx / o.W,
    startYRatio: o.cy / o.H,
    targetRatio: target / o.W,
    targetYRatio: targetY / o.H,
    totalRatio: Math.abs(target - o.cx) / o.W,
    totalYRatio: (targetY - o.cy) / o.H,
  };
};

/**
 * 角落 + 边距 → 宠物根节点左上角像素坐标。
 * 与浏览器 overlay 的 CSS 角落语义一致：
 *   top-left     = left:marginX, top:marginY
 *   top-right    = right:marginX, top:marginY
 *   bottom-left  = left:marginX, bottom:marginY
 *   bottom-right = right:marginX, bottom:marginY
 * 桌面模式用同一套几何摆放宠物（根节点 = 舞台）。
 *
 * area 传入时角落取**那块屏**而不是视口外接矩形。多显示器不规则布局下外接矩形的角落可能
 * 压根不属于任何显示器（实测右倒 T 型双屏：top-left 落在主屏上方的空洞里，配了该角落的宠物
 * 开机即隐身），所以桌面端必须传主屏工作区。不传时按 W/H，浏览器 overlay 行为不变。
 */
export const anchorPixel = (o: {
  corner: Corner;
  marginX: number;
  marginY: number;
  size: number;
  W: number;
  H: number;
  /** 可选：角落所属的工作区矩形（与调用方同坐标系）；缺省用 {0,0,W,H} */
  area?: Rect;
}): { x: number; y: number } => {
  const height = (o.size * 9) / 16;
  const a = o.area ?? { x: 0, y: 0, width: o.W, height: o.H };
  const left = a.x + o.marginX;
  const top = a.y + o.marginY;
  const right = a.x + a.width - o.size - o.marginX;
  const bottom = a.y + a.height - height - o.marginY;
  switch (o.corner) {
    case 'top-left':
      return { x: left, y: top };
    case 'top-right':
      return { x: right, y: top };
    case 'bottom-left':
      return { x: left, y: bottom };
    case 'bottom-right':
      return { x: right, y: bottom };
  }
};
