import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { HOME_DIR } from './config.js';
import { downloadMessageResource, replyMedia } from './lark.js';

const ATTACHMENTS_DIR = join(HOME_DIR, 'attachments');
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export async function receiveAttachments(event) {
  const type = event.message_type || event.msg_type || '';
  const content = parseContent(event.content);
  const resources = [];
  if (type === 'image' && content.image_key) resources.push({ key: content.image_key, type: 'image', name: `${content.image_key}.png` });
  if (['file', 'audio', 'media', 'video'].includes(type) && content.file_key) {
    resources.push({ key: content.file_key, type: 'file', name: content.file_name || content.name || content.file_key });
  }
  if (!resources.length) return [];

  const folder = join(ATTACHMENTS_DIR, safeName(event.message_id));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const paths = [];
  for (const resource of resources) {
    const relative = join('attachments', safeName(event.message_id), safeName(resource.name));
    const downloaded = await downloadMessageResource(event.message_id, resource.key, resource.type, relative);
    if (downloaded) paths.push(resolve(HOME_DIR, downloaded));
  }
  return paths;
}

export function messageText(event) {
  const type = event.message_type || event.msg_type || 'text';
  const content = parseContent(event.content);
  if (type === 'text') return String(content.text ?? event.content ?? '').trim();
  if (type === 'post') return extractPostText(content).trim();
  if (type === 'image') return '请分析这张图片。';
  if (['file', 'audio', 'media', 'video'].includes(type)) return `请处理这个${type === 'file' ? '文件' : '媒体附件'}。`;
  return '';
}

export function withAttachmentContext(prompt, paths) {
  const attachmentText = paths.length ? `\n\n飞书附件（已下载到本机）：\n${paths.map((path) => `- ${path}`).join('\n')}` : '';
  return `${prompt}${attachmentText}\n\n如果你生成了需要发回飞书的文件，请在回复末尾逐行写：LARK_FILE: /absolute/path`;
}

export function extractOutgoingFiles(answer, workspace) {
  const files = [];
  const cleaned = String(answer || '').replace(/^LARK_FILE:\s*(.+)$/gim, (_, rawPath) => {
    const path = rawPath.trim().replace(/^['"]|['"]$/g, '');
    const absolute = resolve(path);
    const root = resolve(workspace);
    if (absolute.startsWith(`${root}/`) && existsSync(absolute) && statSync(absolute).isFile() && statSync(absolute).size <= MAX_UPLOAD_BYTES) files.push(absolute);
    return '';
  }).trim();
  return { answer: cleaned, files: [...new Set(files)].slice(0, 3) };
}

export async function sendOutgoingFiles(messageId, files) {
  for (const path of files) await replyMedia(messageId, path, isImage(path) ? 'image' : 'file');
}

export function cleanupOldAttachments(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  if (!existsSync(ATTACHMENTS_DIR)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of readdirSync(ATTACHMENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(ATTACHMENTS_DIR, entry.name);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { recursive: true });
      }
    } catch {}
  }
}

function parseContent(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return { text: String(value || '') }; }
}

function extractPostText(content) {
  const localized = content.zh_cn || content.en_us || Object.values(content)[0] || content;
  const rows = Array.isArray(localized?.content) ? localized.content : [];
  return [localized?.title || '', ...rows.flat().map((item) => item?.text || '')].filter(Boolean).join('\n');
}

function safeName(value) { return basename(String(value || 'attachment')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }
function isImage(path) { return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(extname(path).toLowerCase()); }
