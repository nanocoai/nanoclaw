import { logger } from '../logger.js';
import { resolveCliMode } from '../cli-mode.js';
import type { CliMode } from '../types.js';
import { registerCommand } from './registry.js';

const VALID_MODES: CliMode[] = ['sdk', 'print', 'interactive', 'codex', 'gemini'];

// /mode <sdk|print|interactive|codex|gemini> — 切换群的 CLI 运行模式，并清掉旧模式 session
registerCommand({
  name: '/mode',
  description: '切换 CLI 运行模式（sdk / print / interactive / codex / gemini）',
  hasArgs: true,
  order: 21,
  handler: async (ctx) => {
    const mode = ctx.args.trim().toLowerCase();

    if (!mode) {
      const config = ctx.group.containerConfig ?? {};
      const current = config.cliMode ?? 'sdk';
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `当前模式: **${current}**\n可选: ${VALID_MODES.join(' / ')}\n用法: \`/mode <模式>\``,
        { isCommandReply: true },
      );
      return;
    }

    if (!VALID_MODES.includes(mode as CliMode)) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `❌ 无效模式 "${mode}"，可选: ${VALID_MODES.join(' / ')}`,
        { isCommandReply: true },
      );
      return;
    }

    const config = ctx.group.containerConfig ?? {};
    const previousMode = resolveCliMode(config);
    config.cliMode = mode as CliMode;
    ctx.group.containerConfig = config;
    ctx.setRegisteredGroup(ctx.chatJid, ctx.group);

    const killed = ctx.queue.killGroup(ctx.chatJid);
    delete ctx.sessions[ctx.group.folder];
    ctx.deleteSession(ctx.group.folder);

    logger.info(
      {
        group: ctx.group.folder,
        previousCliMode: previousMode,
        cliMode: mode,
        killed,
        sessionCleared: true,
      },
      '/mode: CLI 模式切换',
    );
    await ctx.channel.sendMessage(
      ctx.chatJid,
      killed
        ? `✅ 已切换为 **${mode}** 模式，已终止旧进程并清除旧 session，下一条消息会按新模式启动`
        : `✅ 已切换为 **${mode}** 模式，已清除旧 session，下一条消息会按新模式启动`,
      { isCommandReply: true },
    );
  },
});
