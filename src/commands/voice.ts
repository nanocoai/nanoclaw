import { logger } from '../logger.js';
import { registerCommand } from './registry.js';

function ensureVoiceConfig(group: {
  containerConfig?: {
    voiceNotify?: { push?: boolean; mac?: boolean; summaryV2?: boolean };
  };
}) {
  const config = group.containerConfig ?? {};
  config.voiceNotify = config.voiceNotify ?? {};
  group.containerConfig = config;
  return config.voiceNotify;
}

registerCommand({
  name: '/voice',
  description: '切换当前群的语音播报推送（on / off / v2 on / v2 off / status）',
  hasArgs: true,
  order: 23,
  subcommands: [
    { usage: '/voice on', description: '开启当前群最终结果语音推送' },
    { usage: '/voice off', description: '关闭当前群最终结果语音推送' },
    {
      usage: '/voice v2 on',
      description: '开启 v2 智能摘要（按内容类型分流 prompt）',
    },
    {
      usage: '/voice v2 off',
      description: '关闭 v2 智能摘要，恢复 120 字一刀切',
    },
    { usage: '/voice status', description: '查看当前群语音推送状态' },
  ],
  handler: async (ctx) => {
    const args = ctx.args.trim().toLowerCase();
    const action = args || 'status';

    // /voice v2 on | /voice v2 off
    if (action === 'v2 on' || action === 'v2 off') {
      const voice = ensureVoiceConfig(ctx.group);
      voice.summaryV2 = action === 'v2 on';
      ctx.setRegisteredGroup(ctx.chatJid, ctx.group);
      logger.info(
        {
          group: ctx.group.folder,
          chatJid: ctx.chatJid,
          summaryV2: voice.summaryV2,
        },
        '/voice: v2 智能摘要切换',
      );
      await ctx.channel.sendMessage(
        ctx.chatJid,
        voice.summaryV2
          ? '🧠 已开启 v2 智能摘要 — 按内容类型（代码/表格/方案/列表/对话）分流不同 prompt'
          : '📝 已关闭 v2 智能摘要 — 恢复 120 字一刀切',
        { isCommandReply: true },
      );
      return;
    }

    if (!['on', 'off', 'status'].includes(action)) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        '用法：/voice on | off | v2 on | v2 off | status',
        { isCommandReply: true },
      );
      return;
    }

    const voice = ensureVoiceConfig(ctx.group);
    if (action === 'status') {
      const pushOn = voice.push || voice.mac;
      const v2On = voice.summaryV2 === true;
      const lines = [
        pushOn ? '🔊 语音播报推送：已开启' : '🔇 语音播报推送：已关闭',
        v2On ? '🧠 摘要模式：v2 智能分流' : '📝 摘要模式：v1（120 字一刀切）',
      ];
      await ctx.channel.sendMessage(ctx.chatJid, lines.join('\n'), {
        isCommandReply: true,
      });
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
