import { z } from 'zod';
import type { StandaloneLogger } from './logger';
import { createAiConfig } from './ai-config';
import type { StandaloneAiPublicSettings } from './ai-config';
import { isAuthenticationFailure, isRateLimitFailure, isUnsupportedImageFailure, sdkTextStream } from './ai-transport';
import type { AiFetch, AiRequest, AiTransportEvent } from './ai-transport';

const PROVIDER = 'standalone';
const MAX_INPUT_CHARS = 32_768;
const MAX_OUTPUT_CHARS = 16_384;
const MAX_EVENTS = 4096;
const REQUESTS_PER_MINUTE = 12;
/** 逐手出招（X17）另给一份额度：一分钟 30 次，不占、也不挤掉看屏幕和对话的那 12 次 */
const BATTLE_REQUESTS_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;
/** 识图请求里单张图片（data URL）的上限：桌宠截图压成 JPEG 后通常 100–300 KB */
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;
/** 视觉请求被服务端按客户端错误拒绝时的固定文案：模型不支持看图，之后降级成纯文本 */
export const UNSUPPORTED_IMAGE_MESSAGE = 'Standalone AI model does not accept images.';
/** 判断是不是「模型不支持看图」：只认这个固定文案，别的失败照旧按错误处理 */
export function isUnsupportedImageError(error: unknown): boolean {
  return error instanceof Error && error.message === UNSUPPORTED_IMAGE_MESSAGE;
}
const textBlock = z.object({ type: z.literal('text'), text: z.string().max(MAX_INPUT_CHARS) });
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string().max(MAX_INPUT_CHARS), z.array(z.unknown()).max(128)]),
});
const inputSchema = z.object({
  provider: z.literal(PROVIDER),
  model: z.string().max(200),
  system: z.string().max(MAX_INPUT_CHARS).optional(),
  messages: z.array(messageSchema).min(1).max(64),
  signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
  // 采样参数：只给对话这类需要控重复的调用方用；未传就不发，沿用服务端默认。
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
});

export interface StandaloneAiService {
  currentSelection(): { provider: string; model: string };
  listProviders(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
  resolveModelInfo(
    provider?: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<undefined | { id: string; name: string }>;
  stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }>;
  /**
   * 逐手出招（X17）的一次请求：与 `stream` 同一套解析与输出上限，但走另一份每分钟 30 次的额度
   * （心魔一场自家最多出 15 手，12 次不够用）。
   */
  streamBattle(options: unknown): AsyncIterable<{ type: 'text'; text: string }>;
  /**
   * 带一张图的单轮请求（独立应用「看屏幕」用），发往当前配置的模型接口：
   * 本机地址只留在本机，云端地址会把截图上传给服务商。
   */
  streamVision(input: {
    system: string;
    prompt: string;
    /** `data:image/...;base64,` 形式 */
    image: string;
    signal?: AbortSignal;
  }): AsyncIterable<{ type: 'text'; text: string }>;
  /** 当前设置能否走 streamVision（不发请求） */
  canSeeScreen(): boolean;
  getSettings(): StandaloneAiPublicSettings;
  saveSettings(input: unknown): Promise<StandaloneAiPublicSettings>;
  testConnection(input: {
    protocol?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    disableThinking?: boolean;
  }): Promise<{ ok: boolean; message: string; reply?: string }>;
  isReady(): boolean;
  dispose(): void;
}
/** Optional third argument is an isolated transport/clock seam; production uses official SDKs. */
export interface StandaloneAiDependencies {
  fetch?: AiFetch;
  now?: () => number;
}

function parseRequest(options: unknown, model: string): { request: AiRequest; signal?: AbortSignal } {
  const parsed = inputSchema.safeParse(options);
  if (!parsed.success || parsed.data.model !== model)
    throw new Error('Invalid standalone AI model selection or input.');
  const { data } = parsed;
  const messages = data.messages
    .map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((block) => {
                // Unknown/non-text blocks and DSH source metadata never cross the API boundary.
                if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text')
                  return '';
                const result = textBlock.safeParse(block);
                if (!result.success) throw new Error('Invalid standalone AI text input.');
                return result.data.text;
              })
              .join(''),
    }))
    .filter((message) => message.content.trim().length > 0);
  const system = data.system ?? '';
  const size = system.length + messages.reduce((sum, message) => sum + message.content.length, 0);
  if (
    size > MAX_INPUT_CHARS ||
    messages.length === 0 ||
    messages[0].role !== 'user' ||
    messages[messages.length - 1]?.role !== 'user'
  ) {
    throw new Error('Standalone AI input is empty or exceeds limits.');
  }
  return {
    request: {
      system,
      messages,
      ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
      ...(data.topP !== undefined ? { topP: data.topP } : {}),
      ...(data.presencePenalty !== undefined ? { presencePenalty: data.presencePenalty } : {}),
      ...(data.frequencyPenalty !== undefined ? { frequencyPenalty: data.frequencyPenalty } : {}),
    },
    signal: data.signal,
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Standalone AI request cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Standalone AI request cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createStandaloneAi(
  home: string,
  logger: StandaloneLogger,
  dependencies: StandaloneAiDependencies = {},
): StandaloneAiService {
  let store: ReturnType<typeof createAiConfig>;
  try {
    store = createAiConfig(home);
  } catch {
    logger.error('Cannot securely load standalone AI settings.');
    // Corrupt/insecure persistence must never enable ambient or old credentials.
    throw new Error('Cannot securely load standalone AI settings.');
  }
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? Date.now;
  let disposed = false;
  let paused = false;
  let saving = false;
  let requests: ReadonlyArray<number> = [];
  /** 逐手出招的额度（X17）：与对话 / 看屏幕分开记，互不挤占 */
  let battleRequests: ReadonlyArray<number> = [];
  let active: AbortController | undefined;
  /** 本次启动 / 本次设置下已经确认「模型不支持看图」：内存里记着，保存设置就清掉 */
  let visionUnsupported = false;
  const ready = () =>
    !disposed &&
    !paused &&
    !saving &&
    store.current().enabled &&
    !!store.current().model &&
    !!store.current().baseUrl &&
    !!store.current().apiKey;
  const selection = () => ({ provider: PROVIDER, model: ready() ? store.current().model : '' });

  async function* stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }> {
    if (!ready()) throw new Error('Standalone AI is not ready. Configure and enable the model first.');
    const settings = store.current();
    const { request, signal: callerSignal } = parseRequest(options, settings.model);
    yield* run(settings, request, callerSignal);
  }

  async function* streamBattle(options: unknown): AsyncIterable<{ type: 'text'; text: string }> {
    if (!ready()) throw new Error('Standalone AI is not ready. Configure and enable the model first.');
    const settings = store.current();
    const { request, signal: callerSignal } = parseRequest(options, settings.model);
    yield* run(settings, request, callerSignal, false, 'battle');
  }

  const canSeeScreen = () => ready() && !visionUnsupported;

  async function* streamVision(input: {
    system: string;
    prompt: string;
    image: string;
    signal?: AbortSignal;
  }): AsyncIterable<{ type: 'text'; text: string }> {
    if (!ready()) throw new Error('Standalone AI vision requires a configured model.');
    if (visionUnsupported) throw new Error(UNSUPPORTED_IMAGE_MESSAGE);
    if (!/^data:image\/(?:png|jpeg|webp);base64,/.test(input.image) || input.image.length > MAX_IMAGE_CHARS)
      throw new Error('Standalone AI image input is invalid or too large.');
    if (input.system.length + input.prompt.length > MAX_INPUT_CHARS || !input.prompt.trim())
      throw new Error('Standalone AI input is empty or exceeds limits.');
    const request: AiRequest = {
      system: input.system,
      messages: [{ role: 'user', content: input.prompt }],
      images: [input.image],
    };
    yield* run(store.current(), request, input.signal, true);
  }

  /** 一次请求的公共执行：单飞、限频、超时、输出上限与错误归一（stream / streamVision 共用） */
  async function* run(
    settings: ReturnType<typeof store.current>,
    request: AiRequest,
    callerSignal: AbortSignal | undefined,
    vision = false,
    lane: 'chat' | 'battle' = 'chat',
  ): AsyncIterable<{ type: 'text'; text: string }> {
    if (callerSignal?.aborted) throw new Error('Standalone AI request cancelled.');
    if (active) throw new Error('Standalone AI is busy. Please wait.');
    const battle = lane === 'battle';
    const recent = (battle ? battleRequests : requests).filter((time) => now() - time < RATE_WINDOW_MS);
    if (recent.length >= (battle ? BATTLE_REQUESTS_PER_MINUTE : REQUESTS_PER_MINUTE))
      throw new Error('Standalone AI rate limit reached. Please wait.');
    if (battle) battleRequests = [...recent, now()];
    else requests = [...recent, now()];
    const controller = new AbortController();
    active = controller;
    const abort = () => controller.abort();
    callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, settings.timeoutMs);
    const iterator = sdkTextStream(settings, request, controller.signal, fetcher)[Symbol.asyncIterator]();
    let emitted = 0;
    let events = 0;
    try {
      while (true) {
        const part: IteratorResult<AiTransportEvent> = await abortable(iterator.next(), controller.signal);
        if (controller.signal.aborted || !ready()) throw new Error('Standalone AI request cancelled.');
        if (part.done) break;
        if (++events > MAX_EVENTS) throw new Error('Standalone AI response exceeds limits.');
        if (part.value.refusal) throw new Error('Standalone AI could not answer this request.');
        const text = part.value.text;
        if (!text) continue;
        emitted += text.length;
        if (emitted > MAX_OUTPUT_CHARS) throw new Error('Standalone AI response exceeds limits.');
        yield { type: 'text', text };
      }
      if (emitted === 0) throw new Error('Standalone AI returned no text.');
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        paused = true;
        logger.warn('Standalone AI authentication failed; save settings again to resume.');
        throw new Error('Standalone AI authentication failed. Check credentials and save settings again.', {
          cause: error,
        });
      }
      if (controller.signal.aborted) {
        throw new Error('Standalone AI request cancelled or timed out.', { cause: error });
      }
      if (isRateLimitFailure(error)) {
        throw new Error('Standalone AI provider rate limit reached. Please wait.', { cause: error });
      }
      // 视觉请求被服务端按客户端错误拒绝（400/404/415/422）：记住当前设置不支持看图，之后直接降级成纯文本
      if (vision && isUnsupportedImageFailure(error)) {
        visionUnsupported = true;
        logger.warn('Standalone AI model rejected image input; falling back to text.');
        throw new Error(UNSUPPORTED_IMAGE_MESSAGE, { cause: error });
      }
      // Only our fixed messages are safe; never propagate SDK errors, URLs, headers, or bodies.
      if (
        error instanceof Error &&
        [
          'Standalone AI could not answer this request.',
          'Standalone AI returned no text.',
          'Standalone AI response exceeds limits.',
        ].includes(error.message)
      )
        throw error;
      logger.warn('Standalone AI request failed.');
      throw new Error('Standalone AI request failed. Check the endpoint and model settings.', { cause: error });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
      controller.abort();
      if (active === controller) active = undefined;
      // return() may await a pending transport read. Observe it, but never block cancellation.
      void iterator.return?.().catch(() => logger.debug('Standalone AI transport closed.'));
    }
  }

  return {
    currentSelection: selection,
    listProviders: () => (ready() ? [{ id: PROVIDER, name: 'Standalone AI' }] : []),
    listModels: async (provider) =>
      ready() && provider === PROVIDER ? [{ id: settingsModel(), name: settingsModel() }] : [],
    resolveModelInfo: async (provider = PROVIDER, model = settingsModel(), signal) =>
      ready() && !signal?.aborted && provider === PROVIDER && model === settingsModel()
        ? { id: model, name: model }
        : undefined,
    stream,
    streamBattle,
    streamVision,
    canSeeScreen,
    getSettings: () => store.publicSettings(),
    async saveSettings(input) {
      if (disposed) throw new Error('Standalone AI is disposed.');
      if (saving) throw new Error('Standalone AI settings are being saved.');
      saving = true;
      active?.abort();
      try {
        const result = await store.save(input);
        if (!disposed) {
          paused = false;
          // 换模型 / 换地址后重新给视觉一次机会（重启也会清掉）
          visionUnsupported = false;
        }
        return result;
      } catch (error) {
        paused = true;
        throw error;
      } finally {
        saving = false;
      }
    },
    isReady: ready,
    async testConnection(input: {
      protocol?: string;
      baseUrl?: string;
      model?: string;
      apiKey?: string;
      disableThinking?: boolean;
    }) {
      if (disposed) return { ok: false, message: '服务已关闭' };
      const current = store.current();
      const protocol = input.protocol === 'anthropic' ? 'anthropic' : (input.protocol ?? current.protocol);
      const baseUrl = (input.baseUrl !== undefined ? input.baseUrl : current.baseUrl).trim();
      const model = (input.model !== undefined ? input.model : current.model).trim();
      const apiKey = (input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : current.apiKey).trim();
      const disableThinking =
        typeof input.disableThinking === 'boolean' ? input.disableThinking : current.disableThinking;

      if (!baseUrl) {
        return { ok: false, message: '请先填写接口地址（Base URL）' };
      }
      if (!model) {
        return { ok: false, message: '请先填写模型名称' };
      }
      if (!apiKey) {
        return { ok: false, message: '请先填写 API 密钥' };
      }

      const testSettings = {
        protocol: protocol as 'openai-compatible' | 'anthropic',
        baseUrl,
        model,
        apiKey,
        enabled: true,
        timeoutMs: 15_000,
        disableThinking,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const testStream = sdkTextStream(
          testSettings,
          { system: '', messages: [{ role: 'user', content: 'hi' }] },
          controller.signal,
          fetcher,
          32,
        );
        let reply = '';
        for await (const chunk of testStream) {
          if (chunk.refusal) {
            return { ok: false, message: '模型拒绝回答该测试请求' };
          }
          if (chunk.text) {
            reply += chunk.text;
            if (reply.length >= 40) break;
          }
        }
        if (!reply.trim()) {
          return { ok: true, message: '连接成功！接口已成功响应。', reply: '(模型返回了空白内容)' };
        }
        return { ok: true, message: '连接成功！模型响应正常。', reply: reply.trim() };
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, message: '连接超时（15 秒未响应）：请检查网络连通性或服务器状态' };
        }
        if (isAuthenticationFailure(error)) {
          return { ok: false, message: '身份验证失败 (HTTP 401/403)：请检查 API 密钥是否正确' };
        }
        if (isRateLimitFailure(error)) {
          return { ok: false, message: '请求受限或配额超限 (HTTP 429)：请检查 API 账户余额或调用频率' };
        }
        const rawMsg = error instanceof Error ? error.message : String(error);
        if (rawMsg.includes('404')) {
          return { ok: false, message: '接口路径或模型不存在 (HTTP 404)：请检查接口地址（通常以 /v1 结尾）与模型名称' };
        }
        if (rawMsg.includes('ECONNREFUSED') || rawMsg.includes('fetch failed')) {
          return { ok: false, message: '无法连接到目标服务器：请检查地址与端口是否正确、服务器是否正在运行' };
        }
        return { ok: false, message: `连接失败：${rawMsg}` };
      } finally {
        clearTimeout(timer);
      }
    },
    dispose() {
      disposed = true;
      active?.abort();
    },
  };
  function settingsModel(): string {
    return store.current().model;
  }
}
