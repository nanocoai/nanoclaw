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
  TmuxReadyError,
  analyzeTmuxPane,
  buildInteractiveCliArgs,
} from './tmux-session-manager.js';
import {
  accumulateSseEvent,
  createMessageAccumulator,
  buildToolUseProgress,
  buildTextProgress,
  decideTextBlockAction,
  mapAccumulatorToResult,
  type SseEvent,
  type ContainerOutput,
  type TextBlock,
  type MessageAccumulator,
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

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟（Opus 4.8 extended thinking 可达 10+ 分钟）
const UUID_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRealClaudeSessionId(sessionId?: string): boolean {
  return !!sessionId && UUID_SESSION_ID_RE.test(sessionId);
}

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function findLatestClaudeSessionId(options: {
  claudeConfigDir?: string;
  cwd: string;
  sinceMs: number;
}): string | undefined {
  if (!options.claudeConfigDir) return undefined;

  const projectDir = path.join(
    options.claudeConfigDir,
    'projects',
    encodeClaudeProjectDir(options.cwd),
  );
  if (!fs.existsSync(projectDir)) return undefined;

  let latest: { sessionId: string; mtimeMs: number } | undefined;
  for (const entry of fs.readdirSync(projectDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const sessionId = entry.slice(0, -'.jsonl'.length);
    if (!isRealClaudeSessionId(sessionId)) continue;

    const fullPath = path.join(projectDir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs + 1000 < options.sinceMs) continue;
    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = { sessionId, mtimeMs: stat.mtimeMs };
    }
  }

  return latest?.sessionId;
}

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

  // Tap Proxy 路由 token 用来把 tmux 内 CLI 请求分发到本轮订阅。
  // 它不是 Claude CLI 的真实 session id；首次启动时会是 new-* 临时值。
  const desiredRouteToken = config.sessionId || `new-${config.chatJid}-${Date.now()}`;
  const queryStartMs = Date.now();

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
  // 传 --resume 使重启后新建的 tmux session 能恢复 Claude CLI 上下文
  // （旧 tmux session 因 env 过期被 kill，但 CLI 对话历史通过 sessionId 持久化在磁盘）
  // 注意：sessionToken 可能是 "new-<chatJid>-<ts>" 格式的临时 token（首次会话时生成），
  // 这不是真正的 Claude session ID，传给 --resume 会让 CLI 进入搜索界面卡死。
  // 只有 UUID 格式的才是真正的 Claude session ID，才能用于 --resume。
  const isRealSessionId = isRealClaudeSessionId(config.sessionId);
  const cliArgs = buildInteractiveCliArgs({
    model: config.model,
    sessionId: isRealSessionId ? config.sessionId : undefined,
    mcpConfigPath,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions ?? true,
    additionalDirectories: config.additionalDirectories,
    systemPromptAppend: config.systemPromptAppend,
  });

  // 构建环境变量（指向 Tap Proxy 而非直接 OneCLI）
  const tapProxyUrl = proxy.getProxyUrl(desiredRouteToken);
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
  // 注意：必须用 = undefined 而非 delete，这样 key 仍保留在 Object.entries 中，
  // tmux-session-manager 才能生成 unset 命令来覆盖父进程继承的环境变量。
  cliEnv.CLAUDE_AGENT_SDK_CLIENT_APP = undefined;
  cliEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = undefined;
  if (config.credentialProxy) {
    // credential proxy 模式：设置占位 API key 让 CLI 进入 "API key" 认证模式并发起请求，
    // TapProxy MITM 会拦截并替换为 credential proxy 的真实 key
    cliEnv.ANTHROPIC_API_KEY = 'sk-ant-placeholder-for-credential-proxy';
  } else if (config.upstreamProxy) {
    // OneCLI 代理模式：CLI 必须走 OAuth Bearer token 模式（不是 API key 模式），
    // 因为 OneCLI MITM 只替换 Authorization: Bearer header，不替换 x-api-key header。
    // 用 ANTHROPIC_AUTH_TOKEN（而非 CLAUDE_CODE_OAUTH_TOKEN）传占位 Bearer token：
    // - CLAUDE_CODE_OAUTH_TOKEN 会做 JWT 格式校验，占位值过不了 → "Not logged in"
    // - ANTHROPIC_AUTH_TOKEN 直接设置 Authorization: Bearer header，无格式校验
    cliEnv.ANTHROPIC_API_KEY = undefined;
    cliEnv.CLAUDE_CODE_OAUTH_TOKEN = undefined;
    cliEnv.ANTHROPIC_AUTH_TOKEN = 'placeholder_for_proxy_injection';
  } else {
    // 无代理模式：删除 API key，CLI 走 OAuth token（Keychain）
    cliEnv.ANTHROPIC_API_KEY = undefined;
  }

  // 获取或创建 tmux session
  let tmuxSession;
  try {
    tmuxSession = await tmux.getOrCreate({
      chatJid: config.chatJid,
      cwd: config.cwd,
      env: cliEnv,
      cliArgs,
      routeToken: desiredRouteToken,
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
    try {
      await tmux.waitForReady(tmuxSession.name, 60_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[interactive] CLI readiness failed: ${message}`);
      if (err instanceof TmuxReadyError) {
        log(`[interactive] readiness pane snapshot: ${err.paneText.replace(/\n/g, ' | ').slice(0, 500)}`);
      }
      await tmux.destroy(tmuxSession.name, config.chatJid);
      throw err;
    }
  }

  const sessionToken = tmuxSession.routeToken;

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

    const getDurableSessionId = () =>
      findLatestClaudeSessionId({
        claudeConfigDir: config.env.CLAUDE_CONFIG_DIR,
        cwd: config.cwd,
        sinceMs: queryStartMs,
      }) || (isRealClaudeSessionId(config.sessionId) ? config.sessionId : undefined);

    const finish = (result?: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({
        newSessionId: getDurableSessionId(),
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
        log(`[interactive] response timeout after ${timeoutMs}ms of inactivity (pendingTextBlocks: ${pendingTextBlocks.length})`);
        // 超时前把 buffered 的中间叙述先发出去，避免静默吞没
        if (pendingTextBlocks.length > 0) {
          flushPendingTextBlocks('inactivity timeout');
        }
        writeOutput({
          status: 'error',
          result: null,
          error: `Response timeout (${Math.round(timeoutMs / 1000)}s inactivity)`,
          newSessionId: getDurableSessionId(),
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
      // auto-compact 总结 → 换发一条友好提示，不暴露 <analysis> 原文
      // mapAccumulatorToResult 已识别并把 result 置 null + 设 flag
      if (pendingOutput.isCompactSummary) {
        log('[interactive] auto-compact summary detected → emit friendly notice instead of raw <analysis>');
        const notice: ContainerOutput = {
          status: 'success',
          result: '📦 上下文已自动压缩\n本轮对话历史较长，系统已整理为摘要继续会话。工具调用、记忆、Wiki 等不受影响。',
          newSessionId: pendingOutput.newSessionId,
          usage: pendingOutput.usage,
        };
        writeOutput(notice);
        finish(notice.result || undefined);
        pendingOutput = null;
        pendingResult = undefined;
        return;
      }
      log(`[interactive] flushPending: resultLen=${pendingResult?.length ?? 0}, status=${pendingOutput.status}`);
      writeOutput(pendingOutput);
      finish(pendingResult);
      pendingOutput = null;
      pendingResult = undefined;
    };

    const schedulePendingFlush = () => {
      if (pendingFinishTimer) clearTimeout(pendingFinishTimer);
      pendingFinishTimer = setTimeout(flushPending, FINISH_DEBOUNCE_MS);
    };

    // ---- 中间叙述 text block 缓冲 ----
    //
    // Anthropic SSE 流里 assistant 一轮的 content 通常是 [text, tool_use, text, tool_use, ...]：
    //   - text 在 tool_use 之间 → 中间叙述（"让我先看下这块代码"），用户应该看到
    //   - text 在最后（stop_reason=end_turn）→ 最终回复，会走 mapAccumulatorToResult，
    //     若也作为 progress 发送会和正式回复重复
    //
    // 策略：content_block_stop 收到 text 时先存起来，根据后续事件决定 emit 还是 drop：
    //   - 后面来了 tool_use 块（同一 message 内）→ flush（确认是中间叙述）
    //   - message_stop & stop_reason === 'tool_use'（本轮要继续）→ flush 剩余 text
    //   - message_stop & stop_reason === 'end_turn'（本轮结束）→ drop（最终回复在 result 里）
    let pendingTextBlocks: TextBlock[] = [];
    const flushPendingTextBlocks = (reason: string) => {
      if (pendingTextBlocks.length === 0) return;
      log(`[interactive] flushing ${pendingTextBlocks.length} pending text block(s) (reason=${reason})`);
      for (const tb of pendingTextBlocks) {
        const progress = buildTextProgress(tb);
        if (progress) {
          log(`[interactive] emit 💬 text progress: "${(progress.result || '').slice(0, 80)}"`);
          writeOutput(progress);
        }
      }
      pendingTextBlocks = [];
    };

    // 并发 SSE 流隔离：每个 message_start 创建独立 accumulator，按 messageId 路由。
    // 背景：CLI 会同时发 haiku 预热请求和 opus 主请求，两个 SSE 流并发到达。
    // 如果共享一个 acc，后到的 message_start 会清空先到流的 blocks，导致空回复。
    const accMap = new Map<string, MessageAccumulator>();
    let currentMessageId = ''; // 最近收到事件的 message，用于 content 事件路由

    const subscription: TapSubscription = {
      onEvent: (event: SseEvent) => {
        hasReceivedSseData = true;
        resetTimeout(); // SSE 数据到达 → 重置超时

        // message_start → 为新流创建独立 accumulator
        if (event.type === 'message_start') {
          const startData = event.data as { message?: { id?: string; model?: string } };
          const msgId = startData.message?.id || `anon-${Date.now()}`;
          currentMessageId = msgId;

          // 创建新 accumulator 并累积 message_start
          let msgAcc = createMessageAccumulator();
          msgAcc = accumulateSseEvent(msgAcc, event);
          accMap.set(msgId, msgAcc);

          // 同步到主 acc（保持 usage 累积等向后兼容）
          acc = msgAcc;

          log(`[interactive] message_start: id=${msgId.slice(0, 12)}, model=${msgAcc.model}, streams=${accMap.size}`);

          // 取消待发结果（新流开始意味着前一个流的结果可能被覆盖）
          if (pendingFinishTimer) {
            clearTimeout(pendingFinishTimer);
            pendingFinishTimer = null;
            pendingOutput = null;
            pendingResult = undefined;
          }
          return;
        }

        // content 事件路由到当前 message 的 accumulator
        const targetId = currentMessageId;
        let msgAcc = accMap.get(targetId);
        if (!msgAcc) {
          // 没有对应的 message_start（不应该发生），用全局 acc 兜底
          msgAcc = acc;
        }

        // 累积事件
        msgAcc = accumulateSseEvent(msgAcc, event);
        accMap.set(targetId, msgAcc);
        acc = msgAcc; // 同步到主 acc

        // content_block_stop → 块累积完成，按类型分发
        if (event.type === 'content_block_stop') {
          const stopData = event.data as { index: number };
          const block = msgAcc.blocks.get(stopData.index);
          if (block?.type === 'tool_use') {
            // tool_use 出现 → 之前缓冲的 text 一定是中间叙述（在工具调用前发生），flush
            flushPendingTextBlocks('tool_use block follows');
            const progress = buildToolUseProgress(block);
            if (progress) {
              log(`[interactive] emit 🔧 tool_use progress: ${block.name}`);
              writeOutput(progress);
            }
          } else if (block?.type === 'text') {
            // text 块结束 → 暂存，等下一个 tool_use 或 message_stop 决定命运
            log(`[interactive] buffering text block (len=${block.text.length}, idx=${stopData.index})`);
            pendingTextBlocks.push(block);
          }
        }

        // message_stop → 用 decideTextBlockAction 决定 pendingTextBlocks 命运
        if (msgAcc.done) {
          // 用这条消息自己的 model 判断是否 haiku 预热（不受并发流覆盖）
          const isHaikuPreheat = !!(msgAcc.model && msgAcc.model.includes('haiku'));
          const action = decideTextBlockAction({
            stopReason: msgAcc.stopReason,
            isHaikuPreheat,
          });

          if (action === 'flush') {
            flushPendingTextBlocks(`decideTextBlockAction(stop=${msgAcc.stopReason}, haiku=${isHaikuPreheat}) → flush`);
          } else if (pendingTextBlocks.length > 0) {
            log(`[interactive] dropping ${pendingTextBlocks.length} pending text block(s) (stop=${msgAcc.stopReason}, haiku=${isHaikuPreheat}) — included in final result or haiku preheat noise`);
            pendingTextBlocks = [];
          }

          // 清理已完成的 accumulator
          accMap.delete(targetId);

          if (msgAcc.stopReason === 'tool_use') {
            // Claude 使用工具后会继续，本轮没结束
            numTurns++;
            acc = { ...msgAcc, done: false, stopReason: '', blocks: new Map() };
            return;
          }

          if (isHaikuPreheat) {
            log(`[interactive] skipping context-caching result (model: ${msgAcc.model})`);
            acc = { ...msgAcc, done: false, stopReason: '', blocks: new Map() };
            return;
          }

          numTurns++;
          const durationMs = Date.now() - startTime;
          const output = mapAccumulatorToResult(msgAcc, config.sessionId || sessionToken, numTurns, durationMs);
          const durableSessionId = getDurableSessionId();
          if (durableSessionId) {
            output.newSessionId = durableSessionId;
          } else {
            delete output.newSessionId;
          }
          log(`[interactive] mapAccumulatorToResult: status=${output.status}, resultLen=${output.result?.length ?? 0}, blocks=${msgAcc.blocks.size}, stopReason=${msgAcc.stopReason}, model=${msgAcc.model || 'unknown'}, outputTokens=${msgAcc.usage.outputTokens}`);
          if (!output.result && msgAcc.usage.outputTokens > 0) {
            log(`[interactive] ⚠️ result 为空但有 ${msgAcc.usage.outputTokens} output tokens — SSE 文本可能丢失`);
          }
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
        log(`[interactive] SSE error: ${err.message} (hasData: ${hasReceivedSseData}, hasPending: ${!!pendingOutput}, pendingTextBlocks: ${pendingTextBlocks.length})`);
        // 流中断 → 之前缓冲的 text 必然永远收不到后续 tool_use/message_stop 决断，
        // 主动 flush 给用户看（否则中间叙述永久丢失，无任何日志/告警）
        if (pendingTextBlocks.length > 0) {
          flushPendingTextBlocks('SSE error');
        }
        // 重置 hasReceivedSseData：当前流中断了，等下一个流的数据
        hasReceivedSseData = false;
      },
      onEnd: () => {
        // 单个 SSE 流结束 — 不直接 finish
        // CLI 可能有多个并发 SSE 流，且可能自动重试
        if (resolved) return;
        log(`[interactive] SSE stream ended (active: ${activeSseStreams}, hasPending: ${!!pendingOutput}, pendingTextBlocks: ${pendingTextBlocks.length})`);
        // 流结束但还没 message_stop 决断 → 同 onError 处理，flush 防丢失
        // （正常 message_stop 已经清空 pendingTextBlocks，这里只是 belt-and-suspenders）
        if (pendingTextBlocks.length > 0) {
          flushPendingTextBlocks('SSE stream ended without message_stop');
        }
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

    log(`[interactive] subscribing to SSE (session: ${sessionToken.slice(0, 8)}...)`);
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

// ---- 环境健康检查（消息驱动，不用定时器） ----

export interface CliHealthResult {
  healthy: boolean;
  error?: string;
}

/**
 * 检查 CLI 交互环境是否正常。用户发消息时调用（不用定时器）。
 *
 * 检查三项：
 * 1. tmux session 存在
 * 2. window 0 有 CLI 进程（❯ 提示符）
 * 3. TapProxy 端口可连
 *
 * 不尝试自恢复——如果环境坏了，返回 healthy: false，
 * 让主循环 break 退出，主进程会起新 runner（新 runner 自然重建一切）。
 * TapProxy 挂了是个例外：重置单例即可，下次 runInteractiveQuery 会自动重建。
 */
export async function checkCliHealth(
  chatJid: string,
  log: (msg: string) => void,
): Promise<CliHealthResult> {
  const tmux = tmuxManager;
  if (!tmux) {
    // 还没初始化过 tmux manager（首轮 query 还没跑），跳过
    return { healthy: true };
  }

  // 1. 检查 tmux session
  const session = tmux.getSession(chatJid);
  if (!session) {
    // 首次启动或进程刚重启，跳过
    return { healthy: true };
  }

  const alive = await tmux.isAlive(session.name);
  if (!alive) {
    log(`[health] tmux session ${session.name} 不存在`);
    return { healthy: false, error: 'tmux session 不存在' };
  }

  // 2. 检查 window 0 有没有 CLI 进程
  try {
    const pane = await tmux.capturePane(session.name);
    const paneAnalysis = analyzeTmuxPane(pane);
    if (paneAnalysis.state === 'blocked-resume-search' || paneAnalysis.state === 'auth-error') {
      const lastLines = pane.split('\n').filter(l => l.trim()).slice(-5).join(' | ');
      log(`[health] CLI 异常界面: ${paneAnalysis.reason || paneAnalysis.state}: ${lastLines}`);
      return {
        healthy: false,
        error: `CLI 异常界面: ${paneAnalysis.reason || paneAnalysis.state}`,
      };
    }
    // 检测 CLI 是否活着：空闲提示符 / 启动 banner / thinking 状态 / 工具执行
    const hasCliIndicator = pane.includes('❯') || pane.includes('Claude Code') || pane.includes('claude')
      || pane.includes('Thinking') || pane.includes('⏺') || pane.includes('✻');
    if (!hasCliIndicator) {
      const lastLines = pane.split('\n').filter(l => l.trim()).slice(-5).join(' | ');
      log(`[health] window 0 无 CLI 进程: ${lastLines}`);
      return { healthy: false, error: `CLI 进程不存在 (pane: ${lastLines})` };
    }
  } catch (err) {
    // capturePane 失败可能是瞬态错误，不判定为不健康
    log(`[health] capturePane 异常（忽略）: ${err instanceof Error ? err.message : err}`);
  }

  // 3. 检查 TapProxy 端口
  if (tapProxy) {
    const port = tapProxy.getPort();
    try {
      const net = await import('net');
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
          sock.destroy();
          resolve();
        });
        sock.on('error', reject);
        sock.setTimeout(3000, () => { sock.destroy(); reject(new Error('timeout')); });
      });
    } catch {
      // TapProxy 挂了不能自恢复——新 proxy 端口会变，但旧 tmux session 的
      // HTTPS_PROXY 环境变量还指向旧端口。必须退出 runner 重建一切。
      log(`[health] TapProxy 端口 ${port} 不可连`);
      return { healthy: false, error: `TapProxy 端口 ${port} 不可连` };
    }
  }

  return { healthy: true };
}
