import type { FallbackState } from './db.js';

/**
 * Pure decision: which provider should actually run, given a group's native
 * provider and the current fallback state.
 *
 * Identity (native wins) when: fallback isn't active, a return probe is in
 * flight (the probe session must actually try the native provider), no
 * backup provider is configured, or the group's native provider already
 * *is* the backup (nothing to override).
 */
export function effectiveProvider(native: string, state: FallbackState): string {
  if (!state.active || state.probing || !state.backupProvider) return native;
  if (native === state.backupProvider) return native;
  return state.backupProvider;
}
