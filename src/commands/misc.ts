import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { DEFAULT_TRIGGER } from '../config.js';
import { getHelp, registerCommand } from './registry.js';
import { CLAUDE_MODES, resolveCliMode } from '../cli-mode.js';

// /help — 显示当前模式下可用命令
registerCommand({
  name: '/help',
  description: '显示此帮助',
  order: 1,
  handler: async (ctx) => {
    const mode = resolveCliMode(ctx.group?.containerConfig);
    await ctx.channel.sendMessage(ctx.chatJid, getHelp(undefined, mode));
  },
});

// /trigger — 开启 @触发模式
registerCommand({
  name: '/trigger',
  description: '开启 @触发模式（群聊需 @机器人才响应）',
  order: 40,
  handler: async (ctx) => {
    const { group, chatJid, channel } = ctx;
    if (group.isMain) return; // main group 不需要 trigger

    if (group.requiresTrigger) {
      await channel.sendMessage(
        chatJid,
        `已经是 @触发 模式，发消息需要 ${group.trigger || DEFAULT_TRIGGER} 开头`,
      );
      return;
    }

    group.requiresTrigger = true;
    ctx.registeredGroups[chatJid] = group;
    ctx.setRegisteredGroup(chatJid, group);

    logger.info(
      { chatJid, name: group.name, requiresTrigger: true },
      'Trigger mode toggled',
    );

    await channel.sendMessage(
      chatJid,
      `已切换到 @触发 模式，发消息需要 ${group.trigger || DEFAULT_TRIGGER} 开头`,
    );
  },
});

// /notrigger — 关闭 @触发模式
registerCommand({
  name: '/notrigger',
  description: '关闭 @触发模式（所有消息都响应）',
  order: 41,
  handler: async (ctx) => {
    const { group, chatJid, channel } = ctx;
    if (group.isMain) return;

    if (!group.requiresTrigger) {
      await channel.sendMessage(chatJid, '已经是免@模式，所有消息都会被处理');
      return;
    }

    group.requiresTrigger = false;
    ctx.registeredGroups[chatJid] = group;
    ctx.setRegisteredGroup(chatJid, group);

    logger.info(
      { chatJid, name: group.name, requiresTrigger: false },
      'Trigger mode toggled',
    );

    await channel.sendMessage(chatJid, '已切换到免@模式，所有消息都会被处理');
  },
});

// /cwd — 设置 Claude Code 工作目录（仅 Claude 系模式）
registerCommand({
  name: '/cwd',
  description: '设置 Claude Code 工作目录',
  hasArgs: true,
  order: 42,
  modes: CLAUDE_MODES,
  subcommands: [
    { usage: '/cwd', description: '查看当前工作目录' },
    { usage: '/cwd <path>', description: '设置新工作目录（下次对话生效）' },
    { usage: '/cwd reset', description: '重置为默认工作目录' },
  ],
  handler: async (ctx) => {
    const { args, chatJid, channel, group } = ctx;

    if (!args || args === 'status') {
      const cur = group.customCwd || '(默认: groups/' + group.folder + ')';
      await channel.sendMessage(chatJid, `[cwd] 当前工作目录: ${cur}`);
      return;
    }

    if (args === 'reset') {
      delete group.customCwd;
      ctx.setRegisteredGroup(chatJid, group);
      await channel.sendMessage(
        chatJid,
        '[cwd] 已重置为默认目录，下次对话生效',
      );
      return;
    }

    const resolved = path.resolve(args.replace(/^~/, process.env.HOME || '~'));
    if (!fs.existsSync(resolved)) {
      await channel.sendMessage(chatJid, `[cwd] 目录不存在: ${resolved}`);
      return;
    }

    group.customCwd = resolved;
    ctx.setRegisteredGroup(chatJid, group);
    await channel.sendMessage(
      chatJid,
      `[cwd] 已设置为 ${resolved}，下次对话生效`,
    );
  },
});
