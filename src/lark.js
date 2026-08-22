import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { basename, dirname } from 'node:path';
import { run } from './process.js';

export function consumeEvent(eventKey, onEvent) {
  let child;
  let stopped = false;
  let retryTimer;

  const start = () => {
    if (stopped) return;
    child = spawn('lark-cli', ['event', 'consume', eventKey, '--as', 'bot'], {
      env: process.env,
      // lark-cli treats stdin EOF as an explicit request to stop. Keep a pipe
      // open for the lifetime of the bridge even though we never write to it.
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try { onEvent(JSON.parse(line)); } catch (error) { console.error(`[event:${eventKey}] ${error.message}`); }
    });
    child.on('close', () => {
      if (!stopped) retryTimer = setTimeout(start, 10_000);
    });
  };
  start();
  return {
    kill(signal = 'SIGTERM') {
      stopped = true;
      clearTimeout(retryTimer);
      child?.kill(signal);
    },
  };
}

export async function replyText(messageId, text) {
  return run('lark-cli', ['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, '--markdown', text, '--idempotency-key', shortKey(`reply-${messageId}-${text}`)]);
}

export async function replyCard(messageId, card) {
  const result = await run('lark-cli', ['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', shortKey(`card-${messageId}`)]);
  return parseData(result.stdout);
}

export async function sendCard(chatId, card, key = '') {
  const idempotencyKey = key || shortKey(`send-card-${chatId}-${Date.now()}`);
  const result = await run('lark-cli', ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', idempotencyKey]);
  return parseData(result.stdout);
}

export async function updateMessageCard(messageId, card) {
  const payload = JSON.stringify({ content: JSON.stringify(card) });
  return run('lark-cli', ['api', 'PATCH', `/open-apis/im/v1/messages/${messageId}`, '--data', payload, '--as', 'bot']);
}

export async function updateCallbackCard(token, card, operatorId) {
  const completeCard = { ...card, open_ids: operatorId ? [operatorId] : undefined };
  const payload = JSON.stringify({ token, card: completeCard });
  return run('lark-cli', ['api', 'POST', '/open-apis/interactive/v1/card/update', '--data', payload, '--as', 'bot']);
}

export async function downloadMessageResource(messageId, fileKey, type, output) {
  const result = await run('lark-cli', ['im', '+messages-resources-download', '--as', 'bot', '--message-id', messageId, '--file-key', fileKey, '--type', type, '--output', output], { cwd: HOME_FOR_DOWNLOADS() });
  return parseData(result.stdout).saved_path || output;
}

export async function replyMedia(messageId, absolutePath, type = 'file') {
  return run('lark-cli', ['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, `--${type}`, basename(absolutePath), '--idempotency-key', shortKey(`media-${messageId}-${absolutePath}`)], { cwd: dirname(absolutePath) });
}

function shortKey(value) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `lar-${(hash >>> 0).toString(16)}`;
}

function parseData(stdout) {
  try { return JSON.parse(stdout)?.data || {}; } catch { return {}; }
}

function HOME_FOR_DOWNLOADS() { return `${process.env.HOME}/.lark-agent-remote`; }
