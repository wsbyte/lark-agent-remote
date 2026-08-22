import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractOutgoingFiles, messageText, withAttachmentContext } from '../src/attachments.js';

test('normalizes text and attachment-only messages', () => {
  assert.equal(messageText({ message_type: 'text', content: JSON.stringify({ text: ' hello ' }) }), 'hello');
  assert.equal(messageText({ message_type: 'image', content: JSON.stringify({ image_key: 'img_x' }) }), '请分析这张图片。');
});

test('adds local attachment paths to the agent prompt', () => {
  const prompt = withAttachmentContext('分析', ['/tmp/example.png']);
  assert.match(prompt, /\/tmp\/example\.png/);
  assert.match(prompt, /LARK_FILE/);
});

test('only returns declared output files inside the workspace', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lark-output-'));
  const output = join(workspace, 'report.txt');
  writeFileSync(output, 'done');
  const result = extractOutgoingFiles(`完成\nLARK_FILE: ${output}\nLARK_FILE: /etc/hosts`, workspace);
  assert.equal(result.answer, '完成');
  assert.deepEqual(result.files, [output]);
});
