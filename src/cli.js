import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startBridge } from './bridge.js';
import { CONFIG_PATH, initializeConfig, loadConfig, LOG_PATH } from './config.js';
import { installLaunchd, launchdStatus, restartLaunchd } from './launchd.js';
import { commandExists, run, runInteractive } from './process.js';

export async function main(args) {
  const command = args[0] || 'help';
  if (command === 'setup') {
    const workspace = valueAfter(args, '--workspace') || process.cwd();
    if (!(await commandExists('lark-cli'))) throw new Error('缺少 lark-cli，请先运行：npx @larksuite/cli@latest install');
    const show = await run('lark-cli', ['config', 'show'], { allowFailure: true });
    if (show.code !== 0 || !/appId/.test(show.stdout)) {
      console.log('正在启动飞书扫码配置…');
      await runInteractive('lark-cli', ['config', 'init', '--new']);
    }
    initializeConfig(resolve(workspace));
    console.log(`配置已保存：${CONFIG_PATH}`);
    if (!args.includes('--no-install')) {
      const plist = await installLaunchd();
      console.log(`后台服务已安装：${plist}`);
    } else {
      console.log('配置已完成。运行 `lark-agent-remote run` 开始测试。');
    }
    return;
  }
  if (command === 'run') return startBridge();
  if (command === 'install') {
    console.log(`后台服务已安装：${await installLaunchd()}`);
    return;
  }
  if (command === 'restart') { await restartLaunchd(); console.log('已重启。'); return; }
  if (command === 'status') {
    const config = loadConfig();
    console.log(JSON.stringify({ service: await launchdStatus(), runtime: publicConfig(config) }, null, 2));
    return;
  }
  if (command === 'doctor') {
    const config = loadConfig();
    const larkConfig = await run('lark-cli', ['config', 'show'], { allowFailure: true }).catch(() => ({ code: 1 }));
    const workspace = directoryAccess(config.workspace);
    const service = await launchdStatus();
    const checks = {
      node: process.version,
      larkCli: await commandExists('lark-cli'),
      larkConfigured: larkConfig.code === 0,
      codex: existsSync('/Applications/ChatGPT.app/Contents/Resources/codex') || await commandExists('codex'),
      antigravityCli: existsSync(`${process.env.HOME}/.local/bin/agy`) || await commandExists('agy'),
      antigravityOnboarding: antigravityOnboardingStatus(),
      config: existsSync(CONFIG_PATH),
      workspace,
      service,
      log: LOG_PATH,
    };
    console.log(JSON.stringify({ ok: checks.larkCli && checks.larkConfigured && checks.codex && checks.config && workspace.readable && service.running, checks }, null, 2));
    return;
  }
  console.log(`lark-agent-remote

Commands:
  setup [--workspace PATH] [--no-install]
  run
  install
  restart
  status
  doctor`);
}

function directoryAccess(path) {
  const result = { path, exists: existsSync(path), readable: false, writable: false };
  try { accessSync(path, constants.R_OK); result.readable = true; } catch {}
  try { accessSync(path, constants.W_OK); result.writable = true; } catch {}
  return result;
}

function publicConfig(config) {
  return { engine: config.engine, model: config.model || 'default', effort: config.effort, permission: config.permission, workspace: config.workspace };
}

function antigravityOnboardingStatus() {
  const path = `${process.env.HOME}/.gemini/antigravity-cli/cache/onboarding.json`;
  try { return Boolean(JSON.parse(readFileSync(path, 'utf8')).onboardingComplete); } catch { return false; }
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : '';
}
