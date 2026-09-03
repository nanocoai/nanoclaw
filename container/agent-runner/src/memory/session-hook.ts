import { renderMemorySection } from './context.js';

const MEMORY_CONTEXT_SOURCES = ['startup', 'clear', 'compact'] as const;

export type MemorySessionHookSource = (typeof MEMORY_CONTEXT_SOURCES)[number];
export type MemorySessionStartSource = MemorySessionHookSource | 'resume';

export interface MemorySessionHookRegistration {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly MemorySessionHookSource[];
}

export const MEMORY_SESSION_HOOK: MemorySessionHookRegistration = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: MEMORY_CONTEXT_SOURCES,
};

/** Return memory only when a provider is establishing a new context window. */
export function memoryContextForSessionStart(source: MemorySessionStartSource, baseDir?: string): string | undefined {
  return source === 'resume' ? undefined : renderMemorySection(baseDir);
}
