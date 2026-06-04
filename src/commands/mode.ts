import { logger } from '../logger.js';
import type { CliMode } from '../types.js';
import { registerCommand } from './registry.js';

const VALID_MODES: CliMode[] = ['sdk', 'print', 'interactive', 'codex', 'gemini'];

// /mode <sdk|print|interactive|codex|gemini> — 切换群的 CLI 运行模式，立即生效无需重启
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
    config.cliMode = mode as CliMode;
    ctx.group.containerConfig = config;
    ctx.setRegisteredGroup(ctx.chatJid, ctx.group);

    logger.info(
      { group: ctx.group.folder, cliMode: mode },
      '/mode: CLI 模式切换',
    );
    await ctx.channel.sendMessage(
      ctx.chatJid,
      `✅ 已切换为 **${mode}** 模式，下次对话生效`,
      { isCommandReply: true },
    );
  },
});
