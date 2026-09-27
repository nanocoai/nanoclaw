export interface TaskContent {
  prompt: string;
  script: string | null;
  originSessionId: string | null;
  /**
   * Opt-in, default false. When true, each occurrence of the series starts a
   * fresh agent conversation instead of resuming the previous one. Recurring
   * task sessions are never closed (a live series always has a next
   * occurrence), so without this every fire resumes — and re-sends — every
   * prior run's transcript.
   */
  freshSession: boolean;
}

/** Decode the storage-neutral task content envelope. */
export function parseTaskContent(raw: string): TaskContent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      script: typeof parsed.script === 'string' ? parsed.script : null,
      originSessionId: typeof parsed.originSessionId === 'string' ? parsed.originSessionId : null,
      freshSession: parsed.freshSession === true,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- LEGACY-COMPAT(v1-tasks): plain-string content predating the JSON envelope
  } catch {
    return { prompt: raw, script: null, originSessionId: null, freshSession: false };
  }
}
