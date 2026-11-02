// AI 看屏幕选目的地的纯逻辑：解析模型的九宫格回答，把格子换算成宠物中心的归一化坐标。
// 截图、模型调用、真正发 /anim 都在 features/screen.ts；这里只做可单测的解析与几何。
import type { Rect } from '../shared/types';

/** 移动方式：飞 / 走 */
export type MoveKind = 'fly' | 'walk';

/** 模型回答解析出的九宫格编号；kind = null 表示 auto 模式没听出飞还是走（交给距离决定） */
export interface MovePick {
  kind: MoveKind | null;
  cell: number;
}

/** 全角数字 → 半角，去掉空白与句读；模型常把「飞 6」写成带空格或全角的版本 */
function normalizeAnswer(answer: string): string {
  return answer
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s。.!！，,、；;：:]+/g, '');
}

/**
 * 解析模型回答。`mode` 是菜单指定的方式（fly/walk）或 `auto`：
 *   - 回答里有「飞N / 走N」→ auto 用模型选的方式；固定模式仍用调用方指定的方式；
 *   - 只有数字 → 固定模式用指定方式，auto 返回 kind=null（由距离决定）；
 *   - 没有数字但有方位词（左上 / 右边 / 中间…）→ 按九宫格方位换算；
 *   - 都没有 → null。
 * 只取第一个明确的坐标信息，避免模型多说几个字时乱猜。
 */
export function parseMoveAnswer(answer: string, mode: MoveKind | 'auto'): MovePick | null {
  const text = normalizeAnswer(String(answer ?? ''));
  const withKind = /([飞走])([1-9])/.exec(text);
  if (withKind) {
    const said: MoveKind = withKind[1] === '飞' ? 'fly' : 'walk';
    return { kind: mode === 'auto' ? said : mode, cell: Number(withKind[2]) };
  }
  const digit = /[1-9]/.exec(text);
  const cell = digit ? Number(digit[0]) : directionCell(text);
  if (cell === null) return null;
  const said: MoveKind | null = /飞/.test(text) ? 'fly' : /走/.test(text) ? 'walk' : null;
  return { kind: mode === 'auto' ? said : mode, cell };
}

/** 方位词 → 九宫格编号（先认「左上/右下」这类两字方位，再认方向短语；单字只在整句就是一个字时认） */
const DIRECTIONS: ReadonlyArray<readonly [RegExp, number]> = [
  [/左上/, 1],
  [/右上/, 3],
  [/左下/, 7],
  [/右下/, 9],
  [/上方|上边|上面|顶/, 2],
  [/下方|下边|下面|底/, 8],
  [/左边|左侧|左方/, 4],
  [/右边|右侧|右方/, 6],
  [/中间|中央|中心/, 5],
];

const SINGLE_DIRECTION: Readonly<Record<string, number>> = { 上: 2, 下: 8, 左: 4, 右: 6, 中: 5 };

function directionCell(text: string): number | null {
  if (text.length === 1) return SINGLE_DIRECTION[text] ?? null;
  for (const [pattern, cell] of DIRECTIONS) if (pattern.test(text)) return cell;
  return null;
}

/** 九宫格编号 → 该格在中段随机一点（0.2–0.8，避免总贴格线） */
function cellPoint(cell: number, area: Rect, rng: () => number): { x: number; y: number } {
  const col = (cell - 1) % 3;
  const row = Math.floor((cell - 1) / 3);
  const cellW = area.width / 3;
  const cellH = area.height / 3;
  return {
    x: area.x + (col + 0.2 + rng() * 0.6) * cellW,
    y: area.y + (row + 0.2 + rng() * 0.6) * cellH,
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * 九宫格 + 屏幕工作区 → 宠物中心的目标（全部显示器并集归一化坐标）。
 *
 * 目标点按宠物窗口大小留边，保证整只落在工作区内；若离当前位置太近，往屏幕另一侧推一段，
 * 避免「飞/走」变成原地播放。`kind` 为 null（auto 没听出方式）时按距离决定：远飞近走。
 */
export function moveTargetOf(o: {
  cell: number;
  kind: MoveKind | null;
  /** 截图那块屏的工作区（屏幕坐标） */
  area: Rect;
  /** 全部显示器工作区并集（/position、/anim target 的归一化基准） */
  union: Rect;
  /** 宠物窗口宽度（px） */
  size: number;
  /** 宠物当前中心（屏幕坐标）；不知道就不做最小距离修正 */
  current: { x: number; y: number } | null;
  /** 测试注入；默认 Math.random */
  rng?: () => number;
}): { kind: MoveKind; x: number; y: number } | null {
  if (!Number.isInteger(o.cell) || o.cell < 1 || o.cell > 9) return null;
  if (!(o.area.width > 0 && o.area.height > 0 && o.union.width > 0 && o.union.height > 0)) return null;
  const rng = o.rng ?? Math.random;
  const halfW = o.size / 2;
  const halfH = (o.size * 9) / 16 / 2;
  const margin = 20;
  const minX = o.area.x + halfW + margin;
  const maxX = o.area.x + o.area.width - halfW - margin;
  const minY = o.area.y + halfH + margin;
  const maxY = o.area.y + o.area.height - halfH - margin;
  const point = cellPoint(o.cell, o.area, rng);
  let px = clamp(point.x, minX, maxX);
  const py = clamp(point.y, minY, maxY);
  let kind = o.kind;
  if (o.current) {
    const minDist = Math.max(90, o.size * 0.6);
    const far = Math.max(o.area.width, o.area.height) * 0.25;
    if (Math.hypot(px - o.current.x, py - o.current.y) < minDist) {
      // 离当前位置太近：往屏幕另一侧推，仍保留 AI 选的那一行
      const away = o.current.x < o.area.x + o.area.width / 2 ? 1 : -1;
      px = clamp(o.current.x + away * Math.max(minDist * 1.5, (o.area.width / 3) * 2), minX, maxX);
    }
    if (kind === null) kind = Math.hypot(px - o.current.x, py - o.current.y) >= far ? 'fly' : 'walk';
  }
  return {
    kind: kind ?? 'walk',
    x: clamp((px - o.union.x) / o.union.width, 0, 1),
    y: clamp((py - o.union.y) / o.union.height, 0, 1),
  };
}
