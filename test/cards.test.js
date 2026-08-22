import test from 'node:test';
import assert from 'node:assert/strict';
import { configCard, historyCard, taskCard } from '../src/cards.js';

test('config card exposes dynamic models and all permission modes', () => {
  const card = configCard({
    engine: 'codex',
    model: '',
    effort: 'high',
    permission: 'workspace-write',
    workspace: '/tmp/project',
  }, ['gpt-current', 'gpt-next'], { antigravity: false });
  const json = JSON.stringify(card);
  assert.match(json, /gpt-next/);
  assert.match(json, /danger-full-access/);
  assert.match(json, /Antigravity CLI/);
});

test('completed task card starts with the answer and has no header', () => {
  const card = taskCard({
    state: 'completed',
    prompt: 'duplicated prompt',
    answer: 'Direct answer',
    config: { engine: 'codex', model: 'gpt-current', effort: 'high' },
    duration: '8s',
  });

  assert.equal(card.header, undefined);
  assert.equal(card.elements[0].content, 'Direct answer');
  assert.doesNotMatch(JSON.stringify(card), /duplicated prompt/);
  assert.match(JSON.stringify(card), /Codex · gpt-current · High · 8s/);
});

test('uses supported plain text in history div blocks', () => {
  const card = historyCard([{ id: 'thread-123456', title: '你好', updatedAt: '2026-08-22T04:00:00Z' }], 'thread-123456');
  const row = card.elements.find((element) => element.tag === 'div');
  assert.equal(row.text.tag, 'plain_text');
  assert.equal(row.extra.type, 'primary');
  assert.doesNotMatch(row.text.content, /thread-123456/);
  assert.equal(card.elements[1].tag, 'note');
});

test('running task card uses a compact engine header without repeating prompt', () => {
  const card = taskCard({ state: 'running', prompt: 'hi', progress: '正在分析…', config: { engine: 'codex', model: '', effort: 'high' } });
  assert.equal(card.header.title.content, '⏳ Codex 执行中...');
  assert.doesNotMatch(JSON.stringify(card), /\*\*任务\*\*/);
});
