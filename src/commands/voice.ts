import { logger } from '../logger.js';
import { registerCommand } from './registry.js';

function ensureVoiceConfig(group: {
  containerConfig?: { voiceNotify?: { push?: boolean; mac?: boolean } };
}) {
  const config = group.containerConfig ?? {};
  config.voiceNotify = config.voiceNotify ?? {};
  group.containerConfig = config;
  return config.voiceNotify;
}

registerCommand({
  name: '/voice',
  description: '切换当前群的语音播报推送（on / off / status）',
  hasArgs: true,
  order: 23,
  subcommands: [
    { usage: '/voice on', description: '开启当前群最终结果语音推送' },
    { usage: '/voice off', description: '关闭当前群最终结果语音推送' },
    { usage: '/voice status', description: '查看当前群语音推送状态' },
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
        voice.push || voice.mac
          ? '🔊 当前群语音播报推送：已开启'
          : '🔇 当前群语音播报推送：已关闭',
        { isCommandReply: true },
      );
      return;
    }

    voice.push = action === 'on';
    delete voice.mac;
    ctx.setRegisteredGroup(ctx.chatJid, ctx.group);
    logger.info(
      { group: ctx.group.folder, chatJid: ctx.chatJid, voicePush: voice.push },
      '/voice: 语音播报推送切换',
    );
    await ctx.channel.sendMessage(
      ctx.chatJid,
      voice.push
        ? '🔊 已开启当前群语音播报推送 — 最终结果会推送摘要'
        : '🔇 已关闭当前群语音播报推送',
      { isCommandReply: true },
    );
  },
});
