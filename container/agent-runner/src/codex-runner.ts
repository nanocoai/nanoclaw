/**
 * Codex Runner — spawn OpenAI codex CLI 替代 claude（PoC）
 *
 * 每轮消息 spawn 一次 `codex exec`（首轮）或 `codex exec resume <threadId>`（续接），
 * 读 `--json` 输出的 JSONL 事件流后进程退出。IPC 新消息触发下一轮 spawn。
 *
 * 核心约束（均经实测 codex-cli 0.128.0 验证）：
 * - 必须剥掉 OneCLI 注入的 SSL_CERT_FILE/NODE_EXTRA_CA_CERTS/HTTP(S)_PROXY，
 *   否则 codex 的 Rust 二进制读 SSL_CERT_FILE 会替换系统证书，连 chatgpt.com 报 UnknownIssuer
 * - MCP server 不能用 --mcp-config flag（codex 没这个），靠 per-group CODEX_HOME + config.toml 加载
 * - session 续接用 thread_id（thread.started 事件给出），resume 不支持 -s/-C，靠 spawn cwd
 * - 输出格式保持与 SDK / print 路径一致的 ContainerOutput
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ContainerOutput } from './cli-runner.js';

// ---- 类型定义 ----

/** codex exec --json 输出的单行事件 */
export interface CodexEvent {
  type:
    | 'thread.started'
    | 'turn.started'
    | 'turn.completed'
    | 'item.started'
    | 'item.completed'
    | string;
  thread_id?: string;
  item?: {
    id: string;
    type: 'agent_message' | 'command_execution' | string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  [key: string]: unknown;
}

export interface CodexRunnerConfig {
  prompt: string;
  /** codex thread_id，作为 session 续接标识 */
  sessionId?: string;
  model?: string;
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  senderId?: string;
  ipcDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
  /** per-group CODEX_HOME 目录（持久化，跨轮保留 session 文件供 resume） */
  codexHome: string;
}

// ---- 纯函数（可单元测试） ----

/** 解析 codex JSONL 单行 → CodexEvent，畸形输入返回 null */
export function parseCodexEventLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || !parsed.type) return null;
    return parsed as CodexEvent;
  } catch {
    return null;
  }
}

/** 构建 codex CLI 参数数组（prompt 由调用方追加到末尾） */
export function buildCodexArgs(config: {
  sessionId?: string;
  model?: string;
}): string[] {
  const args: string[] = ['exec'];

  // 续接已有 thread
  if (config.sessionId) {
    args.push('resume', config.sessionId);
  }

  args.push(
    '--json',
    '--skip-git-repo-check',
    // 本地受信任子进程，等价于 claude 的 --dangerously-skip-permissions
    '--dangerously-bypass-approvals-and-sandbox',
  );

  if (config.model) {
    args.push('-m', config.model);
  }

  return args;
}

/** 构建清洁环境：剥掉证书/代理污染 + 设置 CODEX_HOME */
export function buildCodexEnv(
  baseEnv: Record<string, string | undefined>,
  codexHome: string,
): Record<string, string | undefined> {
  const env = { ...baseEnv };
  // 关键：OneCLI 注入的证书覆盖会让 codex Rust 二进制无法验证 chatgpt.com TLS
  delete env.SSL_CERT_FILE;
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.NODE_USE_ENV_PROXY;
  delete env.GIT_HTTP_PROXY_AUTHMETHOD;
  env.CODEX_HOME = codexHome;
  return env;
}

/** 生成 config.toml 内容：注册 nanoclaw MCP server */
export function buildCodexConfigToml(config: {
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  ipcDir: string;
  senderId?: string;
}): string {
  // 路径用 JSON.stringify 做 TOML 字符串转义（双引号 + 反斜杠）
  const q = (s: string) => JSON.stringify(s);
  return [
    '[mcp_servers.nanoclaw]',
    'command = "node"',
    `args = [${q(config.mcpServerPath)}]`,
    '',
    '[mcp_servers.nanoclaw.env]',
    `NANOCLAW_CHAT_JID = ${q(config.chatJid)}`,
    `NANOCLAW_GROUP_FOLDER = ${q(config.groupFolder)}`,
    `NANOCLAW_IS_MAIN = ${q(config.isMain ? '1' : '0')}`,
    `NANOCLAW_IPC_DIR = ${q(config.ipcDir)}`,
    `NANOCLAW_SENDER_ID = ${q(config.senderId || '')}`,
    '',
  ].join('\n');
}

/** 把 item.started 工具事件映射成进度输出（agent_message 不在此处理） */
export function mapCodexProgress(event: CodexEvent): ContainerOutput[] {
  if (event.type === 'item.started' && event.item) {
    const it = event.item;
    if (it.type === 'agent_message') return [];
    const label = it.command || it.type;
    const short = typeof label === 'string' ? label.slice(0, 60) : it.type;
    return [
      {
        status: 'progress',
        result: `🔧 ${short}`,
        progressType: 'tool_use',
      },
    ];
  }
  return [];
}

/** 映射 codex usage → ContainerOutput.usage */
export function mapCodexUsage(
  usage: CodexEvent['usage'],
): ContainerOutput['usage'] | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cached_input_tokens ?? 0,
    cacheCreationInputTokens: 0,
    numTurns: 1,
    durationMs: 0,
    totalCostUsd: 0,
  };
}

/**
 * 准备 per-group CODEX_HOME：软链 auth.json（复用宿主 ChatGPT 登录态）+ 写 config.toml
 * homeDir 来自 env.HOME，宿主 ~/.codex/auth.json 是 codex login 的凭据
 */
export function prepareCodexHome(
  codexHome: string,
  homeDir: string,
  configToml: string,
  log: (m: string) => void,
): void {
  fs.mkdirSync(codexHome, { recursive: true });

  // 软链宿主 auth.json（ChatGPT 登录态）。已存在则跳过
  const srcAuth = path.join(homeDir, '.codex', 'auth.json');
  const dstAuth = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(dstAuth)) {
    if (fs.existsSync(srcAuth)) {
      try {
        fs.symlinkSync(srcAuth, dstAuth);
      } catch (err) {
        log(`[codex-runner] symlink auth.json failed: ${(err as Error).message}`);
      }
    } else {
      log(`[codex-runner] WARNING: 宿主 ${srcAuth} 不存在，codex 可能未登录`);
    }
  }

  // 写 config.toml（每轮幂等覆盖，保证 MCP 配置最新）
  fs.writeFileSync(path.join(codexHome, 'config.toml'), configToml);
}

// ---- 主函数 ----

/**
 * 运行一轮 codex 模式 query：
 * spawn codex exec（或 resume），stdin 关闭，读 --json stdout，进程退出后返回
 */
export async function runCodexQuery(
  config: CodexRunnerConfig,
  writeOutput: (output: ContainerOutput) => void,
  log: (message: string) => void,
): Promise<{ newSessionId?: string; result?: string }> {
  // 准备 CODEX_HOME（auth + MCP config）
  const configToml = buildCodexConfigToml({
    mcpServerPath: config.mcpServerPath,
    chatJid: config.chatJid,
    groupFolder: config.groupFolder,
    isMain: config.isMain,
    ipcDir: config.ipcDir,
    senderId: config.senderId,
  });
  const homeDir = config.env.HOME || os.homedir();
  prepareCodexHome(config.codexHome, homeDir, configToml, log);

  const args = buildCodexArgs({
    sessionId: config.sessionId,
    model: config.model,
  });
  // prompt 作为末位位置参数
  args.push(config.prompt);

  const codexEnv = buildCodexEnv(config.env, config.codexHome);

  log(`[codex-runner] spawning: codex ${args.slice(0, -1).join(' ')} <prompt>`);
  log(`[codex-runner] cwd=${config.cwd}, sessionId=${config.sessionId || 'new'}, CODEX_HOME=${config.codexHome}`);

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: codexEnv as NodeJS.ProcessEnv,
      cwd: config.cwd,
    });

    let newSessionId: string | undefined = config.sessionId;
    let lastAgentMessage: string | undefined;
    let usage: ContainerOutput['usage'] | undefined;
    let sentSuccess = false;
    let lineBuffer = '';

    // prompt 已通过 arg 传入，关闭 stdin 避免 codex 等待
    child.stdin!.end();

    const handleLine = (line: string) => {
      const event = parseCodexEventLine(line);
      if (!event) return;

      log(`[codex-runner] event: ${event.type}${event.item ? `/${event.item.type}` : ''}`);

      // 提取 thread_id 作为 session
      if (event.type === 'thread.started' && event.thread_id) {
        newSessionId = event.thread_id;
        log(`[codex-runner] thread: ${newSessionId}`);
      }

      // 累积最后一条 agent_message 作为最终结果
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        if (typeof event.item.text === 'string') {
          lastAgentMessage = event.item.text;
        }
      }

      // turn 完成 → 发 success（result = 最后一条 agent_message）
      if (event.type === 'turn.completed') {
        usage = mapCodexUsage(event.usage);
        writeOutput({
          status: 'success',
          result: lastAgentMessage || null,
          newSessionId,
          usage,
        });
        sentSuccess = true;
        return;
      }

      // 工具进度
      for (const output of mapCodexProgress(event)) {
        writeOutput(output);
      }
    };

    child.stdout!.on('data', (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });

    child.stderr!.on('data', (data: Buffer) => {
      log(`[codex-stderr] ${data.toString().trim()}`);
    });

    child.on('close', (code) => {
      if (lineBuffer.trim()) handleLine(lineBuffer);

      log(`[codex-runner] process exited code=${code}`);

      // 没有正常 turn.completed 但有 agent_message → 兜底发 success
      if (!sentSuccess && lastAgentMessage) {
        writeOutput({
          status: 'success',
          result: lastAgentMessage,
          newSessionId,
          usage,
        });
        sentSuccess = true;
      }

      if (code !== 0 && !sentSuccess) {
        writeOutput({
          status: 'error',
          result: null,
          error: `codex 进程退出码 ${code}`,
          newSessionId,
        });
      }

      resolve({ newSessionId, result: lastAgentMessage });
    });

    child.on('error', (err) => {
      log(`[codex-runner] spawn error: ${err.message}`);
      writeOutput({
        status: 'error',
        result: null,
        error: `启动 codex CLI 失败: ${err.message}`,
      });
      reject(err);
    });
  });
}
