/**
 * Stop and remove every runtime container of one agent group, matched by the
 * install label plus the group label the driver stamps on the session
 * container and its per-session auxiliaries. `ps -a` also catches containers
 * that exited without being auto-removed. A failed stop or rm counts only if
 * the runtime still lists a container for the group afterwards.
 *
 * Never throws: an unreachable daemon or missing runtime binary is returned as
 * a failure for the caller to report.
 */
import { CUTOVER_STOP_CLI_TIMEOUT_MS, CUTOVER_STOP_GRACE_SECONDS, type CommandRunner } from './service.js';

export interface StopGroupContainersOptions {
  runtime: string;
  installSlug: string;
  agentGroupId: string;
  runner: CommandRunner;
}

export interface StopGroupContainersResult {
  /** Container ids the runtime listed for the group (possibly none). */
  listed: string[];
  /** Human-readable failures, one per step that did not succeed. Empty on a clean run. */
  failures: string[];
}

export function stopGroupContainers(options: StopGroupContainersOptions): StopGroupContainersResult {
  const { runtime, installSlug, agentGroupId, runner } = options;
  const filters = [
    '--filter',
    `label=nanoclaw-install=${installSlug}`,
    '--filter',
    `label=nanoclaw-group=${agentGroupId}`,
  ];
  const listed = runner.tryRun(runtime, ['ps', '-aq', ...filters], undefined, {
    timeoutMs: CUTOVER_STOP_CLI_TIMEOUT_MS,
  });
  if (!listed.ok) {
    return { listed: [], failures: [`${runtime} ps failed: ${listed.stdout || 'no output'}`] };
  }
  const ids = listed.stdout.split('\n').filter(Boolean);
  if (ids.length === 0) return { listed: ids, failures: [] };

  const stopped = runner.tryRun(runtime, ['stop', '-t', String(CUTOVER_STOP_GRACE_SECONDS), ...ids], undefined, {
    timeoutMs: CUTOVER_STOP_CLI_TIMEOUT_MS,
  });
  // `--rm` sessions vanish on stop, so rm usually reports "No such container".
  // Only what the runtime still lists afterwards matters.
  const removed = runner.tryRun(runtime, ['rm', '--force', ...ids], undefined, {
    timeoutMs: CUTOVER_STOP_CLI_TIMEOUT_MS,
  });
  if (stopped.ok && removed.ok) return { listed: ids, failures: [] };

  const remaining = runner.tryRun(runtime, ['ps', '-aq', ...filters], undefined, {
    timeoutMs: CUTOVER_STOP_CLI_TIMEOUT_MS,
  });
  if (!remaining.ok) return { listed: ids, failures: [`${runtime} ps failed: ${remaining.stdout || 'no output'}`] };
  const survivors = remaining.stdout.split('\n').filter(Boolean);
  if (survivors.length === 0) return { listed: ids, failures: [] };
  const failures: string[] = [];
  if (!stopped.ok) failures.push(`${runtime} stop failed: ${stopped.stdout || 'no output'}`);
  if (!removed.ok) failures.push(`${runtime} rm failed: ${removed.stdout || 'no output'}`);
  failures.push(`still listed: ${survivors.join(', ')}`);
  return { listed: ids, failures };
}
