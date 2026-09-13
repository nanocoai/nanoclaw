/**
 * Channel-transport wiring : resolve the
 * deployment knob, extend the CLI argv, and make sure claude can find and
 * consent to the nanoclaw-mailbox channel server.
 *
 * The knob is NANOCLAW_CODE_CHANNELS:
 *   ''/unset — off: the delivery loop types (or send-keys under tmux).
 *   'dev'    — research-preview posture: the server loads via
 *              --dangerously-load-development-channels (allowlist bypass for
 *              exactly this entry; the org channelsEnabled gate still applies).
 *   'org'    — organization policy: the org's allowedChannelPlugins policy
 *              carries the server; no development flag on the argv.
 *
 * Fail-safe end: anything unrecognized is 'off' — a typo must degrade to the
 * typing transport, never to a session whose mail silently goes nowhere
 * (channels drop unregistered notifications without an error, so "half
 * configured" is the one posture this module must make unrepresentable).
 */
import fs from 'fs';
import path from 'path';

export type ChannelMode = 'off' | 'dev' | 'org';

export const CHANNEL_SERVER_NAME = 'nanoclaw-mailbox';
/** One replaceable line, argv[0] + rest — the channel subprocess entrypoint. */
export const CHANNEL_SERVER_COMMAND = ['bun', '/app/src/code-runner/mailbox-channel.ts'];

/**
 * Where the server registration is written: container-private, never the
 * workspace. The workspace is the developer's tree (durable, committable, and
 * a project `.mcp.json` there would be theirs to own); the registration is
 * the runner's and rides the CLI's `--mcp-config` flag instead.
 */
export const CHANNEL_MCP_CONFIG_PATH = '/tmp/code-runner/mcp.json';

export function resolveChannelMode(raw: unknown): ChannelMode {
  return raw === 'dev' || raw === 'org' ? raw : 'off';
}

/**
 * Extra CLI argv for the mode: the server registration file for both live
 * modes, plus the dev flag that names exactly our entry in dev mode.
 */
export function channelArgs(mode: ChannelMode, configPath: string = CHANNEL_MCP_CONFIG_PATH): string[] {
  if (mode === 'off') return [];
  const args = ['--mcp-config', configPath];
  if (mode === 'dev') args.push('--dangerously-load-development-channels', `server:${CHANNEL_SERVER_NAME}`);
  return args;
}

/**
 * Write the channel server registration the CLI loads through
 * `--mcp-config`. A private file with exactly one server: nothing to merge,
 * nothing of the developer's to preserve. tmp+rename so the CLI never reads
 * a torn file.
 */
export function ensureChannelMcpConfig(configPath: string = CHANNEL_MCP_CONFIG_PATH): boolean {
  const desired = {
    mcpServers: {
      [CHANNEL_SERVER_NAME]: { command: CHANNEL_SERVER_COMMAND[0], args: CHANNEL_SERVER_COMMAND.slice(1) },
    },
  };
  const content = `${JSON.stringify(desired, null, 2)}\n`;
  try {
    if (fs.readFileSync(configPath, 'utf8') === content) return false;
  } catch {
    // absent or unreadable — write it
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, configPath);
  return true;
}
