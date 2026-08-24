import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const CB_PATH = path.join(DATA_DIR, 'circuit-breaker.json');
const RESET_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// Index = number of consecutive crashes (0 = clean start, attempt 1).
// 6+ crashes capped at 15min.
const BACKOFF_SCHEDULE_S = [0, 0, 10, 30, 120, 300, 900];

interface CircuitBreakerState {
  attempt: number;
  timestamp: string;
}

function read(): CircuitBreakerState | null {
  try {
    const raw = fs.readFileSync(CB_PATH, 'utf-8');
    return JSON.parse(raw) as CircuitBreakerState;
  } catch {
    return null;
  }
}

function write(state: CircuitBreakerState): void {
  // The breaker runs before initDb (which is what creates DATA_DIR), so on a
  // fresh checkout the dir may not exist yet.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CB_PATH, JSON.stringify(state, null, 2) + '\n');
}

function getDelay(attempt: number): number {
  const idx = Math.min(attempt - 1, BACKOFF_SCHEDULE_S.length - 1);
  return BACKOFF_SCHEDULE_S[idx];
}

export function resetCircuitBreaker(): void {
  try {
    fs.unlinkSync(CB_PATH);
    log.info('Circuit breaker reset on clean shutdown');
  } catch {
    // Missing/stale breaker state is already the reset state.
  }
}

export async function enforceStartupBackoff(): Promise<void> {
  const now = new Date();
  const prev = read();

  let attempt: number;
  if (!prev) {
    attempt = 1;
  } else {
    const elapsedMs = now.getTime() - new Date(prev.timestamp).getTime();
    if (elapsedMs < RESET_WINDOW_MS) {
      attempt = prev.attempt + 1;
      log.warn('Previous startup was not a clean shutdown', {
        previousAttempt: prev.attempt,
        previousTimestamp: prev.timestamp,
        elapsedSec: Math.round(elapsedMs / 1000),
      });
    } else {
      attempt = 1;
      log.info('Circuit breaker reset — last startup was over 1h ago', {
        previousAttempt: prev.attempt,
        previousTimestamp: prev.timestamp,
      });
    }
  }

  write({ attempt, timestamp: now.toISOString() });

  const delaySec = getDelay(attempt);
  if (delaySec > 0) {
    const resumeAt = new Date(now.getTime() + delaySec * 1000).toISOString();
    log.warn('Circuit breaker: delaying startup due to repeated crashes', {
      attempt,
      delaySec,
      resumeAt,
    });
    await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
    log.info('Circuit breaker: backoff complete, resuming startup', { attempt });
  }
}
