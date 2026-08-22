import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './process.js';

const LABEL = 'io.wsbyte.lark-agent-remote';
const PLIST = `${homedir()}/Library/LaunchAgents/${LABEL}.plist`;

export async function installLaunchd() {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lark-agent-remote.js');
  chmodSync(entry, 0o755);
  mkdirSync(dirname(PLIST), { recursive: true });
  const proxySetting = process.env.LARK_AGENT_REMOTE_PROXY;
  const proxy = proxySetting?.toLowerCase() === 'none' ? '' : (proxySetting || await systemProxyUrl());
  const proxyEnvironment = proxy ? `<key>HTTP_PROXY</key><string>${escapeXml(proxy)}</string>
<key>HTTPS_PROXY</key><string>${escapeXml(proxy)}</string>
<key>http_proxy</key><string>${escapeXml(proxy)}</string>
<key>https_proxy</key><string>${escapeXml(proxy)}</string>
<key>NO_PROXY</key><string>127.0.0.1,localhost,::1</string>
<key>no_proxy</key><string>127.0.0.1,localhost,::1</string>` : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${entry}</string><string>run</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${homedir()}/.lark-agent-remote/launchd.out.log</string>
<key>StandardErrorPath</key><string>${homedir()}/.lark-agent-remote/launchd.err.log</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${dirname(process.execPath)}:/Applications/ChatGPT.app/Contents/Resources</string>
${proxyEnvironment}</dict>
</dict></plist>\n`;
  writeFileSync(PLIST, xml);
  await run('launchctl', ['bootout', `gui/${process.getuid()}`, PLIST], { allowFailure: true });
  await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST]);
  return PLIST;
}

async function systemProxyUrl() {
  const result = await run('scutil', ['--proxy'], { allowFailure: true });
  if (result.code !== 0 || !/HTTPSEnable\s*:\s*1/.test(result.stdout)) return '';
  const host = result.stdout.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
  const port = result.stdout.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
  return host && port ? `http://${host}:${port}` : '';
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export async function restartLaunchd() {
  return run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`]);
}

export async function launchdStatus() {
  const result = await run('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { allowFailure: true });
  return {
    installed: result.code === 0,
    running: result.code === 0 && /state = running/.test(result.stdout),
    label: LABEL,
    plist: PLIST,
  };
}
