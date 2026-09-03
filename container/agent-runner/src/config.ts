/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

import type { McpServerConfig } from './providers/types.js';

const CONFIG_PATH = '/workspace/agent/container.json';

/**
 * How this group's agent reaches a destination.
 *
 * `envelope`: final-text `<message to="…">` blocks deliver, alongside the
 * outbound tools. `tools-only`: only an explicit outbound tool call delivers
 * and everything else the agent writes is a private scratchpad.
 *
 * Resolved here and carried on the config, but nothing in the runner reads it
 * yet: the poll loop enforces `tools-only` in a separate change. Until then
 * every group delivers as `envelope` whatever this resolves to.
 */
export type DeliveryMode = 'envelope' | 'tools-only';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, McpServerConfig>;
  model?: string;
  effort?: string;
  /** API fast serving tier (host-configured; see the host's container-config). */
  fastMode?: boolean;
  deliveryMode: DeliveryMode;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;
let _loadedFrom: string | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 *
 * `configPath` overrides the mount location. The result is cached, so asking
 * for a different file without resetConfig() first is an error rather than a
 * silent hand-back of the wrong group's contract.
 */
export function loadConfig(configPath: string = CONFIG_PATH): RunnerConfig {
  if (_config) {
    if (configPath !== _loadedFrom) {
      throw new Error(`Config already loaded from ${_loadedFrom}; call resetConfig() before loading ${configPath}`);
    }
    return _config;
  }
  _loadedFrom = configPath;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${configPath}, using defaults`);
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
    fastMode: raw.fastMode === true || undefined,
    // Anything but the explicit opt-in resolves to `envelope`, including an
    // unreadable config: a missing or malformed value must never change how
    // an existing group delivers.
    deliveryMode: raw.deliveryMode === 'tools-only' ? 'tools-only' : 'envelope',
  };

  return _config;
}

/** Drop the cached config so the next loadConfig() re-reads from disk. */
export function resetConfig(): void {
  _config = null;
  _loadedFrom = null;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
