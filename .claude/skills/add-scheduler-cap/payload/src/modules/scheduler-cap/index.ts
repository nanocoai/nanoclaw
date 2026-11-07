/**
 * Scheduler cap module: limits how many containers the reconcile sweep keeps
 * running. Registers only when SCHEDULER_MAX_CONTAINERS is a positive integer;
 * otherwise the default admission (wake everything) stays in place.
 */
import { getActiveContainerCount, isContainerRunning, killContainer } from '../../container-runner.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { registerSchedulerAdmission } from '../scheduling/admission.js';
import { createSchedulerCap } from './cap.js';

const KEY = 'SCHEDULER_MAX_CONTAINERS';

export function parseLimit(raw: string | undefined): number | null {
  if (!raw) return null;
  if (!/^[1-9][0-9]*$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

const raw = process.env[KEY] || readEnvFile([KEY])[KEY];
const limit = parseLimit(raw);

if (limit !== null) {
  registerSchedulerAdmission(
    createSchedulerCap({
      limit,
      activeCount: getActiveContainerCount,
      isRunning: isContainerRunning,
      stop: (sessionId, reason) => killContainer(sessionId, reason),
      now: Date.now,
    }),
  );
  log.info('Scheduler container cap enabled', { limit });
} else if (raw) {
  log.warn(`${KEY} must be a positive integer; scheduler cap disabled`, { value: raw });
}
