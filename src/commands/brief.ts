import { logger } from '../logger.js';
import { registerCommand } from './registry.js';

// /brief — 切换自动后置总结：最终回复照常发送后，再补一条极简总结
registerCommand({
  name: '/brief',
  description: '切换自动后置总结（最终回复后追加极简总结）',
  order: 22,
  handler: async (ctx) => {
    const config = ctx.group.containerConfig ?? {};
    const newValue = !config.autoFollowupSummary;
    config.autoFollowupSummary = newValue;
    ctx.group.containerConfig = config;
    ctx.setRegisteredGroup(ctx.chatJid, ctx.group);

    logger.info(
      { group: ctx.group.folder, autoFollowupSummary: newValue },
      '/brief: 自动后置总结切换',
    );
    await ctx.channel.sendMessage(
      ctx.chatJid,
      newValue
        ? '✅ brief 已开启 — 最终回复后会自动追加一条极简总结'
        : '✅ brief 已关闭 — 只发送原始最终回复',
      { isCommandReply: true },
    );
  },
});
