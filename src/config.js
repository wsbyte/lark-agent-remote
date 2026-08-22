import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const HOME_DIR = join(homedir(), '.lark-agent-remote');
export const CONFIG_PATH = join(HOME_DIR, 'config.json');
export const LOG_PATH = join(HOME_DIR, 'bridge.log');

function defaults() {
  return {
    version: 1,
    ownerId: '',
    engine: 'codex',
    model: '',
    effort: 'high',
    permission: 'workspace-write',
    workspace: process.cwd(),
    conversations: {},
  };
}

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return defaults();
  return { ...defaults(), ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function initializeConfig(workspace) {
  const config = loadConfig();
  config.workspace = resolve(workspace || config.workspace || process.cwd());
  saveConfig(config);
  return config;
}
