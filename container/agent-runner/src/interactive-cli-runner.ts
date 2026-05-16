/**
 * Interactive CLI Runner — tmux 输入 + Tap Proxy SSE 输出
 *
 * 替代 cli-runner.ts 的 runCliQuery()，走交互式 CLI 模式。
 * 接口签名与 runCliQuery 语义一致（ContainerOutput 回调）。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  TapProxy,
  type TapSubscription,
} from './tap-proxy.js';
import {
  TmuxSessionManager,
  buildInteractiveCliArgs,
} from './tmux-session-manager.js';
import {
  accumulateSseEvent,
  createMessageAccumulator,
  mapSseEventToProgress,
  mapAccumulatorToResult,
  type SseEvent,
  type ContainerOutput,
} from './sse-parser.js';
import { buildMcpConfig } from './cli-runner.js';

// ---- 配置 ----

export interface InteractiveCliConfig {
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
  /** OneCLI 上游代理 URL */
  upstreamProxy: string;
  /** OneCLI CA 证书 PEM */
  upstreamCaCert?: string;
  /** 响应超时 ms（默认 10 分钟） */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

// ---- 全局单例 ----

let tapProxy: TapProxy | null = null;
let tapProxyInitPromise: Promise<TapProxy> | null = null;
let tmuxManager: TmuxSessionManager | null = null;

/** 获取或初始化 Tap Proxy 单例（Promise 锁防止并发重复创建） */
async function getOrCreateTapProxy(
  upstreamProxy: string,
  upstreamCaCert: string | undefined,
  log: (msg: string) => void,
): Promise<TapProxy> {
  if (tapProxy) return tapProxy;

  if (!tapProxyInitPromise) {
    tapProxyInitPromise = (async () => {
      const proxy = new TapProxy({
        upstreamProxy,
        upstreamCaCert,
        log,
      });
      await proxy.start();
      tapProxy = proxy;
      return proxy;
    })();
  }

  return tapProxyInitPromise;
}

/** 获取或初始化 tmux 管理器单例 */
function getOrCreateTmuxManager(log: (msg: string) => void): TmuxSessionManager {
  if (tmuxManager) return tmuxManager;
  tmuxManager = new TmuxSessionManager(log);
  return tmuxManager;
}

// ---- 主函数 ----

/**
 * 运行一轮交互模式 query
 * 创建/复用 tmux session，注入消息，通过 Tap Proxy 拦截 SSE 响应
 */
export async function runInteractiveQuery(
  config: InteractiveCliConfig,
  writeOutput: (output: ContainerOutput) => void,
  log: (message: string) => void,
): Promise<{
  newSessionId?: string;
  result?: string;
}> {
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;

  // 初始化 Tap Proxy
  const proxy = await getOrCreateTapProxy(
    config.upstreamProxy,
    config.upstreamCaCert,
    log,
  );

  // 初始化 tmux 管理器
  const tmux = getOrCreateTmuxManager(log);

  // 生成 session token（用于 Tap Proxy 路由）
  const sessionToken = config.sessionId || `new-${config.chatJid}-${Date.now()}`;

  // 写入临时 MCP 配置文件
  const mcpConfig = buildMcpConfig(
    config.mcpServerPath,
    config.chatJid,
    config.groupFolder,
    config.isMain,
    config.ipcDir,
  );
  const mcpConfigPath = path.join(
    os.tmpdir(),
    `nanoclaw-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

  // 构建 CLI 参数
  const cliArgs = buildInteractiveCliArgs({
    model: config.model,
    mcpConfigPath,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions ?? true,
    additionalDirectories: config.additionalDirectories,
    systemPromptAppend: config.systemPromptAppend,
    sessionId: config.sessionId,
  });

  // 构建环境变量（指向 Tap Proxy 而非直接 OneCLI）
  const tapProxyUrl = proxy.getProxyUrl(sessionToken);
  const tapCaCert = proxy.getCaCertificate();

  // 合并 CA 证书（Tap Proxy CA + OneCLI CA）
  const combinedCaPath = path.join(os.tmpdir(), `nanoclaw-combined-ca-${Date.now()}.pem`);
  let combinedCa = tapCaCert;
  if (config.upstreamCaCert) {
    combinedCa += '\n' + config.upstreamCaCert;
  }
  fs.writeFileSync(combinedCaPath, combinedCa);

  const cliEnv: Record<string, string | undefined> = {
    ...config.env,
    HTTPS_PROXY: tapProxyUrl,
    https_proxy: tapProxyUrl,
    HTTP_PROXY: tapProxyUrl,
    http_proxy: tapProxyUrl,
    NODE_EXTRA_CA_CERTS: combinedCaPath,
  };
  // 清除 Agent SDK 标识
  delete cliEnv.CLAUDE_AGENT_SDK_CLIENT_APP;
  delete cliEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;

  // 获取或创建 tmux session
  let tmuxSession;
  try {
    tmuxSession = await tmux.getOrCreate({
      chatJid: config.chatJid,
      cwd: config.cwd,
      env: cliEnv,
      cliArgs,
      log,
    });
  } catch (err) {
    // subscribe 前异常，手动清理临时文件
    try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
    throw err;
  }

  // 注册 SSE 订阅
  return new Promise<{ newSessionId?: string; result?: string }>((resolve) => {
    let acc = createMessageAccumulator();
    let resolved = false;
    let numTurns = 0;
    const startTime = Date.now();

    const cleanup = () => {
      proxy.unsubscribe(sessionToken);
      clearTimeout(timer);
      // 清理 MCP 配置（临时文件，每轮请求生成）
      try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
      // 注意：combinedCaPath 不删除 — tmux session 持续运行，NODE_EXTRA_CA_CERTS 指向它
    };

    const finish = (result?: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({
        newSessionId: config.sessionId || sessionToken,
        result,
      });
    };

    // 超时控制
    const timer = setTimeout(() => {
      if (resolved) return;
      log(`[interactive] response timeout after ${timeoutMs}ms`);
      writeOutput({
        status: 'error',
        result: null,
        error: `Response timeout (${Math.round(timeoutMs / 1000)}s)`,
        newSessionId: config.sessionId || sessionToken,
      });
      finish();
    }, timeoutMs);

    const subscription: TapSubscription = {
      onEvent: (event: SseEvent) => {
        // 实时发送工具调用进度
        const progress = mapSseEventToProgress(event);
        if (progress) {
          writeOutput(progress);
        }

        // 累积事件
        acc = accumulateSseEvent(acc, event);

        // message_stop 且 stop_reason 是 end_turn → 最终结果
        if (acc.done) {
          if (acc.stopReason === 'tool_use') {
            // Claude 使用工具后会继续，重置状态等待下一轮
            numTurns++;
            acc = { ...acc, done: false, stopReason: '', blocks: new Map() };
            return;
          }

          numTurns++;
          const durationMs = Date.now() - startTime;
          const output = mapAccumulatorToResult(acc, config.sessionId || sessionToken, numTurns, durationMs);
          writeOutput(output);
          finish(output.result || undefined);
        }
      },
      onError: (err: Error) => {
        log(`[interactive] SSE error: ${err.message}`);
        writeOutput({
          status: 'error',
          result: null,
          error: `SSE stream error: ${err.message}`,
        });
        finish();
      },
      onEnd: () => {
        // 流结束但没收到 message_stop — 可能是连接断开
        if (!resolved) {
          log('[interactive] SSE stream ended without message_stop');
          if (acc.blocks.size > 0) {
            // 有部分数据，发送出去
            const output = mapAccumulatorToResult(acc, config.sessionId || sessionToken, numTurns, Date.now() - startTime);
            writeOutput(output);
            finish(output.result || undefined);
          } else {
            finish();
          }
        }
      },
    };

    proxy.subscribe(sessionToken, subscription);

    // 注入消息
    tmux.sendMessage(tmuxSession.name, config.prompt).catch((err) => {
      log(`[interactive] failed to send message: ${err.message}`);
      writeOutput({
        status: 'error',
        result: null,
        error: `Failed to send message to tmux: ${err.message}`,
      });
      finish();
    });
  });
}

/** 清理所有资源（进程退出时调用） */
export async function cleanupInteractiveResources(log: (msg: string) => void): Promise<void> {
  if (tapProxy) {
    await tapProxy.stop();
    tapProxy = null;
    tapProxyInitPromise = null;
  }
  if (tmuxManager) {
    // 不销毁 tmux session（让 Claude 继续运行，下次可恢复）
    log('[interactive] cleanup: tap proxy stopped, tmux sessions preserved');
  }
}
