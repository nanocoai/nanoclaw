import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  resolveClaudeExecutionPolicy,
  resolveClaudeInference,
  resolveClaudeMcpServers,
  resolveClaudeMemoryRuntime,
} from '../providers/claude-config.js';
import { claudeConfigDirectory, newestClaudeTranscript } from '../providers/claude-history.js';

import { registerProviderContract } from '../providers/provider-registry.js';
import {
  PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  type ProviderRuntimeContract,
  type RuntimeMemoryHookInput,
} from './registry.js';

const provider = 'claude';
// Claude Code's own default output style. With a named style (such as Concise) Claude Code adds a style message to every
// request, and the conversation is then not read back from the prompt cache: each request writes it to the cache again.
// The concise instruction is in the agent's CLAUDE.md (container/CLAUDE.md, Communication), in the cached prefix.
const tone = { default: 'default', toSettings: (tone: string) => ({ outputStyle: tone }) };

export const claudeRuntimeContract: ProviderRuntimeContract = {
  seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  configuration: {
    // Claude's stance is fixed — the container and the OneCLI allow-list are
    // the boundary — so it is declared as the constant it is.
    executionPolicy: { constant: resolveClaudeExecutionPolicy() },
    inference: resolveClaudeInference,
    tone,
    // The memory runtime env is likewise fixed: auto-memory stays off whatever
    // hook core registers, so it is a constant, not a function of the hook.
    memory: { constant: resolveClaudeMemoryRuntime() },
    mcpServers: resolveClaudeMcpServers,
  },
  lifecycle: { memorySessionHookRegistration: writeMemorySessionHook },
  // Pre-compact archiving and continuation rotation are provider-internal
  // (providers/claude-history.ts); core only needs the trace lookup.
  history: { readTrace: newestClaudeTranscript },
  textDelivery: 'mid-turn-complete',
  // Aliases are listed with their command, as in the host contract.
  commands: {
    formatting: 'native',
    nativeAdmin: [
      '/remote-control',
      '/rc',
      '/compact',
      '/context',
      '/cost',
      '/usage',
      '/stats',
      '/files',
      '/reset',
      '/new',
    ],
    nativeFiltered: ['/help', '/login', '/logout', '/doctor', '/checkup', '/config', '/settings', '/start'],
  },
};

registerProviderContract(provider, claudeRuntimeContract);

function writeMemorySessionHook(hook: RuntimeMemoryHookInput): void {
  const filePath = path.join(claudeConfigDirectory(), 'settings.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = readSettingsFile(filePath);
  if (text === null) return;
  const parsed: unknown = text === undefined ? {} : JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${filePath} must contain a JSON object`);

  const hooks = parsed.hooks === undefined ? {} : parsed.hooks;
  if (!isRecord(hooks)) throw new Error(`${filePath} hooks must be a JSON object`);

  const sessionStart = hooks.SessionStart === undefined ? [] : hooks.SessionStart;
  if (!Array.isArray(sessionStart)) throw new Error(`${filePath} hooks.SessionStart must be an array`);

  const memoryCommands = new Set([hook.command, ...hook.legacyCommands]);
  const nextSessionStart = sessionStart
    .map((entry) => removeMemoryCommands(entry, memoryCommands))
    .filter((entry) => entry !== undefined);
  nextSessionStart.push({
    matcher: hook.sources.join('|'),
    hooks: [{ type: 'command', command: hook.command, timeout: 10 }],
  });

  hooks.SessionStart = nextSessionStart;
  parsed.hooks = hooks;
  // Seed user defaults; existing values and higher-priority project/local settings win.
  const settings = { ...tone.toSettings(tone.default), ...parsed };
  const next = JSON.stringify(settings, null, 2) + '\n';
  if (next !== text) replaceFile(filePath, next);
}

// settings.json lives in the group's persistent, agent-writable .claude dir,
// shared by every session of the group. Read it the way the host's
// prepareClaudeMemorySettings does: O_NOFOLLOW refuses a symlink, and
// O_NONBLOCK + the isFile check refuse a FIFO that would otherwise block
// startup forever. A refused entry is logged and left alone, as on the host,
// so the session still starts (without the memory hook).
const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = fs.constants;

/** The file's text, `undefined` when absent, or `null` when refused. */
function readSettingsFile(filePath: string): string | undefined | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP' || code === 'EISDIR') return refuse(filePath);
    throw err;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return refuse(filePath);
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function refuse(filePath: string): null {
  console.error(
    `[claude] Not registering the memory hook: ${filePath} is not a regular file. Remove it so it can be recreated.`,
  );
  return null;
}

/** Write a sibling temp file and rename it over the name: never truncate in place or write through a link. */
function replaceFile(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function removeMemoryCommands(value: unknown, commands: ReadonlySet<string>): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const hooks = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return typeof hook.command !== 'string' || !commands.has(hook.command);
  });
  return hooks.length > 0 ? { ...value, hooks } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
