import { logger } from '../logger.js';
import { startRemoteControl, stopRemoteControl } from '../remote-control.js';
import { registerCommand } from './registry.js';
import { CLAUDE_MODES } from '../cli-mode.js';

// /remote-control — 启动远程控制会话（仅 Claude 系模式）
registerCommand({
  name: '/remote-control',
  description: '启动 Claude Code 远程控制会话',
  requiresMain: true,
  order: 50,
  modes: CLAUDE_MODES,
  handler: async (ctx) => {
    const result = await startRemoteControl(
      ctx.msg.sender,
      ctx.chatJid,
      process.cwd(),
    );
    if (result.ok) {
      await ctx.channel.sendMessage(ctx.chatJid, result.url);
    } else {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `Remote Control failed: ${result.error}`,
      );
    }
  },
});

// /remote-control-end — 结束远程控制会话（仅 Claude 系模式）
registerCommand({
  name: '/remote-control-end',
  description: '结束远程控制会话',
  requiresMain: true,
  order: 51,
  modes: CLAUDE_MODES,
  handler: async (ctx) => {
    const result = stopRemoteControl();
    if (result.ok) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        'Remote Control session ended.',
      );
    } else {
      await ctx.channel.sendMessage(ctx.chatJid, result.error);
    }
  },
});
