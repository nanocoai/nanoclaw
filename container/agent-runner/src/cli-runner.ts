/**
 * CLI Runner — spawn claude CLI 替代 Agent SDK
 *
 * 每轮消息 spawn 一次 `claude --print --resume <sessionId>`，
 * 读 stream-json stdout 后进程退出。IPC 新消息触发下一轮 spawn。
 *
 * 核心约束：
 * - 清除 CLAUDE_AGENT_SDK_CLIENT_APP 环境变量（不带 x-client-app header）
 * - 输出格式保持与 SDK 路径完全一致的 ContainerOutput
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---- 类型定义 ----

/** CLI stream-json 每行 JSON 的类型 */
export interface CliStreamMessage {
  type: 'system' | 'assistant' | 'result' | 'rate_limit_event';
  subtype?: string;
  session_id?: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
    model?: string;
    usage?: Record<string, number>;
  };
  result?: string;
  usage?: Record<string, number>;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  /** session_id 也可能出现在 result 顶层 */
  [key: string]: unknown;
}

/** 与 index.ts 中的 ContainerOutput 保持一致 */
export interface ContainerOutput {
  status: 'success' | 'error' | 'progress';
  result: string | null;
  newSessionId?: string;
  error?: string;
  progressType?: 'tool_use' | 'tool_result' | 'thinking';
  detail?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    numTurns: number;
    durationMs: number;
    totalCostUsd: number;
    modelContextWindows?: Record<string, number>;
    model?: string;
  };
}

export interface CliRunnerConfig {
  prompt: string;
  sessionId?: string;
  model?: string;
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  ipcDir: string;
  dangerouslySkipPermissions?: boolean;
  cwd: string;
  env: Record<string, string | undefined>;
  additionalDirectories?: string[];
  systemPromptAppend?: string;
}

// ---- 纯函数（可单元测试） ----

/**
 * 解析 stream-json 单行 → CliStreamMessage
 * 对畸形输入宽容：返回 null
 */
export function parseStreamJsonLine(line: string): CliStreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || !parsed.type) return null;
    return parsed as CliStreamMessage;
  } catch {
    return null;
  }
}

/**
 * 构建 MCP 配置 JSON 对象
 */
export function buildMcpConfig(
  mcpServerPath: string,
  chatJid: string,
  groupFolder: string,
  isMain: boolean,
  ipcDir: string,
): Record<string, unknown> {
  return {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: chatJid,
          NANOCLAW_GROUP_FOLDER: groupFolder,
          NANOCLAW_IS_MAIN: isMain ? '1' : '0',
          NANOCLAW_IPC_DIR: ipcDir,
        },
      },
    },
  };
}

/**
 * 构建 claude CLI 参数数组
 */
export function buildCliArgs(config: {
  model?: string;
  sessionId?: string;
  mcpConfigPath: string;
  dangerouslySkipPermissions?: boolean;
  additionalDirectories?: string[];
  systemPromptAppend?: string;
}): string[] {
  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
  ];

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
 * 将 CliStreamMessage 映射为 ContainerOutput 数组
 * assistant 消息可能产生多个输出（text + tool_use），全部返回
 * 其他类型最多返回一个
 */
export function mapToContainerOutput(
  msg: CliStreamMessage,
  sessionId?: string,
): ContainerOutput[] {
  // system init — 提取 session_id
  if (msg.type === 'system' && msg.subtype === 'init') {
    // 不产生输出，session_id 由调用方提取
    return [];
  }

  // assistant 消息 — 提取工具调用和文本，全部返回
  if (msg.type === 'assistant' && msg.message?.content) {
    const content = msg.message.content;
    const outputs: ContainerOutput[] = [];

    for (const block of content) {
      if (block.type === 'tool_use' && block.name) {
        const input = block.input as Record<string, unknown> | null;
        const emoji = block.name === 'Bash' ? '🔧' :
                      block.name === 'Read' ? '📖' :
                      block.name === 'Write' || block.name === 'Edit' ? '✏️' :
                      block.name === 'Grep' ? '🔍' :
                      block.name === 'Glob' ? '📋' : '⚙️';
        const inputStr = input
          ? (input.command as string || input.file_path as string || input.query as string || input.pattern as string || block.name)
          : block.name;
        const shortInput = typeof inputStr === 'string' ? inputStr.slice(0, 60) : block.name;

        outputs.push({
          status: 'progress',
          result: `${emoji} ${block.name}: ${shortInput}`,
          progressType: 'tool_use',
        });
      }

      if (block.type === 'text' && block.text) {
        const trimmed = block.text.trim();
        if (trimmed.length > 5) {
          const short = trimmed.slice(0, 80) + (trimmed.length > 80 ? '...' : '');
          outputs.push({
            status: 'progress',
            result: `💭 ${short}`,
            progressType: 'thinking',
            detail: trimmed.length > 80 ? trimmed : undefined,
          });
        }
      }
    }

    return outputs;
  }

  // result — 最终结果
  if (msg.type === 'result') {
    const rawUsage = msg.usage as Record<string, number> | undefined;
    const usage = rawUsage ? {
      inputTokens: rawUsage.input_tokens ?? 0,
      outputTokens: rawUsage.output_tokens ?? 0,
      cacheReadInputTokens: rawUsage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: rawUsage.cache_creation_input_tokens ?? 0,
      numTurns: (msg.num_turns as number) ?? 0,
      durationMs: (msg.duration_ms as number) ?? 0,
      totalCostUsd: (msg.total_cost_usd as number) ?? 0,
      model: msg.message?.model,
    } : undefined;

    return [{
      status: 'success' as const,
      result: (msg.result as string) || null,
      newSessionId: (msg.session_id as string) || sessionId,
      usage,
    }];
  }

  // system error
  if (msg.type === 'system' && msg.subtype === 'error') {
    const rawMsg = (msg as Record<string, unknown>).message;
    const errorText = typeof rawMsg === 'string' ? rawMsg : 'CLI error';
    return [{
      status: 'error' as const,
      result: null,
      error: errorText,
    }];
  }

  return [];
}

/**
 * 构建清洁的环境变量（移除 CLAUDE_AGENT_SDK_CLIENT_APP）
 */
export function buildCliEnv(baseEnv: Record<string, string | undefined>): Record<string, string | undefined> {
  const env = { ...baseEnv };
  // 核心：移除 Agent SDK 标识，让请求走交互式配额
  delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
  // 也移除其他可能的 SDK 标识
  delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  return env;
}

// ---- 主函数 ----

/**
 * 运行一轮 CLI 模式的 query
 * spawn claude --print，写入 stdin prompt，读 stdout stream-json，进程退出后返回
 */
export async function runCliQuery(
  config: CliRunnerConfig,
  writeOutput: (output: ContainerOutput) => void,
  log: (message: string) => void,
): Promise<{
  newSessionId?: string;
  result?: string;
}> {
  // 写入临时 MCP 配置文件
  const mcpConfig = buildMcpConfig(
    config.mcpServerPath,
    config.chatJid,
    config.groupFolder,
    config.isMain,
    config.ipcDir,
  );
  const mcpConfigPath = path.join(os.tmpdir(), `nanoclaw-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

  // 构建 CLI 参数
  const args = buildCliArgs({
    model: config.model,
    sessionId: config.sessionId,
    mcpConfigPath,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions ?? true,
    additionalDirectories: config.additionalDirectories,
    systemPromptAppend: config.systemPromptAppend,
  });

  // 构建清洁环境（移除 SDK 标识）
  const cliEnv = buildCliEnv(config.env);

  log(`[cli-runner] spawning: claude ${args.join(' ')}`);
  log(`[cli-runner] cwd=${config.cwd}, sessionId=${config.sessionId || 'new'}`);

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cliEnv as NodeJS.ProcessEnv,
      cwd: config.cwd,
    });

    let newSessionId: string | undefined = config.sessionId;
    let resultText: string | undefined;
    let lineBuffer = '';

    // 写入 prompt 到 stdin
    const stdinMsg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: config.prompt },
    });
    child.stdin!.write(stdinMsg + '\n');
    child.stdin!.end();

    // 逐行解析 stdout
    child.stdout!.on('data', (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      // 保留最后一个可能不完整的行
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const msg = parseStreamJsonLine(line);
        if (!msg) continue;

        log(`[cli-runner] stream: type=${msg.type}${msg.subtype ? `/${msg.subtype}` : ''}`);

        // 提取 session_id
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          newSessionId = msg.session_id;
          log(`[cli-runner] session: ${newSessionId}`);
        }

        // result 消息中提取 session_id
        if (msg.type === 'result' && msg.session_id) {
          newSessionId = msg.session_id;
        }

        // 映射为 ContainerOutput 并发送（可能产生多个）
        const outputs = mapToContainerOutput(msg, newSessionId);
        for (const output of outputs) {
          writeOutput(output);
          if (output.status === 'success') {
            resultText = output.result || undefined;
          }
        }
      }
    });

    // stderr 日志
    child.stderr!.on('data', (data: Buffer) => {
      log(`[cli-stderr] ${data.toString().trim()}`);
    });

    child.on('close', (code) => {
      // 处理 lineBuffer 中残留的最后一行
      if (lineBuffer.trim()) {
        const msg = parseStreamJsonLine(lineBuffer);
        if (msg) {
          if (msg.type === 'result' && msg.session_id) {
            newSessionId = msg.session_id;
          }
          const outputs = mapToContainerOutput(msg, newSessionId);
          for (const output of outputs) {
            writeOutput(output);
            if (output.status === 'success') {
              resultText = output.result || undefined;
            }
          }
        }
      }

      // 清理临时 MCP 配置
      try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }

      log(`[cli-runner] process exited code=${code}`);

      if (code !== 0 && !resultText) {
        writeOutput({
          status: 'error',
          result: null,
          error: `CLI process exited with code ${code}`,
          newSessionId,
        });
      }

      resolve({ newSessionId, result: resultText });
    });

    child.on('error', (err) => {
      // 清理临时 MCP 配置
      try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }

      log(`[cli-runner] spawn error: ${err.message}`);
      writeOutput({
        status: 'error',
        result: null,
        error: `Failed to spawn claude CLI: ${err.message}`,
      });
      reject(err);
    });
  });
}
