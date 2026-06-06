import { deleteGroupAlias, getAllGroupAliases, setGroupAlias } from '../db.js';
import { logger } from '../logger.js';
import { registerCommand } from './registry.js';

function usage(): string {
  return [
    '用法：',
    '/alias set <别名> <群JID>',
    '/alias list',
    '/alias del <别名>',
  ].join('\n');
}

registerCommand({
  name: '/alias',
  description: '管理跨群发送别名',
  hasArgs: true,
  requiresMain: true,
  order: 24,
  subcommands: [
    { usage: '/alias set <别名> <群JID>', description: '设置跨群别名' },
    { usage: '/alias list', description: '查看跨群别名' },
    { usage: '/alias del <别名>', description: '删除跨群别名' },
  ],
  handler: async (ctx) => {
    const [action, alias, chatJid] = ctx.args.split(/\s+/).filter(Boolean);

    if (action === 'set') {
      if (!alias || !chatJid) {
        await ctx.channel.sendMessage(ctx.chatJid, usage());
        return;
      }
      setGroupAlias(alias, chatJid);
      logger.info(
        { alias, chatJid, group: ctx.group.folder },
        '/alias: 设置跨群别名',
      );
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `已设置：${alias} → ${chatJid}`,
      );
      return;
    }

    if (action === 'list') {
      const aliases = getAllGroupAliases();
      const entries = Object.entries(aliases);
      if (entries.length === 0) {
        await ctx.channel.sendMessage(ctx.chatJid, '当前没有跨群别名');
        return;
      }
      await ctx.channel.sendMessage(
        ctx.chatJid,
        entries.map(([name, jid]) => `${name} → ${jid}`).join('\n'),
      );
      return;
    }

    if (action === 'del' || action === 'delete' || action === 'rm') {
      if (!alias) {
        await ctx.channel.sendMessage(ctx.chatJid, usage());
        return;
      }
      const deleted = deleteGroupAlias(alias);
      logger.info(
        { alias, deleted, group: ctx.group.folder },
        '/alias: 删除跨群别名',
      );
      await ctx.channel.sendMessage(
        ctx.chatJid,
        deleted ? `已删除：${alias}` : `别名不存在：${alias}`,
      );
      return;
    }

    await ctx.channel.sendMessage(ctx.chatJid, usage());
  },
});
