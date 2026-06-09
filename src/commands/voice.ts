import { logger } from '../logger.js';
import { registerCommand } from './registry.js';

function ensureVoiceConfig(group: {
  containerConfig?: { voiceNotify?: { mac?: boolean } };
}) {
  const config = group.containerConfig ?? {};
  config.voiceNotify = config.voiceNotify ?? {};
  group.containerConfig = config;
  return config.voiceNotify;
}

registerCommand({
  name: '/voice',
  description: '切换当前群的 Mac 语音播报（on / off / status）',
  hasArgs: true,
  order: 23,
  subcommands: [
    { usage: '/voice on', description: '开启当前群最终结果 Mac 播报' },
    { usage: '/voice off', description: '关闭当前群最终结果 Mac 播报' },
    { usage: '/voice status', description: '查看当前群 Mac 播报状态' },
  ],
  handler: async (ctx) => {
    const action = ctx.args.trim().toLowerCase() || 'status';
    if (!['on', 'off', 'status'].includes(action)) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        '用法：/voice on | /voice off | /voice status',
        { isCommandReply: true },
      );
      return;
    }

    const voice = ensureVoiceConfig(ctx.group);
    if (action === 'status') {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        voice.mac
          ? '🔊 当前群 Mac 语音播报：已开启'
          : '🔇 当前群 Mac 语音播报：已关闭',
        { isCommandReply: true },
      );
      return;
    }

    voice.mac = action === 'on';
    ctx.setRegisteredGroup(ctx.chatJid, ctx.group);
    logger.info(
      { group: ctx.group.folder, chatJid: ctx.chatJid, macVoice: voice.mac },
      '/voice: Mac 语音播报切换',
    );
    await ctx.channel.sendMessage(
      ctx.chatJid,
      voice.mac
        ? '🔊 已开启当前群 Mac 语音播报 — 最终结果会播报摘要'
        : '🔇 已关闭当前群 Mac 语音播报',
      { isCommandReply: true },
    );
  },
});
