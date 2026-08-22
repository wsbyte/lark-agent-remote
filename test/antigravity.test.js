import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { antigravityEffortFromModel, antigravityModelForEffort, listAntigravitySessions } from '../src/antigravity.js';

test('keeps Antigravity model variants aligned with reasoning effort', () => {
  assert.equal(antigravityModelForEffort('gemini-3.7-flash-high', 'low'), 'gemini-3.7-flash-low');
  assert.equal(antigravityEffortFromModel('gemini-3.7-flash-medium'), 'medium');
  assert.equal(antigravityModelForEffort('claude-sonnet-4-6', 'high'), 'claude-sonnet-4-6');
});

test('lists recent non-internal Antigravity sessions from the official cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-sessions-'));
  const cachePath = join(root, 'conversation_metadata.json');
  const conversationsDir = join(root, 'conversations');
  mkdirSync(conversationsDir);
  writeFileSync(join(conversationsDir, 'old.db'), '');
  writeFileSync(join(conversationsDir, 'newest.db'), '');
  writeFileSync(cachePath, JSON.stringify({ conversations: {
    old: { summary: { ID: 'old', Preview: 'Old task' }, last_modified_time: '2026-08-20T00:00:00Z', is_internal: false },
    newest: { summary: { ID: 'newest', Title: 'Newest task' }, last_modified_time: '2026-08-22T00:00:00Z', is_internal: false },
    hidden: { summary: { ID: 'hidden', Title: 'Internal' }, last_modified_time: '2026-08-23T00:00:00Z', is_internal: true },
  } }));

  const sessions = listAntigravitySessions({ cachePath, conversationsDir });
  assert.deepEqual(sessions.map(({ id, title }) => ({ id, title })), [
    { id: 'newest', title: 'Newest task' },
    { id: 'old', title: 'Old task' },
  ]);
});

test('does not expose desktop-only Antigravity sessions that agy cannot resume', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-local-sessions-'));
  const cachePath = join(root, 'conversation_metadata.json');
  const conversationsDir = join(root, 'conversations');
  mkdirSync(conversationsDir);
  writeFileSync(join(conversationsDir, 'cli-session.db'), '');
  writeFileSync(cachePath, JSON.stringify({ conversations: {
    'desktop-only': { summary: { ID: 'desktop-only', Title: 'Desktop' } },
    'cli-session': { summary: { ID: 'cli-session', Title: 'CLI' } },
  } }));
  assert.deepEqual(listAntigravitySessions({ cachePath, conversationsDir }).map((item) => item.id), ['cli-session']);
});

test('uses the first real user request as the CLI conversation title', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-session-title-'));
  const conversationsDir = join(root, 'conversations');
  const brainDir = join(root, 'brain');
  mkdirSync(conversationsDir);
  mkdirSync(join(brainDir, 'cli-session', '.system_generated', 'logs'), { recursive: true });
  writeFileSync(join(conversationsDir, 'cli-session.db'), '');
  writeFileSync(join(brainDir, 'cli-session', '.system_generated', 'logs', 'transcript.jsonl'), `${JSON.stringify({
    source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\n帮我整理 Downloads 目录\n\n文件回传规则：不要只发路径\n</USER_REQUEST>',
  })}\n`);
  const sessions = listAntigravitySessions({ cachePath: join(root, 'missing.json'), conversationsDir, brainDir });
  assert.equal(sessions[0].title, '帮我整理 Downloads 目录');
});

test('parses Antigravity stream-json results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-fake-'));
  const fake = join(root, 'agy');
  writeFileSync(fake, `#!/bin/sh
printf '%s\n' '{"event":"init","cwd":"/tmp"}'
printf '%s\n' '{"event":"step_update","step_type":"tool","state":"ACTIVE"}'
printf '%s\n' '{"event":"result","result":{"conversation_id":"agy-123","status":"SUCCESS","response":"done"}}'
`);
  chmodSync(fake, 0o755);
  process.env.LARK_AGENT_REMOTE_AGY = fake;
  const { runAntigravityTurn } = await import(`../src/antigravity.js?fake=${Date.now()}`);
  const progress = [];
  const result = await runAntigravityTurn({ prompt: 'test', cwd: root, permission: 'read-only', effort: 'low', onProgress: (value) => progress.push(value) });
  delete process.env.LARK_AGENT_REMOTE_AGY;
  assert.equal(result.answer, 'done');
  assert.equal(result.conversationId, 'agy-123');
  assert.match(progress.join(' '), /调用工具/);
});

test('interrupts the Antigravity child process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-cancel-'));
  const fake = join(root, 'agy');
  writeFileSync(fake, `#!/usr/bin/env node
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
setInterval(() => {}, 1000);
`);
  chmodSync(fake, 0o755);
  process.env.LARK_AGENT_REMOTE_AGY = fake;
  const { runAntigravityTurn } = await import(`../src/antigravity.js?cancel=${Date.now()}`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(runAntigravityTurn({ prompt: 'test', cwd: root, permission: 'read-only', signal: controller.signal }), (error) => error.code === 'cancelled');
  delete process.env.LARK_AGENT_REMOTE_AGY;
});
