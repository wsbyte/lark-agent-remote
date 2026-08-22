import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

export async function listCodexSessions({ cwd, limit = 10, sessionsDir = DEFAULT_SESSIONS_DIR } = {}) {
  if (!existsSync(sessionsDir)) return [];
  const files = collectJsonl(sessionsDir)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 100);
  const sessions = [];
  for (const file of files) {
    const session = await readSessionSummary(file);
    if (!session || (cwd && resolve(session.cwd) !== resolve(cwd))) continue;
    sessions.push(session);
  }
  return sessions
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

async function readSessionSummary(file) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let session;
  let firstPrompt = '';
  let updatedAt = '';
  for await (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    updatedAt = entry.timestamp || updatedAt;
    if (entry.type === 'session_meta') {
      const meta = entry.payload || {};
      session = {
        id: meta.session_id || meta.id,
        cwd: meta.cwd || '',
        createdAt: meta.timestamp || entry.timestamp || '',
      };
    }
    if (!firstPrompt) firstPrompt = extractUserPrompt(entry);
  }
  if (!session?.id) return null;
  return {
    ...session,
    title: cleanTitle(firstPrompt) || `会话 ${session.id.slice(0, 8)}`,
    updatedAt: updatedAt || session.createdAt,
  };
}

function extractUserPrompt(entry) {
  if (entry.type === 'event_msg' && entry.payload?.type === 'user_message') {
    return String(entry.payload.message || '');
  }
  const payload = entry.payload;
  if (entry.type !== 'response_item' || payload?.type !== 'message' || payload?.role !== 'user') return '';
  const texts = (payload.content || []).map((item) => item?.text || '').filter(Boolean);
  return texts.find((text) => !text.trimStart().startsWith('<')) || '';
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function collectJsonl(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJsonl(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
  }
  return files;
}
