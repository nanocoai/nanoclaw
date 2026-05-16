/**
 * tmux 会话管理器 — 创建/注入/健康检查/清理 Claude CLI 交互式会话
 *
 * 纯函数与副作用分离：
 * - 纯函数：buildTmuxSessionName, escapeTmuxInput, buildInteractiveCliArgs, buildTmuxCommand
 * - 副作用：TmuxSessionManager 类（exec tmux 命令）
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

// ---- 纯函数 ----

/** 短文本阈值（字节），超过则用 load-buffer 方案 */
export const SEND_KEYS_MAX_BYTES = 2048;

/**
 * 用单引号安全包裹 shell 参数，防止 $()、反引号、\ 等元字符展开。
 * 内部单引号通过 '\'' 转义（关闭单引号 → 转义单引号 → 重开单引号）。
 */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * 生成 tmux session 名称
 * 格式：nanoclaw-<chatJid 前 8 位>-<时间戳>
 */
export function buildTmuxSessionName(chatJid: string): string {
  const prefix = chatJid.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'unknown';
  return `nanoclaw-${prefix}-${Date.now()}`;
}

/**
 * 转义文本以便 tmux send-keys -l 安全发送
 *
 * tmux send-keys -l 按字面量发送，但换行符需要替换为空格
 * （send-keys 路径中换行会被解释为回车，导致提前提交）。
 * 仅用于短消息（<= SEND_KEYS_MAX_BYTES）。
 */
export function escapeTmuxInput(text: string): string {
  return text.replace(/\n/g, ' ');
}

/**
 * 构建 Claude CLI 交互模式启动参数（不含 --print）
 */
export function buildInteractiveCliArgs(config: {
  model?: string;
  mcpConfigPath: string;
  dangerouslySkipPermissions?: boolean;
  additionalDirectories?: string[];
  systemPromptAppend?: string;
  sessionId?: string;
}): string[] {
  const args: string[] = [];

  if (config.model) {
    args.push('--model', config.model);
  }

  if (config.sessionId) {
    args.push('--resume', config.sessionId);
  }

  if (config.dangerouslySkipPermissions !== false) {
    args.push('--dangerously-skip-permissions');
  }

  args.push('--mcp-config', config.mcpConfigPath);

  if (config.additionalDirectories) {
    for (const dir of config.additionalDirectories) {
      args.push('--add-dir', dir);
    }
  }

  if (config.systemPromptAppend) {
    args.push('--append-system-prompt', config.systemPromptAppend);
  }

  return args;
}

/**
 * 构建 tmux 命令参数数组
 */
export function buildTmuxCommand(
  action: 'new-session' | 'send-keys' | 'kill-session' | 'has-session' | 'list-sessions' | 'load-buffer' | 'paste-buffer' | 'capture-pane',
  sessionName: string,
  extraArgs?: string[],
): string[] {
  switch (action) {
    case 'new-session':
      return ['tmux', 'new-session', '-d', '-s', sessionName, '-x', '200', '-y', '50', ...(extraArgs || [])];
    case 'send-keys':
      return ['tmux', 'send-keys', '-t', sessionName, ...(extraArgs || [])];
    case 'kill-session':
      return ['tmux', 'kill-session', '-t', sessionName];
    case 'has-session':
      return ['tmux', 'has-session', '-t', sessionName];
    case 'list-sessions':
      return ['tmux', 'list-sessions', '-F', '#{session_name}'];
    case 'load-buffer':
      return ['tmux', 'load-buffer', ...(extraArgs || [])];
    case 'paste-buffer':
      return ['tmux', 'paste-buffer', '-t', sessionName];
    case 'capture-pane':
      return ['tmux', 'capture-pane', '-t', sessionName, '-p', ...(extraArgs || [])];
  }
}

// ---- TmuxSessionManager 类 ----

export interface TmuxSessionConfig {
  chatJid: string;
  cwd: string;
  env: Record<string, string | undefined>;
  cliArgs: string[];
  log: (message: string) => void;
}

export interface TmuxSession {
  name: string;
  chatJid: string;
  createdAt: number;
}

export class TmuxSessionManager {
  private sessions = new Map<string, TmuxSession>();
  private log: (message: string) => void;

  constructor(log: (message: string) => void) {
    this.log = log;
  }

  /** 获取或创建 tmux session */
  async getOrCreate(config: TmuxSessionConfig): Promise<TmuxSession> {
    // 检查是否已有该 chatJid 的活跃 session
    const existing = this.sessions.get(config.chatJid);
    if (existing) {
      const alive = await this.isAlive(existing.name);
      if (alive) {
        this.log(`[tmux] reusing session ${existing.name}`);
        return existing;
      }
      this.sessions.delete(config.chatJid);
    }

    // 创建新 session
    const sessionName = buildTmuxSessionName(config.chatJid);

    // 构建 claude 启动命令（单引号包裹防止 shell 元字符展开）
    const claudeCmd = ['claude', ...config.cliArgs].map(arg =>
      shellQuote(arg)
    ).join(' ');

    // 构建环境变量导出命令（单引号包裹值防止注入）
    const envExports = Object.entries(config.env)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `export ${k}=${shellQuote(String(v))}`)
      .join('; ');

    const shellCmd = `${envExports}; cd "${config.cwd}" && ${claudeCmd}`;

    const args = buildTmuxCommand('new-session', sessionName, [shellCmd]);
    await this.exec(args[0], args.slice(1));

    const session: TmuxSession = {
      name: sessionName,
      chatJid: config.chatJid,
      createdAt: Date.now(),
    };
    this.sessions.set(config.chatJid, session);

    this.log(`[tmux] created session ${sessionName} for ${config.chatJid.slice(0, 16)}...`);
    return session;
  }

  /** 向 tmux session 注入消息文本 */
  async sendMessage(sessionName: string, text: string): Promise<void> {
    const byteLength = Buffer.byteLength(text, 'utf-8');

    if (byteLength <= SEND_KEYS_MAX_BYTES) {
      // 短消息：send-keys -l
      const escaped = escapeTmuxInput(text);
      const args = buildTmuxCommand('send-keys', sessionName, ['-l', escaped]);
      await this.exec(args[0], args.slice(1));
    } else {
      // 长消息：load-buffer + paste-buffer（保留原始换行，paste-buffer 能正确粘贴多行）
      const tmpFile = path.join(os.tmpdir(), `nanoclaw-msg-${Date.now()}.txt`);
      try {
        fs.writeFileSync(tmpFile, text);
        const loadArgs = buildTmuxCommand('load-buffer', sessionName, [tmpFile]);
        await this.exec(loadArgs[0], loadArgs.slice(1));
        const pasteArgs = buildTmuxCommand('paste-buffer', sessionName);
        await this.exec(pasteArgs[0], pasteArgs.slice(1));
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    }

    // 发送 Enter 键触发
    const enterArgs = buildTmuxCommand('send-keys', sessionName, ['Enter']);
    await this.exec(enterArgs[0], enterArgs.slice(1));

    this.log(`[tmux] sent message to ${sessionName} (${byteLength} bytes)`);
  }

  /** 检查 tmux session 是否存活 */
  async isAlive(sessionName: string): Promise<boolean> {
    try {
      const args = buildTmuxCommand('has-session', sessionName);
      await this.exec(args[0], args.slice(1));
      return true;
    } catch {
      return false;
    }
  }

  /** 优雅退出 session */
  async destroy(sessionName: string, chatJid?: string): Promise<void> {
    try {
      // 先发 /exit 命令
      const exitArgs = buildTmuxCommand('send-keys', sessionName, ['-l', '/exit']);
      await this.exec(exitArgs[0], exitArgs.slice(1));
      const enterArgs = buildTmuxCommand('send-keys', sessionName, ['Enter']);
      await this.exec(enterArgs[0], enterArgs.slice(1));

      // 等待最多 10 秒
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const alive = await this.isAlive(sessionName);
        if (!alive) {
          this.log(`[tmux] session ${sessionName} exited gracefully`);
          if (chatJid) this.sessions.delete(chatJid);
          return;
        }
      }

      // 超时，强制 kill
      this.log(`[tmux] session ${sessionName} did not exit, force killing`);
    } catch {
      // has-session 失败说明已退出
    }

    // 强制终止
    try {
      const killArgs = buildTmuxCommand('kill-session', sessionName);
      await this.exec(killArgs[0], killArgs.slice(1));
    } catch { /* already dead */ }

    if (chatJid) this.sessions.delete(chatJid);
    this.log(`[tmux] session ${sessionName} destroyed`);
  }

  /** 清理孤儿 nanoclaw-* session */
  async cleanupOrphans(): Promise<number> {
    try {
      const args = buildTmuxCommand('list-sessions', '');
      const { stdout } = await this.exec(args[0], args.slice(1));
      const sessions = stdout.trim().split('\n').filter(s => s.startsWith('nanoclaw-'));

      let cleaned = 0;
      for (const session of sessions) {
        // 不清理自己管理的 session
        const isManaged = Array.from(this.sessions.values()).some(s => s.name === session);
        if (isManaged) continue;

        try {
          const killArgs = buildTmuxCommand('kill-session', session);
          await this.exec(killArgs[0], killArgs.slice(1));
          cleaned++;
          this.log(`[tmux] cleaned orphan session: ${session}`);
        } catch { /* ignore */ }
      }

      return cleaned;
    } catch {
      // tmux server not running or no sessions
      return 0;
    }
  }

  /** 获取指定 chatJid 的 session */
  getSession(chatJid: string): TmuxSession | undefined {
    return this.sessions.get(chatJid);
  }

  private async exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(cmd, args, { timeout: 10_000 });
  }
}
