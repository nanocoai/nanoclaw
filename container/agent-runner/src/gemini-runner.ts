/**
 * Gemini Runner — spawn Gemini CLI in headless stream-json mode.
 *
 * 每轮消息 spawn 一次 `gemini -p <prompt> --output-format stream-json`，
 * 用 per-group GEMINI home 隔离会话与 MCP 配置，同时软链宿主 OAuth 凭证。
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ContainerOutput } from './cli-runner.js';

const DEFAULT_GEMINI_MODEL = 'gemini-3-pro-preview';

export interface GeminiEvent {
  type: 'init' | 'message' | 'result' | 'error' | string;
  session_id?: string;
  role?: 'user' | 'assistant' | string;
  content?: string;
  delta?: boolean;
  status?: string;
  message?: string;
  error?: { message?: string };
  model?: string;
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    input?: number;
    duration_ms?: number;
    tool_calls?: number;
    models?: Record<string, {
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      cached?: number;
      input?: number;
    }>;
  };
  [key: string]: unknown;
}

export interface GeminiRunnerConfig {
  prompt: string;
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
  geminiHome: string;
  additionalDirectories?: string[];
}

export function parseGeminiEventLine(line: string): GeminiEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || !parsed.type) return null;
    return parsed as GeminiEvent;
  } catch {
    return null;
  }
}

export function buildGeminiArgs(config: {
  prompt: string;
  sessionId?: string;
  model?: string;
  additionalDirectories?: string[];
}): string[] {
  const args: string[] = [
    '-p',
    config.prompt,
    '--output-format',
    'stream-json',
    '--skip-trust',
    '--approval-mode',
    'yolo',
  ];

  if (config.sessionId) {
    args.push('--resume', config.sessionId);
  }

  args.push('--model', config.model || DEFAULT_GEMINI_MODEL);

  for (const dir of config.additionalDirectories || []) {
    args.push('--include-directories', dir);
  }

  return args;
}

export function buildGeminiSettings(config: {
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  ipcDir: string;
  senderId?: string;
}): Record<string, unknown> {
  return {
    security: {
      auth: {
        selectedType: 'oauth-personal',
      },
    },
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [config.mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: config.chatJid,
          NANOCLAW_GROUP_FOLDER: config.groupFolder,
          NANOCLAW_IS_MAIN: config.isMain ? '1' : '0',
          NANOCLAW_IPC_DIR: config.ipcDir,
          NANOCLAW_SENDER_ID: config.senderId || '',
        },
        trust: true,
      },
    },
  };
}

export function prepareGeminiHome(
  geminiHome: string,
  sourceHome: string,
  settings: Record<string, unknown>,
  log: (message: string) => void,
): void {
  const configDir = path.join(geminiHome, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });

  for (const name of ['oauth_creds.json', 'google_accounts.json', 'installation_id']) {
    const src = path.join(sourceHome, '.gemini', name);
    const dst = path.join(configDir, name);
    if (fs.existsSync(dst)) continue;
    if (!fs.existsSync(src)) {
      log(`[gemini-runner] WARNING: 宿主 ${src} 不存在，gemini 可能未登录`);
      continue;
    }
    try {
      fs.symlinkSync(src, dst);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      log(`[gemini-runner] symlink ${name} failed: ${(err as Error).message}`);
    }
  }

  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify(settings, null, 2),
  );
}

export function buildGeminiEnv(
  baseEnv: Record<string, string | undefined>,
  geminiHome: string,
): Record<string, string | undefined> {
  const env = { ...baseEnv };
  env.HOME = geminiHome;
  return env;
}

export function mapGeminiUsage(
  event: GeminiEvent,
  initModel?: string,
): ContainerOutput['usage'] | undefined {
  const stats = event.stats;
  if (!stats) return undefined;

  const model = selectGeminiUsageModel(stats.models, initModel);
  return {
    inputTokens: stats.input_tokens ?? stats.input ?? 0,
    outputTokens: stats.output_tokens ?? 0,
    cacheReadInputTokens: stats.cached ?? 0,
    cacheCreationInputTokens: 0,
    numTurns: 1,
    durationMs: stats.duration_ms ?? 0,
    totalCostUsd: 0,
    model,
  };
}

function selectGeminiUsageModel(
  models: NonNullable<GeminiEvent['stats']>['models'],
  initModel?: string,
): string | undefined {
  if (initModel && initModel !== 'auto') return initModel;
  if (!models || typeof models !== 'object') return initModel;
  let best: { name: string; total: number } | undefined;
  for (const [name, stat] of Object.entries(models as Record<string, { total_tokens?: number }>)) {
    const total = stat.total_tokens ?? 0;
    if (!best || total > best.total) best = { name, total };
  }
  return best?.name || initModel;
}

export function extractGeminiError(event: GeminiEvent): string | undefined {
  if (event.type === 'error') {
    return event.error?.message || event.message || undefined;
  }
  if (event.type === 'result' && event.status && event.status !== 'success') {
    return event.error?.message || event.message || `gemini result status=${event.status}`;
  }
  return undefined;
}

export async function runGeminiQuery(
  config: GeminiRunnerConfig,
  writeOutput: (output: ContainerOutput) => void,
  log: (message: string) => void,
): Promise<{ newSessionId?: string; result?: string }> {
  const settings = buildGeminiSettings({
    mcpServerPath: config.mcpServerPath,
    chatJid: config.chatJid,
    groupFolder: config.groupFolder,
    isMain: config.isMain,
    ipcDir: config.ipcDir,
    senderId: config.senderId,
  });
  const sourceHome = config.env.HOME || os.homedir();
  prepareGeminiHome(config.geminiHome, sourceHome, settings, log);

  const args = buildGeminiArgs({
    prompt: config.prompt,
    sessionId: config.sessionId,
    model: config.model,
    additionalDirectories: config.additionalDirectories,
  });

  const geminiEnv = buildGeminiEnv(config.env, config.geminiHome);
  log(`[gemini-runner] spawning: gemini ${args.map((arg) => arg === config.prompt ? '<prompt>' : arg).join(' ')}`);
  log(`[gemini-runner] cwd=${config.cwd}, sessionId=${config.sessionId || 'new'}, HOME=${config.geminiHome}`);

  return new Promise((resolve) => {
    const child: ChildProcess = spawn('gemini', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: geminiEnv as NodeJS.ProcessEnv,
      cwd: config.cwd,
    });

    let newSessionId: string | undefined = config.sessionId;
    let initModel: string | undefined;
    let lastAssistantMessage = '';
    let usage: ContainerOutput['usage'] | undefined;
    let sentSuccess = false;
    let lineBuffer = '';
    let stderrAccum = '';
    let lastErrorMessage: string | undefined;
    let errorAlreadySent = false;

    child.stdin!.end();

    const handleLine = (line: string) => {
      const event = parseGeminiEventLine(line);
      if (!event) return;
      log(`[gemini-runner] event: ${event.type}${event.role ? `/${event.role}` : ''}`);

      if (event.type === 'init') {
        if (event.session_id) newSessionId = event.session_id;
        if (event.model) initModel = event.model;
        return;
      }

      if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
        if (event.delta) {
          lastAssistantMessage += event.content;
        } else {
          lastAssistantMessage = event.content;
        }
        return;
      }

      const errMsg = extractGeminiError(event);
      if (errMsg) lastErrorMessage = errMsg;

      if (event.type === 'result') {
        usage = mapGeminiUsage(event, initModel);
        if (!lastErrorMessage && (event.status === 'success' || !event.status)) {
          writeOutput({
            status: 'success',
            result: lastAssistantMessage || null,
            newSessionId,
            usage,
          });
          sentSuccess = true;
        }
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
      log(`[gemini-stderr] ${text.trim()}`);
    });

    child.on('close', (code) => {
      if (lineBuffer.trim()) handleLine(lineBuffer);

      log(`[gemini-runner] process exited code=${code}`);
      if (errorAlreadySent) {
        resolve({ newSessionId, result: lastAssistantMessage || undefined });
        return;
      }
      if (!sentSuccess && lastAssistantMessage && !lastErrorMessage) {
        writeOutput({
          status: 'success',
          result: lastAssistantMessage,
          newSessionId,
          usage,
        });
        sentSuccess = true;
      }

      if (!sentSuccess && (code !== 0 || lastErrorMessage)) {
        writeOutput({
          status: 'error',
          result: null,
          error: lastErrorMessage
            ? `gemini 失败: ${lastErrorMessage}`
            : `gemini 进程退出码 ${code}: ${stderrAccum.trim().slice(0, 500)}`,
          newSessionId,
        });
        sentSuccess = true;
      }

      resolve({ newSessionId, result: lastAssistantMessage || undefined });
    });

    child.on('error', (err) => {
      log(`[gemini-runner] spawn error: ${err.message}`);
      writeOutput({
        status: 'error',
        result: null,
        error: `启动 gemini CLI 失败: ${err.message}。请确认已安装：npm install -g @google/gemini-cli`,
      });
      errorAlreadySent = true;
      sentSuccess = true;
      resolve({ newSessionId, result: lastAssistantMessage || undefined });
    });
  });
}
