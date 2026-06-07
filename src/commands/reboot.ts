import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from '../logger.js';
import { registerCommand } from './registry.js';
import type { CommandContext } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const restartScript = path.join(repoRoot, 'restart.sh');
const rebootLog = path.join(repoRoot, 'logs', 'reboot-command.log');

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function handleReboot(ctx: CommandContext): Promise<void> {
  if (!fs.existsSync(restartScript)) {
    await ctx.channel.sendMessage(
      ctx.chatJid,
      `[reboot] 找不到重启脚本: ${restartScript}`,
    );
    return;
  }

  await ctx.channel.sendMessage(
    ctx.chatJid,
    `[reboot] 收到，正在执行 restart.sh。日志: ${rebootLog}`,
  );

  const command = [
    'nohup',
    quoteShell(restartScript),
    '>>',
    quoteShell(rebootLog),
    '2>&1',
    '&',
  ].join(' ');

  const child = spawn('/bin/bash', ['-lc', command], {
    cwd: repoRoot,
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (err) => {
    logger.error({ err, restartScript }, '/reboot: 启动 restart.sh 失败');
  });
  child.unref();

  logger.info(
    {
      chatJid: ctx.chatJid,
      group: ctx.group.folder,
      restartScript,
      rebootLog,
    },
    '/reboot: 已触发 restart.sh',
  );
}

registerCommand({
  name: '/reboot',
  description: '重启 NanoClaw 主进程（执行 restart.sh）',
  requiresMain: true,
  order: 30,
  handler: handleReboot,
});

registerCommand({
  name: '/Reboot',
  description: '重启 NanoClaw 主进程（同 /reboot）',
  requiresMain: true,
  order: 31,
  handler: handleReboot,
});
