import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { configCard, fullAccessConfirmationCard, historyCard, taskCard } from './cards.js';
import { loadConfig, LOG_PATH, saveConfig } from './config.js';
import { listCodexModels, runCodexTurn } from './codex.js';
import { consumeEvent, replyCard, replyText, sendCard, updateCallbackCard, updateMessageCard } from './lark.js';
import { commandExists } from './process.js';
import { listCodexSessions } from './sessions.js';

export async function startBridge() {
  let config = loadConfig();
  const activeTasks = new Map();
  const availability = { codex: await commandExists('codex'), antigravity: await commandExists('agy') };
  const models = { codex: await listCodexModels(), antigravity: [] };
  log(`starting engine=${config.engine} codexModels=${models.codex.length}`);

  const messageConsumer = consumeEvent('im.message.receive_v1', (event) => { void handleMessage(event).catch((error) => log(error.stack || error.message)); });
  const cardConsumer = consumeEvent('card.action.trigger', (event) => { void handleCard(event).catch((error) => log(error.stack || error.message)); });
  const children = [messageConsumer, cardConsumer];
  const stop = () => {
    for (const task of activeTasks.values()) task.controller.abort();
    for (const child of children) child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 250).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`Lark Agent Remote 已启动 · Codex models: ${models.codex.length} · Ctrl-C 退出`);

  async function handleMessage(event) {
    if (!event?.message_id || event.sender_type === 'bot') return;
    if (!config.ownerId) {
      config.ownerId = event.sender_id;
      saveConfig(config);
    }
    if (event.sender_id !== config.ownerId) return;
    const text = String(event.content || '').trim().replace(/^@\S+\s*/, '');
    if (!text) return;
    if (text === '/config') {
      await replyCard(event.message_id, configCard(config, models[config.engine] || [], availability));
      return;
    }
    if (text === '/status') {
      await replyText(event.message_id, statusText(config, models, availability));
      return;
    }
    if (text === '/history') {
      const key = scope(event);
      const sessions = await listCodexSessions({ limit: 15 });
      await replyCard(event.message_id, historyCard(sessions, config.conversations[key]?.codexThreadId));
      return;
    }
    if (text === '/new') {
      delete config.conversations[scope(event)];
      saveConfig(config);
      await replyText(event.message_id, '✅ 已新建会话，下一条消息会创建新的 Agent Session。');
      return;
    }
    if (text.startsWith('/cd ')) {
      config.workspace = text.slice(4).trim();
      delete config.conversations[scope(event)];
      saveConfig(config);
      await replyText(event.message_id, `✅ 工作目录已切换为：\`${config.workspace}\``);
      return;
    }
    if (config.engine === 'antigravity') {
      await replyText(event.message_id, 'Antigravity CLI (`agy`) 尚未安装。请先切换回 Codex。');
      return;
    }

    const key = scope(event);
    if (activeTasks.has(key)) {
      await replyText(event.message_id, '当前会话已有任务正在执行。请等待完成，或点击任务卡片中的「停止任务」。');
      return;
    }
    const startedAt = Date.now();
    const initialCard = taskCard({ state: 'running', prompt: text, config, taskKey: key });
    const sent = await replyCard(event.message_id, initialCard);
    const taskMessageId = sent.message_id || sent.messageId || '';
    const controller = new AbortController();
    activeTasks.set(key, { controller, taskMessageId });
    let lastCardUpdateAt = 0;
    let cardUpdateChain = Promise.resolve();
    const updateProgress = async (message) => {
      log(`${key} ${message}`);
      const now = Date.now();
      if (!taskMessageId || now - lastCardUpdateAt < 2500) return;
      lastCardUpdateAt = now;
      cardUpdateChain = cardUpdateChain
        .then(() => updateMessageCard(taskMessageId, taskCard({ state: 'running', prompt: text, progress: message, config, taskKey: key })))
        .catch((error) => log(`card update ${error.message}`));
      await cardUpdateChain;
    };
    const session = config.conversations[key] || {};
    try {
      const result = await runCodexTurn({
        prompt: text,
        cwd: config.workspace,
        model: config.model,
        permission: config.permission,
        effort: config.effort,
        threadId: session.codexThreadId,
        signal: controller.signal,
        onProgress: (message) => { void updateProgress(message); },
      });
      config.conversations[key] = { ...session, codexThreadId: result.threadId, updatedAt: new Date().toISOString() };
      saveConfig(config);
      const duration = formatDuration(Date.now() - startedAt);
      const completed = taskCard({ state: 'completed', prompt: text, answer: result.answer, config, duration });
      await cardUpdateChain;
      if (taskMessageId) await updateMessageCard(taskMessageId, completed);
      else await replyCard(event.message_id, completed);
    } catch (error) {
      log(`${key} error ${error.stack || error.message}`);
      const cancelled = error?.code === 'cancelled' || controller.signal.aborted;
      const failed = taskCard({ state: cancelled ? 'cancelled' : 'failed', prompt: text, answer: cancelled ? '任务已停止。' : friendlyError(error), config, duration: formatDuration(Date.now() - startedAt) });
      await cardUpdateChain;
      if (taskMessageId) await updateMessageCard(taskMessageId, failed);
      else await replyCard(event.message_id, failed);
    } finally {
      activeTasks.delete(key);
    }
  }

  async function handleCard(event) {
    const operator = event?.operator_id || event?.operator?.open_id || event?.open_id;
    if (config.ownerId && operator && operator !== config.ownerId) return;
    const value = parseActionValue(event?.action_value || event?.action?.value || event?.value);
    const selected = event?.option || event?.action?.option;
    if (value.action === 'engine') {
      if (value.value === 'antigravity' && !availability.antigravity) return;
      config.engine = value.value;
      config.model = '';
    } else if (value.action === 'model') {
      config.model = selected === '(inherit Codex default)' ? '' : selected;
    } else if (value.action === 'effort') {
      config.effort = value.value;
    } else if (value.action === 'permission') {
      if (value.value === 'danger-full-access') {
        if (event.token) await updateCallbackCard(event.token, fullAccessConfirmationCard(config), operator);
        return;
      }
      config.permission = value.value;
    } else if (value.action === 'confirm_permission') {
      config.permission = 'danger-full-access';
    } else if (value.action === 'cancel_permission') {
      if (event.token) await updateCallbackCard(event.token, configCard(config, models[config.engine] || [], availability), operator);
      return;
    } else if (value.action === 'cancel_task') {
      const task = activeTasks.get(value.taskKey || event.chat_id);
      if (task) task.controller.abort();
      return;
    } else if (value.action === 'session' && value.value === 'new') {
      if (event.chat_id) delete config.conversations[event.chat_id];
    } else if (value.action === 'open_config') {
      if (event.chat_id) await sendCard(event.chat_id, configCard(config, models[config.engine] || [], availability));
      return;
    } else if (value.action === 'open_history') {
      if (event.chat_id) {
        const sessions = await listCodexSessions({ limit: 15 });
        await sendCard(event.chat_id, historyCard(sessions, config.conversations[event.chat_id]?.codexThreadId));
      }
      return;
    } else if (value.action === 'resume_session' && value.threadId) {
      if (!event.chat_id) return;
      const sessions = await listCodexSessions({ limit: 15 });
      if (!sessions.some((session) => session.id === value.threadId)) return;
      config.conversations[event.chat_id] = { codexThreadId: value.threadId, updatedAt: new Date().toISOString() };
      saveConfig(config);
      log(`session resumed ${value.threadId}`);
      if (event.token) await updateCallbackCard(event.token, historyCard(sessions, value.threadId), operator);
      return;
    } else return;
    saveConfig(config);
    log(`config changed ${value.action}`);
    // Settings cards update in place. Task-card actions never replace the
    // completed result with a settings UI.
    if (event.token && ['engine', 'model', 'effort', 'permission', 'confirm_permission'].includes(value.action)) {
      await updateCallbackCard(event.token, configCard(config, models[config.engine] || [], availability), operator);
    }
  }
}

function scope(event) { return event.thread_id || event.chat_id; }
function parseActionValue(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}
function formatDuration(ms) { return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`; }
function friendlyError(error) {
  const message = String(error?.message || error || '未知错误');
  if (/No such file|ENOENT|cwd/i.test(message)) return '执行失败：工作目录不存在或无法访问。请使用 `/cd /有效路径` 切换目录。';
  if (/model.*(not found|unsupported|unavailable)|unsupported.*model/i.test(message)) return '执行失败：当前模型不可用。请打开「设置」重新选择模型。';
  if (/thread.*(not found|missing)|resume/i.test(message)) return '执行失败：历史会话无法恢复。请新建会话后重试。';
  if (/timed out|timeout/i.test(message)) return '执行超时：Codex 在限定时间内没有完成。可以新建会话后重试。';
  if (/permission|denied|sandbox/i.test(message)) return '执行失败：当前权限不足。请检查设置中的权限模式。';
  if (/app-server exited|EPIPE|ECONNRESET/i.test(message)) return 'Codex 进程意外退出。Bridge 仍在运行，请直接重试。';
  return `执行失败：${message.slice(0, 500)}`;
}
function statusText(config, models, availability) {
  return [
    '**Lark Agent Remote**',
    `- 引擎：${config.engine}`,
    `- 模型：${config.model || '继承默认模型'}`,
    `- 推理：${config.effort}`,
    `- 权限：${config.permission}`,
    `- 工作目录：${config.workspace}`,
    `- Codex：${availability.codex ? `可用（发现 ${models.codex.length} 个模型）` : '不可用'}`,
    `- Antigravity CLI：${availability.antigravity ? '可用' : '未安装'}`,
  ].join('\n');
}
function log(message) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
}
