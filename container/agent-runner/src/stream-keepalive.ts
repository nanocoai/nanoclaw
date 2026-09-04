/**
 * Stream keep-alive policy — whether the runner's follow-up poll tick may
 * touch the heartbeat while a provider stream is open.
 *
 * The heartbeat normally ticks only on provider stream events, so the host
 * sweep reads a slow local model (minutes between events while decoding) the
 * same as a dead container and cold-kills it at the turn ceiling (#3643).
 * The follow-up poll proves the runner's event loop and mailbox are alive
 * every 500ms, so it can honestly vouch for the container — but an
 * UNCONDITIONAL touch would also keep a genuinely hung provider call or tool
 * alive forever, deleting the only backstop #2668 relies on. Hence:
 *
 *   - Opt-in: NANOCLAW_STREAM_KEEPALIVE_MS unset/invalid = keep-alive off,
 *     exactly today's behavior.
 *   - Bounded: touches happen only while the last REAL provider event is
 *     younger than the cap. A stream silent past the cap stops being vouched
 *     for; the heartbeat then ages normally and the turn ceiling still
 *     fires. Effective kill time for a silent stream = cap + ceiling.
 *
 * Operators pair it with the per-group turn ceiling: a slow-model install
 * sets a cap that covers its longest legitimate decode and can then keep the
 * ceiling itself short.
 */

// A cap below the sweep's claim-stuck tolerance (60s) would be meaningless —
// the sweep could kill between two vouches. Mirror the host-side floor.
export const MIN_STREAM_KEEPALIVE_MS = 60 * 1000;

/**
 * Parse NANOCLAW_STREAM_KEEPALIVE_MS. Returns undefined (keep-alive off) for
 * anything that is not a finite integer >= MIN_STREAM_KEEPALIVE_MS, so a
 * typo'd value degrades to today's behavior instead of an over-eager or
 * unbounded keep-alive.
 */
export function parseStreamKeepAliveMs(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < MIN_STREAM_KEEPALIVE_MS) return undefined;
  return n;
}

/**
 * Should this poll tick touch the heartbeat? True only when keep-alive is
 * enabled and the last provider event is still younger than the cap.
 */
export function shouldKeepAliveTouch(nowMs: number, lastEventMs: number, capMs: number | undefined): boolean {
  if (capMs === undefined) return false;
  return nowMs - lastEventMs < capMs;
}
