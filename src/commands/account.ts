import { execSync } from 'child_process';
import { logger } from '../logger.js';
import { getRotateEnabled, setRotateEnabled, setLastRotateAt, setRotateIndex } from '../db.js';
import { registerCommand } from './registry.js';

// /account — 列出/切换 Anthropic 账号
registerCommand({
  name: '/account',
  description: '列出或切换 Anthropic 账号',
  hasArgs: true,
  order: 30,
  subcommands: [
    { usage: '/account', description: '列出所有账号及当前绑定' },
    { usage: '/account <name>', description: '切换到指定账号' },
    {
      usage: '/account auto on|off',
      description: '开关自动轮换（429 时自动切换）',
    },
  ],
  handler: async (ctx) => {
    const { args, chatJid, channel, group, queue, registeredGroups } = ctx;
    logger.info({ chatJid, arg: args }, '/account 命令匹配');

    if (args === 'auto on') {
      setRotateEnabled(true);
      await channel.sendMessage(chatJid, '🔄 自动轮换已开启');
      logger.info('/account auto on');
      return;
    }
    if (args === 'auto off') {
      setRotateEnabled(false);
      await channel.sendMessage(chatJid, '🔄 自动轮换已关闭');
      logger.info('/account auto off');
      return;
    }

    if (!args) {
      // 列出所有 secrets
      let secrets: Array<{ id: string; name: string; type: string }>;
      let agents: Array<{
        id: string;
        name: string;
        identifier: string;
        secretMode: string;
        isDefault?: boolean;
      }>;
      try {
        secrets = JSON.parse(
          execSync('onecli secrets list', {
            encoding: 'utf-8',
            timeout: 5000,
          }),
        );
        agents = JSON.parse(
          execSync('onecli agents list', {
            encoding: 'utf-8',
            timeout: 5000,
          }),
        );
      } catch (err) {
        logger.error({ err }, '/account: onecli 命令失败');
        await channel.sendMessage(chatJid, '❌ 账号操作失败，onecli 不可用');
        return;
      }

      const agentId = group?.folder.toLowerCase().replace(/_/g, '-') || '';
      // 优先匹配独立 agent，兜底用 Default（查看操作不改 secret，fallback 安全）
      const currentAgent =
        agents.find((a) => a.identifier === agentId) ||
        agents.find((a) => 'isDefault' in a && a.isDefault);

      let assignedSecretIds: string[] = [];
      if (currentAgent) {
        try {
          const agentSecrets = JSON.parse(
            execSync(`onecli agents secrets --id ${currentAgent.id}`, {
              encoding: 'utf-8',
              timeout: 5000,
            }),
          ) as Array<string | { id: string }>;
          assignedSecretIds = agentSecrets.map((s) =>
            typeof s === 'string' ? s : s.id,
          );
        } catch {
          /* no secrets assigned */
        }
      }

      const autoStatus = getRotateEnabled() ? '开启' : '关闭';
      const lines = secrets.map((s) => {
        const active = assignedSecretIds.includes(s.id) ? ' ← 当前' : '';
        return `• ${s.name} (${s.type})${active}`;
      });
      const reply =
        lines.length > 0
          ? `可用账号：\n${lines.join('\n')}\n\n自动轮换: ${autoStatus}\n\n切换：/account <name>\n开关：/account auto on|off`
          : '没有配置任何账号。用 onecli secrets create 添加。';
      await channel.sendMessage(chatJid, reply);
    } else {
      // 切换到指定账号
      let secrets: Array<{ id: string; name: string }>;
      try {
        secrets = JSON.parse(
          execSync('onecli secrets list', {
            encoding: 'utf-8',
            timeout: 5000,
          }),
        );
      } catch (err) {
        logger.error({ err }, '/account: onecli 命令失败');
        await channel.sendMessage(chatJid, '❌ 账号操作失败，onecli 不可用');
        return;
      }
      const target = secrets.find(
        (s) =>
          s.name === args ||
          s.id === args ||
          s.name.toLowerCase().includes(args.toLowerCase()),
      );
      if (!target) {
        await channel.sendMessage(
          chatJid,
          `❌ 找不到账号 "${args}"。用 /account 查看可用账号。`,
        );
        return;
      }

      const agentId = group?.folder.toLowerCase().replace(/_/g, '-') || '';
      let agents: Array<{
        id: string;
        identifier: string;
        isDefault?: boolean;
      }>;
      try {
        agents = JSON.parse(
          execSync('onecli agents list', {
            encoding: 'utf-8',
            timeout: 5000,
          }),
        );
      } catch (err) {
        logger.error({ err }, '/account: onecli agents list 失败');
        await channel.sendMessage(chatJid, '❌ 账号操作失败，onecli 不可用');
        return;
      }
      // 严格匹配 identifier，不 fallback 到 Default Agent（防止误改全局）
      const agent = agents.find((a) => a.identifier === agentId);
      if (agent) {
        try {
          execSync(
            `onecli agents set-secrets --id ${agent.id} --secret-ids ${target.id}`,
            { encoding: 'utf-8', timeout: 5000 },
          );
        } catch (err) {
          logger.error({ err }, '/account: 切换账号失败');
          await channel.sendMessage(chatJid, '❌ 账号切换失败');
          return;
        }
        // 同步 rotateIndex + 防抖时间戳，阻止 auto-rotate 覆盖手动切换
        if (group) {
          const targetIndex = secrets.findIndex((s) => s.id === target.id);
          if (targetIndex >= 0) setRotateIndex(targetIndex, group.folder);
          setLastRotateAt(Date.now(), group.folder);
        }
        // 杀掉旧容器，让新消息用新 key 起新容器
        // 保留 session（内存+DB），新容器用旧 sessionId 恢复上下文
        if (group) {
          queue.killGroup(chatJid);
        }
        await channel.sendMessage(
          chatJid,
          `✅ 已切换到 ${target.name}。下次对话生效。`,
        );
        logger.info(
          { agent: agent.id, secret: target.name },
          '/account: 账号已切换',
        );
      } else {
        await channel.sendMessage(chatJid, '❌ 找不到对应的 agent。');
      }
    }
  },
});

// /usage — 查询配额使用率
registerCommand({
  name: '/usage',
  description: '查询账号配额使用率',
  hasArgs: true,
  order: 31,
  subcommands: [
    { usage: '/usage', description: '查当前账号配额' },
    { usage: '/usage all', description: '查所有账号配额' },
    { usage: '/usage <name>', description: '查指定账号配额' },
    { usage: '/usage delete <name>', description: '删除 OAuth 凭证' },
  ],
  handler: async (ctx) => {
    const { args, chatJid, channel, registeredGroups } = ctx;
    // 动态 import 避免循环依赖
    const {
      formatUsage,
      formatUsageAll,
      getCurrentSecretName,
      getUsageAll,
      getUsageForSecret,
    } = await import('../usage-api.js');

    if (args?.startsWith('delete ')) {
      const name = args.slice('delete '.length).trim();
      if (!name) {
        await channel.sendMessage(chatJid, '⚠️ 用法: /usage delete <name>');
        return;
      }
      const { deleteOAuthCredential, getOAuthCredential } = await import('../db.js');
      if (!getOAuthCredential(name)) {
        await channel.sendMessage(chatJid, `⚠️ ${name}: 未找到该 OAuth 凭证`);
        return;
      }
      deleteOAuthCredential(name);
      await channel.sendMessage(chatJid, `✅ 已删除 ${name} 的 OAuth 凭证`);
      return;
    }

    if (args === 'all') {
      const results = await getUsageAll();
      const currentSecret = getCurrentSecretName(chatJid, registeredGroups);
      const reply = formatUsageAll(results, currentSecret);
      await channel.sendMessage(chatJid, reply);
    } else if (!args) {
      const currentSecret = getCurrentSecretName(chatJid, registeredGroups);
      if (!currentSecret) {
        await channel.sendMessage(
          chatJid,
          '⚠️ 无法确定当前账号。用 /usage all 查看所有。',
        );
        return;
      }
      const result = await getUsageForSecret(currentSecret);
      await channel.sendMessage(chatJid, formatUsage(result));
    } else {
      const result = await getUsageForSecret(args);
      await channel.sendMessage(chatJid, formatUsage(result));
    }
  },
});
