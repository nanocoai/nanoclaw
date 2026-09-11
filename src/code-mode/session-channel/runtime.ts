/**
 * The host loop behind every bound coding session.
 *
 * Two activities per binding, both fed by the pure mapper (mapper.ts):
 *   - a tick (every `tickMs`): observe the session — container running?
 *     what does the runner's turn stamp say? — and act on the decision:
 *     send a status, render the diff view after a completed turn;
 *   - a long-poll on the service's event queue (client.events) so a Stop
 *     pressed in the channel interrupts the turn within a poll interval
 *     (stop.ts), then gates status sends until the next human turn.
 *
 * Everything the loop touches is injected (SessionChannelRuntimeDeps) so the
 * tests drive it with a fake service, a scripted observation and no timers;
 * index.ts wires the real DB, session dirs, git and the session driver.
 *
 * Failure posture: a service that refuses a binding for good (channel gone,
 * feature unavailable) drops that binding from this process and, when the
 * channel is gone, marks it archived so no future process retries; anything
 * transient is retried on the next tick or after a bounded backoff. A
 * binding never fails the sandbox it mirrors.
 */
import { log } from '../../log.js';
import {
  backoff,
  isChannelGone,
  isSessionStopped,
  isUnavailable,
  LONG_POLL_MAX_SECONDS,
  type ChannelEvent,
  type SessionChannelClient,
} from './client.js';
import type { SessionChannelPatch, SessionChannelRow } from './db.js';
import type { DiffView } from './diff-view.js';
import {
  DEFAULT_MIRROR_POLICY,
  decide,
  markStopped,
  type MirrorObservation,
  type MirrorPolicy,
  type MirrorState,
} from './mapper.js';
import { isStopEvent } from './stop.js';

export interface SessionChannelRuntimeDeps {
  /** A client for the row's service, or null when this host holds no bearer for it. */
  clientFor(row: SessionChannelRow): SessionChannelClient | null;
  listBindings(): Promise<SessionChannelRow[]>;
  observe(row: SessionChannelRow): Promise<MirrorObservation>;
  collectDiff(row: SessionChannelRow): Promise<DiffView | null>;
  /** Interrupt the group's coding session; resolves whether a live session took it. */
  interrupt(agentGroupId: string): Promise<boolean>;
  persist(agentGroupId: string, patch: SessionChannelPatch): Promise<void>;
  now?(): number;
  tickMs?: number;
  policy?: MirrorPolicy;
  /** Start the per-binding long-poll (tests that script stops directly turn it off). */
  watchEvents?: boolean;
  pollWaitSeconds?: number;
}

interface BindingState {
  row: SessionChannelRow;
  client: SessionChannelClient;
  mirror: MirrorState;
  /** Last diff content sent, so an unchanged tree is not re-sent. */
  lastDiff: string | null;
  ticking: boolean;
  watcher: AbortController | null;
}

export const DEFAULT_TICK_MS = 2_000;

/** The one code tab, and the name it carries in the channel. */
export const DIFF_VIEW_NAME = 'Changes';

function mirrorFromRow(row: SessionChannelRow): MirrorState {
  const lastStatus = row.last_status;
  return {
    lastStatus:
      lastStatus === 'active' || lastStatus === 'processing' || lastStatus === 'suspended' ? lastStatus : null,
    lastSentAt: row.last_status_at ? Date.parse(row.last_status_at) || 0 : 0,
    stoppedAt: row.stopped_at,
    lastTurnSeq: Number(row.last_turn_seq) || 0,
  };
}

export class SessionChannelRuntime {
  private readonly deps: SessionChannelRuntimeDeps;
  private readonly bindings = new Map<string, BindingState>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(deps: SessionChannelRuntimeDeps) {
    this.deps = deps;
  }

  get size(): number {
    return this.bindings.size;
  }

  has(agentGroupId: string): boolean {
    return this.bindings.has(agentGroupId);
  }

  async start(): Promise<void> {
    this.stopped = false;
    for (const row of await this.deps.listBindings()) await this.add(row);
    const tickMs = this.deps.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.error('Session channel tick failed', { err }));
    }, tickMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.bindings.keys()]) this.remove(id);
  }

  /** Register a binding (new or loaded). Idempotent on the group id. */
  async add(row: SessionChannelRow): Promise<void> {
    if (row.archived_at || this.bindings.has(row.agent_group_id)) return;
    const client = this.deps.clientFor(row);
    if (!client) {
      log.warn('Session channel has no credentials on this host — not mirrored', {
        agentGroupId: row.agent_group_id,
        channelId: row.channel_id,
      });
      return;
    }
    const state: BindingState = {
      row: { ...row },
      client,
      mirror: mirrorFromRow(row),
      lastDiff: null,
      ticking: false,
      watcher: null,
    };
    this.bindings.set(row.agent_group_id, state);
    if (this.deps.watchEvents !== false) this.watch(state);
  }

  remove(agentGroupId: string): void {
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
        log.warn('Session channel mirror tick failed', { agentGroupId: state.row.agent_group_id, err });
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
        await state.client.setStatus(state.row.channel_id, status, resume ? { resume: true } : {});
        const at = new Date(this.now()).toISOString();
        await this.deps.persist(id, {
          last_status: status,
          last_status_at: at,
          ...(resume ? { stopped_at: null } : {}),
        });
        log.debug('Session channel status sent', { agentGroupId: id, status, resume });
      } catch (err) {
        if (isSessionStopped(err)) {
          // The service knows of a Stop this process has not seen (a missed
          // or not-yet-polled event): honour it now; the watcher's interrupt
          // follows when the event arrives.
          const at = new Date(this.now()).toISOString();
          state.mirror = markStopped({ ...state.mirror, lastStatus: before.lastStatus }, at);
          await this.deps.persist(id, { stopped_at: at });
          log.info('Session channel reports the session stopped', { agentGroupId: id });
          return;
        }
        // Keep the send slot (rate limit) but not the status: the next tick retries.
        state.mirror = { ...state.mirror, lastStatus: before.lastStatus };
        if (await this.dropIfDead(state, err, 'status')) return;
        log.warn('Session channel status not sent', { agentGroupId: id, status, err });
      }
    }

    if (decision.renderDiff) {
      await this.renderDiff(state, decision.renderDiff.turnSeq);
    } else if (decision.next.lastTurnSeq !== before.lastTurnSeq) {
      await this.deps.persist(id, { last_turn_seq: decision.next.lastTurnSeq });
    }
  }

  private async renderDiff(state: BindingState, turnSeq: number): Promise<void> {
    const id = state.row.agent_group_id;
    let diff: DiffView | null = null;
    try {
      diff = await this.deps.collectDiff(state.row);
    } catch (err) {
      log.warn('Session channel diff not collected', { agentGroupId: id, err });
    }
    await this.deps.persist(id, { last_turn_seq: turnSeq });
    if (!diff || !diff.content || diff.content === state.lastDiff) return;
    try {
      await state.client.putView(state.row.channel_id, 'diff', {
        type: 'diff',
        name: DIFF_VIEW_NAME,
        content: diff.content,
        ...(diff.headBranch ? { headBranch: diff.headBranch } : {}),
      });
      state.lastDiff = diff.content;
      log.debug('Session channel diff view updated', { agentGroupId: id, turnSeq, truncated: diff.truncated });
    } catch (err) {
      if (isSessionStopped(err)) return; // the stop gate will hold the next one
      if (await this.dropIfDead(state, err, 'diff')) return;
      log.warn('Session channel diff view not updated', { agentGroupId: id, err });
    }
  }

  /** A binding the service will never serve again leaves this process (and, when the channel is gone, the table's live set). */
  private async dropIfDead(state: BindingState, err: unknown, what: string): Promise<boolean> {
    const id = state.row.agent_group_id;
    if (isChannelGone(err)) {
      log.info('Session channel is gone — binding retired', {
        agentGroupId: id,
        channelId: state.row.channel_id,
        what,
      });
      this.remove(id);
      await this.deps.persist(id, { archived_at: new Date(this.now()).toISOString() });
      return true;
    }
    if (isUnavailable(err)) {
      log.warn('Session channel unavailable — not mirrored by this process', { agentGroupId: id, what, err });
      this.remove(id);
      return true;
    }
    return false;
  }

  /** A Stop from the channel: interrupt the turn, then hold status until the next human turn. */
  async handleStop(agentGroupId: string, event?: Pick<ChannelEvent, 'ts' | 'user'>): Promise<void> {
    const state = this.bindings.get(agentGroupId);
    if (!state) return;
    let interrupted = false;
    try {
      interrupted = await this.deps.interrupt(agentGroupId);
    } catch (err) {
      log.error('Session channel stop: interrupt failed', { agentGroupId, err });
    }
    const at = new Date(this.now()).toISOString();
    state.mirror = markStopped(state.mirror, at);
    await this.deps.persist(agentGroupId, { stopped_at: at });
    log.info('Session channel stop honoured', {
      agentGroupId,
      channelId: state.row.channel_id,
      interrupted,
      user: event?.user,
      eventTs: event?.ts,
    });
  }

  private watch(state: BindingState): void {
    const abort = new AbortController();
    state.watcher = abort;
    const id = state.row.agent_group_id;
    const wait = this.deps.pollWaitSeconds ?? LONG_POLL_MAX_SECONDS;
    const loop = async (): Promise<void> => {
      let attempt = 0;
      while (!abort.signal.aborted && !this.stopped) {
        try {
          const page = await state.client.events(state.row.channel_id, {
            since: state.row.events_cursor,
            wait,
            signal: abort.signal,
          });
          attempt = 0;
          for (const event of page.events) {
            if (isStopEvent(event)) await this.handleStop(id, event);
          }
          if (page.cursor && page.cursor !== state.row.events_cursor) {
            state.row.events_cursor = page.cursor;
            await this.deps.persist(id, { events_cursor: page.cursor });
          }
        } catch (err) {
          if (abort.signal.aborted || this.stopped) return;
          if (await this.dropIfDead(state, err, 'events')) return;
          attempt++;
          if (attempt === 1 || attempt % 10 === 0) {
            log.warn('Session channel event poll failed — backing off', { agentGroupId: id, attempt, err });
          }
          await backoff(attempt, abort.signal);
        }
      }
    };
    loop().catch((err) => log.error('Session channel event loop died', { agentGroupId: id, err }));
  }
}
