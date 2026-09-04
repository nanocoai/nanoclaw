/**
 * Cursor sessionStart / preCompact hook adapter.
 *
 * Cursor hooks speak JSON on stdin/stdout. NanoClaw's shared memory hook
 * prints plain text. This wrapper maps Cursor's lifecycle events onto
 * `memoryContextForSessionStart` and returns `{ additional_context }`.
 *
 * Invoked as: `bun /app/src/providers/cursor-hook.ts` (sessionStart)
 *         or: `bun /app/src/providers/cursor-hook.ts --compact` (preCompact)
 */
import fs from 'fs';

import { memoryContextForSessionStart, type MemorySessionStartSource } from '../memory/session-hook.js';

export function resolveSource(argv: string[], stdin: string): MemorySessionStartSource {
  if (argv.includes('--compact')) return 'compact';
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (parsed && typeof parsed === 'object' && 'source' in parsed) {
      const source = (parsed as { source?: unknown }).source;
      if (source === 'compact' || source === 'clear' || source === 'startup' || source === 'resume') {
        return source;
      }
    }
  } catch {
    /* Cursor sessionStart has no `source` field — treat as a new window. */
  }
  return 'startup';
}

export function hookPayload(source: MemorySessionStartSource, baseDir?: string): { additional_context?: string } {
  const context = memoryContextForSessionStart(source, baseDir);
  return context ? { additional_context: context } : {};
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

if (import.meta.main) {
  const source = resolveSource(process.argv.slice(2), readStdin());
  process.stdout.write(JSON.stringify(hookPayload(source)) + '\n');
}
