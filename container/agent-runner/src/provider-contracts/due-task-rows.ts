/**
 * Generic seam: a provider may own a due task batch.
 * Core does not name a product, a fallback, or a log prefix.
 * Absent registration keeps the historical runner task log.
 */
import type { MessageInRow } from '../db/messages-in.js';

export const DUE_TASK_ROW_SEAM = 1;

export type DueTaskRowPolicy = 'runner-log' | 'provider';

/**
 * Opaque per-batch state. `begin` returns null when this batch stays on the
 * runner's historical path, including `autoAppendTaskLog`. A non-null return
 * means the provider owns the batch: the poll loop skips the task log, awaits
 * the decision hooks, and the outer failure path stays log-only.
 */
export interface DueTaskRowHooks {
  begin(batch: MessageInRow[]): unknown | null;
  noteFollowUpRows(turn: unknown, rows: MessageInRow[]): void | Promise<void>;
  onErrorEvent(turn: unknown, text: string | null): void | Promise<void>;
  onResultEvent(turn: unknown): void | Promise<void>;
  decideResult(turn: unknown, undeliveredVisible: string | null, sanitizeFailed: boolean): void | Promise<void>;
  decideError(turn: unknown, text: string): void | Promise<void>;
  markHandled(turn: unknown): void | Promise<void>;
  isHandled(turn: unknown): boolean;
  finish(turn: unknown): void | Promise<void>;
}

const hooksByProvider = new Map<string, DueTaskRowHooks>();

export function registerDueTaskRowHooks(providerName: string, hooks: DueTaskRowHooks): void {
  if (hooksByProvider.has(providerName)) {
    throw new Error(`Due task row hooks already registered: ${providerName}`);
  }
  hooksByProvider.set(providerName, hooks);
}

export function dueTaskRowHooksFor(providerName: string): DueTaskRowHooks | undefined {
  return hooksByProvider.get(providerName);
}
