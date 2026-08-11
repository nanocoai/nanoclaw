import { readTextNoFollow, writeTextAtomic } from './fs-hygiene.js';
import { log } from './log.js';

const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';
const LEGACY_MEMORY_SESSION_START_COMMAND = 'bun /app/src/memory-hook.ts';

/** Reconcile existing Claude settings with NanoClaw's shared memory system. */
export function migrateClaudeMemorySettings(settingsFile: string): boolean {
  try {
    // Claude's own settings file, in a directory Claude also writes. Read the
    // name we were handed; anything that is not a readable regular file there
    // is simply nothing to reconcile.
    const raw = readTextNoFollow(settingsFile);
    if (raw === null) return false;

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      log.warn('Claude settings root is not an object; leaving it unchanged', { settingsFile });
      return false;
    }

    let changed = false;
    if (parsed.autoMemoryEnabled !== false) {
      parsed.autoMemoryEnabled = false;
      changed = true;
    }

    const env = isRecord(parsed.env) ? parsed.env : {};
    if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1') {
      env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      changed = true;
    }
    if (parsed.env !== env) {
      parsed.env = env;
      changed = true;
    }

    const hooks = isRecord(parsed.hooks) ? parsed.hooks : {};
    const existingSessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    const nextSessionStart = existingSessionStart
      .map(removeLegacyNanoClawMemoryHook)
      .filter((entry) => entry !== undefined);
    if (JSON.stringify(nextSessionStart) !== JSON.stringify(existingSessionStart)) {
      if (nextSessionStart.length > 0) hooks.SessionStart = nextSessionStart;
      else delete hooks.SessionStart;
      changed = true;
    }

    const preCompact = Array.isArray(hooks.PreCompact) ? hooks.PreCompact : [];
    if (!JSON.stringify(preCompact).includes(PRE_COMPACT_COMMAND)) {
      preCompact.push({ hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }] });
      hooks.PreCompact = preCompact;
      changed = true;
    }
    if (parsed.hooks !== hooks) {
      parsed.hooks = hooks;
      changed = true;
    }

    if (!changed) return false;
    writeTextAtomic(settingsFile, JSON.stringify(parsed, null, 2) + '\n');
    return true;
  } catch (err) {
    log.warn('Failed to reconcile Claude settings; leaving them unchanged', {
      settingsFile,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function removeLegacyNanoClawMemoryHook(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return value;
  const remaining = value.hooks.filter((hook) => {
    if (!isRecord(hook)) return true;
    return hook.command !== LEGACY_MEMORY_SESSION_START_COMMAND;
  });
  return remaining.length > 0 ? { ...value, hooks: remaining } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
