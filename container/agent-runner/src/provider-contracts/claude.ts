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

export const claudeRuntimeContract: ProviderRuntimeContract = {
  seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  configuration: {
    // Claude's stance is fixed — the container and the OneCLI allow-list are
    // the boundary — so it is declared as the constant it is.
    executionPolicy: { constant: resolveClaudeExecutionPolicy() },
    inference: resolveClaudeInference,
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
  commands: {
    formatting: 'native',
    nativeAdmin: ['/remote-control', '/compact', '/context', '/cost', '/files'],
    nativeFiltered: ['/help', '/login', '/logout', '/doctor', '/config', '/start'],
  },
};

registerProviderContract(provider, claudeRuntimeContract);

function writeMemorySessionHook(hook: RuntimeMemoryHookInput): void {
  const filePath = path.join(claudeConfigDirectory(), 'settings.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const exists = fs.existsSync(filePath);
  const parsed: unknown = exists ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : {};
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
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n');
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
