/**
 * Channel-transport wiring (terminal-architecture phase 2): resolve the
 * deployment knob, extend the CLI argv, and make sure claude can find and
 * consent to the nanoclaw-mailbox channel server.
 *
 * The knob is NANOCLAW_CODE_CHANNELS:
 *   ''/unset — off: the delivery loop types (or send-keys under tmux).
 *   'dev'    — research-preview posture: the server loads via
 *              --dangerously-load-development-channels (allowlist bypass for
 *              exactly this entry; the org channelsEnabled gate still applies).
 *   'org'    — enterprise posture: the org's allowedChannelPlugins policy
 *              carries the server; no development flag on the argv.
 *
 * Fail-safe end: anything unrecognized is 'off' — a typo must degrade to the
 * typing transport, never to a session whose mail silently goes nowhere
 * (channels drop unregistered notifications without an error, so "half
 * configured" is the one posture this module must make unrepresentable).
 */
import fs from 'fs';
import path from 'path';

import { claudeSettingsPath } from './settings-hooks.js';

export type ChannelMode = 'off' | 'dev' | 'org';

export const CHANNEL_SERVER_NAME = 'nanoclaw-mailbox';
/** One replaceable line, argv[0] + rest — the release bake swaps it for the
 * compiled binary exactly like MAILBOX_HOOK_COMMAND (ci/release-bundle.ts). */
export const CHANNEL_SERVER_COMMAND = ['bun', '/app/src/code-runner/mailbox-channel.ts'];

export function resolveChannelMode(raw: unknown): ChannelMode {
  return raw === 'dev' || raw === 'org' ? raw : 'off';
}

/** Extra CLI argv for the mode — the dev flag names exactly our entry. */
export function channelArgs(mode: ChannelMode): string[] {
  return mode === 'dev' ? ['--dangerously-load-development-channels', `server:${CHANNEL_SERVER_NAME}`] : [];
}

/**
 * Register the channel server in the workspace .mcp.json (merge, never
 * clobber — the workspace is durable and the developer may keep their own
 * servers there). claude reads this at startup and spawns the server.
 */
export function ensureChannelMcpConfig(workspaceDir: string): boolean {
  const file = path.join(workspaceDir, '.mcp.json');
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof config;
  } catch {
    // absent or unreadable — start fresh; the write below is tmp+rename
  }
  const servers = (config.mcpServers ??= {});
  const desired = { command: CHANNEL_SERVER_COMMAND[0], args: CHANNEL_SERVER_COMMAND.slice(1) };
  if (JSON.stringify(servers[CHANNEL_SERVER_NAME]) === JSON.stringify(desired)) return false;
  servers[CHANNEL_SERVER_NAME] = desired;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return true;
}

/**
 * Pre-consent to project MCP servers: a disposable pod has nobody attached
 * to answer the "New MCP server found in this project" dialog — the same
 * reasoning as ensureClaudeState's folder-trust pre-seed. Scoped to the
 * group's own settings.json, whose only project is the group workspace.
 */
export function ensureProjectMcpConsent(settingsPath: string = claudeSettingsPath()): boolean {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // absent — ensureMailboxHooks creates it first at boot; merge regardless
  }
  if (settings.enableAllProjectMcpServers === true) return false;
  settings.enableAllProjectMcpServers = true;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, settingsPath);
  return true;
}
