/**
 * 对话提示词与请求形状的单元测试 —— 钉住「聊天不再复读碎碎念」的几处关键行为：
 * - system 顺序：人设 → 生活上下文 → 对话规则（规则放最后，模型更容易遵守）；
 * - 上次对话间隔只在 ≥10 分钟时出现，避免每轮都往 system 里塞；
 * - 配图去重提示只带最近几轮实际用过的图；
 * - 空池 = 关闭配图时，user 正文与旧行为逐字一致；
 * - 采样参数（temperature / presence / frequency）确实进了请求选项。
 *
 * 跑法：node --experimental-strip-types --test src/host/chat-prompt.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_MODE_RULES,
  chatGapLine,
  composeChatSystem,
  generateChat,
  imageInstruction,
  recentChatImages,
  type ChatMemoryMessage,
} from './chat.ts';
import type { MemeEntry } from './memes.ts';
import type { ModelService } from './model-selection.ts';

const POOL: MemeEntry[] = [
  { name: '可爱', desc: '卖萌立绘' },
  { name: '死掉了', desc: '累瘫阵亡' },
];

/** 取出请求里 user/assistant 正文（消息是 { role, content:[{type:'text',text}] } 形状） */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && 'text' in block ? String(block.text) : ''))
    .join('');
}

function fakeAi(reply: string, seen: unknown[] = []): ModelService {
  return {
    currentSelection: () => ({ provider: 'standalone', model: 'test-model' }),
    stream: async function* (options: unknown) {
      seen.push(options);
      yield { type: 'text', text: reply };
    },
  };
}

describe('composeChatSystem —— system 拼装顺序', () => {
  test('context 夹在人设与对话规则之间，规则永远在最后', () => {
    const system = composeChatSystem('人设', '【最近的事】吃饭');
    assert.ok(system.startsWith('人设\n【最近的事】吃饭\n'));
    assert.ok(system.endsWith(CHAT_MODE_RULES));
  });

  test('没有上下文时只有人设 + 规则，不留下多余空行', () => {
    assert.equal(composeChatSystem('人设'), '人设\n' + CHAT_MODE_RULES);
    assert.equal(composeChatSystem('人设', ''), '人设\n' + CHAT_MODE_RULES);
  });

  test('规则明确「这是聊天」并解除碎碎念长度限制', () => {
    assert.ok(CHAT_MODE_RULES.includes('对话模式'));
    assert.ok(CHAT_MODE_RULES.includes('20字以内'));
    assert.ok(CHAT_MODE_RULES.includes('不要重复'));
  });
});

describe('chatGapLine —— 上次对话间隔', () => {
  const NOW = 1_000_000_000;
  test('没有历史 / 非法时间戳 → 不提示', () => {
    assert.equal(chatGapLine(undefined, NOW), '');
    assert.equal(chatGapLine(Number.NaN, NOW), '');
  });

  test('间隔不到 10 分钟 → 不提示（同一段对话里不刷屏）', () => {
    assert.equal(chatGapLine(NOW - 5 * 60_000, NOW), '');
  });

  test('分钟 / 小时 / 天三种粒度', () => {
    assert.ok(chatGapLine(NOW - 25 * 60_000, NOW).includes('25 分钟'));
    assert.ok(chatGapLine(NOW - 3 * 3_600_000, NOW).includes('3 小时'));
    assert.ok(chatGapLine(NOW - 2 * 86_400_000, NOW).includes('2 天'));
  });
});

describe('recentChatImages —— 配图去重提示', () => {
  const history: ChatMemoryMessage[] = [
    { role: 'user', content: '你好', ts: 1 },
    { role: 'assistant', content: '嗨', ts: 2, image: '可爱' },
    { role: 'assistant', content: '嗯', ts: 3 },
    { role: 'assistant', content: '哈哈', ts: 4, image: '死掉了' },
    { role: 'assistant', content: '又是我', ts: 5, image: '可爱' },
  ];

  test('只取 assistant 实际用过的图，去重后按时间顺序保留', () => {
    assert.deepEqual(recentChatImages(history), ['可爱', '死掉了']);
  });

  test('limit 只保留最后几张', () => {
    assert.deepEqual(recentChatImages(history, 1), ['死掉了']);
    assert.deepEqual(recentChatImages(history, 0), []);
  });
});

describe('imageInstruction —— 配图只是可选点缀', () => {
  test('带清单，并明确「不必每句都配」', () => {
    const text = imageInstruction(POOL);
    assert.ok(text.includes('不必每句都配'));
    assert.ok(text.includes('- 可爱：卖萌立绘'));
    assert.ok(text.includes('[图:名称]'));
  });

  test('给出最近用过的图 → 提示换一张；没给 → 不出现该行', () => {
    assert.ok(imageInstruction(POOL, ['可爱', '死掉了']).includes('最近几轮已经用过这些配图：可爱、死掉了'));
    assert.equal(imageInstruction(POOL).includes('最近几轮已经用过'), false);
  });
});

describe('generateChat —— 请求形状与失败口径', () => {
  test('未配置模型 → provider-missing，不发请求', async () => {
    const result = await generateChat(
      { currentSelection: () => ({ provider: '', model: '' }), stream: () => assert.fail('不该发请求') } as never,
      'system',
      [],
      '你好',
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'provider-missing');
  });

  test('历史按时间顺序进入消息，最后一条是用户这句话；空池不改写正文', async () => {
    const seen: unknown[] = [];
    const history: ChatMemoryMessage[] = [
      { role: 'user', content: '第一句', ts: 1 },
      { role: 'assistant', content: '第一答', ts: 2 },
    ];
    const result = await generateChat(fakeAi('第二答', seen), '人设', history, '第二句');
    assert.deepEqual(result, { ok: true, text: '第二答' });
    const req = seen[0] as { system: string; messages: unknown[]; temperature: number };
    assert.equal(req.system, '人设'); // 对话规则由调用方 composeChatSystem 拼好再传进来
    assert.deepEqual(
      req.messages.map((message) => [(message as { role: string }).role, textOf(message)]),
      [
        ['user', '第一句'],
        ['assistant', '第一答'],
        ['user', '第二句'],
      ],
    );
    assert.equal(req.temperature, 1);
    const options = seen[0] as { presencePenalty?: number; frequencyPenalty?: number };
    assert.equal(options.presencePenalty, 0.1);
    assert.equal(options.frequencyPenalty, 0.1);
  });

  test('有配图池 → 正文追加清单与最近用图提示；回复标记被剥掉', async () => {
    const seen: unknown[] = [];
    const result = await generateChat(fakeAi('好呀\n[图:可爱]', seen), '人设', [], '来点什么', POOL, ['死掉了']);
    assert.deepEqual(result, { ok: true, text: '好呀', image: '可爱' });
    const user = textOf((seen[0] as { messages: unknown[] }).messages[0]);
    assert.ok(user.startsWith('来点什么\n\n[配图]'));
    assert.ok(user.includes('- 可爱：卖萌立绘'));
    assert.ok(user.includes('最近几轮已经用过这些配图：死掉了'));
  });

  test('模型没写标记 → 纯文本，不配图', async () => {
    const result = await generateChat(fakeAi('就很普通'), '人设', [], '嗯', POOL);
    assert.deepEqual(result, { ok: true, text: '就很普通' });
  });

  test('流抛错 / 空正文 → 结构化失败，不伪造文案', async () => {
    const broken: ModelService = {
      currentSelection: () => ({ provider: 'standalone', model: 'test-model' }),
      stream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('网络断了')) }),
      }),
    };
    assert.deepEqual(await generateChat(broken, '人设', [], '在吗'), {
      ok: false,
      reason: 'generate-error',
      message: '网络断了',
    });
    assert.deepEqual(await generateChat(fakeAi('   '), '人设', [], '在吗'), {
      ok: false,
      reason: 'generate-error',
      message: '模型未返回文本',
    });
  });
});
