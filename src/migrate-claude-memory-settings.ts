import path from 'path';

import { AnchoredDir } from './anchored-dir.js';
import { log } from './log.js';
import type { ProviderFileDiagnostic, ProviderFileTransformer } from './provider-contracts/registry.js';

const CLAUDE_SETTINGS_FILE = 'settings.json';
const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';
const LEGACY_MEMORY_SESSION_START_COMMAND = 'bun /app/src/memory-hook.ts';

export const CLAUDE_DEFAULT_SETTINGS =
  JSON.stringify(
    {
      autoMemoryEnabled: false,
      env: {
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      },
      hooks: {
        PreCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: PRE_COMPACT_COMMAND,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n';

/**
 * Seed or reconcile `settings.json` in the Claude state directory. The
 * directory is a read-write mount, so the file is reached through the
 * directory's descriptor: a symlink or FIFO planted under its name is refused
 * and the settings are left alone. Returns what was done.
 */
export function prepareClaudeMemorySettings(claudeDir: string): 'created' | 'reconciled' | 'unchanged' {
  const settingsFile = path.join(claudeDir, CLAUDE_SETTINGS_FILE);
  let dir: AnchoredDir | null = null;
  try {
    dir = AnchoredDir.open(claudeDir, [], true);
    if (!dir) throw new Error(`Claude settings directory is missing: '${claudeDir}'`);
    let current: string;
    try {
      current = dir.readFile(CLAUDE_SETTINGS_FILE).toString('utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      dir.writeNewFile(CLAUDE_SETTINGS_FILE, Buffer.from(CLAUDE_DEFAULT_SETTINGS));
      return 'created';
    }
    const result = claudeSettingsTransformer.transform(current, settingsFile);
    emitDiagnostics(result.diagnostics);
    if (result.kind === 'unchanged') return 'unchanged';
    dir.replaceFile(CLAUDE_SETTINGS_FILE, result.content);
    return 'reconciled';
  } catch (err) {
    emitDiagnostic(claudeSettingsTransformer.mapIoFailure(err, settingsFile));
    return 'unchanged';
  } finally {
    dir?.close();
  }
}

export const claudeSettingsTransformer: ProviderFileTransformer = {
  transform(current, settingsFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch (err) {
      return {
        kind: 'unchanged',
        diagnostics: [failedDiagnostic(err, settingsFile)],
      };
    }
    if (!isRecord(parsed)) {
      return {
        kind: 'unchanged',
        diagnostics: [
          {
            level: 'warn',
            message: 'Claude settings root is not an object; leaving it unchanged',
            fields: { settingsFile },
          },
        ],
      };
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

    return changed ? { kind: 'replace', content: JSON.stringify(parsed, null, 2) + '\n' } : { kind: 'unchanged' };
  },
  mapIoFailure: failedDiagnostic,
};

function failedDiagnostic(err: unknown, settingsFile: string): ProviderFileDiagnostic {
  return {
    level: 'warn',
    message: 'Failed to reconcile Claude settings; leaving them unchanged',
    fields: {
      settingsFile,
      error: err instanceof Error ? err.message : String(err),
    },
  };
}

function emitDiagnostics(diagnostics: readonly ProviderFileDiagnostic[] | undefined): void {
  for (const diagnostic of diagnostics ?? []) emitDiagnostic(diagnostic);
}

function emitDiagnostic(diagnostic: ProviderFileDiagnostic): void {
  log[diagnostic.level](diagnostic.message, diagnostic.fields);
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
