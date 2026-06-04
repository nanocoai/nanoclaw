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
 * 生成 tmux session 名称（与群绑定的固定名，不含时间戳）
 *
 * 用 chatJid 清洗后的完整标识做名字，保证同一个群每次都拿到同一个 session 名，
 * 便于跨进程/重启复用已存在的 tmux session（见 getOrCreate）。
 * 格式：nanoclaw-<chatJid 去掉非字母数字后的完整串>
 */
export function buildTmuxSessionName(chatJid: string): string {
  const id = chatJid.replace(/[^a-zA-Z0-9]/g, '') || 'unknown';
  return `nanoclaw-${id}`;
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
      // 显式指定 :0 窗口，防止用户手动开新窗口后 active window 不是 CLI 所在的 window 0
      return ['tmux', 'send-keys', '-t', `${sessionName}:0`, ...(extraArgs || [])];
    case 'kill-session':
      return ['tmux', 'kill-session', '-t', sessionName];
    case 'has-session':
      return ['tmux', 'has-session', '-t', sessionName];
    case 'list-sessions':
      return ['tmux', 'list-sessions', '-F', '#{session_name}'];
    case 'load-buffer':
      return ['tmux', 'load-buffer', ...(extraArgs || [])];
    case 'paste-buffer':
      // 显式指定 :0 窗口
      return ['tmux', 'paste-buffer', '-t', `${sessionName}:0`];
    case 'capture-pane':
      // 显式指定 :0 窗口
      return ['tmux', 'capture-pane', '-t', `${sessionName}:0`, '-p', ...(extraArgs || [])];
  }
}

// ---- TmuxSessionManager 类 ----

export interface TmuxSessionConfig {
  chatJid: string;
  cwd: string;
  env: Record<string, string | undefined>;
  cliArgs: string[];
  routeToken: string;
  log: (message: string) => void;
}

export interface TmuxSession {
  name: string;
  chatJid: string;
  createdAt: number;
  routeToken: string;
}

export type TmuxPaneState =
  | 'ready'
  | 'recoverable-dialog'
  | 'blocked-resume-search'
  | 'auth-error'
  | 'busy'
  | 'unknown';

export interface TmuxPaneAnalysis {
  state: TmuxPaneState;
  action?: 'enter' | 'select-and-enter';
  keys?: string[];
  reason?: string;
}

export class TmuxReadyError extends Error {
  constructor(
    message: string,
    public readonly state: TmuxPaneState,
    public readonly paneText: string,
  ) {
    super(message);
    this.name = 'TmuxReadyError';
  }
}

export function analyzeTmuxPane(paneText: string): TmuxPaneAnalysis {
  const selectAndConfirmPatterns: { match: string; keys: string[] }[] = [
    { match: 'Is this a project', keys: [] },
    { match: 'No, exit', keys: ['Down'] },
    { match: 'Do you want to use this API key', keys: ['Up'] },
  ];

  const autoConfirmPatterns = [
    'Choose the text style',
    'Let\'s get started',
    'trust this folder',
    'Press Enter to continue',
    'Security notes',
    'Enter to confirm',
    'Syntax theme:',
  ];

  const readyPatterns = [
    'Try "',
    '/effort',
  ];

  const blockedResumePatterns = [
    'Resume session',
    'No sessions match',
    'Type to Search',
  ];

  const authErrorPatterns = [
    'Not logged in',
    'Invalid API key',
    'Authentication failed',
    'OAuth token',
  ];

  if (readyPatterns.some((p) => paneText.includes(p))) {
    return { state: 'ready' };
  }

  if (blockedResumePatterns.some((p) => paneText.includes(p))) {
    return {
      state: 'blocked-resume-search',
      reason: 'Claude CLI 停在 Resume session 搜索页',
    };
  }

  const selectMatch = selectAndConfirmPatterns.find((p) => paneText.includes(p.match));
  if (selectMatch) {
    return {
      state: 'recoverable-dialog',
      action: 'select-and-enter',
      keys: selectMatch.keys,
      reason: selectMatch.match,
    };
  }

  if (autoConfirmPatterns.some((p) => paneText.includes(p))) {
    return {
      state: 'recoverable-dialog',
      action: 'enter',
      reason: 'auto-confirm dialog',
    };
  }

  if (authErrorPatterns.some((p) => paneText.includes(p))) {
    return {
      state: 'auth-error',
      reason: 'Claude CLI 鉴权失败',
    };
  }

  if (paneText.includes('Thinking') || paneText.includes('⏺') || paneText.includes('✻')) {
    return { state: 'busy' };
  }

  return { state: 'unknown' };
}

export class TmuxSessionManager {
  private sessions = new Map<string, TmuxSession>();
  private log: (message: string) => void;

  constructor(log: (message: string) => void) {
    this.log = log;
  }

  /** 获取或创建 tmux session */
  async getOrCreate(config: TmuxSessionConfig): Promise<TmuxSession> {
    // session 名是与群绑定的固定名，进程重启后仍能算出同一个名字
    const sessionName = buildTmuxSessionName(config.chatJid);

    // 1) 内存 Map 命中且存活 → 直接复用
    const existing = this.sessions.get(config.chatJid);
    if (existing) {
      const alive = await this.isAlive(existing.name);
      if (alive) {
        this.log(`[tmux] reusing session ${existing.name} (routeToken: ${existing.routeToken.slice(0, 8)}...)`);
        return existing;
      }
      this.sessions.delete(config.chatJid);
    }

    // 2) 内存 miss（如主进程刚重启），但 tmux 里固定名 session 还活着
    //    此时 session 里的 claude 进程 env（HTTPS_PROXY 端口、API key 等）可能已过期，
    //    因为每次 agent-runner 启动会创建新 TapProxy（随机端口）。
    //    必须 kill 旧 session 并创建新的，否则 CLI 永远指向已死的旧代理端口。
    if (await this.isAlive(sessionName)) {
      this.log(`[tmux] found stale session ${sessionName} from previous process, killing to recreate with fresh env`);
      try {
        await this.exec('tmux', ['kill-session', '-t', sessionName]);
      } catch { /* ignore if already dead */ }
    }

    // 3) 都没有 → 创建新 session

    // 构建 claude 启动命令（单引号包裹防止 shell 元字符展开）
    const claudeCmd = ['claude', ...config.cliArgs].map(arg =>
      shellQuote(arg)
    ).join(' ');

    // 构建环境变量命令：
    // - undefined 值 → unset（覆盖父进程继承的环境变量）
    // - 有值 → export（单引号包裹值防止注入）
    const envUnsets = Object.entries(config.env)
      .filter(([, v]) => v === undefined)
      .map(([k]) => `unset ${k}`)
      .join('; ');
    const envExports = Object.entries(config.env)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `export ${k}=${shellQuote(String(v))}`)
      .join('; ');
    const envSetup = [envUnsets, envExports].filter(Boolean).join('; ');

    // 用 script 捕获终端输出（保留 pty），方便诊断 CLI 退出原因
    const diagLog = `/tmp/nanoclaw-cli-diag-${Date.now()}.log`;
    const shellCmd = `${envSetup}; cd "${config.cwd}" && script -q ${diagLog} ${claudeCmd}`;
    this.log(`[tmux] diag log: ${diagLog}`);

    const args = buildTmuxCommand('new-session', sessionName, [shellCmd]);
    await this.exec(args[0], args.slice(1));

    const session: TmuxSession = {
      name: sessionName,
      chatJid: config.chatJid,
      createdAt: Date.now(),
      routeToken: config.routeToken,
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

    // 等 CLI 处理完粘贴（bracketed paste mode 下文本渲染需要时间）
    await new Promise(resolve => setTimeout(resolve, 300));

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

  /** 捕获 tmux pane 当前内容 */
  async capturePane(sessionName: string): Promise<string> {
    const args = buildTmuxCommand('capture-pane', sessionName, ['-S', '-50']);
    const { stdout } = await this.exec(args[0], args.slice(1));
    return stdout;
  }

  /**
   * 等待 Claude CLI 在 tmux 中就绪（输入提示出现）。
   * 自动处理所有启动阶段的确认对话框（主题选择、信任确认、安全提示等）。
   */
  async waitForReady(sessionName: string, timeoutMs = 60_000): Promise<void> {
    const startTime = Date.now();
    const pollIntervalMs = 1000;

    let lastPaneText = '';

    while (Date.now() - startTime < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

      let pane: string;
      try {
        pane = await this.capturePane(sessionName);
      } catch (err) {
        this.log(`[tmux] capturePane failed (session dead?): ${err instanceof Error ? err.message : err}`);
        // session 可能已经死了，检查一下
        const alive = await this.isAlive(sessionName);
        if (!alive) {
          this.log(`[tmux] session ${sessionName} is dead, aborting waitForReady`);
          throw new TmuxReadyError('tmux session 已退出', 'unknown', '');
        }
        continue;
      }

      const lines = pane.split('\n');
      const lastNonEmpty = lines.filter(l => l.trim().length > 0).slice(-8);
      const paneText = lastNonEmpty.join('\n');
      lastPaneText = paneText;
      // 调试：打印 pane 内容
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      this.log(`[tmux] pane@${elapsed}s: ${paneText.replace(/\n/g, ' | ')}`);

      const analysis = analyzeTmuxPane(paneText);

      if (analysis.state === 'ready') {
        this.log(`[tmux] CLI ready in session ${sessionName}`);
        return;
      }

      if (analysis.state === 'blocked-resume-search' || analysis.state === 'auth-error') {
        throw new TmuxReadyError(
          `Claude CLI 未就绪：${analysis.reason || analysis.state}`,
          analysis.state,
          paneText,
        );
      }

      if (analysis.state === 'recoverable-dialog' && analysis.action === 'select-and-enter') {
        this.log(`[tmux] navigating for "${analysis.reason}" in ${sessionName}: keys=[${(analysis.keys || []).join(',')}]`);
        for (const key of analysis.keys || []) {
          const keyArgs = buildTmuxCommand('send-keys', sessionName, [key]);
          await this.exec(keyArgs[0], keyArgs.slice(1));
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        const enterArgs = buildTmuxCommand('send-keys', sessionName, ['Enter']);
        await this.exec(enterArgs[0], enterArgs.slice(1));
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }

      if (analysis.state === 'recoverable-dialog' && analysis.action === 'enter') {
        this.log(`[tmux] auto-confirming dialog in session ${sessionName}`);
        const enterArgs = buildTmuxCommand('send-keys', sessionName, ['Enter']);
        await this.exec(enterArgs[0], enterArgs.slice(1));
        await new Promise(resolve => setTimeout(resolve, 1500));
        continue;
      }
    }

    throw new TmuxReadyError(
      `Claude CLI readiness timeout after ${timeoutMs}ms`,
      'unknown',
      lastPaneText,
    );
  }

  private async exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(cmd, args, { timeout: 10_000 });
  }
}
