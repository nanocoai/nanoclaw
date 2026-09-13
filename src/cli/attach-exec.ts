/**
 * Attach-exec decision logic, extracted pure from the ncl client entry
 * point so it is testable: which responses are attach responses, and what
 * argv the client (which owns the terminal) should exec for them.
 */
import type { ResponseFrame } from './frame.js';

export interface AttachExecSpec {
  bin: string;
  argsTty: string[];
  argsPlain: string[];
}

export function isAttachResponse(data: unknown): data is { attachExec: AttachExecSpec } {
  if (typeof data !== 'object' || data === null) return false;
  const exec = (data as { attachExec?: unknown }).attachExec;
  return (
    typeof exec === 'object' &&
    exec !== null &&
    typeof (exec as { bin?: unknown }).bin === 'string' &&
    Array.isArray((exec as { argsTty?: unknown }).argsTty) &&
    Array.isArray((exec as { argsPlain?: unknown }).argsPlain)
  );
}

/**
 * Undefined = not an attach response (or --json, which must print the
 * frame, never hand over the terminal). Otherwise the exact argv to exec.
 */
export function resolveAttachExec(
  res: ResponseFrame,
  json: boolean,
  stdinIsTty: boolean,
): { bin: string; args: string[] } | undefined {
  if (json || !res.ok || !isAttachResponse(res.data)) return undefined;
  const { bin, argsTty, argsPlain } = res.data.attachExec;
  return { bin, args: stdinIsTty ? argsTty : argsPlain };
}

/**
 * Warnings a verb attached to its response for the client to print before
 * the terminal is handed over (an attach response prints nothing else).
 * Only an array of non-empty strings counts; anything else is no warnings.
 */
export function attachWarnings(res: ResponseFrame): string[] {
  if (!res.ok || typeof res.data !== 'object' || res.data === null) return [];
  const warnings = (res.data as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((w): w is string => typeof w === 'string' && w.trim().length > 0);
}
