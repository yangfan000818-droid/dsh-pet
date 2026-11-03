/**
 * 对话面板历史归一化：GET /chat 的回执只有形状合法、正文非空的消息才上屏，
 * 并只保留最近 CHAT_LOG_MAX 条（memory.json 全量保存，面板不无限拉长）。
 *
 * 跑法：node --experimental-strip-types --test src/shared/chat.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_LOG_MAX, normalizeHistory } from './chat.ts';

describe('normalizeHistory —— GET /chat 回执', () => {
  test('非对象 / ok 不为 true / messages 不是数组 → 空历史', () => {
    assert.deepEqual(normalizeHistory(null), []);
    assert.deepEqual(normalizeHistory('nope'), []);
    assert.deepEqual(normalizeHistory({ ok: false, messages: [] }), []);
    assert.deepEqual(normalizeHistory({ ok: true, messages: {} }), []);
  });

  test('跳过非法角色 / 空正文 / 非对象条目，其余按原顺序保留', () => {
    const msg = (role: string, content: unknown) => ({ role, content });
    assert.deepEqual(
      normalizeHistory({
        ok: true,
        messages: [
          msg('user', '你好'),
          msg('system', '忽略我'),
          msg('assistant', '  '),
          null,
          msg('assistant', '在呢'),
        ],
      }),
      [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '在呢' },
      ],
    );
  });

  test(`最多保留最近 ${CHAT_LOG_MAX} 条`, () => {
    const messages = Array.from({ length: CHAT_LOG_MAX + 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'm' + i,
    }));
    const items = normalizeHistory({ ok: true, messages });
    assert.equal(items.length, CHAT_LOG_MAX);
    assert.equal(items[0].text, 'm5');
    assert.equal(items[items.length - 1].text, 'm' + (CHAT_LOG_MAX + 4));
  });
});
