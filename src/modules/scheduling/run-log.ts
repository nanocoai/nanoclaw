/**
 * Task-series run log — one host-timestamped line per event, at
 * `<GROUPS_DIR>/<group folder>/tasks/<series>.md`.
 *
 * Two writers, one format:
 *   - `ncl tasks append-log` (agent's explicit mid-run/work-log entry)
 *   - the `task_log` outbound row a task run's final text produces
 *     (container/agent-runner poll-loop auto-append; delivery.ts routes it here)
 */
import path from 'path';

import { AnchoredDir } from '../../anchored-dir.js';
import { GROUPS_DIR } from '../../config.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { formatLocalStamp } from '../../timezone.js';

// The group folder is mounted read-write into the container, so the container
// owns the `tasks` dir and the `<series>.md` leaf below it. Reach them through
// an AnchoredDir anchored at the host-owned group folder: `tasks` is opened
// refusing a symlink, and the append/unlink go through that descriptor and
// O_NOFOLLOW, so a symlink planted at `tasks` or the leaf cannot redirect the
// host outside the group folder (CWE-59). The charset guard stays as traversal
// defence in depth.

export async function appendRunLog(
  agentGroupId: string,
  series: string,
  msg: string,
): Promise<{ series: string; timestamp: string; path: string }> {
  if (!/^[a-z0-9-]+$/.test(series)) throw new Error(`invalid task id: ${series}`);
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) throw new Error(`agent group not found: ${agentGroupId}`);

  const timestamp = formatLocalStamp(new Date(), await resolveGroupTimezone(agentGroupId));
  const groupDir = path.join(GROUPS_DIR, ag.folder);
  const tasks = AnchoredDir.open(groupDir, ['tasks'], true);
  if (!tasks) throw new Error(`could not open tasks dir for group ${ag.folder}`);
  try {
    tasks.appendFile(`${series}.md`, `${timestamp} — ${msg}\n`);
  } finally {
    tasks.close();
  }
  return { series, timestamp, path: path.join(groupDir, 'tasks', `${series}.md`) };
}

/** Last `lines` lines of a series' run log, newest last. [] if absent or unsafe. */
export async function readRunLogTail(agentGroupId: string, series: string, lines = 10): Promise<string[]> {
  if (!/^[a-z0-9-]+$/.test(series)) return [];
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) return [];

  let tasks: AnchoredDir | null = null;
  try {
    tasks = AnchoredDir.open(path.join(GROUPS_DIR, ag.folder), ['tasks']);
    if (!tasks) return [];
    // readFile refuses a symlinked leaf / non-regular file; a symlinked `tasks`
    // was already refused at open. Either way: no log rather than a host read.
    const text = tasks.readFile(`${series}.md`).toString('utf8');
    return text.trimEnd().split('\n').filter(Boolean).slice(-lines);
  } catch {
    return [];
  } finally {
    tasks?.close();
  }
}

export async function deleteRunLog(agentGroupId: string, series: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(series)) throw new Error(`invalid task id: ${series}`);
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) throw new Error(`agent group not found: ${agentGroupId}`);

  // Best-effort, like the old force-unlink: a missing dir/file or a refused
  // (symlinked) tasks dir leaves nothing to do rather than throwing.
  let tasks: AnchoredDir | null = null;
  try {
    tasks = AnchoredDir.open(path.join(GROUPS_DIR, ag.folder), ['tasks']);
    tasks?.unlink(`${series}.md`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('run-log: skipped delete of unsafe or missing run log', { series, err });
    }
  } finally {
    tasks?.close();
  }
}
