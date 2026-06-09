/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  model?: string;
  effort?: string;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 *
 * Retry loop: on Apple Container, /workspace/agent is a nested virtio-fs
 * mount that takes a moment to become readable after the container starts.
 * The first read commonly fails with EACCES or ENOENT and the file becomes
 * available within ~500ms. We retry briefly before giving up. This is a
 * no-op on Docker/Linux runtimes where the mount is ready before init runs.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  let lastErr: unknown = null;
  const RETRY_MS = [50, 100, 200, 400, 800, 1500];
  for (let attempt = 0; attempt <= RETRY_MS.length; attempt++) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (attempt > 0) {
        console.error(`[config] Read ${CONFIG_PATH} on retry ${attempt}`);
      }
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_MS.length) {
        // Synchronous sleep — we're in startup, no event loop yet.
        const until = Date.now() + RETRY_MS[attempt];
        while (Date.now() < until) {} // busy-wait, ~hundreds of ms total in worst case
      }
    }
  }
  if (lastErr) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
    console.error(`[config] Failed to read ${CONFIG_PATH} after retries, using defaults: ${reason}`);
  }

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    model: (raw.model as string) || undefined,
    effort: (raw.effort as string) || undefined,
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
