import test from 'node:test';
import assert from 'node:assert/strict';
import { configCard } from '../src/cards.js';

test('model list falls back to inherited default', () => {
  const card = configCard({ engine: 'codex', model: '', effort: 'medium', permission: 'read-only', workspace: '/tmp' }, [], { antigravity: false });
  assert.match(JSON.stringify(card), /inherit Codex default/);
});
