export function configCard(config, models, availability) {
  const modelOptions = (models.length ? models : ['(inherit Codex default)']).slice(0, 20).map((model) => ({ text: { tag: 'plain_text', content: model }, value: model }));
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: 'Lark Agent Remote 设置' } },
    elements: [
      { tag: 'markdown', content: `**执行引擎**\n当前：${config.engine === 'codex' ? 'Codex' : 'Antigravity'}${availability.antigravity ? '' : '\nAntigravity CLI 尚未安装'}` },
      { tag: 'action', actions: [
        button('Codex', { action: 'engine', value: 'codex' }, config.engine === 'codex' ? 'primary' : 'default'),
        button('Antigravity', { action: 'engine', value: 'antigravity' }, config.engine === 'antigravity' ? 'primary' : 'default'),
      ] },
      { tag: 'div', text: { tag: 'plain_text', content: `模型：${config.model || '继承 Codex 默认模型'}` }, extra: { tag: 'select_static', placeholder: { tag: 'plain_text', content: '选择模型' }, options: modelOptions, value: { action: 'model' } } },
      { tag: 'markdown', content: `**推理强度：${config.effort}**` },
      { tag: 'action', actions: ['low', 'medium', 'high'].map((value) => button(value, { action: 'effort', value }, config.effort === value ? 'primary' : 'default')) },
      { tag: 'markdown', content: `**权限：${config.permission}**` },
      { tag: 'action', actions: [
        button('只读', { action: 'permission', value: 'read-only' }, config.permission === 'read-only' ? 'primary' : 'default'),
        button('工作区读写', { action: 'permission', value: 'workspace-write' }, config.permission === 'workspace-write' ? 'primary' : 'default'),
        button('完整权限', { action: 'permission', value: 'danger-full-access' }, config.permission === 'danger-full-access' ? 'danger' : 'default'),
      ] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `工作目录：${config.workspace}` }] },
    ],
  };
}

export function taskCard({ state, prompt, answer = '', progress = '正在分析…', config, duration = '' }) {
  const appearance = {
    running: { template: 'blue', icon: '⏳', title: `${engineLabel(config)} 执行中...` },
    completed: { template: '', icon: '', title: '' },
    failed: { template: 'red', icon: '❌', title: '任务失败' },
  }[state] || { template: 'grey', icon: '•', title: '任务状态' };
  const elements = [];
  if (state === 'running') {
    elements.push({ tag: 'markdown', content: progress });
  } else {
    elements.push({ tag: 'markdown', content: clip(answer || '任务已完成。', 3500) });
  }
  elements.push(
    { tag: 'hr' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: `${engineLabel(config)} · ${config.model || '默认模型'} · ${capitalize(config.effort)}${duration ? ` · ${duration}` : ''}` }] },
  );
  if (state !== 'running') {
    elements.push({ tag: 'action', actions: [
      button('新会话', { action: 'session', value: 'new' }),
      button('历史会话', { action: 'open_history', value: 'history' }),
      button('设置', { action: 'open_config', value: 'config' }),
    ] });
  }
  const card = {
    config: { wide_screen_mode: true, enable_forward: true },
    elements,
  };
  if (state !== 'completed') {
    card.header = { template: appearance.template, title: { tag: 'plain_text', content: `${appearance.icon} ${appearance.title}` } };
  }
  return card;
}

export function historyCard(sessions, currentThreadId = '') {
  const elements = sessions.length ? sessions.flatMap((session) => [
    {
      tag: 'div',
      text: { tag: 'plain_text', content: `${session.id === currentThreadId ? '🟢 ' : ''}${session.title}` },
      extra: button(session.id === currentThreadId ? '当前会话' : '继续聊', { action: 'resume_session', threadId: session.id }, session.id === currentThreadId ? 'primary' : 'default'),
    },
    { tag: 'note', elements: [{ tag: 'plain_text', content: formatTime(session.updatedAt) }] },
    { tag: 'hr' },
  ]) : [{ tag: 'markdown', content: '还没有可恢复的 Codex 会话。' }];
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '历史会话' } },
    elements: [
      ...elements,
      { tag: 'note', elements: [{ tag: 'plain_text', content: `全部工作目录 · 最近 ${sessions.length} 条` }] },
    ],
  };
}

function button(label, value, type = 'default') {
  return { tag: 'button', text: { tag: 'plain_text', content: label }, type, value };
}

function engineLabel(config) { return config.engine === 'codex' ? 'Codex' : 'Antigravity'; }
function capitalize(value) { return value ? value[0].toUpperCase() + value.slice(1) : ''; }
function clip(value, max) { const text = String(value || ''); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }
function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
