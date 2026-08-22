import { spawn } from 'node:child_process';

const CODEX = process.env.LARK_AGENT_REMOTE_CODEX || '/Applications/ChatGPT.app/Contents/Resources/codex';

export async function listCodexModels() {
  try {
    const client = new AppServerClient(process.cwd());
    await client.start();
    const result = await client.request('model/list', {});
    await client.close();
    const items = result?.data || result?.models || result || [];
    return (Array.isArray(items) ? items : [])
      .map((item) => typeof item === 'string' ? item : item?.id || item?.model || item?.slug)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function runCodexTurn({ prompt, cwd, model, permission, effort, threadId, onProgress, signal }) {
  const client = new AppServerClient(cwd);
  let activeThreadId = threadId || '';
  let answer = '';
  let turnId = '';
  let aborting = false;

  const abort = async () => {
    if (aborting) return;
    aborting = true;
    if (activeThreadId && turnId) {
      try { await client.request('turn/interrupt', { threadId: activeThreadId, turnId }); } catch {}
    } else {
      await client.close();
    }
  };
  if (signal?.aborted) throw new CodexTurnError('cancelled', 'Task cancelled');
  signal?.addEventListener('abort', abort, { once: true });

  try {
    await client.start();

    client.onNotification = (method, params) => {
      if (method === 'turn/started') {
        turnId = params?.turn?.id || turnId;
        onProgress?.('正在分析…');
      } else if (method === 'item/started') {
        const type = params?.item?.type || '';
        if (/command|tool/i.test(type)) onProgress?.('正在执行工具…');
        else if (/file|patch/i.test(type)) onProgress?.('正在修改文件…');
      } else if (method === 'item/agentMessage/delta') {
        answer += params?.delta || '';
      } else if (method === 'item/completed') {
        const item = params?.item;
        if ((item?.type === 'agentMessage' || item?.type === 'agent_message') && item?.text) answer = item.text;
      }
    };

    const approvalPolicy = permission === 'read-only' ? 'untrusted' : 'never';
    const threadParams = compact({ cwd, model, sandbox: permission, approvalPolicy });
    if (threadId) {
      const resumed = await client.request('thread/resume', { threadId, ...threadParams });
      activeThreadId = resumed?.thread?.id || threadId;
    } else {
      const started = await client.request('thread/start', { ...threadParams, serviceName: 'lark-agent-remote' });
      activeThreadId = started?.thread?.id || started?.threadId || '';
    }
    if (!activeThreadId) throw new CodexTurnError('protocol', 'Codex app-server did not return a thread id');
    if (signal?.aborted) throw new CodexTurnError('cancelled', 'Task cancelled');

    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CodexTurnError('timeout', 'Codex task timed out after 30 minutes')), 30 * 60 * 1000);
      client.onExit = () => {
        clearTimeout(timer);
        reject(new CodexTurnError('process_exited', 'Codex app-server exited unexpectedly'));
      };
      client.onTurnComplete = (turn) => {
        if (turnId && turn?.id && turn.id !== turnId) return;
        clearTimeout(timer);
        if (turn?.status === 'interrupted' || signal?.aborted) reject(new CodexTurnError('cancelled', 'Task cancelled'));
        else if (turn?.status && turn.status !== 'completed') reject(new CodexTurnError('turn_failed', `Codex turn ${turn.status}`));
        else resolve();
      };
    });

    const turn = await client.request('turn/start', compact({
      threadId: activeThreadId,
      cwd,
      model,
      effort,
      approvalPolicy,
      input: [{ type: 'text', text: prompt }],
    }));
    turnId = turn?.turn?.id || turnId;
    if (signal?.aborted) await abort();
    await completed;
    return { answer: answer.trim() || '任务已完成。', threadId: activeThreadId };
  } finally {
    signal?.removeEventListener('abort', abort);
    await client.close();
  }
}

export class CodexTurnError extends Error {
  constructor(code, message) { super(message); this.name = 'CodexTurnError'; this.code = code; }
}

class AppServerClient {
  constructor(cwd) {
    this.cwd = cwd;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
  }

  async start() {
    this.child = spawn(CODEX, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stderr.on('data', () => {});
    this.child.on('error', (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.onExit?.(error);
    });
    this.child.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Codex app-server exited'));
      this.pending.clear();
      this.onExit?.();
    });
    await this.request('initialize', {
      clientInfo: { name: 'lark-agent-remote', version: '0.1.0', title: 'Lark Agent Remote' },
      capabilities: { experimentalApi: true },
    });
  }

  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.id && message.method) {
        this.child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Interactive approval is unavailable in Feishu MVP' } })}\n`);
      } else if (message.method === 'turn/completed') {
        this.onTurnComplete?.(message.params?.turn);
      } else if (message.method) {
        this.onNotification?.(message.method, message.params || {});
      }
    }
  }

  async close() {
    if (!this.child || this.child.killed) return;
    this.child.kill('SIGTERM');
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== '' && item !== undefined && item !== null));
}
