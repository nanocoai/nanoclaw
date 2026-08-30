import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const DEFAULT_OLLAMA_BASE_URL = 'http://host.docker.internal:11434';
const WEB_BROWSING_ENABLED = 'enabled';
const WEB_BROWSING_DISABLED = 'disabled';
const MODEL_NAME = /^[a-zA-Z0-9_.:/-]+$/;
const BLOCKED_CLOUD_HOSTS = [
  'api.anthropic.com',
  'claude.ai',
  'www.claude.ai',
  'statsig.anthropic.com',
  'platform.claude.com',
  'mcp-proxy.anthropic.com',
  'code.claude.com',
  'claude.com',
];

export interface OllamaModelState {
  runtimeModel: string;
  contextLength?: number;
}

export function resolveOllamaWebBrowsing(hostEnv: NodeJS.ProcessEnv): 'enabled' | 'disabled' {
  const configured = hostEnv.OLLAMA_WEB_BROWSING ?? readEnvFile(['OLLAMA_WEB_BROWSING']).OLLAMA_WEB_BROWSING;
  if (configured === undefined || configured === '' || configured === WEB_BROWSING_DISABLED) {
    return WEB_BROWSING_DISABLED;
  }
  if (configured === WEB_BROWSING_ENABLED) return WEB_BROWSING_ENABLED;
  throw new Error('OLLAMA_WEB_BROWSING must be "enabled" or "disabled"');
}

export function readOllamaModelState(sourceModel: string, dataDir = DATA_DIR): OllamaModelState | undefined {
  const file = path.join(
    dataDir,
    'provider-state',
    'ollama',
    `${createHash('sha256').update(sourceModel).digest('hex')}.json`,
  );
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  let state: unknown;
  try {
    state = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`invalid Ollama model state: ${file}`, { cause: error });
  }
  if (!state || typeof state !== 'object' || Array.isArray(state))
    throw new Error(`invalid Ollama model state: ${file}`);
  const { source, runtime, contextLength } = state as Record<string, unknown>;
  if (source !== sourceModel) return undefined;
  if (typeof runtime !== 'string' || !MODEL_NAME.test(runtime))
    throw new Error(`invalid Ollama runtime model: ${file}`);
  if (contextLength !== undefined && (!Number.isSafeInteger(contextLength) || (contextLength as number) <= 0)) {
    throw new Error(`invalid Ollama context length: ${file}`);
  }
  return { runtimeModel: runtime, ...(contextLength !== undefined && { contextLength: contextLength as number }) };
}

registerProviderContainerConfig('ollama', (ctx) => {
  const configured = ctx.hostEnv.OLLAMA_BASE_URL ?? readEnvFile(['OLLAMA_BASE_URL']).OLLAMA_BASE_URL;
  const baseUrl = configured || DEFAULT_OLLAMA_BASE_URL;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error: unknown) {
    throw new Error(`invalid OLLAMA_BASE_URL: ${baseUrl}`, { cause: error });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OLLAMA_BASE_URL must be an http(s) URL without credentials, query, or fragment');
  }
  const noProxy = ['127.0.0.1', 'localhost', url.hostname, ...BLOCKED_CLOUD_HOSTS].join(',');
  const sourceModel = ctx.model;
  if (!sourceModel || !MODEL_NAME.test(sourceModel)) {
    throw new Error('Ollama provider requires a valid model configured on the agent group');
  }
  const modelState = readOllamaModelState(sourceModel);
  const runtimeModel = modelState?.runtimeModel ?? sourceModel;
  const webBrowsing = resolveOllamaWebBrowsing(ctx.hostEnv);

  return {
    blockedHosts: BLOCKED_CLOUD_HOSTS,
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      // OneCLI or the host may inject a Claude credential before provider
      // routing is applied. Blank both forms at the provider boundary so Ollama
      // containers never carry a usable direct-cloud credential.
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // With retries, the same runaway generation repeats after the 300s client cancel and holds the channel,
      // observed live 5x on 2026-08-22 and twice on 2026-08-23. Fail fast and surface the error instead.
      CLAUDE_CODE_MAX_RETRIES: '0',
      // Caps a runaway local-model generation by output length before the CLI's 300s request timeout. Measured
      // 63.8 tok/s on gemma4:12b-mlx: 8192 tokens ends a runaway at roughly 2 minutes and stays under the timeout
      // even if throughput halves at long context; legitimate long answers are far below it.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
      CLAUDE_CODE_FORCE_MID_CONVERSATION_SYSTEM: 'false',
      // Claude Code emits per-call context as role:"system" messages, and Ollama's qwen3.8 renderer variant folds
      // every system message into the leading system turn, so each one lands at the end of the prompt prefix and
      // re-prefills the conversation behind it. Measured on qwen3.8:27b-mlx: the tokens reminder fires after every
      // tool result and user prompt (cache stuck at 45%, 39.9s per call); the todo reminder fires every 9 to 12
      // calls (54281 tokens re-prefilled in one 167s call at 69k context) and only nudges TodoWrite and the task
      // tools. With both off, 24 consecutive calls held re-prefill flat at 24-85 while the prompt grew 69519 to
      // 72107. Not seen on gemma4:12b-mlx; Ollama sets the tokens one on its own launch path (add1f92b).
      // ollama.test.ts pins both keys.
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
      CLAUDE_CODE_TODO_REMINDER_MODE: 'off',
      CLAUDE_CODE_DISABLE_ARTIFACT: '1',
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
      CLAUDE_CODE_DISABLE_CRON: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      DISABLE_LOGIN_COMMAND: '1',
      DISABLE_LOGOUT_COMMAND: '1',
      DISABLE_UPDATES: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_TELEMETRY: '1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: runtimeModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: runtimeModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: runtimeModel,
      CLAUDE_CODE_SUBAGENT_MODEL: runtimeModel,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      NANOCLAW_OLLAMA_RUNTIME_MODEL: runtimeModel,
      NANOCLAW_OLLAMA_WEB_BROWSING: webBrowsing,
      ...(modelState?.contextLength && {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(modelState.contextLength),
        // Claude Code's default auto-compact window (165k) never triggers for a
        // local model whose context is far smaller, so a long conversation
        // overruns the real window and Ollama rejects it. Pull the window below
        // the model's limit (mirrors the ~0.8 stock ratio) so compaction runs
        // in time.
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.floor(modelState.contextLength * 0.8)),
      }),
    },
  };
});
