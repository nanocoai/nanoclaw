import type {
  Channel,
  CliMode,
  NewMessage,
  RegisteredGroup,
} from '../types.js';
import type { GroupQueue } from '../group-queue.js';

export interface Command {
  name: string; // '/reset'
  description: string; // '杀进程，保留 session'
  hasArgs?: boolean; // true 时前缀匹配 '/account xxx'，false 时精确匹配
  requiresMain?: boolean; // 仅 main group 可用
  order?: number; // help 显示排序（默认注册顺序）
  // subcommand 也可带 modes：例 /usage 的 all/<name>/delete 仅 Claude 适用，codex 模式不显示
  subcommands?: { usage: string; description: string; modes?: CliMode[] }[];
  /**
   * 适用的 CLI 模式白名单。不填 = 全模式适用。
   * 例：Anthropic 专属命令标 ['sdk','print','interactive']，/stop 标 ['codex']。
   * help 按当前群模式过滤显示，dispatch 拦截不适用模式的调用。
   */
  modes?: CliMode[];
  handler: (ctx: CommandContext) => Promise<void>;
}

export interface CommandContext {
  chatJid: string;
  args: string; // 命令后的参数
  group: RegisteredGroup;
  channel: Channel; // dispatch 层已保证非 null，handler 无需 findChannel
  msg: NewMessage; // 原始消息
  // 可变状态
  sessions: Record<string, string>;
  queue: GroupQueue;
  registeredGroups: Record<string, RegisteredGroup>;
  // 辅助函数
  deleteSession: (folder: string) => void;
  setRegisteredGroup: (jid: string, group: RegisteredGroup) => void;
  // 推进群消息处理游标到指定时间戳，丢弃该时间戳之前未处理的消息（/new、/clear 用于开启全新对话）
  advanceCursor: (chatJid: string, timestamp: string) => void;
}
