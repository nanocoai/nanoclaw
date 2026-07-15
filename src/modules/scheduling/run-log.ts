/**
 * Task-series run log — one host-timestamped line per event, at
 * `<GROUPS_DIR>/<group folder>/tasks/<series>.md`.
 *
 * Two writers, one format:
 *   - `ncl tasks append-log` (agent's explicit mid-run/work-log entry)
 *   - the `task_log` outbound row a task run's final text produces
 *     (container/agent-runner poll-loop auto-append; delivery.ts routes it here)
 */
import fs from 'fs';

import { GROUPS_DIR, TIMEZONE } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { formatLocalStamp } from '../../timezone.js';

export function appendRunLog(
  agentGroupId: string,
  series: string,
  msg: string,
): { series: string; timestamp: string; path: string } {
  // Charset guard is the security boundary: blocks path traversal and keeps
  // the id safe as a filename. Callers resolve group scope before this.
  if (!/^[a-z0-9-]+$/.test(series)) throw new Error(`invalid task id: ${series}`);
  const ag = getAgentGroup(agentGroupId);
  if (!ag) throw new Error(`agent group not found: ${agentGroupId}`);

  const timestamp = formatLocalStamp(new Date(), TIMEZONE);
  const dir = `${GROUPS_DIR}/${ag.folder}/tasks`;
  const file = `${dir}/${series}.md`;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, `${timestamp} — ${msg}\n`);
  return { series, timestamp, path: file };
}
