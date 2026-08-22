import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const AGY = process.env.LARK_AGENT_REMOTE_AGY || `${process.env.HOME}/.local/bin/agy`;
const CONVERSATION_CACHE = `${process.env.HOME}/.gemini/antigravity-cli/cache/conversation_metadata.json`;
const CONVERSATIONS_DIR = `${process.env.HOME}/.gemini/antigravity-cli/conversations`;

export async function listAntigravityModels() {
  return new Promise((resolve) => {
    const child = spawn(AGY, ['models'], { env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => resolve([]));
    child.on('close', (code) => {
      if (code !== 0) return resolve([]);
      resolve(output.split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((model) => model && /^[a-z0-9][a-z0-9._-]+$/i.test(model)));
    });
  });
}

export function antigravityModelForEffort(model, effort) {
  if (!model || !effort) return model;
  return model.replace(/-(?:low|medium|high)$/i, `-${effort}`);
}

export function antigravityEffortFromModel(model) {
  return model?.match(/-(low|medium|high)$/i)?.[1]?.toLowerCase() || '';
}

export function listAntigravitySessions({ limit = 15, cachePath = CONVERSATION_CACHE, conversationsDir = CONVERSATIONS_DIR } = {}) {
  if (!existsSync(conversationsDir)) return [];
  try {
    const data = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : { conversations: {} };
    const metadata = data.conversations || {};
    // Desktop-only IDs also appear in conversation_metadata.json, but agy
    // cannot resume them until the user explicitly imports them in the TUI.
    // A local CLI database is the reliable indication that --conversation is usable.
    return readdirSync(conversationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.db'))
      .map((entry) => {
        const id = basename(entry.name, '.db');
        const item = metadata[id];
        return {
          id,
          title: item?.summary?.Title || item?.summary?.Preview || `Antigravity 会话 ${id.slice(0, 8)}`,
          updatedAt: item?.last_modified_time || item?.summary?.UpdatedAt || statSync(join(conversationsDir, entry.name)).mtime.toISOString(),
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function runAntigravityTurn(options) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (options.signal?.aborted) throw new AntigravityError('cancelled', 'Task cancelled');
    try { return await runAntigravityTurnOnce(options); }
    catch (error) {
      lastError = error;
      if (error?.code !== 'transient' || attempt === 2) throw error;
      options.onProgress?.(`Antigravity 网络波动，正在重试（${attempt + 1}/2）…`);
      await delay(750 * (attempt + 1), options.signal);
    }
  }
  throw lastError;
}

function runAntigravityTurnOnce({ prompt, cwd, model, permission, effort, conversationId, onProgress, signal }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--print-timeout', '30m'];
  if (conversationId) args.push('--conversation', conversationId);
  const resolvedModel = antigravityModelForEffort(model, effort);
  if (resolvedModel) args.push('--model', resolvedModel);
  // Some official model IDs already encode their effort. Passing both flags
  // makes agy reject an otherwise valid selection as conflicting.
  if (effort && !antigravityEffortFromModel(resolvedModel)) args.push('--effort', effort);
  if (permission === 'read-only') args.push('--sandbox');
  if (permission === 'workspace-write') args.push('--sandbox', '--mode', 'accept-edits');
  if (permission === 'danger-full-access') args.push('--mode', 'accept-edits', '--dangerously-skip-permissions');

  return new Promise((resolve, reject) => {
    let result;
    let stderr = '';
    let cancelled = false;
    let settled = false;
    let exited = false;
    const child = spawn(AGY, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => {
      if (cancelled || child.killed) return;
      cancelled = true;
      child.kill('SIGINT');
      setTimeout(() => { if (!exited) child.kill('SIGTERM'); }, 2_000).unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.event === 'init') onProgress?.('正在启动 Antigravity…');
      else if (event.event === 'step_update') onProgress?.(progressLabel(event));
      else if (event.event === 'result') result = event.result || event;
    });
    child.on('error', (error) => finish(reject, new AntigravityError('process', error.message)));
    child.on('close', (code) => {
      exited = true;
      const status = String(result?.status || '').toUpperCase();
      if (cancelled || ['CANCELED', 'INTERRUPTED'].includes(status)) {
        finish(reject, new AntigravityError('cancelled', 'Task cancelled'));
      } else if (code !== 0 || status !== 'SUCCESS') {
        finish(reject, classifyError(result?.error || stderr || `Antigravity exited with code ${code}`));
      } else {
        finish(resolve, {
          answer: String(result?.response || '').trim() || '任务已完成。',
          conversationId: result?.conversation_id || conversationId || '',
          usage: result?.usage || {},
        });
      }
    });
  });
}

export class AntigravityError extends Error {
  constructor(code, message) { super(message); this.name = 'AntigravityError'; this.code = code; }
}

function progressLabel(event) {
  const step = event.step_update || event.step || event.data || event;
  const type = String(step.step_type || step.type || '').toLowerCase();
  if (/command|terminal|shell/.test(type)) return '正在执行命令…';
  if (/file|write|edit|patch/.test(type)) return '正在修改文件…';
  if (/tool|mcp|browser|search/.test(type)) return '正在调用工具…';
  if (/subagent|task/.test(type)) return '正在协调子任务…';
  return '正在分析…';
}

function classifyError(value) {
  const message = String(value || 'Unknown Antigravity error');
  if (/(EOF|ECONNRESET|connection reset|temporarily unavailable)/i.test(message)) return new AntigravityError('transient', message);
  if (/authentication required|not signed in/i.test(message)) return new AntigravityError('auth', message);
  if (/eligibility check failed/i.test(message)) return new AntigravityError('eligibility', message);
  if (/invalid model|model.*not.*recognized/i.test(message)) return new AntigravityError('model', message);
  if (/permission|waiting on input|approval/i.test(message)) return new AntigravityError('permission', message);
  if (/(conversation|trajectory).*(not found|invalid)/i.test(message)) return new AntigravityError('conversation', message);
  if (/timed out|timeout/i.test(message)) return new AntigravityError('timeout', message);
  return new AntigravityError('runtime', message);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new AntigravityError('cancelled', 'Task cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
