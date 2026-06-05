import type { Channel, CliMode, NewMessage, RegisteredGroup } from '../types.js';
import type { GroupQueue } from '../group-queue.js';
import { findChannel } from '../router.js';
import { logger } from '../logger.js';
import { CLAUDE_MODES, resolveCliMode } from '../cli-mode.js';
import type { Command, CommandContext } from './types.js';

/** 命令在给定模式下是否可用（无 modes 字段 = 全模式适用） */
function isCommandAvailable(cmd: Command, mode: CliMode): boolean {
  return !cmd.modes || cmd.modes.includes(mode);
}

const commands: Command[] = [];

export function registerCommand(cmd: Command): void {
  if (commands.some((c) => c.name === cmd.name)) {
    throw new Error(`命令 "${cmd.name}" 已注册，禁止重复注册`);
  }
  commands.push(cmd);
}

export interface DispatchDeps {
  chatJid: string;
  msg: NewMessage;
  group: RegisteredGroup;
  channels: Channel[];
  sessions: Record<string, string>;
  queue: GroupQueue;
  registeredGroups: Record<string, RegisteredGroup>;
  deleteSession: (folder: string) => void;
  setRegisteredGroup: (jid: string, group: RegisteredGroup) => void;
}

/**
 * 匹配并执行命令。返回 true 表示已处理（调用方应 return），false 表示未匹配。
 */
export async function dispatch(
  trimmed: string,
  deps: DispatchDeps,
): Promise<boolean> {
  // '/ ' 开头不算命令
  if (trimmed.startsWith('/ ')) return false;

  // 精确匹配优先
  let matched = commands.find((c) => !c.hasArgs && trimmed === c.name);

  // 未命中则前缀匹配（hasArgs: true）
  if (!matched) {
    matched = commands.find(
      (c) =>
        c.hasArgs && (trimmed === c.name || trimmed.startsWith(c.name + ' ')),
    );
  }

  if (!matched) return false;

  // channel 空值守卫
  const channel = findChannel(deps.channels, deps.chatJid);
  if (!channel) {
    logger.warn(
      { chatJid: deps.chatJid, cmd: matched.name },
      '命令匹配但 channel 未找到',
    );
    return true; // 命令已匹配，不应穿透到"未知命令"
  }

  // 包装 channel：命令回复自动带 isCommandReply，避免打断正在运行的 agent
  const commandChannel: typeof channel = {
    ...channel,
    sendMessage: (jid: string, text: string) =>
      channel.sendMessage(jid, text, { isCommandReply: true }),
  };

  // 模式检查：当前群 CLI 模式不在命令的 modes 白名单时，拦截并提示（用 commandChannel 避免打断 agent）
  const currentMode = resolveCliMode(deps.group?.containerConfig);
  if (!isCommandAvailable(matched, currentMode)) {
    await commandChannel
      .sendMessage(
        deps.chatJid,
        `⚠️ ${matched.name} 在当前 ${currentMode} 模式下不可用`,
      )
      .catch(() => {});
    logger.info(
      { chatJid: deps.chatJid, cmd: matched.name, mode: currentMode },
      '命令因模式不匹配被拦截',
    );
    return true;
  }

  // 权限检查
  if (matched.requiresMain && !deps.group?.isMain) {
    await channel
      .sendMessage(deps.chatJid, '此命令仅限主群使用')
      .catch(() => {});
    return true;
  }

  // 提取 args
  const args = trimmed.slice(matched.name.length).trim();

  try {
    await matched.handler({
      chatJid: deps.chatJid,
      args,
      group: deps.group,
      channel: commandChannel,
      msg: deps.msg,
      sessions: deps.sessions,
      queue: deps.queue,
      registeredGroups: deps.registeredGroups,
      deleteSession: deps.deleteSession,
      setRegisteredGroup: deps.setRegisteredGroup,
    });
  } catch (err) {
    logger.error({ err, cmd: matched.name }, '命令执行失败');
    await commandChannel
      .sendMessage(deps.chatJid, `命令执行失败: ${(err as Error).message}`)
      .catch(() => {});
  }
  return true;
}

/**
 * 生成 help 文本，按当前 CLI 模式过滤命令与修饰符。
 * @param prefix 前缀，如 '❓ 未知命令 "/foo"，'
 * @param mode 当前群 CLI 模式，不传则默认 'sdk'（显示全部 Claude 命令）
 */
export function getHelp(prefix?: string, mode: CliMode = 'sdk'): string {
  const sorted = [...commands]
    .filter((c) => isCommandAvailable(c, mode))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const lines = sorted.map((c) => {
    let line = `${c.name} — ${c.description}`;
    if (c.subcommands) {
      for (const sub of c.subcommands) {
        // subcommand 无 modes = 跟随主命令；有 modes 则按当前模式过滤
        if (sub.modes && !sub.modes.includes(mode)) continue;
        line += `\n  ${sub.usage} — ${sub.description}`;
      }
    }
    return line;
  });

  const header = prefix ? `${prefix}可用命令：\n` : '可用命令：\n';
  // 思考修饰符（! !! ~ +）是 Sonnet/Opus 专属，仅 Claude 系模式显示
  const suffix = CLAUDE_MODES.includes(mode)
    ? `\n\n消息前缀修饰符：\n! — Sonnet 快速（无思考）\n!! — Sonnet 深度思考\n~ — 关闭思考（默认模型）\n+ — Opus 4.6 深度思考`
    : '';
  return header + lines.join('\n') + suffix;
}

export function getRegisteredCommands(): readonly Command[] {
  return commands;
}
