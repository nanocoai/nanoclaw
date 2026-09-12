/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval while the agent is actually working.
 *
 * "Working" is decided from the runner's own turn report, read on the
 * delivery poll (`noteTurnState`). The runner writes `working` while a
 * turn runs and `idle` when it ends, so the host no longer has to guess
 * from a heartbeat FILE — which is invisible when the delivering process
 * doesn't share a filesystem with the runner, and never says "stop". A
 * runner that predates the turn report never calls `noteTurnState`, so
 * those sessions keep the old heartbeat-file behaviour unchanged.
 *
 * When a turn ends (idle, or a `working` report that has gone stale) the
 * refresh ENDS: the interval is cleared and the adapter's optional
 * `clearTyping` fires once, for platforms whose indicator does not expire
 * on its own (Slack's assistant status has no TTL and is only cleared by
 * a post or an explicit clear).
 *
 * After delivering a user-facing message, the refresh is paused for
 * POST_DELIVERY_PAUSE_MS so the client-side indicator can visually
 * clear.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { heartbeatPath } from '../../session-manager.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of turn/heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before the first turn report).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Only used for older
 * runners that never report a turn (see noteTurnState).
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * A `working` turn report counts as live only if its stamp is within this
 * many ms of now. The runner re-marks `working` every 5s, so this is three
 * re-marks: a report older than that means the runner stopped moving (turn
 * ended without an idle write, or the runner died) and we stop refreshing.
 */
const TURN_STALE_MS = 15000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;

interface TypingAdapter {
  setTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
  /**
   * Clear the typing indicator. Only platforms whose indicator does not
   * expire on its own implement it (e.g. Slack's assistant status); others
   * omit it and the module no-ops via optional chaining.
   */
  clearTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
}

/** The runner's latest turn report, as read on the delivery poll. */
interface TurnReport {
  /** 'working' | 'idle', or null when the runner never reported (older runner). */
  turn: 'working' | 'idle' | null;
  /** container_state.updated_at in epoch ms, or null when there is no record. */
  updatedAtMs: number | null;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
  /** Latest runner turn report; undefined until the first noteTurnState. */
  turnReport?: TurnReport;
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping` and `clearTyping`. Called once by `src/delivery.ts`
 * inside `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

async function triggerTyping(
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): Promise<void> {
  try {
    await adapter?.setTyping?.(channelType, platformId, threadId, instance);
  } catch {
    // Typing is best-effort — don't let it fail delivery or routing.
  }
}

async function triggerClear(
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): Promise<void> {
  try {
    await adapter?.clearTyping?.(channelType, platformId, threadId, instance);
  } catch {
    // Best-effort — a failed clear must never affect delivery or routing.
  }
}

/**
 * End a refresher: stop the interval, drop the entry, and clear the
 * indicator once. Idempotent per session — the entry is removed first, so a
 * later tick or a stopTypingRefresh call finds nothing and does not clear
 * twice.
 */
function endRefresh(sessionId: string, entry: TypingTarget): void {
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
  triggerClear(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    triggerTyping(channelType, platformId, threadId, instance).catch(() => {});
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    // Keep the stored entry self-consistent: a re-trigger can arrive from
    // a different chat address (agent-shared sessions span messaging
    // groups, possibly on different platforms/instances), so the address
    // fields and the owning instance must move together — a torn entry
    // (old address + new instance) would hand e.g. a telegram platformId
    // to a Slack instance's setTyping on the next interval tick.
    existing.channelType = channelType;
    existing.platformId = platformId;
    existing.threadId = threadId;
    existing.instance = instance;
    return;
  }

  // Immediate tick + periodic refresh.
  triggerTyping(channelType, platformId, threadId, instance).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    const now = Date.now();

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > now) return;

    // Within the grace window since the last inbound: fire
    // unconditionally, covering container spawn/wake latency before the
    // first turn report lands.
    if (now - entry.startedAt < TYPING_GRACE_MS) {
      triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
      return;
    }

    // The runner reported a turn: follow it. 'working' with a fresh stamp
    // keeps refreshing; 'idle', or a 'working' report gone stale (runner
    // stopped re-marking), ends the refresh and clears the indicator.
    const report = entry.turnReport;
    if (report && report.turn !== null) {
      const working =
        report.turn === 'working' && report.updatedAtMs !== null && now - report.updatedAtMs < TURN_STALE_MS;
      if (working) {
        triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
        return;
      }
      endRefresh(sessionId, entry);
      return;
    }

    // No turn ever reported (older runner): fall back to the heartbeat file.
    if (isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
      return;
    }
    endRefresh(sessionId, entry);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    interval,
    startedAt,
    pausedUntil: 0,
  });
}

/**
 * Record the runner's latest turn report for a session, read on the
 * delivery poll. Stores it on the active refresher entry; creates no entry
 * if none is active (typing is only ever started by an inbound message). A
 * missing record or a null turn (older runner) reads as "not reported" and
 * leaves the heartbeat-file fallback in charge.
 */
export function noteTurnState(sessionId: string, state: TurnReport): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.turnReport = state;
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after
 * a user-facing message is delivered so the client-side indicator
 * has a chance to visually clear before the agent's next SDK event
 * pushes it back on. No-op if no refresh is active for this session.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  endRefresh(sessionId, entry);
}
