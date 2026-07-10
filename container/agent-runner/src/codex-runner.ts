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
import { buildSendMessageToolEnv } from './mcp-tool-policy.js';

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
    type: 'agent_message' | 'command_execution' | 'file_change' | string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    /** file_change 事件：改动的文件列表（实测 codex-cli 0.136.0：path + kind:add|modify|delete） */
    changes?: { path: string; kind: string }[];
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  /** type:"error" 事件的错误正文（如鉴权失败、限额、重连） */
  message?: string;
  /** type:"turn.failed" 事件的错误对象 */
  error?: { message?: string };
  [key: string]: unknown;
}

export interface CodexRunnerConfig {
  prompt: string;
  /** codex thread_id，作为 session 续接标识 */
  sessionId?: string;
  model?: string;
  effort?: string;
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
  isScheduledTask?: boolean;
}

export interface CodexTextProgressState {
  pendingAgentMessage?: string;
  lastAgentMessage?: string;
}

export interface CodexMcpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
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

export function createCodexTextProgressState(): CodexTextProgressState {
  return {};
}

function buildCodexTextProgress(text: string): ContainerOutput {
  const short = text.slice(0, 80) + (text.length > 80 ? '...' : '');
  return {
    status: 'progress',
    result: `💬 ${short}`,
    progressType: 'text',
    detail: text,
  };
}

function flushPendingCodexText(state: CodexTextProgressState): ContainerOutput[] {
  const text = state.pendingAgentMessage;
  state.pendingAgentMessage = undefined;
  // 一旦文本被发成 💬 中间进度，就不能再作为最终 success.result 复用。
  if (text) state.lastAgentMessage = undefined;
  return text ? [buildCodexTextProgress(text)] : [];
}

/**
 * Codex 的 agent_message 可能是最终回复，也可能是阶段性中间叙述。
 * 先缓存，下一条 agent_message 到达时把前一条 flush 成 💬（确认前一条确是中间叙述）；
 * 最后一条 agent_message 不发 💬，由 turn.completed 留作 success.result（避免结果文案重复/落空）。
 */
export function mapCodexTextProgress(
  event: CodexEvent,
  state: CodexTextProgressState,
): ContainerOutput[] {
  if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
    const outputs = flushPendingCodexText(state);
    const text =
      typeof event.item.text === 'string'
        ? event.item.text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim()
        : '';
    state.lastAgentMessage = undefined;
    if (text) {
      state.pendingAgentMessage = text;
      state.lastAgentMessage = text;
    }
    return outputs;
  }

  // 工具/文件事件不再 flush pending agent_message。
  // 原因：codex 常在最终回复后还跟 file_change/command 收尾动作，若按工具事件 flush，
  // 最终回复会被误当中间叙述发成 💬、result 落空（卡片里有结果文案但无独立最终回复）。
  // 改为：只有下一条 agent_message 到达时才 flush 前一条（说明前一条确是中间叙述）；
  // 最后一条 agent_message 的 lastAgentMessage 保留到 turn.completed 作 result。

  if (event.type === 'turn.completed') {
    state.pendingAgentMessage = undefined;
  }

  return [];
}

/** 构建 codex CLI 参数数组（prompt 由调用方追加到末尾） */
export function buildCodexArgs(config: {
  sessionId?: string;
  model?: string;
  effort?: string;
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

  if (config.effort) {
    args.push('-c', `model_reasoning_effort="${config.effort}"`);
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
  isScheduledTask?: boolean;
  extraMcpServers?: CodexMcpServerConfig[];
}): string {
  // 路径用 JSON.stringify 做 TOML 字符串转义（双引号 + 反斜杠）
  const q = (s: string) => JSON.stringify(s);
  const lines = [
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
    ...Object.entries(buildSendMessageToolEnv(config.isScheduledTask)).map(
      ([key, value]) => `${key} = ${q(value)}`,
    ),
    '',
  ];

  for (const server of config.extraMcpServers ?? []) {
    lines.push(`[mcp_servers.${server.name}]`);
    lines.push(`command = ${q(server.command)}`);
    if (server.args && server.args.length > 0) {
      lines.push(`args = [${server.args.map(q).join(', ')}]`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push('');
      lines.push(`[mcp_servers.${server.name}.env]`);
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`${key} = ${q(value)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function buildGitNexusMcpServerConfig(): CodexMcpServerConfig {
  return {
    name: 'gitnexus',
    command: 'bash',
    args: [
      '-lc',
      'if [ -f "$HOME/.gitnexus/env" ]; then . "$HOME/.gitnexus/env"; fi; exec "${GITNEXUS_BIN:-gitnexus}" mcp',
    ],
  };
}

export function isGitNexusCommandAvailable(
  env: Record<string, string | undefined>,
): boolean {
  const configured = env.GITNEXUS_BIN?.trim();
  if (configured) {
    if (configured.includes('/')) {
      try {
        fs.accessSync(configured, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
    return findExecutableOnPath(configured, env.PATH);
  }
  return findExecutableOnPath('gitnexus', env.PATH);
}

function findExecutableOnPath(command: string, pathValue?: string): boolean {
  const searchPath = pathValue ?? process.env.PATH ?? '';
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

/** 把 item.started 工具事件映射成进度输出（agent_message 不在此处理） */
export function mapCodexProgress(event: CodexEvent): ContainerOutput[] {
  if (event.type === 'item.started' && event.item) {
    const it = event.item;
    if (it.type === 'agent_message') return [];

    // file_change：codex 改文件事件无 command 字段，明细在 changes 数组（path + kind）。
    // 不特殊处理会退化成只显示 "file_change" 类型名、无文件明细。
    if (
      it.type === 'file_change' &&
      Array.isArray(it.changes) &&
      it.changes.length > 0
    ) {
      const files = it.changes;
      const kindLabel = (k: string): string =>
        (
          ({ add: '新增', modify: '修改', update: '修改', delete: '删除' }) as Record<
            string,
            string
          >
        )[k] ?? k;
      const short =
        files.length === 1
          ? `${kindLabel(files[0].kind)} ${path.basename(files[0].path)}`
          : `改动 ${files.length} 个文件`;
      const detailBody = files
        .map((c) => `${kindLabel(c.kind)}  ${c.path}`)
        .join('\n')
        .slice(0, 500);
      return [
        {
          status: 'progress',
          result: `📝 ${short}`,
          progressType: 'tool_use',
          detail: `\`\`\`\n${detailBody}\n\`\`\``,
        },
      ];
    }

    const label = it.command || it.type;
    const short = typeof label === 'string' ? label.slice(0, 60) : it.type;
    // detail：完整命令（与 SDK 模式 buildToolUseProgress 对齐，进度页「详情」区展示）。
    // 命令执行类用 ```bash 包裹完整命令（截断 500 字符防超长）；非命令类无 detail。
    let detail: string | undefined;
    if (typeof it.command === 'string' && it.command.trim()) {
      detail = `\`\`\`bash\n${it.command.slice(0, 500)}\n\`\`\``;
    }
    return [
      {
        status: 'progress',
        result: `🔧 ${short}`,
        progressType: 'tool_use',
        detail,
      },
    ];
  }
  return [];
}

/**
 * 从 codex 事件提取错误正文。
 * - type:"turn.failed" → event.error.message（turn 最终失败的权威错误）
 * - type:"error" → event.message（鉴权失败/限额/重连等中间错误）
 * 非错误事件返回 undefined。
 */
export function extractCodexError(event: CodexEvent): string | undefined {
  if (event.type === 'turn.failed') {
    const msg = event.error?.message;
    return typeof msg === 'string' && msg.trim() ? msg.trim() : undefined;
  }
  if (event.type === 'error') {
    return typeof event.message === 'string' && event.message.trim()
      ? event.message.trim()
      : undefined;
  }
  return undefined;
}

/** 映射 codex usage → ContainerOutput.usage（modelInfo 来自 rollout，--json 流不暴露 model） */
export function mapCodexUsage(
  usage: CodexEvent['usage'],
  modelInfo?: { model?: string; modelContextWindow?: number; lastTurnContext?: number },
): ContainerOutput['usage'] | undefined {
  if (!usage) return undefined;
  const result: ContainerOutput['usage'] = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cached_input_tokens ?? 0,
    cacheCreationInputTokens: 0,
    numTurns: 1,
    durationMs: 0,
    totalCostUsd: 0,
    lastTurnContext:
      modelInfo?.lastTurnContext ??
      (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0),
  };
  if (modelInfo?.model) {
    result.model = modelInfo.model;
    if (modelInfo.modelContextWindow) {
      result.modelContextWindows = {
        [modelInfo.model]: modelInfo.modelContextWindow,
      };
    }
  }
  return result;
}

/**
 * 从 rollout 文件读 codex 实际模型名 + context window。
 * codex exec --json 的 stdout 流不暴露 model（实测只有 thread.started/turn.started/
 * item.completed/turn.completed 四种事件，无 model 字段），模型信息只写在 rollout 的
 * turn_context 记录里（payload.model / payload.model_context_window）。
 * rollout 文件名以 threadId 结尾：sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl
 */
export function readCodexModelInfo(
  codexHome: string,
  threadId: string,
): { model?: string; modelContextWindow?: number; lastTurnContext?: number } {
  try {
    const sessionsDir = path.join(codexHome, 'sessions');
    if (!fs.existsSync(sessionsDir)) return {};
    const rollout = findRolloutByThreadId(sessionsDir, threadId);
    if (!rollout) return {};
    const lines = fs.readFileSync(rollout, 'utf-8').split('\n');
    // model 和 ctx 分散在不同记录：model 在 turn_context.payload.model，
    // ctx 在 event_msg(task_started).payload.model_context_window。倒序各取最新一条。
    // usage 事件里的 total_token_usage 是整条线程累计值，footer 要用 last_token_usage。
    let model: string | undefined;
    let modelContextWindow: number | undefined;
    let lastTurnContext: number | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj: {
        payload?: {
          model?: unknown;
          model_context_window?: unknown;
          info?: { last_token_usage?: { input_tokens?: unknown } };
        };
      };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const p = obj?.payload;
      if (!p) continue;
      if (model === undefined && typeof p.model === 'string') {
        model = p.model;
      }
      if (
        modelContextWindow === undefined &&
        typeof p.model_context_window === 'number'
      ) {
        modelContextWindow = p.model_context_window;
      }
      const maybeLastInput = p.info?.last_token_usage?.input_tokens;
      if (lastTurnContext === undefined && typeof maybeLastInput === 'number') {
        lastTurnContext = maybeLastInput;
      }
      if (
        model !== undefined &&
        modelContextWindow !== undefined &&
        lastTurnContext !== undefined
      ) break;
    }
    return { model, modelContextWindow, lastTurnContext };
  } catch {
    return {};
  }
}

/** 在 sessions 目录递归找文件名以 -<threadId>.jsonl 结尾的 rollout 文件 */
function findRolloutByThreadId(
  sessionsDir: string,
  threadId: string,
): string | undefined {
  const suffix = `-${threadId}.jsonl`;
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.name.startsWith('rollout-') && ent.name.endsWith(suffix)) {
        return full;
      }
    }
  }
  return undefined;
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
  const extraMcpServers = isGitNexusCommandAvailable(config.env)
    ? [buildGitNexusMcpServerConfig()]
    : [];
  if (extraMcpServers.length === 0) {
    log('[codex-runner] GitNexus MCP not injected: gitnexus command not found');
  }
  const configToml = buildCodexConfigToml({
    mcpServerPath: config.mcpServerPath,
    chatJid: config.chatJid,
    groupFolder: config.groupFolder,
    isMain: config.isMain,
    ipcDir: config.ipcDir,
    senderId: config.senderId,
    isScheduledTask: config.isScheduledTask,
    extraMcpServers,
  });
  const homeDir = config.env.HOME || os.homedir();
  prepareCodexHome(config.codexHome, homeDir, configToml, log);

  const args = buildCodexArgs({
    sessionId: config.sessionId,
    model: config.model,
    effort: config.effort,
  });
  // prompt 作为末位位置参数
  args.push(config.prompt);

  const codexEnv = buildCodexEnv(config.env, config.codexHome);

  log(`[codex-runner] spawning: codex ${args.slice(0, -1).join(' ')} <prompt>`);
  log(`[codex-runner] cwd=${config.cwd}, sessionId=${config.sessionId || 'new'}, CODEX_HOME=${config.codexHome}`);

  // 诊断：把本轮 codex 原始 stderr 落盘（每轮截断覆盖），主进程日志走 debug 级别看不到
  const stderrLogPath = path.join(config.codexHome, 'last-codex-stderr.log');
  try {
    fs.writeFileSync(stderrLogPath, `[spawn ${new Date().toISOString()}] codex ${args.slice(0, -1).join(' ')}\n`);
  } catch {
    /* ignore */
  }

  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: codexEnv as NodeJS.ProcessEnv,
      cwd: config.cwd,
    });

    let newSessionId: string | undefined = config.sessionId;
    const textProgressState = createCodexTextProgressState();
    let usage: ContainerOutput['usage'] | undefined;
    let sentSuccess = false;
    let lineBuffer = '';
    let stderrAccum = '';
    // codex 通过 type:error/turn.failed 上报鉴权失败/限额等错误，捕获正文供 close 透传
    let lastErrorMessage: string | undefined;

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

      // Codex agent_message 先缓存；后续工具事件到达时才作为中间叙述输出。
      for (const output of mapCodexTextProgress(event, textProgressState)) {
        writeOutput(output);
      }

      // 捕获错误正文（turn.failed 权威错误最后到达，覆盖中间 type:error 重连噪声）
      const errMsg = extractCodexError(event);
      if (errMsg) {
        lastErrorMessage = errMsg;
      }

      // turn 完成 → 发 success（result = 最后一条 agent_message）
      if (event.type === 'turn.completed') {
        // model 不在 --json 流里，从 rollout 文件读（需要 thread_id）
        const modelInfo = newSessionId
          ? readCodexModelInfo(config.codexHome, newSessionId)
          : undefined;
        usage = mapCodexUsage(event.usage, modelInfo);
        writeOutput({
          status: 'success',
          result: textProgressState.lastAgentMessage || null,
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
      const text = data.toString();
      stderrAccum += text;
      log(`[codex-stderr] ${text.trim()}`);
      try {
        fs.appendFileSync(stderrLogPath, text);
      } catch {
        /* ignore */
      }
    });

    child.on('close', (code) => {
      if (lineBuffer.trim()) handleLine(lineBuffer);

      log(`[codex-runner] process exited code=${code}`);
      try {
        fs.appendFileSync(stderrLogPath, `\n[exit code=${code} at ${new Date().toISOString()}]\n`);
      } catch {
        /* ignore */
      }

      // 没有正常 turn.completed 但有 agent_message → 兜底发 success
      if (!sentSuccess && textProgressState.lastAgentMessage) {
        writeOutput({
          status: 'success',
          result: textProgressState.lastAgentMessage,
          newSessionId,
          usage,
        });
        sentSuccess = true;
      }

      // resume 指向的 rollout 不存在（如从 SDK 模式切到 codex，继承了 Claude 的 session
      // UUID；或 codex rollout 被删/过期）→ 丢弃坏 session，用新 thread 重跑一次。
      // 这不是降级：无法 resume 的 session id 是无效输入，开新会话是唯一正确动作。
      const resumeRolloutMissing =
        code !== 0 &&
        !sentSuccess &&
        !!config.sessionId &&
        /no rollout found|thread\/resume failed/i.test(stderrAccum);
      if (resumeRolloutMissing) {
        log(
          `[codex-runner] resume 失败（rollout 不存在: ${config.sessionId}），改用新 thread 重跑`,
        );
        runCodexQuery({ ...config, sessionId: undefined }, writeOutput, log)
          .then(resolve)
          .catch(reject);
        return;
      }

      // 错误透传：codex 可能 turn.failed 但退出码仍为 0（实测鉴权失败场景），
      // 所以判定条件是「非0退出 OR 捕获到错误正文」。优先用 codex 给的真实正文，
      // 否则退回退出码。这样群里能看到「鉴权失败/限额」而非干等无响应。
      if (!sentSuccess && (code !== 0 || lastErrorMessage)) {
        writeOutput({
          status: 'error',
          result: null,
          error: lastErrorMessage
            ? `codex 失败: ${lastErrorMessage}`
            : `codex 进程退出码 ${code}`,
          newSessionId,
        });
      }

      resolve({ newSessionId, result: textProgressState.lastAgentMessage });
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
