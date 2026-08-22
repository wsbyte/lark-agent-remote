import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startBridge } from './bridge.js';
import { CONFIG_PATH, initializeConfig, loadConfig, LOG_PATH } from './config.js';
import { installLaunchd, restartLaunchd } from './launchd.js';
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
    if (args.includes('--install-launchd')) {
      const plist = await installLaunchd();
      console.log(`后台服务已安装：${plist}`);
    } else {
      console.log('运行 `lark-agent-remote run` 开始测试；稳定后运行 `lark-agent-remote install` 设置开机启动。');
    }
    return;
  }
  if (command === 'run') return startBridge();
  if (command === 'install') {
    console.log(`后台服务已安装：${await installLaunchd()}`);
    return;
  }
  if (command === 'restart') { await restartLaunchd(); console.log('已重启。'); return; }
  if (command === 'status') { console.log(JSON.stringify(loadConfig(), null, 2)); return; }
  if (command === 'doctor') {
    const checks = {
      node: process.version,
      larkCli: await commandExists('lark-cli'),
      codex: await commandExists('codex'),
      antigravityCli: await commandExists('agy'),
      config: existsSync(CONFIG_PATH),
      log: LOG_PATH,
    };
    console.log(JSON.stringify(checks, null, 2));
    return;
  }
  console.log(`lark-agent-remote

Commands:
  setup [--workspace PATH] [--install-launchd]
  run
  install
  restart
  status
  doctor`);
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : '';
}
