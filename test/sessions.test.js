import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listCodexSessions } from '../src/sessions.js';

test('lists current-workspace sessions using the first real user prompt as title', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lark-agent-sessions-'));
  const directory = join(root, '2026', '08', '22');
  mkdirSync(directory, { recursive: true });
  const entries = [
    { timestamp: '2026-08-22T01:00:00Z', type: 'session_meta', payload: { id: 'thread-123456789', cwd: '/work', timestamp: '2026-08-22T01:00:00Z' } },
    { timestamp: '2026-08-22T01:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '<environment_context>hidden</environment_context>' }] } },
    { timestamp: '2026-08-22T01:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: '帮我修一下登录问题' } },
  ];
  writeFileSync(join(directory, 'rollout-test.jsonl'), `${entries.map(JSON.stringify).join('\n')}\n`);

  const sessions = await listCodexSessions({ cwd: '/work', sessionsDir: root });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, '帮我修一下登录问题');
});
