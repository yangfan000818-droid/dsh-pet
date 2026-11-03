import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { StandaloneAiSettings } from './ai-config';

export type AiFetch = typeof globalThis.fetch;
export interface AiTextMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface AiRequest {
  system: string;
  messages: AiTextMessage[];
  /** 附在最后一条用户消息上的图片（data URL）；两种协议都支持 */
  images?: string[];
  /** 采样参数（可选；当前只在 OpenAI 兼容分支发送，Anthropic 分支保持原样） */
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
}
export type AiTransportEvent = { text?: string; refusal?: boolean };
/** 单次输出上限：桌宠每句话只有二十来字，只在模型跑飞（复读停不下来）时兜底 */
export const MAX_OUTPUT_TOKENS = 1024;
/** 视觉请求被服务端按客户端错误拒绝（不是鉴权 / 限流 / 超时）：据此判断模型不支持看图 */
const IMAGE_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 404, 415, 422]);
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** `data:image/...;base64,` → Anthropic 图片块（只认桌宠截图会用的三种格式） */
function anthropicImage(image: string): Anthropic.ImageBlockParam {
  const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(image);
  if (!match) throw new Error('Unsupported image input.');
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: `image/${match[1]}` as 'image/png' | 'image/jpeg' | 'image/webp',
      data: match[2],
    },
  };
}

/** SDKs can inherit custom auth headers from env even with explicit keys; rebuild headers. */
export function isolatedFetch(settings: Readonly<StandaloneAiSettings>, fetcher: AiFetch): AiFetch {
  const base = settings.baseUrl.replace(/\/+$/, '');
  const expected = base + (settings.protocol === 'anthropic' ? '/v1/messages' : '/chat/completions');
  return async (url, init) => {
    const beta =
      settings.protocol === 'anthropic' &&
      new URL(base).origin === 'https://api.anthropic.com' &&
      settings.model === 'claude-opus-5-5';
    const urlStr = String(url);
    const validOpenAi =
      settings.protocol === 'openai-compatible' &&
      (urlStr === expected || urlStr === base + '/chat/completions' || urlStr === base + '/v1/chat/completions');
    const validAnthropic =
      settings.protocol === 'anthropic' &&
      (urlStr === expected + (beta ? '?beta=true' : '') ||
        urlStr === base + '/messages' ||
        urlStr === base + '/v1/messages' + (beta ? '?beta=true' : ''));
    if (!validOpenAi && !validAnthropic) throw new Error('Unexpected standalone AI endpoint.');
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
    if (settings.protocol === 'anthropic') {
      headers.set('x-api-key', settings.apiKey);
      headers.set('anthropic-version', '2023-06-01');
      if (new URL(base).origin === 'https://api.anthropic.com' && settings.model === 'claude-opus-5-5') {
        headers.set('anthropic-beta', 'server-side-fallback-2026-07-01');
      }
    } else headers.set('authorization', `Bearer ${settings.apiKey}`);
    return fetcher(url, { method: 'POST', body: init?.body, headers, signal: init?.signal, redirect: 'error' });
  };
}

export async function* sdkTextStream(
  settings: Readonly<StandaloneAiSettings>,
  request: AiRequest,
  signal: AbortSignal,
  fetcher: AiFetch,
  maxTokens: number = MAX_OUTPUT_TOKENS,
): AsyncIterable<AiTransportEvent> {
  const shared = {
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl.replace(/\/+$/, ''),
    maxRetries: 0,
    timeout: settings.timeoutMs,
    fetch: isolatedFetch(settings, fetcher),
    logger: quiet,
    logLevel: 'off' as const,
  };
  const images = request.images ?? [];
  const last = request.messages.length - 1;
  if (settings.protocol === 'openai-compatible') {
    const client = new OpenAI({ ...shared, organization: null, project: null, webhookSecret: null });
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
      ...request.messages.map((message, index): OpenAI.Chat.Completions.ChatCompletionMessageParam =>
        index === last && message.role === 'user' && images.length
          ? {
              role: 'user',
              content: [
                { type: 'text', text: message.content },
                ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
              ],
            }
          : message,
      ),
    ];
    // chat_template_kwargs 不在 OpenAI 类型里，SDK 会原样透传进请求体；官方 OpenAI 会拒收未知参数，所以只按设置开启
    const thinking = settings.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {};
    // 采样参数由调用方按场景给（目前只有对话给轻量反重复值）；未给就不发，沿用服务端默认。
    const sampling = {
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
      ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
    };
    const stream = await client.chat.completions.create(
      { model: settings.model, messages, stream: true, max_tokens: maxTokens, n: 1, ...sampling, ...thinking },
      { signal },
    );
    for await (const event of stream) {
      const delta = event.choices.find((choice) => choice.index === 0)?.delta;
      if (delta?.refusal) yield { refusal: true };
      if (delta?.content) yield { text: delta.content };
    }
    return;
  }
  // Explicit authToken:null prevents SDK environment/OAuth/profile credential resolution.
  const client = new Anthropic({ ...shared, authToken: null, webhookKey: null });
  const messages: Anthropic.MessageParam[] = request.messages.map((message, index) =>
    index === last && message.role === 'user' && images.length
      ? {
          role: 'user',
          content: [...images.map(anthropicImage), { type: 'text', text: message.content }],
        }
      : message,
  );
  const opus = settings.model === 'claude-opus-5-5';
  const firstParty = new URL(settings.baseUrl).origin === 'https://api.anthropic.com';
  const parameters = {
    model: settings.model,
    max_tokens: maxTokens,
    system: request.system,
    messages,
    stream: true as const,
    ...(opus ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const } } : {}),
  };
  const stream =
    opus && firstParty
      ? await client.beta.messages.create(
          { ...parameters, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
          { signal },
        )
      : await client.messages.create(parameters, { signal });
  for await (const event of stream) {
    if (event.type === 'message_delta' && event.delta.stop_reason === 'refusal') yield { refusal: true };
    // Only delta text: never re-emit accumulated content or thinking/progress blocks.
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield { text: event.delta.text };
  }
}

export function isAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError ||
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  );
}
export function isRateLimitFailure(error: unknown): boolean {
  return error instanceof OpenAI.RateLimitError || error instanceof Anthropic.RateLimitError;
}
/** 从 SDK 错误里取 HTTP status：视觉请求被 400/404/415/422 拒绝 = 模型不支持看图 */
export function isUnsupportedImageFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && IMAGE_REJECTION_STATUSES.has(status);
}
