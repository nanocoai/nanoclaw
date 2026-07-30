import fs from 'fs';

import { MEMORY_SESSION_HOOK, memoryContextForSessionStart, type MemorySessionStartSource } from './session-hook.js';

function readSource(): MemorySessionStartSource | undefined {
  try {
    const input: unknown = JSON.parse(fs.readFileSync(0, 'utf-8'));
    if (!input || typeof input !== 'object' || !('source' in input)) return undefined;
    const source = input.source;
    const validSources: readonly unknown[] = [...MEMORY_SESSION_HOOK.sources, 'resume'];
    if (validSources.includes(source)) {
      return source as MemorySessionStartSource;
    }
  } catch {
    // Invalid hook input fails closed: no additional context is emitted.
  }
  return undefined;
}

const source = readSource();
const context = source ? memoryContextForSessionStart(source, process.argv[2]) : undefined;
if (context) console.log(context);
