import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { configCard, historyCard, taskCard } from './cards.js';
import { loadConfig, LOG_PATH, saveConfig } from './config.js';
import { listCodexModels, runCodexTurn } from './codex.js';
import { consumeEvent, replyCard, replyText, sendCard, updateCallbackCard, updateMessageCard } from './lark.js';
import { commandExists } from './process.js';
import { listCodexSessions } from './sessions.js';

export async function startBridge() {
  let config = loadConfig();
  const availability = { codex: await commandExists('codex'), antigravity: await commandExists('agy') };
  const models = { codex: await listCodexModels(), antigravity: [] };
  log(`starting engine=${config.engine} codexModels=${models.codex.length}`);

  const messageConsumer = consumeEvent('im.message.receive_v1', (event) => queue(() => handleMessage(event)));
  const cardConsumer = consumeEvent('card.action.trigger', (event) => queue(() => handleCard(event)));
  const children = [messageConsumer, cardConsumer];
  const stop = () => { for (const child of children) child.kill('SIGTERM'); process.exit(0); };
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

    const startedAt = Date.now();
    const initialCard = taskCard({ state: 'running', prompt: text, config });
    const sent = await replyCard(event.message_id, initialCard);
    const taskMessageId = sent.message_id || sent.messageId || '';
    let lastCardUpdateAt = 0;
    let cardUpdateChain = Promise.resolve();
    const updateProgress = async (message) => {
      log(`${key} ${message}`);
      const now = Date.now();
      if (!taskMessageId || now - lastCardUpdateAt < 2500) return;
      lastCardUpdateAt = now;
      cardUpdateChain = cardUpdateChain
        .then(() => updateMessageCard(taskMessageId, taskCard({ state: 'running', prompt: text, progress: message, config })))
        .catch((error) => log(`card update ${error.message}`));
      await cardUpdateChain;
    };
    const key = scope(event);
    const session = config.conversations[key] || {};
    try {
      const result = await runCodexTurn({
        prompt: text,
        cwd: config.workspace,
        model: config.model,
        permission: config.permission,
        effort: config.effort,
        threadId: session.codexThreadId,
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
      const failed = taskCard({ state: 'failed', prompt: text, answer: `执行失败：${error.message}`, config, duration: formatDuration(Date.now() - startedAt) });
      await cardUpdateChain;
      if (taskMessageId) await updateMessageCard(taskMessageId, failed);
      else await replyCard(event.message_id, failed);
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
      config.permission = value.value;
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
    if (event.token && ['engine', 'model', 'effort', 'permission'].includes(value.action)) {
      await updateCallbackCard(event.token, configCard(config, models[config.engine] || [], availability), operator);
    }
  }
}

let chain = Promise.resolve();
function queue(task) {
  chain = chain.then(task).catch((error) => log(error.stack || error.message));
}

function scope(event) { return event.thread_id || event.chat_id; }
function label(config) { return `${config.engine === 'codex' ? 'Codex' : 'Antigravity'} · ${config.model || 'default'} · ${config.effort}`; }
function parseActionValue(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}
function formatDuration(ms) { return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`; }
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
