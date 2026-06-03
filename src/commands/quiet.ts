import { logger } from '../logger.js';
import { registerCommand } from './registry.js';

// /quiet — 切换安静模式：LLM 中间文字进进度卡片 vs 独立发消息
registerCommand({
  name: '/quiet',
  description: '切换安静模式（中间文字进卡片 / 独立发送）',
  order: 20,
  handler: async (ctx) => {
    const config = ctx.group.containerConfig ?? {};
    const newValue = !config.quietProgress;
    config.quietProgress = newValue;
    ctx.group.containerConfig = config;
    // 持久化到 DB
    ctx.setRegisteredGroup(ctx.chatJid, ctx.group);
    logger.info(
      { group: ctx.group.folder, quietProgress: newValue },
      '/quiet: 安静模式切换',
    );
    await ctx.channel.sendMessage(
      ctx.chatJid,
      newValue
        ? '🔇 安静模式已开启 — LLM 中间文字将收入进度卡片'
        : '🔊 安静模式已关闭 — LLM 中间文字将独立发送',
      { isCommandReply: true },
    );
  },
});
