/**
 * Stop and remove every runtime container of one agent group, matched by the
 * install label plus the group label the driver stamps on the session
 * container and its per-session auxiliaries. `ps -a` also catches containers
 * that exited without being auto-removed. A successful `rm --force` proves
 * removal; otherwise a failed stop or rm counts only if the runtime still
 * lists a container for the group afterwards.
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
  /** Listed ids the runtime no longer lists afterwards. */
  stopped: string[];
  /**
   * Ids the runtime still lists for the group after the stop and rm, which can
   * include one that appeared after the first listing. When that re-list
   * itself fails, every listed id counts as a survivor.
   */
  survivors: string[];
  /** Human-readable failures, one per step that did not succeed. Empty on a clean run. */
  failures: string[];
}

export type ListGroupContainersResult = { ok: true; ids: string[] } | { ok: false; failure: string };

/** List the group's container ids (`ps -a`, install + group labels). Never throws. */
export function listGroupContainers(options: StopGroupContainersOptions): ListGroupContainersResult {
  const { runtime, installSlug, agentGroupId, runner } = options;
  const listed = runner.tryRun(
    runtime,
    [
      'ps',
      '-aq',
      '--filter',
      `label=nanoclaw-install=${installSlug}`,
      '--filter',
      `label=nanoclaw-group=${agentGroupId}`,
    ],
    undefined,
    { timeoutMs: CUTOVER_STOP_CLI_TIMEOUT_MS },
  );
  if (!listed.ok) return { ok: false, failure: `${runtime} ps failed: ${listed.stdout || 'no output'}` };
  return { ok: true, ids: listed.stdout.split('\n').filter(Boolean) };
}

export function stopGroupContainers(options: StopGroupContainersOptions): StopGroupContainersResult {
  const { runtime, runner } = options;
  const listed = listGroupContainers(options);
  if (!listed.ok) return { listed: [], stopped: [], survivors: [], failures: [listed.failure] };
  const ids = listed.ids;
  if (ids.length === 0) return { listed: ids, stopped: [], survivors: [], failures: [] };

  const stopped = runner.tryRun(runtime, ['stop', '-t', String(CUTOVER_STOP_GRACE_SECONDS), ...ids], undefined, {
    timeoutMs: CUTOVER_STOP_CLI_TIMEOUT_MS,
  });
  // `--rm` sessions vanish on stop, so rm usually reports "No such container".
  // A successful `rm --force` has removed every id, whatever the stop did;
  // otherwise only what the runtime still lists afterwards matters.
  const removed = runner.tryRun(runtime, ['rm', '--force', ...ids], undefined, {
    timeoutMs: CUTOVER_STOP_CLI_TIMEOUT_MS,
  });
  if (removed.ok) return { listed: ids, stopped: ids, survivors: [], failures: [] };

  const failures: string[] = [];
  if (!stopped.ok) failures.push(`${runtime} stop failed: ${stopped.stdout || 'no output'}`);
  if (!removed.ok) failures.push(`${runtime} rm failed: ${removed.stdout || 'no output'}`);
  const remaining = listGroupContainers(options);
  if (!remaining.ok) return { listed: ids, stopped: [], survivors: ids, failures: [...failures, remaining.failure] };
  const survivors = remaining.ids;
  const gone = ids.filter((id) => !survivors.includes(id));
  if (survivors.length === 0) return { listed: ids, stopped: gone, survivors, failures: [] };
  failures.push(`still listed: ${survivors.join(', ')}`);
  return { listed: ids, stopped: gone, survivors, failures };
}
