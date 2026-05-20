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
  buildToolUseProgress,
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
  /** Credential Proxy（如 cli-proxy-api），直接 HTTP 转发走 OAuth 凭证 */
  credentialProxy?: { url: string; apiKey: string };
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
  credentialProxy: { url: string; apiKey: string } | undefined,
  log: (msg: string) => void,
): Promise<TapProxy> {
  if (tapProxy) return tapProxy;

  if (!tapProxyInitPromise) {
    tapProxyInitPromise = (async () => {
      const proxy = new TapProxy({
        upstreamProxy,
        upstreamCaCert,
        credentialProxy,
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
    config.credentialProxy,
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

  // 构建 CLI 参数（交互模式不传 --resume，tmux session 本身就是会话持久化）
  const cliArgs = buildInteractiveCliArgs({
    model: config.model,
    mcpConfigPath,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions ?? true,
    additionalDirectories: config.additionalDirectories,
    systemPromptAppend: config.systemPromptAppend,
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
    // undici 的 proxy CONNECT 隧道不信任 NODE_EXTRA_CA_CERTS 中的自签 CA
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    // 跳过 onboarding 向导（主题选择等），直接进入输入提示
    CLAUDE_CODE_SIMPLE: '1',
    // 禁用遥测：防止 CLI 向 api.anthropic.com/api/event_logging/batch 发送遥测事件
    // （遥测会包含 terminal:tmux 等异常信号，存在风控隐患）
    DISABLE_TELEMETRY: '1',
  };
  // 清除 Agent SDK 标识（interactive 模式不走 SDK）
  delete cliEnv.CLAUDE_AGENT_SDK_CLIENT_APP;
  delete cliEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  if (config.credentialProxy) {
    // credential proxy 模式：设置占位 API key 让 CLI 进入 "API key" 认证模式并发起请求，
    // TapProxy MITM 会拦截并替换为 credential proxy 的真实 key
    cliEnv.ANTHROPIC_API_KEY = 'sk-ant-placeholder-for-credential-proxy';
  } else {
    // 非 credential proxy 模式：删除 API key，CLI 走 OAuth token（Keychain）
    delete cliEnv.ANTHROPIC_API_KEY;
  }

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

  // 新创建的 session 需要等 CLI 就绪（跳过 onboarding、等待输入提示）
  const isNewSession = (Date.now() - tmuxSession.createdAt) < 5000;
  if (isNewSession) {
    log('[interactive] waiting for CLI to become ready...');
    await tmux.waitForReady(tmuxSession.name, 60_000);
  }

  // 注册 SSE 订阅
  return new Promise<{ newSessionId?: string; result?: string }>((resolve) => {
    let acc = createMessageAccumulator();
    let resolved = false;
    let numTurns = 0;
    const startTime = Date.now();
    // CLI 会先用 haiku 做 context caching（预热缓存），再用目标模型做真正 prompt。
    // 过滤掉 haiku context caching 流的结果，只 emit 真正 prompt 的结果。

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

    // 超时控制 — 活动超时：每次收到 SSE 事件时重置计时器。
    // CLI 多轮 tool_use 场景下，API 调用之间有工具执行的静默期（几十秒到几分钟），
    // 但只要 SSE 数据持续流入就说明 CLI 还在正常工作，不应超时。
    let timer: NodeJS.Timeout;
    const resetTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (resolved) return;
        log(`[interactive] response timeout after ${timeoutMs}ms of inactivity`);
        writeOutput({
          status: 'error',
          result: null,
          error: `Response timeout (${Math.round(timeoutMs / 1000)}s inactivity)`,
          newSessionId: config.sessionId || sessionToken,
        });
        finish();
      }, timeoutMs);
    };
    resetTimeout();

    // 跟踪是否收到过有意义的 SSE 事件（message_start / content_block_*）
    let hasReceivedSseData = false;
    // CLI 可能发多个 SSE 流（context caching + 真正 prompt），
    // 只保留最后一个完整结果（覆盖式），当所有流结束后 flush
    let pendingOutput: ContainerOutput | null = null;
    let pendingResult: string | undefined;
    let pendingFinishTimer: NodeJS.Timeout | null = null;
    let activeSseStreams = 0;
    const FINISH_DEBOUNCE_MS = 2000; // 最后一个 message_stop 后等 2s（CLI 重试间隔 ~1s）

    const flushPending = () => {
      if (resolved || !pendingOutput) return;
      if (pendingFinishTimer) { clearTimeout(pendingFinishTimer); pendingFinishTimer = null; }
      writeOutput(pendingOutput);
      finish(pendingResult);
      pendingOutput = null;
      pendingResult = undefined;
    };

    const schedulePendingFlush = () => {
      if (pendingFinishTimer) clearTimeout(pendingFinishTimer);
      pendingFinishTimer = setTimeout(flushPending, FINISH_DEBOUNCE_MS);
    };

    const subscription: TapSubscription = {
      onEvent: (event: SseEvent) => {
        hasReceivedSseData = true;
        resetTimeout(); // SSE 数据到达 → 重置超时

        // message_start 表示新 SSE 流开始 → 取消待发结果（前一个流的结果被覆盖）
        if (event.type === 'message_start' && pendingFinishTimer) {
          clearTimeout(pendingFinishTimer);
          pendingFinishTimer = null;
          pendingOutput = null;
          pendingResult = undefined;
        }

        // 累积事件（先累积再判断，确保 content_block_stop 时 inputJson 已完整）
        acc = accumulateSseEvent(acc, event);

        // content_block_stop → 工具调用参数已完整，发送富进度（含命令/文件详情）
        if (event.type === 'content_block_stop') {
          const stopData = event.data as { index: number };
          const block = acc.blocks.get(stopData.index);
          if (block && block.type === 'tool_use') {
            const progress = buildToolUseProgress(block);
            if (progress) writeOutput(progress);
          }
        }

        // message_stop 且 stop_reason 是 end_turn → 最终结果
        if (acc.done) {
          if (acc.stopReason === 'tool_use') {
            // Claude 使用工具后会继续，重置状态等待下一轮
            numTurns++;
            acc = { ...acc, done: false, stopReason: '', blocks: new Map() };
            return;
          }

          // 过滤 context caching 流：CLI 用 haiku 预热缓存，结果无意义，跳过
          if (acc.model && acc.model.includes('haiku')) {
            log(`[interactive] skipping context-caching result (model: ${acc.model})`);
            acc = { ...acc, done: false, stopReason: '', blocks: new Map() };
            return;
          }

          numTurns++;
          const durationMs = Date.now() - startTime;
          const output = mapAccumulatorToResult(acc, config.sessionId || sessionToken, numTurns, durationMs);
          // 不立刻 emit — 存起来等所有流结束或超时后 flush
          pendingOutput = output;
          pendingResult = output.result || undefined;
          schedulePendingFlush();
        }
      },
      onError: (err: Error) => {
        // SSE 流中断（EPIPE / ECONNRESET / aborted）是常见的瞬态错误。
        // CLI 自带重试机制（"Retrying in 1s · attempt 1/10"），
        // 不应在此时放弃 — 让 CLI 重试，用 timeout 兜底。
        log(`[interactive] SSE error: ${err.message} (hasData: ${hasReceivedSseData}, hasPending: ${!!pendingOutput})`);
        // 重置 hasReceivedSseData：当前流中断了，等下一个流的数据
        hasReceivedSseData = false;
      },
      onEnd: () => {
        // 单个 SSE 流结束 — 不直接 finish
        // CLI 可能有多个并发 SSE 流，且可能自动重试
        if (resolved) return;
        log(`[interactive] SSE stream ended (active: ${activeSseStreams}, hasPending: ${!!pendingOutput})`);
      },
      onActiveStreamsChange: (count: number) => {
        activeSseStreams = count;
        log(`[interactive] active SSE streams: ${count}`);
        if (count > 0) resetTimeout(); // 新 SSE 流开始 → CLI 还在活跃
        // 当最后一个流结束（count→0）且有待发结果 → 安排 flush
        // 不立刻 flush，给 CLI 1s 时间开新的重试流
        if (count <= 0 && pendingOutput && !resolved) {
          log('[interactive] all streams closed, scheduling flush');
          schedulePendingFlush();
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
