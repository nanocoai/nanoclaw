/**
 * Rate limiter for nostr-signer daemon.
 * Tracks signing requests per session with configurable limits.
 */

const DEFAULT_LIMITS = {
  perMinute: 10,
  perHour: 100,
  burstWindow: 10_000,  // 10 seconds
  burstMax: 5,
};

// Per-session rate tracking: Map<token, { minute: [], hour: [], burst: [] }>
const windows = new Map();

function getWindow(token) {
  if (!windows.has(token)) {
    windows.set(token, { timestamps: [] });
  }
  return windows.get(token);
}

function pruneTimestamps(timestamps, cutoff) {
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }
}

/**
 * Check if a signing request is allowed under rate limits.
 * @param {string} token - Session token
 * @param {object} [limits] - Override default limits
 * @returns {{ allowed: boolean, error?: string, remaining?: { minute: number, hour: number } }}
 */
export function checkRate(token, limits = DEFAULT_LIMITS) {
  const now = Date.now();
  const window = getWindow(token);
  const ts = window.timestamps;

  // Prune old timestamps
  const oneHourAgo = now - 3_600_000;
  pruneTimestamps(ts, oneHourAgo);

  // Count in windows
  const oneMinuteAgo = now - 60_000;
  const burstStart = now - limits.burstWindow;

  const inMinute = ts.filter(t => t >= oneMinuteAgo).length;
  const inHour = ts.length; // already pruned to 1 hour
  const inBurst = ts.filter(t => t >= burstStart).length;

  // Check burst
  if (inBurst >= limits.burstMax) {
    return {
      allowed: false,
      error: `Rate limit: burst exceeded (${inBurst}/${limits.burstMax} in ${limits.burstWindow / 1000}s)`,
    };
  }

  // Check per-minute
  if (inMinute >= limits.perMinute) {
    return {
      allowed: false,
      error: `Rate limit: ${inMinute}/${limits.perMinute} per minute`,
    };
  }

  // Check per-hour
  if (inHour >= limits.perHour) {
    return {
      allowed: false,
      error: `Rate limit: ${inHour}/${limits.perHour} per hour`,
    };
  }

  // Allowed — record timestamp
  ts.push(now);

  return {
    allowed: true,
    remaining: {
      minute: limits.perMinute - inMinute - 1,
      hour: limits.perHour - inHour - 1,
    },
  };
}

/**
 * Clear rate tracking for a session (on session revocation).
 * @param {string} token
 */
export function clearRate(token) {
  windows.delete(token);
}

/**
 * Get rate stats for a session.
 * @param {string} token
 */
export function getRateStats(token) {
  const window = windows.get(token);
  if (!window) return null;

  const now = Date.now();
  const ts = window.timestamps;
  const oneMinuteAgo = now - 60_000;

  return {
    lastMinute: ts.filter(t => t >= oneMinuteAgo).length,
    lastHour: ts.length,
    limits: DEFAULT_LIMITS,
  };
}
