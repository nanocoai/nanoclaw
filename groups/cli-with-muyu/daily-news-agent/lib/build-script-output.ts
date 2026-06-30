import type { FetchPayload, NewsItem, ScriptResult } from './types.js';

export function buildScriptOutput(
  items: NewsItem[],
  errors: FetchPayload['errors'],
  timezone: string,
  windowHours: number,
  now: Date,
): ScriptResult {
  const wakeAgent = items.length > 0;

  if (!wakeAgent) {
    return { wakeAgent: false };
  }

  return {
    wakeAgent: true,
    data: {
      fetchedAt: now.toISOString(),
      timezone,
      windowHours,
      items,
      errors,
    },
  };
}

export function serializeScriptLine(result: ScriptResult): string {
  return JSON.stringify(result);
}
