/**
 * Agent Runner for NanoClaw
 * Spawns agent execution as Node.js child processes and handles IPC
 */
import { ChildProcess, execFileSync, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import os from 'os';
import {
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { OneCLI } from '@onecli-sh/sdk';
import { RegisteredGroup } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL });
import {
  getLastRotateAt,
  getRotateEnabled,
  getRotateIndex,
  setLastRotateAt,
  setRotateIndex,
} from './db.js';

// agent-runner 编译产物路径
const AGENT_RUNNER_DIST = path.join(
  process.cwd(),
  'container',
  'agent-runner',
  'dist',
  'index.js',
);

// Agent 输出大小限制（10MB）
const AGENT_MAX_OUTPUT_SIZE = parseInt(
  process.env.AGENT_MAX_OUTPUT_SIZE ||
    process.env.CONTAINER_MAX_OUTPUT_SIZE ||
    '10485760',
  10,
);

// Agent 超时时间（默认 30 分钟）
const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);

/**
 * 检测容器输出中的 429/rate-limit 错误。
 * 覆盖 Anthropic API 常见错误格式。
 *
 * 严格匹配：正常对话中讨论 "429"、"rate limit" 话题不应误触发。
 * 要求匹配典型 API 错误短语而非单独关键词。
 */
export function detectRateLimit(text: string): boolean {
  const patterns = [
    // "429 Too Many Requests" / "429 rate limit" 完整短语
    /\b429\s+(?:too\s+many\s+requests|rate[\s-]?limit)/i,
    // "Error: 429" / "status 429" / "code 429" / "HTTP 429"
    /\b(?:error|status|code|http)[\s:=]+429\b/i,
    // Anthropic API 错误类型字面量
    /rate_limit_error/,
    /overloaded_error/,
    // Claude Code "假成功" 限流提示（强信号）
    /you['\u2019]ve\s+hit\s+your\s+(?:usage\s+)?limit/i,
    /you\s+have\s+hit\s+your\s+(?:usage\s+)?limit/i,
    // 经典限流完整短语
    /rate[\s-]?limit\s+exceeded/i,
    /(?:api\s+)?quota\s+exceeded/i,
    /too\s+many\s+requests/i,
  ];
  return patterns.some((p) => p.test(text));
}

// 全部耗尽后的 cooldown（10 分钟）
const EXHAUSTED_COOLDOWN_MS = 10 * 60 * 1000;
// 单次轮换防抖（60 秒）
const ROTATE_DEBOUNCE_MS = 60 * 1000;

/**
 * 尝试轮换到下一个 Anthropic 账号。
 * 返回 { success, newSecretName } 或 null（未开启/防抖/全部耗尽）。
 *
 * agentId: OneCLI agent identifier（group.folder 派生）
 * groupFolder: 群目录名，用于 per-group 防抖和 index 隔离
 */
export function rotateAccount(
  agentId: string,
  groupFolder: string,
): {
  success: boolean;
  newSecretName: string;
} | null {
  if (!getRotateEnabled()) return null;

  const now = Date.now();
  const lastRotate = getLastRotateAt(groupFolder);
  if (lastRotate && now - lastRotate < ROTATE_DEBOUNCE_MS) {
    logger.info({ groupFolder }, '轮换防抖中，跳过');
    return null;
  }

  let secrets: Array<{ id: string; name: string }>;
  try {
    secrets = JSON.parse(
      execSync('onecli secrets list', { encoding: 'utf-8', timeout: 5000 }),
    );
  } catch (err) {
    logger.error({ err }, 'rotateAccount: 无法获取 secrets 列表');
    return null;
  }

  if (secrets.length < 2) {
    logger.warn('只有一个 secret，无法轮换');
    return null;
  }

  const currentIndex = getRotateIndex(groupFolder);
  const nextIndex = (currentIndex + 1) % secrets.length;

  if (
    nextIndex === 0 &&
    lastRotate &&
    now - lastRotate < EXHAUSTED_COOLDOWN_MS
  ) {
    logger.warn({ groupFolder }, '所有账号配额已耗尽');
    return { success: false, newSecretName: '' };
  }

  let agents: Array<{ id: string; identifier: string; isDefault?: boolean }>;
  try {
    agents = JSON.parse(
      execSync('onecli agents list', { encoding: 'utf-8', timeout: 5000 }),
    );
  } catch (err) {
    logger.error({ err }, 'rotateAccount: 无法获取 agents 列表');
    return null;
  }

  // 严格匹配 identifier，不 fallback 到 Default Agent（防止误改全局）
  const agent = agents.find((a) => a.identifier === agentId);

  if (!agent) {
    logger.error(
      { agentId, groupFolder },
      'rotateAccount: 找不到匹配的 agent（不 fallback 到 Default，避免全局污染）',
    );
    return null;
  }

  const nextSecret = secrets[nextIndex];
  try {
    execSync(
      `onecli agents set-secrets --id ${agent.id} --secret-ids ${nextSecret.id}`,
      { encoding: 'utf-8', timeout: 5000 },
    );
  } catch (err) {
    logger.error({ err, secret: nextSecret.name }, 'rotateAccount: 切换失败');
    return null;
  }

  setRotateIndex(nextIndex, groupFolder);
  setLastRotateAt(now, groupFolder);

  logger.info(
    { agent: agent.id, secret: nextSecret.name, index: nextIndex, groupFolder },
    '账号已自动轮换',
  );

  return { success: true, newSecretName: nextSecret.name };
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  /** 触发本次对话的用户 ID（飞书 open_id），传给 agent-runner 用于记忆读写 */
  senderId?: string;
  /** 启用 CLI 模式：spawn claude CLI 替代 Agent SDK，走交互式配额 */
  useCliMode?: boolean;
  /** 单次模型/思考模式覆盖，不持久化 */
  modelOverride?: {
    model?: string;
    thinking?: 'adaptive' | 'disabled';
  };
  /** 由 runContainerAgent 内部填充，调用方无需设置 */
  workspacePaths?: {
    group: string;
    queryCwd?: string; // Custom cwd for query(), falls back to group
    project?: string;
    global?: string;
    ipc: string;
    extra?: string;
  };
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'progress';
  result: string | null;
  newSessionId?: string | null;
  error?: string;
  progressType?: 'tool_use' | 'tool_result' | 'thinking';
  /** 步骤标题（进度推送用） */
  title?: string;
  /** 可折叠面板的展开内容（markdown 格式） */
  detail?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    numTurns: number;
    durationMs: number;
    totalCostUsd: number;
    /** 各模型的实际 context window 大小（tokens），key 为模型名 */
    modelContextWindows?: Record<string, number>;
    model?: string;
    /** 最后一轮 API 调用的实际 context 大小（input + output tokens） */
    lastTurnContext?: number;
  };
}

// ---- 路径与环境 ----

export interface WorkspacePaths {
  group: string;
  queryCwd?: string;
  project?: string;
  global?: string;
  ipc: string;
  extra?: string;
}

/** 根据群组计算宿主真实路径 */
export function resolveWorkspacePaths(
  group: RegisteredGroup,
  isMain: boolean,
): WorkspacePaths {
  const projectRoot = process.cwd();
  return {
    group: resolveGroupFolderPath(group.folder),
    queryCwd: group.customCwd || undefined,
    project: isMain ? projectRoot : undefined,
    global: path.join(GROUPS_DIR, 'global'),
    ipc: resolveGroupIpcPath(group.folder),
    extra: group.containerConfig?.additionalMounts?.[0]?.hostPath,
  };
}

/** 准备 per-group .claude 配置目录（settings.json + skills 同步） */
export function prepareGroupSession(groupFolder: string): string {
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          model: 'claude-opus-4-7',
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // 同步 container/skills/ → per-group .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  return groupSessionsDir;
}

/** 解析 onecli agents get-env 输出的 KEY=VALUE 格式 */
export function parseEnvOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) result[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return result;
}

// OneCLI CA 证书路径（放在 data/ 下，避免 /tmp 被清理导致 proxy 连接失败）
const ONECLI_CA_PATH = path.join(DATA_DIR, 'onecli-gateway-ca.pem');
const ONECLI_COMBINED_CA_PATH = path.join(DATA_DIR, 'onecli-combined-ca.pem');

/**
 * 获取 OneCLI 代理配置（HTTPS_PROXY + CA 证书），用于凭证注入。
 * OneCLI 网关拦截到 api.anthropic.com 的请求并注入 API key。
 * local 模式下把 host.docker.internal 替换为 localhost。
 */
async function getOneCLIProxyEnv(): Promise<Record<string, string>> {
  try {
    const config = await onecli.getContainerConfig();
    if (!config?.env) return {};

    // 写 CA 证书到临时文件
    if (config.caCertificate) {
      fs.writeFileSync(ONECLI_CA_PATH, config.caCertificate);
      // combined CA = system CA + OneCLI CA (for git etc.)
      const systemCa = process.env.SSL_CERT_FILE
        ? fs.readFileSync(process.env.SSL_CERT_FILE, 'utf-8')
        : '';
      fs.writeFileSync(
        ONECLI_COMBINED_CA_PATH,
        systemCa
          ? `${systemCa}\n${config.caCertificate}`
          : config.caCertificate,
      );
    }

    // 把 host.docker.internal 替换为 localhost（local 模式不走 Docker 网络）
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env)) {
      env[key] = value.replace(/host\.docker\.internal/g, 'localhost');
    }
    // 修正 CA 证书路径（容器内路径 → 宿主临时文件）
    env.NODE_EXTRA_CA_CERTS = ONECLI_CA_PATH;
    env.SSL_CERT_FILE = ONECLI_COMBINED_CA_PATH;

    logger.info('OneCLI proxy config applied for local agent');
    return env;
  } catch (err) {
    logger.warn(
      { err },
      'OneCLI proxy not available — agent will have no credentials',
    );
    return {};
  }
}

/** 获取非代理凭证（GitHub token、SSH 等） */
function getStaticCredentials(): Record<string, string | undefined> {
  return {
    GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    GITHUB_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    SSH_AGENT_PID: process.env.SSH_AGENT_PID,
  };
}

/** 获取飞书 User Token（纯用户 token，不用应用 token） */
export async function getFeishuToken(
  chatJid?: string,
  senderId?: string,
): Promise<string | undefined> {
  if (!chatJid?.startsWith('fs:')) return undefined;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feishuOauth = await import('./channels/feishu-oauth.js' as any);

    // 优先用指定的 senderId，否则查 DB 最近发送者
    let userId = senderId;
    if (!userId) {
      const db = await import('./db.js');
      userId = (db as any).getLastSenderForChat?.(chatJid) || undefined;
    }
    if (!userId) return undefined;

    const userToken = await feishuOauth.getFeishuUserToken(userId);
    return userToken || undefined;
  } catch {
    /* feishu-oauth 未导入或无 user token */
    return undefined;
  }
}

/**
 * 获取群对应的 OneCLI agent access token（用于 per-group 账号隔离）。
 * 用 groupFolder 派生 identifier（与 ensureOneCLIAgent 一致）去匹配 OneCLI agent。
 * 找不到独立 agent 时 fallback 到 Default Agent（运行时兜底）。
 */
function getAgentAccessToken(groupFolder: string): string | undefined {
  try {
    const agents: Array<{
      id: string;
      name: string;
      identifier?: string;
      accessToken: string;
      isDefault?: boolean;
    }> = JSON.parse(
      execSync('onecli agents list', { encoding: 'utf-8', timeout: 5000 }),
    );

    // groupFolder 如 "feishu_main" → identifier "feishu-main"（与 ensureOneCLIAgent 一致）
    const identifier = groupFolder.toLowerCase().replace(/_/g, '-');
    const agent =
      agents.find((a) => a.identifier === identifier) ||
      agents.find((a) => a.isDefault);

    if (agent) {
      logger.info(
        { groupFolder, agentName: agent.name, agentId: agent.id },
        '群账号映射: 使用 OneCLI agent',
      );
      return agent.accessToken;
    }
  } catch (err) {
    logger.warn({ err, groupFolder }, '获取群 OneCLI agent token 失败，将用默认');
  }
  return undefined;
}

/** 构建子进程环境变量（精确过滤，不泄露宿主无关变量） */
async function buildLocalEnv(
  input: ContainerInput,
  groupSessionsDir: string,
): Promise<NodeJS.ProcessEnv> {
  // OneCLI 代理注入（HTTPS_PROXY + CA 证书）
  const proxyEnv = await getOneCLIProxyEnv();
  const staticCreds = getStaticCredentials();

  // 按群替换 access token（per-group 账号隔离）
  const groupToken = getAgentAccessToken(input.groupFolder || '');
  if (groupToken && proxyEnv.HTTPS_PROXY) {
    // 替换 proxy URL 里的 access token: http://x:<old_token>@host:port → http://x:<group_token>@host:port
    proxyEnv.HTTPS_PROXY = proxyEnv.HTTPS_PROXY.replace(
      /x:[^@]+@/,
      `x:${groupToken}@`,
    );
    // 同步替换小写版本
    if (proxyEnv.https_proxy) {
      proxyEnv.https_proxy = proxyEnv.https_proxy.replace(
        /x:[^@]+@/,
        `x:${groupToken}@`,
      );
    }
    if (proxyEnv.HTTP_PROXY) {
      proxyEnv.HTTP_PROXY = proxyEnv.HTTP_PROXY.replace(
        /x:[^@]+@/,
        `x:${groupToken}@`,
      );
    }
    if (proxyEnv.http_proxy) {
      proxyEnv.http_proxy = proxyEnv.http_proxy.replace(
        /x:[^@]+@/,
        `x:${groupToken}@`,
      );
    }
  }

  return {
    HOME: process.env.HOME,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
    NODE_PATH: process.env.NODE_PATH,
    NODE_ENV: process.env.NODE_ENV || 'production',
    TZ: process.env.TZ || TIMEZONE,

    // SSH（纯透传）
    ...staticCreds,

    // OneCLI 代理（HTTPS_PROXY, NODE_EXTRA_CA_CERTS 等）
    ...proxyEnv,

    // Claude SDK
    CLAUDE_CONFIG_DIR: groupSessionsDir,

    // 所有群共享同一个 auto-memory（MEMORY.md），覆盖 SDK 默认的 per-cwd 隔离
    CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: path.join(
      GROUPS_DIR,
      'global',
      'memory',
    ),

    // NanoClaw IPC 路径（agent-runner 传给 MCP server）
    NANOCLAW_IPC_DIR: input.workspacePaths!.ipc,

    // 群标识（feishu-docs 等 skill 通过 IPC 请求 token 时需要）
    NANOCLAW_CHAT_JID: input.chatJid || '',
    NANOCLAW_GROUP_FOLDER: input.groupFolder || '',

    // 触发用户 ID（记忆读写用）
    NANOCLAW_SENDER_ID: input.senderId || '',

    // Agent SDK 配置 — 与 settings.json 双保险
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  };
}

/** 检查 agent-runner 编译产物是否存在 */
export function checkAgentRunnerDist(): void {
  if (!fs.existsSync(AGENT_RUNNER_DIST)) {
    throw new Error(
      `agent-runner 未编译: ${AGENT_RUNNER_DIST} 不存在。请运行 npm run build:agent`,
    );
  }
}

/** 杀进程组（包括 MCP server、浏览器等孙进程） */
function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* 已退出 */
    }
  }
}

/**
 * 启动时清理上次运行遗留的孤儿 agent 进程。
 * Docker 时代用 `docker stop` 清理孤儿容器，迁移到本地子进程后需要用 pkill。
 */
export function cleanupOrphanAgents(): void {
  try {
    // 找到所有 agent-runner 进程（排除当前主进程的子进程）
    const mainPid = process.pid;
    const output = execSync(
      `pgrep -f "agent-runner/dist/index.js" 2>/dev/null || true`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (!output) {
      logger.debug('No orphan agent processes found');
      return;
    }
    const pids = output.split('\n').map(Number).filter(Boolean);
    let killed = 0;
    for (const pid of pids) {
      try {
        // 检查是否是当前进程的子进程（不杀自己的子进程）
        const ppid = parseInt(
          execSync(`ps -o ppid= -p ${pid} 2>/dev/null || echo 0`, {
            encoding: 'utf-8',
          }).trim(),
          10,
        );
        if (ppid === mainPid) continue; // 当前主进程的子进程，跳过
        // 杀掉进程组
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            /* already dead */
          }
        }
        killed++;
      } catch {
        /* 忽略单个进程的错误 */
      }
    }
    if (killed > 0) {
      logger.info(
        { killed, total: pids.length },
        'Cleaned up orphan agent processes',
      );
      // 等 2 秒后强杀残留
      setTimeout(() => {
        for (const pid of pids) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* already dead */
          }
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already dead */
          }
        }
      }, 2000);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to cleanup orphan agents');
  }
}

// ---- 主函数 ----

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const isMain = input.isMain;

  // 确保群组目录存在
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // 准备路径
  const workspacePaths = resolveWorkspacePaths(group, isMain);
  input.workspacePaths = workspacePaths;

  // 准备 per-group .claude 目录
  const groupSessionsDir = prepareGroupSession(group.folder);

  // 准备 IPC 目录
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // 检查 agent-runner 编译产物
  checkAgentRunnerDist();

  // 构建环境变量
  const localEnv = await buildLocalEnv(input, groupSessionsDir);

  // agent-runner 需要知道自己的安装目录来定位 CLI
  localEnv.AGENT_RUNNER_DIR = path.join(
    process.cwd(),
    'container',
    'agent-runner',
  );

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const agentName = `nanoclaw-${safeName}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      agentName,
      isMain,
      cwd: workspacePaths.group,
    },
    'Spawning agent process',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENT_RUNNER_DIST], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: localEnv,
      cwd: workspacePaths.group,
      detached: true,
    });

    // detached 后 unref 让子进程不阻止宿主退出（timeout 时 kill 会处理清理）
    child.unref();

    onProcess(child, agentName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    // 流式解析 stdout 中的 OUTPUT_START/END 标记
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    child.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = AGENT_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            const now = Date.now();
            const gap = ((now - lastOutputTime) / 1000).toFixed(1);
            lastOutputTime = now;
            hadStreamingOutput = true;
            logger.debug(
              {
                group: group.name,
                status: parsed.status,
                gap: `${gap}s`,
                resultLen: parsed.result?.length,
              },
              'Agent output received',
            );
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed)).catch((err) => {
              logger.error(
                { group: group.name, error: err, status: parsed.status },
                'onOutput callback failed, message may be lost',
              );
            });
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) {
          // model-override 和 query-start 日志用 info 级别确保可见
          if (
            line.includes('[model-override]') ||
            line.includes('[query-start]') ||
            line.includes('[result]') ||
            line.includes('[text-block]')
          ) {
            logger.info({ agent: group.folder }, line);
          } else {
            logger.debug({ agent: group.folder }, line);
          }
        }
      }
      if (stderrTruncated) return;
      const remaining = AGENT_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Agent stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    let lastOutputTime = startTime;
    const configTimeout = group.containerConfig?.timeout || AGENT_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    logger.info(
      { group: group.name, pid: child.pid, timeoutMs },
      'Agent process started, timeout set',
    );

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, agentName },
        'Agent timeout, sending SIGTERM',
      );
      if (child.pid) {
        killProcessTree(child.pid, 'SIGTERM');
        // 5 秒宽限期后 SIGKILL
        setTimeout(() => {
          if (child.pid) killProcessTree(child.pid, 'SIGKILL');
        }, 5000);
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      const sinceLastOutput = ((Date.now() - lastOutputTime) / 1000).toFixed(1);
      logger.info(
        {
          group: group.name,
          pid: child.pid,
          code,
          duration,
          hadStreamingOutput,
          sinceLastOutput: `${sinceLastOutput}s`,
          timedOut,
        },
        'Agent process exited',
      );

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `agent-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Agent Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, agentName, duration, code },
            'Agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          }).catch((err) => {
            logger.error({ group: group.name, error: err }, 'outputChain rejected on timeout close');
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        logger.error(
          { group: group.name, agentName, duration, code },
          'Agent timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Agent log written');

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr, stdout, logFile },
          'Agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // 流式模式：等待 output chain 完成
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        }).catch((err) => {
          logger.error({ group: group.name, error: err }, 'outputChain rejected on normal close');
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy 模式：从累积 stdout 解析
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);
        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Agent completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout, stderr, error: err },
          'Failed to parse agent output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, agentName, error: err },
        'Agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      });
    });
  });
}

// ---- IPC 快照（保留不变） ----

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
