/**
 * The host loop behind every bound coding session.
 *
 * Two activities per binding, both fed by the pure mapper (mapper.ts):
 *   - a tick (every `tickMs`): observe the session — container running?
 *     what does the runner's turn stamp say? — and act on the decision:
 *     send a status, render the diff view after a completed turn;
 *   - a long-poll on the provider's events (types.ts `events`) so a Stop
 *     pressed on the surface interrupts the turn within a poll interval
 *     (stop.ts), then gates status sends until the next human turn.
 *
 * Everything the loop touches is injected (SessionSurfaceRuntimeDeps) so the
 * tests drive it with a fake provider, a scripted observation and no timers;
 * index.ts wires the real DB, session dirs, git and the session driver.
 *
 * Failure posture: a provider that refuses a binding for good (surface
 * gone, feature unavailable) drops that binding from this process and, when
 * the surface is gone, marks it archived so no future process retries;
 * anything transient is retried on the next tick or after a bounded
 * backoff. A binding never fails the sandbox it mirrors.
 *
 * Two facts are kept apart on purpose:
 *   - a binding whose platform has no provider yet (the module activates
 *     after the host restored the rows, or left) WAITS: it is held aside,
 *     nothing is sent or persisted for it, and `refresh(channelType)` —
 *     called when a provider registers or unregisters — binds it live or
 *     puts it back to waiting;
 *   - a turn OBSERVED is not a turn PUBLISHED: the diff for a completed
 *     turn stays pending until the provider took it (or the tree had
 *     nothing new), and a failed collect or publish is retried on the next
 *     healthy tick, a bounded number of times, before the turn is given up
 *     with a log line. Only then is `last_turn_seq` persisted for it.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { log } from '../../log.js';
import type { SessionSurfacePatch, SessionSurfaceRow } from './db.js';
import type { DiffCollection } from './diff-view.js';
import {
  DEFAULT_MIRROR_POLICY,
  decide,
  markStopped,
  type MirrorObservation,
  type MirrorPolicy,
  type MirrorState,
} from './mapper.js';
import { noopSessionSurface } from './registry.js';
import { isStopEvent } from './stop.js';
import { surfaceErrorKind, type SessionSurfaceProvider, type SurfaceEvent, type SurfaceHandle } from './types.js';

export interface SessionSurfaceRuntimeDeps {
  /** The provider for the row's platform, or null when this host has none for it. */
  providerFor(row: SessionSurfaceRow): SessionSurfaceProvider | null;
  listBindings(): Promise<SessionSurfaceRow[]>;
  observe(row: SessionSurfaceRow): Promise<MirrorObservation>;
  /** Read the session's tree: an answer (hunks, clean, no repository) or a failed read to retry. */
  collectDiff(row: SessionSurfaceRow): Promise<DiffCollection>;
  /** Interrupt the group's coding session; resolves whether a live session took it. */
  interrupt(agentGroupId: string): Promise<boolean>;
  persist(agentGroupId: string, patch: SessionSurfacePatch): Promise<void>;
  now?(): number;
  tickMs?: number;
  policy?: MirrorPolicy;
  /** Start the per-binding long-poll (tests that script stops directly turn it off). */
  watchEvents?: boolean;
  pollWaitSeconds?: number;
}

interface PendingDiff {
  turnSeq: number;
  attempts: number;
}

interface BindingState {
  row: SessionSurfaceRow;
  provider: SessionSurfaceProvider;
  handle: SurfaceHandle;
  mirror: MirrorState;
  /** Last diff content sent, so an unchanged tree is not re-sent. */
  lastDiff: string | null;
  /** A completed turn whose diff the provider has not taken yet. */
  pendingDiff: PendingDiff | null;
  ticking: boolean;
  watcher: AbortController | null;
}

export const DEFAULT_TICK_MS = 2_000;

/** Collect-or-publish attempts for one turn's diff before it is given up. */
export const MAX_DIFF_ATTEMPTS = 3;

/** The one code view, and the name it carries on the surface. */
export const DIFF_VIEW_KEY = 'diff';
export const DIFF_VIEW_NAME = 'Changes';

/** How long one events long-poll may wait (a provider may cap it lower). */
export const DEFAULT_POLL_WAIT_SECONDS = 25;

/** Bounded backoff for a failing long-poll: 1 s, 2 s, 4 s … capped at a minute. */
export async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const ms = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    // Aborted: the caller is stopping.
  }
}

function mirrorFromRow(row: SessionSurfaceRow): MirrorState {
  const lastStatus = row.last_status;
  return {
    lastStatus:
      lastStatus === 'active' || lastStatus === 'processing' || lastStatus === 'suspended' ? lastStatus : null,
    lastSentAt: row.last_status_at ? Date.parse(row.last_status_at) || 0 : 0,
    stoppedAt: row.stopped_at,
    lastTurnSeq: Number(row.last_turn_seq) || 0,
  };
}

export class SessionSurfaceRuntime {
  private readonly deps: SessionSurfaceRuntimeDeps;
  /** Bindings with a provider: ticked, watched, persisted. */
  private readonly bindings = new Map<string, BindingState>();
  /** Bindings whose platform has no provider on this host right now. */
  private readonly waiting = new Map<string, SessionSurfaceRow>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(deps: SessionSurfaceRuntimeDeps) {
    this.deps = deps;
  }

  /** Bindings mirrored live (a waiting one is not). */
  get size(): number {
    return this.bindings.size;
  }

  /** Whether this process mirrors the group's binding live. */
  has(agentGroupId: string): boolean {
    return this.bindings.has(agentGroupId);
  }

  /** Whether the group's binding is known but waiting for a provider. */
  isWaiting(agentGroupId: string): boolean {
    return this.waiting.has(agentGroupId);
  }

  async start(): Promise<void> {
    this.stopped = false;
    for (const row of await this.deps.listBindings()) await this.add(row);
    const tickMs = this.deps.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error('Session surface tick failed', { err }));
    }, tickMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.bindings.keys()]) this.remove(id);
    this.waiting.clear();
  }

  /** The row's provider, or null: a platform with none, or the no-op object, is no provider. */
  private resolveProvider(row: SessionSurfaceRow): SessionSurfaceProvider | null {
    const provider = this.deps.providerFor(row);
    return provider && provider !== noopSessionSurface ? provider : null;
  }

  /**
   * Register a binding (new or loaded), or re-resolve a known one. A row
   * whose platform has a provider is mirrored live; one without waits,
   * unpersisted, until `refresh` finds a provider for it. A live binding
   * whose provider changed is rebound with its mirror state kept.
   */
  async add(row: SessionSurfaceRow): Promise<void> {
    const id = row.agent_group_id;
    if (row.archived_at) return;
    const provider = this.resolveProvider(row);
    const live = this.bindings.get(id);
    if (live) {
      if (provider === live.provider) return;
      live.watcher?.abort();
      live.watcher = null;
      if (!provider) {
        this.bindings.delete(id);
        this.hold(live.row);
        return;
      }
      live.provider = provider;
      if (this.deps.watchEvents !== false) this.watch(live);
      log.info('Session surface rebound to a new provider', { agentGroupId: id, provider: row.provider });
      return;
    }
    if (!provider) {
      this.hold(row);
      return;
    }
    this.waiting.delete(id);
    const state: BindingState = {
      row: { ...row },
      provider,
      handle: { surfaceId: row.surface_id, sessionId: row.session_id },
      mirror: mirrorFromRow(row),
      lastDiff: null,
      pendingDiff: null,
      ticking: false,
      watcher: null,
    };
    this.bindings.set(id, state);
    if (this.deps.watchEvents !== false) this.watch(state);
  }

  private hold(row: SessionSurfaceRow): void {
    if (!this.waiting.has(row.agent_group_id)) {
      log.warn('Session surface has no provider on this host — waiting, not mirrored', {
        agentGroupId: row.agent_group_id,
        provider: row.provider,
        surfaceId: row.surface_id,
      });
    }
    this.waiting.set(row.agent_group_id, { ...row });
  }

  /**
   * A platform's provider registered or unregistered: re-resolve every
   * binding of that platform — a waiting one goes live and starts ticking,
   * a live one whose provider went away goes back to waiting.
   */
  async refresh(channelType: string): Promise<void> {
    const rows = [
      ...[...this.waiting.values()].filter((row) => row.provider === channelType),
      ...[...this.bindings.values()].filter((state) => state.row.provider === channelType).map((state) => state.row),
    ];
    for (const row of rows) {
      try {
        await this.add(row);
      } catch (err) {
        log.warn('Session surface not rebound', { agentGroupId: row.agent_group_id, channelType, err });
      }
    }
  }

  remove(agentGroupId: string): void {
    this.waiting.delete(agentGroupId);
    const state = this.bindings.get(agentGroupId);
    if (!state) return;
    state.watcher?.abort();
    this.bindings.delete(agentGroupId);
  }

  /** One pass over every binding — exported so tests run it without the timer. */
  async tick(): Promise<void> {
    for (const state of [...this.bindings.values()]) {
      if (state.ticking) continue;
      state.ticking = true;
      try {
        await this.tickOne(state);
      } catch (err) {
        log.warn('Session surface mirror tick failed', { agentGroupId: state.row.agent_group_id, err });
      } finally {
        state.ticking = false;
      }
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async tickOne(state: BindingState): Promise<void> {
    const observation = await this.deps.observe(state.row);
    const before = state.mirror;
    const decision = decide(before, observation, this.now(), this.deps.policy ?? DEFAULT_MIRROR_POLICY);
    state.mirror = decision.next;
    const id = state.row.agent_group_id;

    if (decision.send) {
      const { status, resume } = decision.send;
      try {
        await state.provider.status(state.handle, status, resume ? { resume: true } : {});
        const at = new Date(this.now()).toISOString();
        await this.deps.persist(id, {
          last_status: status,
          last_status_at: at,
          ...(resume ? { stopped_at: null } : {}),
        });
        log.debug('Session surface status sent', { agentGroupId: id, status, resume });
      } catch (err) {
        if (surfaceErrorKind(err) === 'stopped') {
          // The provider knows of a Stop this process has not seen (a missed
          // or not-yet-polled event): honour it now; the watcher's interrupt
          // follows when the event arrives.
          const at = new Date(this.now()).toISOString();
          state.mirror = markStopped({ ...state.mirror, lastStatus: before.lastStatus }, at);
          await this.deps.persist(id, { stopped_at: at });
          log.info('Session surface reports the session stopped', { agentGroupId: id });
          return;
        }
        // Keep the send slot (rate limit) but not the status: the next tick retries.
        state.mirror = { ...state.mirror, lastStatus: before.lastStatus };
        if (await this.dropIfDead(state, err, 'status')) return;
        log.warn('Session surface status not sent', { agentGroupId: id, status, err });
      }
    }

    // A completed turn is observed here and published below; the two are
    // not the same event. A newer completed turn supersedes a pending one
    // (its diff shows the newer tree anyway). A turn that needs no diff (a
    // busy stamp) advances the persisted seq only while nothing is pending,
    // so a restart still finds the pending turn newer than what it stored.
    if (decision.renderDiff) {
      state.pendingDiff = { turnSeq: decision.renderDiff.turnSeq, attempts: 0 };
    } else if (decision.next.lastTurnSeq !== before.lastTurnSeq && !state.pendingDiff) {
      await this.deps.persist(id, { last_turn_seq: decision.next.lastTurnSeq });
    }
    if (state.pendingDiff && observation.running && state.mirror.stoppedAt === null) {
      await this.publishDiff(state, state.pendingDiff);
    }
  }

  /**
   * One attempt at the pending turn's diff. Settled — persisted as the
   * binding's last turn and cleared — when the provider took the view, or
   * when there was nothing new to send; kept pending otherwise, until the
   * attempts run out.
   */
  private async publishDiff(state: BindingState, pending: PendingDiff): Promise<void> {
    const id = state.row.agent_group_id;
    const { turnSeq } = pending;
    const settle = async (): Promise<void> => {
      if (state.pendingDiff === pending) state.pendingDiff = null;
      await this.deps.persist(id, { last_turn_seq: turnSeq });
    };
    const failed = async (what: string, err: unknown): Promise<void> => {
      pending.attempts += 1;
      if (pending.attempts >= MAX_DIFF_ATTEMPTS) {
        log.warn(`Session surface diff ${what} failed ${pending.attempts} times — giving up on this turn`, {
          agentGroupId: id,
          turnSeq,
          err,
        });
        await settle();
        return;
      }
      log.warn(`Session surface diff not ${what === 'collect' ? 'collected' : 'published'} — will retry`, {
        agentGroupId: id,
        turnSeq,
        attempt: pending.attempts,
        err,
      });
    };

    // A read that failed (the exec, git) is NOT a clean tree: it stays
    // pending and is retried like a failed publish.
    let collected: DiffCollection;
    try {
      collected = await this.deps.collectDiff(state.row);
    } catch (err) {
      collected = { ok: false, error: err };
    }
    if (!collected.ok) {
      await failed('collect', collected.error);
      return;
    }
    const diff = collected.view;
    if (!diff || !diff.content || diff.content === state.lastDiff) {
      await settle();
      return;
    }
    try {
      await state.provider.view(state.handle, {
        key: DIFF_VIEW_KEY,
        type: 'diff',
        name: DIFF_VIEW_NAME,
        content: diff.content,
        ...(diff.headBranch ? { headBranch: diff.headBranch } : {}),
      });
      state.lastDiff = diff.content;
      await settle();
      log.debug('Session surface diff view updated', { agentGroupId: id, turnSeq, truncated: diff.truncated });
    } catch (err) {
      if (await this.dropIfDead(state, err, 'diff')) return;
      // A 'stopped' refusal is the provider gating a stop this process has
      // not seen; the turn stays pending like any other failed attempt.
      await failed('publish', err);
    }
  }

  /** A binding the provider will never serve again leaves this process (and, when the surface is gone, the table's live set). */
  private async dropIfDead(state: BindingState, err: unknown, what: string): Promise<boolean> {
    const id = state.row.agent_group_id;
    const kind = surfaceErrorKind(err);
    if (kind === 'gone') {
      log.info('Session surface is gone — binding retired', {
        agentGroupId: id,
        surfaceId: state.row.surface_id,
        what,
      });
      this.remove(id);
      await this.deps.persist(id, { archived_at: new Date(this.now()).toISOString() });
      return true;
    }
    if (kind === 'unavailable') {
      log.warn('Session surface unavailable — not mirrored by this process', { agentGroupId: id, what, err });
      this.remove(id);
      return true;
    }
    return false;
  }

  /** A Stop from the surface: interrupt the turn, then hold status until the next human turn. */
  async handleStop(agentGroupId: string, event?: { ts?: string; user?: string }): Promise<void> {
    const state = this.bindings.get(agentGroupId);
    if (!state) return;
    let interrupted = false;
    try {
      interrupted = await this.deps.interrupt(agentGroupId);
    } catch (err) {
      log.error('Session surface stop: interrupt failed', { agentGroupId, err });
    }
    const at = new Date(this.now()).toISOString();
    state.mirror = markStopped(state.mirror, at);
    await this.deps.persist(agentGroupId, { stopped_at: at });
    log.info('Session surface stop honoured', {
      agentGroupId,
      surfaceId: state.row.surface_id,
      interrupted,
      user: event?.user,
      eventTs: event?.ts,
    });
  }

  /**
   * One host-bound notification. A surface-wide Stop is the one event the
   * host acts on today. A command, a membership change, a board change, a
   * thread-scoped stop and any type this host does not know are logged and
   * dropped, never raised: the provider may carry events newer than this
   * host, and none of them is a message for the session.
   */
  private async handleEvent(state: BindingState, event: SurfaceEvent): Promise<void> {
    const agentGroupId = state.row.agent_group_id;
    if (event.type === 'stop') {
      if (isStopEvent(event)) await this.handleStop(agentGroupId, event);
      else log.debug('Session surface thread stop relayed only', { agentGroupId, threadId: event.threadId });
      return;
    }
    if (event.type === 'command') {
      log.info('Session surface command noted', { agentGroupId, command: event.command, user: event.user });
      return;
    }
    log.info('Session surface event ignored', { agentGroupId, type: event.type });
  }

  private watch(state: BindingState): void {
    const abort = new AbortController();
    state.watcher = abort;
    const id = state.row.agent_group_id;
    const wait = this.deps.pollWaitSeconds ?? DEFAULT_POLL_WAIT_SECONDS;
    const loop = async (): Promise<void> => {
      let attempt = 0;
      while (!abort.signal.aborted && !this.stopped) {
        try {
          const page = await state.provider.events(state.handle, state.row.events_cursor, wait, abort.signal);
          attempt = 0;
          for (const event of page.events) await this.handleEvent(state, event);
          if (page.cursor && page.cursor !== state.row.events_cursor) {
            state.row.events_cursor = page.cursor;
            await this.deps.persist(id, { events_cursor: page.cursor });
          }
        } catch (err) {
          if (abort.signal.aborted || this.stopped) return;
          if (surfaceErrorKind(err) === 'stopped') {
            // The provider refuses the poll because the user stopped the
            // session: that IS the stop event. Honour it and keep polling.
            await this.handleStop(id);
            continue;
          }
          if (await this.dropIfDead(state, err, 'events')) return;
          attempt++;
          if (attempt === 1 || attempt % 10 === 0) {
            log.warn('Session surface event poll failed — backing off', { agentGroupId: id, attempt, err });
          }
          await backoff(attempt, abort.signal);
        }
      }
    };
    loop().catch((err) => log.error('Session surface event loop died', { agentGroupId: id, err }));
  }
}
