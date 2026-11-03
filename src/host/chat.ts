/**
 * 对话生成（host 半侧）：用独立应用的模型服务（StandaloneAiService）按设置页配置的
 * provider/model 生成一句回复。与碎碎念（generateWhisper）同构，区别是：
 *  - 输入带历史对话（memory.json 截取的最近 N 轮），历史以 user/assistant 消息进入请求；
 *  - user 消息 = 用户刚输入的话（不是"随便叨叨"指令）；
 *  - system 在人设之外追加 CHAT_MODE_RULES：人设仍与碎碎念共用，但对话是 1-3 句的
 *    多轮聊天，不受人设里"短短一句（20字以内）"的碎碎念长度约束；
 *  - 超时 60s；输出上限由传输层兜底（1024 token）。
 *
 * 设计：
 *  - provider/model：就是设置页配的那一个（候选链见 model-selection.ts）；
 *  - system = composeChatSystem(人设 + 时间 + 主人此刻, 生活上下文 + 上次对话间隔)；
 *  - reasoningEffort: 'off' —— 仅当模型声明支持 reasoning effort（含 "off"）时传，
 *    关闭深度思考：闲聊对话不需要推理。无 reasoning 元数据的模型（如
 *    reasoningEfforts: false）显式传 off 会被判为不支持的 reasoning effort
 *    并表现为"模型未返回文本"，因此这类模型省略该字段（语义等价于不传）；
 *  - sessionId: PET_CALL_IDENTITY —— 调用身份（见 llm-call.ts）；
 *  - 无正文时读 BlockAssembler.finish 报真实失败原因；
 *  - 历史 assistant 消息用 createAssistantMessage 构造（provider/model 记当前选择，
 *    仅作消息角色载体，不涉及适配器回放）；
 *  - 流式收集 + BlockAssembler 拼装文本；生成失败显式返回结构化原因，不伪造文案。
 *
 * 配图（可选，pool 非空时）：与碎碎念「随机抽」不同——对话有真实上下文（用户输入 + 历史），
 * 故把整张表情包清单交给模型由它**按语境选**一张；模型在末尾附标记 [图:名称]，
 * host 解析并**只在池内命中时**采纳（防幻觉出池外名称），未选/选错则不配图。
 * 对话配图只是点缀：指令明确「不必每句都配」，并带上最近几轮用过的图让人（模型）换一张；
 * 选中的图随 assistant 消息写进 memory.json 的 image 字段，供下一轮去重。
 */

import { BlockAssembler, createAssistantMessage, createUserMessage, ReasoningEffortId } from './llm-messages';
import { PET_CALL_IDENTITY, noTextReason } from './llm-call';
import { supportsReasoningOff } from './llm-reasoning';
import { extractChatImage, memeCatalog, type MemeEntry } from './memes';
import { modelCandidates, modelLabel, type ModelRef, type ModelService } from './model-selection';

/** 生成失败原因（与 shared/whisper.ts 的 WhisperState 失败分支同构） */
export type ChatGenerateResult =
  | { ok: true; text: string; image?: string }
  | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string };

/** 记忆中的一条消息（与 shared/chat.ts 的 ChatMessage 同构） */
export interface ChatMemoryMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
  /** assistant 这一轮实际展示的配图名（只在池内命中时写入；下一轮用它提醒模型换图） */
  image?: string;
}

/** 单次生成超时（ms）：对话等 LLM 回复，60s 足够 */
const TIMEOUT_MS = 60_000;

/**
 * 对话专用行为规则：人设仍然共用，这里只补“这是聊天不是碎碎念”的场景与反重复要求。
 * 放在 system 末尾（最后一次指令），比夹在人设中间更容易被模型遵守。
 */
export const CHAT_MODE_RULES = [
  '【对话模式】主人是在和你聊天，不是在让你碎碎念；人设里“短短一句（20字以内）”只用于碎碎念。',
  '回复 1-3 句、总共不超过 100 字：先接住主人这句话（回应情绪或内容），再自然延伸，可以问一句、吐槽或说说自己的反应。',
  '不要每句都像结束语，不要重复最近说过的句子、开场白和口头禅；主人认真倾诉时先共情，不急着卖萌。',
].join('\n');

/** 拼出对话的最终 system：人设（含名字/时间/主人此刻）+ 生活上下文 + 对话规则。 */
export function composeChatSystem(base: string, context = ''): string {
  return [base, context, CHAT_MODE_RULES].filter((part) => part !== '').join('\n');
}

/**
 * 「上次对话」间隔行：只在隔了 10 分钟以上时加，避免每轮都往 system 里塞一句。
 * 让模型知道旧话题不是刚刚发生的，别把几天前的上下文当成眼下的事。
 */
export function chatGapLine(lastTs: number | undefined, now: number): string {
  if (lastTs === undefined || !Number.isFinite(lastTs)) return '';
  const gap = now - lastTs;
  if (gap < 10 * 60_000) return '';
  const minutes = Math.floor(gap / 60_000);
  const text =
    minutes < 60
      ? `${minutes} 分钟`
      : minutes < 24 * 60
        ? `${Math.floor(minutes / 60)} 小时`
        : `${Math.floor(minutes / (24 * 60))} 天`;
  return `【上次对话】距离上一次聊天已经过去 ${text}。这只是背景，不必刻意提起；如果主人换了话题就自然接新话题。`;
}

/** 最近几轮 assistant 用过的配图（去重、按时间顺序取最后 limit 张）。 */
export function recentChatImages(history: ReadonlyArray<ChatMemoryMessage>, limit = 3): string[] {
  const max = Math.max(0, Math.floor(limit));
  // slice(-0) === slice(0)（返回整个数组），limit=0 必须显式返回空
  if (max === 0) return [];
  const out: string[] = [];
  for (const message of history) {
    if (message.role !== 'assistant' || !message.image || out.includes(message.image)) continue;
    out.push(message.image);
  }
  return out.slice(-max);
}

/** 配图指令：附在 user 正文之后（紧邻回答位置，模型更容易遵守） */
export function imageInstruction(pool: MemeEntry[], recentImages: readonly string[] = []): string {
  const recent =
    recentImages.length > 0
      ? '\n最近几轮已经用过这些配图：' + recentImages.join('、') + '。这次尽量换一张；没有合适的就完全不要写标记。'
      : '';
  return (
    '\n\n[配图] 配图只是可选点缀，不必每句都配；只有特别贴切时才在回复末尾附一张，从下列清单里挑最贴合当前语境的：\n' +
    memeCatalog(pool) +
    '\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。' +
    recent
  );
}

/**
 * 生成一句对话回复。
 * @param ai 独立应用的模型服务
 * @param system 人设提示词（whisperPrompt）
 * @param history 最近记忆（按时间正序；user/assistant 交替）
 * @param userText 用户刚输入的话
 * @param pool 表情包候选池（开启对话配图时传入；空/缺省 = 纯文本，指令与解析都不介入）
 * @param recentImages 最近几轮已经用过的配图名（用于提醒模型换一张；空 = 不提示）
 * @returns 回复文本（+ 命中池内的配图名），或结构化失败（provider 缺失 / 生成错误）
 */
export async function generateChat(
  ai: ModelService,
  system: string,
  history: ChatMemoryMessage[],
  userText: string,
  pool: MemeEntry[] = [],
  recentImages: readonly string[] = [],
): Promise<ChatGenerateResult> {
  // 候选链：只有设置页配的那一个模型
  const candidates = modelCandidates(ai);
  if (candidates.length === 0) {
    return { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' };
  }
  if (typeof ai.stream !== 'function') {
    return { ok: false, reason: 'generate-error', message: 'LLM 服务不可用' };
  }
  // 依次尝试：配置的模型失败（凭据被删 / 模型下架 / 该服务商没配 key）时**回落到当前对话的模型
  // 重试一次**，仍失败才抛出失败原因——最后一次是用户当前真正在用的模型，报错更有意义。
  // 兜底文案与失败分支同源，避免两处字面量漂移
  let last: ChatGenerateResult = { ok: false, reason: 'generate-error', message: noTextReason(undefined) };
  for (const [i, sel] of candidates.entries()) {
    const result = await generateWith(ai, sel, system, history, userText, pool, recentImages);
    if (result.ok) return result;
    last = result;
    // 回落要留痕：配的模型没生效时能在日志里看到原因（否则"我明明配了 A，怎么还是用 B"没法查）
    if (i + 1 < candidates.length) {
      console.warn(
        `dsh-pet: 对话用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`,
      );
    }
  }
  return last;
}

/** 用**一个**确定的 provider/model 跑一次对话生成（候选链的一环；失败原样返回结构化原因，不吞） */
async function generateWith(
  ai: ModelService,
  sel: ModelRef,
  system: string,
  history: ChatMemoryMessage[],
  userText: string,
  pool: MemeEntry[],
  recentImages: readonly string[],
): Promise<ChatGenerateResult> {
  // 历史 → 消息对象：user 经 createUserMessage（plugin 来源），assistant 经 createAssistantMessage
  const historyMessages = history.map((m) =>
    m.role === 'user'
      ? createUserMessage({
          content: [{ type: 'text', text: m.content }],
          source: { kind: 'user' },
        })
      : createAssistantMessage({
          content: [{ type: 'text', text: m.content }],
          source: { provider: sel.provider, model: sel.model },
        }),
  );

  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  // 仅当模型声明支持 reasoning effort（含 "off"）时才传，否则省略：
  // 无 reasoning 元数据的模型（如 reasoningEfforts: false）显式传 off 会被
  // 会被判为不支持的 reasoning effort 并表现为"模型未返回文本"。
  const supportsOff = await supportsReasoningOff(ai, sel.provider, sel.model);
  // 配图：池非空才把清单与指令附进 user 正文（空池 = 关闭配图，正文与旧行为逐字一致）
  const wantImage = pool.length > 0;
  const options = {
    provider: sel.provider,
    model: sel.model,
    // 调用身份（见 llm-call.ts）：缺它时 opencode-go 回 400
    sessionId: PET_CALL_IDENTITY,
    messages: [
      ...historyMessages,
      createUserMessage({
        content: [{ type: 'text', text: wantImage ? userText + imageInstruction(pool, recentImages) : userText }],
        source: { kind: 'user' },
      }),
    ],
    system,
    // 输出上限由传输层统一兜底（ai-transport.ts 的 MAX_OUTPUT_TOKENS=1024）；
    // 推理模型会把思考计入预算，这里不显式设更小的上限，免得截断正文。
    temperature: 1,
    // 轻量反重复：只压掉逐字复读和固定口头禅，别把正常接话也罚掉（本地 qwen 实测 0.1 合适）。
    presencePenalty: 0.1,
    frequencyPenalty: 0.1,
    // 统一关闭深度思考：闲聊对话不需要推理（与碎碎念同一约束；仅模型声明支持时传）
    ...(supportsOff ? { reasoningEffort: ReasoningEffortId('off') } : {}),
    signal: deadline,
  };

  const assembler = new BlockAssembler();
  try {
    for await (const chunk of ai.stream(options)) {
      assembler.push(chunk as Parameters<BlockAssembler['push']>[0]);
    }
  } catch (e) {
    return {
      ok: false,
      reason: 'generate-error',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  const text = assembler
    .blocks()
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? (b as { text: string }).text : ''))
    .join('')
    .trim();
  if (!text) return { ok: false, reason: 'generate-error', message: noTextReason(assembler.finish) };
  // 配图解析：命中池内才采纳并剥离标记；未选/幻觉名称 → 原样返回纯文本
  if (!wantImage) return { ok: true, text };
  const picked = extractChatImage(text, pool);
  return picked.image ? { ok: true, text: picked.text, image: picked.image } : { ok: true, text: picked.text };
}
