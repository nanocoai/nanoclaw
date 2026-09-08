/**
 * The memory-maintenance series, created PAUSED — seeding must never start
 * unattended work that spends tokens (the same rule template tasks follow).
 *
 * One series, deliberately. Two overlapping passes would be two containers
 * rewriting the same bind-mounted memory tree with nothing serializing them,
 * so the weekly pass is the whole schedule.
 *
 * A stamp file makes deletion stick: an operator who deletes the series does
 * not get it back. Nothing needs to re-check the DB for an existing series
 * first — the stamp is a sibling of the group's session directories, so the
 * only thing that drops it also drops the task row it guards, and a re-seed
 * after that is correct rather than duplicative.
 *
 * Nothing here throws: message routing must not fail over a maintenance task.
 *
 * The prompt stays short on purpose: the procedure lives in
 * `container/skills/memory-hygiene/SKILL.md`, which every group mounts
 * (`skills` defaults to `"all"` and is recomputed from `container/skills/` each
 * spawn). Restating the skill here would mean maintaining it twice. What the
 * prompt does keep is the unattended-deletion guard and the report shape —
 * worth repeating where a wrong answer is unrecoverable.
 *
 * No destination is named — a task run reaches a human only through an explicit
 * `<message to>` block, appended to the prompt when an operator picks one.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import { sessionsBaseDir } from '../../session-manager.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';

const STAMP_FILE = '.memory-maintenance-tasks';

export const MEMORY_MAINTENANCE_TASKS: readonly { name: string; recurrence: string; prompt: string }[] = [
  {
    name: 'memory hygiene',
    recurrence: '0 8 * * 0', // Sundays 08:00, group timezone.
    prompt:
      'Run the memory-hygiene skill over /workspace/agent/memory. ' +
      'Delete a fact only when it is clearly obsolete AND already safely represented elsewhere; ' +
      'keep uncertain history. ' +
      'Finish with one short line: what changed, or "no changes".',
  },
];

/** Create the paused series for a group, once. Returns the names created. */
export async function ensureMemoryMaintenanceTasks(agentGroupId: string): Promise<string[]> {
  const stamp = path.join(sessionsBaseDir(), agentGroupId, STAMP_FILE);
  if (fs.existsSync(stamp)) return [];

  const created: string[] = [];
  try {
    const timezone = await resolveGroupTimezone(agentGroupId);
    for (const spec of MEMORY_MAINTENANCE_TASKS) {
      await createScheduledTask(agentGroupId, prepareScheduledTask({ ...spec, timezone }), { status: 'paused' });
      created.push(spec.name);
    }
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, `${new Date().toISOString()}\n`);
  } catch (err) {
    // No stamp is written, but there is no retry either: the hook fires only at
    // a group's FIRST conversation, so this group will not be offered again.
    // The warning is the whole recovery path — `docs/memory.md` has the command
    // to add the series by hand.
    log.warn('Could not seed memory maintenance tasks', { agentGroupId, created, err });
  }

  if (created.length > 0) log.info('Seeded memory maintenance tasks (paused)', { agentGroupId, tasks: created });
  return created;
}
