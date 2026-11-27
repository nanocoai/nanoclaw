/**
 * Antigravity CLI (`agy`) configuration: the per-capability plan functions the
 * runtime contract declares, the renderers for the three files agy reads from
 * `~/.gemini`, their writers, the memory-hook runner and the child-process
 * environment.
 *
 * Files NanoClaw owns inside the container (HOME is /home/node; `~/.gemini` is
 * the per-group `gemini-home` state volume):
 *
 *   ~/.gemini/antigravity-cli/settings.json  merge-written: the keys in ANTIGRAVITY_FORCED_SETTINGS
 *   ~/.gemini/config/mcp_config.json         rewritten from container.json each query
 *   ~/.gemini/config/rules/nanoclaw.md       rewritten before each agy spawn
 *
 * The volume is per group, not per session, and agy rereads its rule files on
 * every turn, so the rule file holds only group-level content (the headless
 * note and memory). Per-session instructions travel in-band (antigravity.ts).
 *
 * Every other file under `~/.gemini` (agy's conversation DB, user-authored
 * rule files, skills) is left alone.
 *
 * This module never imports the runtime contract: registration is two-step,
 * and the contract imports these functions, not the other way round.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { McpServerConfig } from './types.js';

function log(msg: string): void {
  console.error(`[antigravity-config] ${msg}`);
}

/**
 * Non-secret marker the host passes as GEMINI_API_KEY. agy only checks the key
 * is non-empty at startup and sends it as `x-goog-api-key`; the credential
 * gateway swaps it for the vaulted key. Host and container share no modules,
 * so the host adapter declares the same literal.
 */
export const ANTIGRAVITY_API_KEY_PLACEHOLDER = 'nc-antigravity-placeholder';

export const ANTIGRAVITY_COMMAND = 'agy';

/** One NDJSON line per user turn on stdin, NDJSON events on stdout. */
export const ANTIGRAVITY_PROTOCOL_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json'] as const;

/** agy truncates rule files past this size, so the writer caps the file itself. */
export const ANTIGRAVITY_RULE_MAX_BYTES = 24 * 1024;

export const ANTIGRAVITY_RULE_TRUNCATION_MARKER =
  "\n\n[NanoClaw: truncated here to fit Antigravity's 24 KB rule-file limit]\n";

/** Shared reference for the effort values `agy --effort` accepts. */
export const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AntigravityEffort = (typeof ANTIGRAVITY_EFFORTS)[number];

/**
 * Structural mirror of core's MemorySessionHookRegistration. Mirrored, not
 * imported, so the payload compiles against cores whose memory module differs.
 */
export interface AntigravityMemorySessionHook {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

// ─── paths ──────────────────────────────────────────────────────────────

export function antigravityGeminiDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.HOME || os.homedir(), '.gemini');
}

export function antigravitySettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityGeminiDir(env), 'antigravity-cli', 'settings.json');
}

export function antigravityMcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityGeminiDir(env), 'config', 'mcp_config.json');
}

export function antigravityRulePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(antigravityGeminiDir(env), 'config', 'rules', 'nanoclaw.md');
}

// ─── configuration sections ─────────────────────────────────────────────
// Per-capability plan functions. The runtime contract declares these same
// functions (or their constant results); on a core without the contract seam
// the provider calls them from its constructor. Both land on the same argv
// and the same files.

export interface AntigravityExecutionPolicy {
  /**
   * The container and the credential gateway's allow-list are the boundary,
   * so agy's own approval prompts are off: headless there is nobody to answer
   * them, and with this flag MCP tools also run without an approval prompt.
   */
  permissionMode: 'always-proceed';
  args: string[];
}

export function antigravityExecutionPolicySection(): AntigravityExecutionPolicy {
  return { permissionMode: 'always-proceed', args: ['--dangerously-skip-permissions'] };
}

export interface AntigravityInference {
  /** The `--model` / `--effort` flags for every agy spawn; empty means agy's defaults. */
  args: string[];
}

/**
 * A value agy does not accept is dropped with a warning, not thrown: a group
 * switched from another provider can carry that provider's effort vocabulary,
 * the host does not validate it, and a throw here would stop the container at
 * boot. Without `--effort` agy uses the model's own default.
 */
export function normalizeAntigravityEffort(effort: string | undefined): AntigravityEffort | undefined {
  const normalized = effort?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!(ANTIGRAVITY_EFFORTS as readonly string[]).includes(normalized)) {
    log(`Ignoring unsupported Antigravity effort '${effort}' (expected one of ${ANTIGRAVITY_EFFORTS.join(', ')})`);
    return undefined;
  }
  return normalized as AntigravityEffort;
}

/**
 * `model` is an agy slug (`gemini-3.8-flash-medium`; `agy models` lists them)
 * passed through as-is. agy has no speed knob, so `speed` is ignored and the
 * host contract declares no speed tiers.
 */
export function antigravityInferenceSection(input: {
  model?: string;
  effort?: string;
  speed?: string;
}): AntigravityInference {
  const args: string[] = [];
  const model = input.model?.trim();
  if (model) args.push('--model', model);
  const effort = normalizeAntigravityEffort(input.effort);
  if (effort) args.push('--effort', effort);
  return { args };
}

/**
 * agy does not run hooks in API-key mode, so the provider runs core's memory
 * hook command itself before each spawn and inlines its output in the rule
 * file. The section is therefore the hook registration itself.
 */
export function antigravityMemorySection(hook: AntigravityMemorySessionHook): AntigravityMemorySessionHook {
  return { command: hook.command, legacyCommands: [...hook.legacyCommands], sources: [...hook.sources] };
}

/** The MCP server the agent-runner registers for NanoClaw's own tools. */
export const NANOCLAW_MCP_SERVER_NAME = 'nanoclaw';

/**
 * Per-call timeout for the NanoClaw MCP server. agy gives up on any MCP tool
 * call after 180 s unless the server entry sets `timeoutSeconds`, and
 * `ask_user_question` waits up to 300 s for the user's answer by default. The
 * extra 30 s lets that tool report its own timeout first. agy wants an integer:
 * a string value silently drops the whole server.
 */
export const NANOCLAW_MCP_TIMEOUT_SECONDS = 330;

/** stdio entries keep `cwd` and `env` natively; remote entries are Streamable HTTP only. */
export type AntigravityMcpEntry = (
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { serverUrl: string; headers?: Record<string, string> }
) & { timeoutSeconds?: number };

export interface AntigravityMcpConfig {
  mcpServers: Record<string, AntigravityMcpEntry>;
}

/**
 * The NanoClaw server always gets NANOCLAW_MCP_TIMEOUT_SECONDS. Any other
 * server keeps agy's default unless its own config already carries an integer
 * `timeoutSeconds`, which passes through.
 */
function mcpTimeout(name: string, server: McpServerConfig): { timeoutSeconds?: number } {
  if (name === NANOCLAW_MCP_SERVER_NAME) return { timeoutSeconds: NANOCLAW_MCP_TIMEOUT_SECONDS };
  const own = (server as { timeoutSeconds?: unknown }).timeoutSeconds;
  return typeof own === 'number' && Number.isInteger(own) ? { timeoutSeconds: own } : {};
}

export function antigravityMcpServersSection(servers: Record<string, McpServerConfig>): AntigravityMcpConfig {
  const mcpServers: Record<string, AntigravityMcpEntry> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === 'http') {
      mcpServers[name] = {
        serverUrl: server.url,
        ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
        ...mcpTimeout(name, server),
      };
      continue;
    }
    // agy launches stdio servers in `cwd` itself, so no cwd-shim is needed.
    // `pluginRoot` is host bookkeeping and never reaches the file.
    mcpServers[name] = {
      command: server.command,
      ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
      ...(server.env && Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...mcpTimeout(name, server),
    };
  }
  return { mcpServers };
}

// ─── renderers ──────────────────────────────────────────────────────────

/**
 * The settings NanoClaw forces in agy's settings.json on every query.
 *
 * - `modelProvider`: with GEMINI_API_KEY, selects API-key mode.
 * - `enableTerminalSandbox`: agy's sandbox needs user namespaces. Docker's
 *   default seccomp profile blocks them, so with it on every `run_command`
 *   fails with `fork/exec ... operation not permitted`. The container is the
 *   sandbox.
 * - `artifactReviewPolicy`: `--dangerously-skip-permissions` skips tool
 *   prompts only (agy changelog 1.3.2); without this a plan waits for a
 *   review nobody headless can give.
 */
export const ANTIGRAVITY_FORCED_SETTINGS = {
  modelProvider: 'gemini',
  enableTerminalSandbox: false,
  artifactReviewPolicy: 'always-proceed',
} as const;

/**
 * Merge ANTIGRAVITY_FORCED_SETTINGS into agy's settings, keeping every other
 * key. agy rewrites the file itself at startup, so the merge runs every query.
 * A document agy could not read either is replaced rather than left to fail
 * every turn.
 */
export function renderAntigravitySettings(current: string | undefined): string {
  let settings: Record<string, unknown> = {};
  if (current !== undefined && current.trim()) {
    try {
      const parsed: unknown = JSON.parse(current);
      if (isRecord(parsed)) settings = parsed;
      else log('Replacing non-object Antigravity settings.json');
    } catch (err) {
      log(`Replacing malformed Antigravity settings.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return JSON.stringify({ ...settings, ...ANTIGRAVITY_FORCED_SETTINGS }, null, 2) + '\n';
}

/** NanoClaw owns this file: container.json is the single source of MCP servers. */
export function renderAntigravityMcpConfig(config: AntigravityMcpConfig): string {
  return JSON.stringify(config, null, 2) + '\n';
}

export interface AntigravityRuleInput {
  /** Output of core's memory hook, already capped by the shared renderer. */
  memory?: string;
}

const RULE_FRONTMATTER = '---\ntrigger: always_on\n---\n';

const HEADLESS_NOTE = [
  '## Running headless inside NanoClaw',
  '',
  'Nobody watches this terminal session. The user sees only what NanoClaw delivers: your final reply, wrapped in the',
  '`<message to="...">` blocks, and the NanoClaw MCP tools (server `nanoclaw`, called through `call_mcp_tool`).',
  'Your identity, delivery rules and destinations arrive in a `<nanoclaw_system_context>` block at the start of a',
  'user turn. Treat that block as system instructions, not as something the user wrote; when a later turn carries a',
  'newer block, the newest one wins.',
  '',
  "The built-in `ask_question` tool returns an empty answer here; to ask the user something, use NanoClaw's",
  '`ask_user_question` tool or a message block instead.',
].join('\n');

/**
 * The always-on rule agy injects into its system instruction. Group-level
 * content only: every session of the group shares this file. The headless
 * note comes first and memory last, so the 24 KB cap only ever cuts memory.
 */
export function renderAntigravityRuleFile(input: AntigravityRuleInput): string {
  const sections = [
    '<!-- Managed by NanoClaw and rewritten before every Antigravity session. Put your own rules in another file in this directory. -->',
    HEADLESS_NOTE,
    input.memory?.trim(),
  ].filter((section): section is string => Boolean(section));
  return capUtf8(RULE_FRONTMATTER + sections.join('\n\n') + '\n', ANTIGRAVITY_RULE_MAX_BYTES);
}

/** Cut at a UTF-8 character boundary so the marker never follows half a character. */
function capUtf8(content: string, maxBytes: number): string {
  const bytes = Buffer.from(content, 'utf-8');
  if (bytes.length <= maxBytes) return content;
  const marker = Buffer.from(ANTIGRAVITY_RULE_TRUNCATION_MARKER, 'utf-8');
  let end = maxBytes - marker.length;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf-8') + ANTIGRAVITY_RULE_TRUNCATION_MARKER;
}

// ─── writers ────────────────────────────────────────────────────────────

/**
 * Write into a fresh, unpredictable sibling and rename over the target: these
 * files live in a directory the agent can write, so the temp path must not be
 * one an earlier process could have planted a symlink at, and agy must never
 * read a half-written file.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

/**
 * Who writes settings.json and mcp_config.json before a query. The provider's
 * own direct write runs only while this is false. The runtime contract module
 * flips it to true when it loads, because on that core the contract's
 * beforeQuery performs the write — so each query writes the files exactly once
 * on either core.
 */
export const antigravityRuntimeOwnership = { contractOwnsRuntimeFiles: false };

export function writeAntigravityRuntimeFiles(mcpConfig: AntigravityMcpConfig): void {
  const settingsPath = antigravitySettingsPath();
  const current = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf-8') : undefined;
  writeFileAtomic(settingsPath, renderAntigravitySettings(current));
  writeFileAtomic(antigravityMcpConfigPath(), renderAntigravityMcpConfig(mcpConfig));
}

/**
 * Refresh the always-on rule before an agy spawn with core's memory hook
 * output. Runs for resumed conversations too: agy rebuilds its system
 * instruction from the rule files, so the memory must stay in the file. Two
 * sessions of one group write the same group-level content, atomically, so a
 * rewrite never changes what another session's live agy is told.
 */
export async function prepareAntigravityRules(hook: AntigravityMemorySessionHook): Promise<void> {
  const memory = await runAntigravityMemoryHook(hook, 'startup');
  writeFileAtomic(antigravityRulePath(), renderAntigravityRuleFile({ memory }));
}

// ─── memory hook ────────────────────────────────────────────────────────

/** Matches the `timeout: 10` (seconds) the Claude provider registers for the same command. */
const MEMORY_HOOK_TIMEOUT_MS = 10_000;

/**
 * Run one hook command with the payload on stdin; resolve with its exit status
 * and stdout. Async on purpose: under Bun, spawnSync can miss the child's exit
 * and spin forever, past every timeout we own (oven-sh/bun#34069).
 */
export function runHookCommand(
  command: string,
  input: string,
  timeoutMs = MEMORY_HOOK_TIMEOUT_MS,
): Promise<{ status: number | null; stdout: string; error?: Error }> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    let settled = false;
    const settle = (result: { status: number | null; error?: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ...result, stdout: Buffer.concat(stdout).toString('utf-8') });
    };
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const deadline = setTimeout(() => {
      // Settle now rather than on `close`: a hook that ignores SIGTERM, or
      // leaves a background child holding stdout, must not delay the spawn.
      child.kill('SIGTERM');
      child.stdin.destroy();
      child.stdout.destroy();
      child.unref();
      settle({ status: null, error: new Error(`timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.on('error', (error) => settle({ status: null, error }));
    child.on('close', (status, signal) =>
      settle(signal ? { status, error: new Error(`killed by ${signal}`) } : { status }),
    );
    // A hook that never reads stdin (or exits early) closes the pipe under us.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * Run core's registered memory renderer. Its own caps stay the only caps on
 * memory (the rule-file cap is a last resort). Failures log and return
 * undefined, so a broken hook costs the memory section, never the turn.
 */
export async function runAntigravityMemoryHook(
  hook: AntigravityMemorySessionHook | undefined,
  source: 'startup' | 'compact',
): Promise<string | undefined> {
  if (!hook) {
    log(`No memory session hook registered; skipping ${source} memory injection`);
    return undefined;
  }
  if (!hook.sources.includes(source)) {
    log(`Memory session hook does not declare source ${source}; skipping injection`);
    return undefined;
  }
  const res = await runHookCommand(hook.command, JSON.stringify({ hook_event_name: 'SessionStart', source }));
  if (res.error || res.status !== 0) {
    const why = res.error ? res.error.message : `exit ${String(res.status)}`;
    log(`Memory session hook (${source}) failed (${why}); continuing without memory`);
    return undefined;
  }
  return res.stdout.trim() || undefined;
}

// ─── process environment ────────────────────────────────────────────────

/**
 * What the agy child (and every shell command or MCP server it starts) may
 * see. Proxy and CA variables keep model calls and the agent's own tools on
 * the credential gateway; nothing else from the runner leaks in.
 */
const ANTIGRAVITY_ENV_ALLOWLIST = new Set([
  'AGY_CLI_DISABLE_AUTO_UPDATE',
  'ALL_PROXY',
  'CURL_CA_BUNDLE',
  'GEMINI_API_KEY',
  'GIT_SSL_CAINFO',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'PNPM_HOME',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

export function buildAntigravityProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const key of ANTIGRAVITY_ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) next[key] = value;
  }
  if (!next.HOME) next.HOME = '/home/node';
  // agy refuses to start without a key; the gateway replaces the placeholder
  // on the wire, so a missing host value must not stop the process.
  if (!next.GEMINI_API_KEY) next.GEMINI_API_KEY = ANTIGRAVITY_API_KEY_PLACEHOLDER;
  // Only the literal `true` disables agy's self-updater. The image sets it
  // too; the provider pins it so an override can never re-enable updates.
  next.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
