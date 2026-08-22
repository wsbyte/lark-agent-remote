import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { configCard, fullAccessConfirmationCard, historyCard, taskCard } from './cards.js';
import { antigravityEffortFromModel, antigravityModelForEffort, listAntigravityModels, listAntigravitySessions, runAntigravityTurn } from './antigravity.js';
import { cleanupOldAttachments, extractOutgoingFiles, messageText, receiveAttachments, sendOutgoingFiles, withAttachmentContext } from './attachments.js';
import { loadConfig, LOG_PATH, saveConfig } from './config.js';
import { listCodexModels, runCodexTurn } from './codex.js';
import { consumeEvent, replyCard, replyText, sendCard, updateCallbackCard, updateMessageCard } from './lark.js';
import { commandExists } from './process.js';
import { listCodexSessions } from './sessions.js';

export async function startBridge() {
  let config = loadConfig();
  const activeTasks = new Map();
  const availability = { codex: await commandExists('codex'), antigravity: existsSync(`${process.env.HOME}/.local/bin/agy`) || await commandExists('agy') };
  const models = { codex: await listCodexModels(), antigravity: availability.antigravity ? await listAntigravityModels() : [] };
  cleanupOldAttachments();
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
    const text = messageText(event).replace(/^@\S+\s*/, '');
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
      const sessions = recentSessions(config.engine);
      const currentId = config.engine === 'antigravity' ? config.conversations[key]?.antigravityConversationId : config.conversations[key]?.codexThreadId;
      await replyCard(event.message_id, historyCard(await sessions, currentId, config.engine));
      return;
    }
    if (text === '/new') {
      clearCurrentSession(scope(event));
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
    const key = scope(event);
    if (activeTasks.has(key)) {
      await replyText(event.message_id, '当前会话已有任务正在执行。请等待完成，或点击任务卡片中的「停止任务」。');
      return;
    }
    const startedAt = Date.now();
    let attachments = [];
    try {
      attachments = await receiveAttachments(event);
    } catch (error) {
      await replyText(event.message_id, `附件下载失败：${friendlyError(error).replace(/^执行失败：/, '')}`);
      return;
    }
    const agentPrompt = withAttachmentContext(text, attachments);
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
      const common = {
        prompt: agentPrompt,
        cwd: config.workspace,
        model: config.model,
        permission: config.permission,
        effort: config.effort,
        signal: controller.signal,
        onProgress: (message) => { void updateProgress(message); },
      };
      const result = config.engine === 'antigravity'
        ? await runAntigravityTurn({ ...common, conversationId: session.antigravityConversationId })
        : await runCodexTurn({ ...common, threadId: session.codexThreadId });
      config.conversations[key] = {
        ...session,
        ...(config.engine === 'antigravity'
          ? { antigravityConversationId: result.conversationId }
          : { codexThreadId: result.threadId }),
        updatedAt: new Date().toISOString(),
      };
      saveConfig(config);
      const duration = formatDuration(Date.now() - startedAt);
      const outgoing = extractOutgoingFiles(result.answer, config.workspace);
      const completed = taskCard({ state: 'completed', prompt: text, answer: outgoing.answer, config, duration });
      await cardUpdateChain;
      if (taskMessageId) await updateMessageCard(taskMessageId, completed);
      else await replyCard(event.message_id, completed);
      if (outgoing.files.length) {
        try { await sendOutgoingFiles(event.message_id, outgoing.files); }
        catch (error) { await replyText(event.message_id, `任务已完成，但文件上传失败：${String(error.message || error).slice(0, 300)}`); }
      }
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
      if (config.engine === 'antigravity') config.effort = antigravityEffortFromModel(config.model) || config.effort;
    } else if (value.action === 'effort') {
      config.effort = value.value;
      if (config.engine === 'antigravity') config.model = antigravityModelForEffort(config.model, config.effort);
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
      if (event.chat_id) clearCurrentSession(event.chat_id);
    } else if (value.action === 'open_config') {
      if (event.chat_id) await sendCard(event.chat_id, configCard(config, models[config.engine] || [], availability));
      return;
    } else if (value.action === 'open_history') {
      if (event.chat_id) {
        const sessions = await recentSessions(config.engine);
        const currentId = config.engine === 'antigravity' ? config.conversations[event.chat_id]?.antigravityConversationId : config.conversations[event.chat_id]?.codexThreadId;
        await sendCard(event.chat_id, historyCard(sessions, currentId, config.engine));
      }
      return;
    } else if (value.action === 'resume_session' && value.threadId) {
      if (!event.chat_id) return;
      const sessions = await recentSessions(config.engine);
      if (!sessions.some((session) => session.id === value.threadId)) return;
      config.conversations[event.chat_id] = {
        ...(config.conversations[event.chat_id] || {}),
        ...(config.engine === 'antigravity' ? { antigravityConversationId: value.threadId } : { codexThreadId: value.threadId }),
        updatedAt: new Date().toISOString(),
      };
      saveConfig(config);
      log(`session resumed ${value.threadId}`);
      if (event.token) await updateCallbackCard(event.token, historyCard(sessions, value.threadId, config.engine), operator);
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

  function recentSessions(engine) {
    return engine === 'antigravity' ? listAntigravitySessions({ limit: 15 }) : listCodexSessions({ limit: 15 });
  }

  function clearCurrentSession(key) {
    const session = config.conversations[key];
    if (!session) return;
    if (config.engine === 'antigravity') delete session.antigravityConversationId;
    else delete session.codexThreadId;
    if (!session.codexThreadId && !session.antigravityConversationId) delete config.conversations[key];
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
  if (error?.code === 'auth') return 'Antigravity CLI 尚未登录。请在 Mac 终端运行 `agy` 并完成 Google 登录。';
  if (error?.code === 'eligibility') return 'Antigravity 账号资格检查失败。请确认网络可访问 Google 服务，然后在 Mac 终端运行一次 `agy`。';
  if (error?.code === 'model') return '当前 Antigravity 模型不可用。请打开「设置」重新选择模型。';
  if (error?.code === 'conversation') return 'Antigravity 历史会话无法恢复。请新建会话后重试。';
  if (error?.code === 'permission') return 'Antigravity 正在等待权限确认。请调整权限模式或配置允许规则。';
  if (error?.code === 'transient') return 'Antigravity 网络连接暂时不可用，自动重试后仍未恢复。请稍后再试。';
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
