/**
 * The host loop with every dependency scripted: status sends follow the
 * mapper, the diff view renders after a completed turn (and only when it
 * changed), a Stop interrupts the session and gates sends until the next
 * human turn resumes with `resume: true`, a service-side stop the host has
 * not seen is honoured, a gone channel retires the binding, and the event
 * loop drives the stop from the long-poll.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';

import { SessionChannelServiceError, type ChannelEvent, type SessionChannelClient } from './client.js';
import type { SessionChannelPatch, SessionChannelRow } from './db.js';
import type { DiffView } from './diff-view.js';
import type { MirrorObservation, TurnStamp } from './mapper.js';
import { SessionChannelRuntime, type SessionChannelRuntimeDeps } from './runtime.js';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const stamp = (state: 'idle' | 'busy', seq: number, atMs: number): TurnStamp => ({ state, seq, at: iso(atMs) });

function row(over: Partial<SessionChannelRow> = {}): SessionChannelRow {
  return {
    agent_group_id: 'ag-1',
    channel_id: 'C1',
    session_id: 'ag-1',
    messaging_group_id: 'mg-1',
    service_base: 'https://slack.example.test',
    app_id: 'A1',
    title: 'box',
    last_status: null,
    last_status_at: null,
    stopped_at: null,
    last_turn_seq: 0,
    events_cursor: null,
    archived_at: null,
    created_at: iso(T0),
    updated_at: iso(T0),
    ...over,
  };
}

interface Harness {
  runtime: SessionChannelRuntime;
  client: {
    setStatus: Mock<(channelId: string, status: string, options?: { resume?: boolean }) => Promise<unknown>>;
    putView: Mock<(channelId: string, viewKey: string, view: unknown) => Promise<unknown>>;
    events: Mock<(channelId: string, options?: unknown) => Promise<unknown>>;
  };
  observation: MirrorObservation;
  diff: DiffView | null;
  interrupt: Mock<(agentGroupId: string) => Promise<boolean>>;
  patches: Array<[string, SessionChannelPatch]>;
  clock: { now: number };
}

function harness(rows: SessionChannelRow[], over: Partial<SessionChannelRuntimeDeps> = {}): Harness {
  const client = {
    setStatus: vi.fn(async () => ({})),
    putView: vi.fn(async () => ({})),
    events: vi.fn(async () => ({ events: [], cursor: null })),
  };
  const h: Harness = {
    runtime: null as unknown as SessionChannelRuntime,
    client,
    observation: { running: true, turn: null },
    diff: null,
    interrupt: vi.fn(async () => true),
    patches: [],
    clock: { now: T0 },
  };
  h.runtime = new SessionChannelRuntime({
    clientFor: () => client as unknown as SessionChannelClient,
    listBindings: async () => rows,
    observe: async () => h.observation,
    collectDiff: async () => h.diff,
    interrupt: h.interrupt,
    persist: async (id, patch) => {
      h.patches.push([id, patch]);
    },
    now: () => h.clock.now,
    watchEvents: false,
    ...over,
  });
  return h;
}

describe('status mirroring', () => {
  it('sends active on the first tick, processing when a turn starts, and nothing while unchanged', async () => {
    const h = harness([row()]);
    await h.runtime.start();
    await h.runtime.tick();
    expect(h.client.setStatus).toHaveBeenLastCalledWith('C1', 'active', {});
    expect(h.patches.at(-1)).toEqual(['ag-1', { last_status: 'active', last_status_at: iso(T0) }]);

    h.clock.now += 5_000;
    await h.runtime.tick();
    expect(h.client.setStatus).toHaveBeenCalledTimes(1);

    h.observation = { running: true, turn: stamp('busy', 1, h.clock.now) };
    await h.runtime.tick();
    expect(h.client.setStatus).toHaveBeenLastCalledWith('C1', 'processing', {});
    await h.runtime.stop();
  });

  it('a failed send is retried on a later tick; a session_stopped refusal marks the binding stopped', async () => {
    const h = harness([row()]);
    h.client.setStatus.mockRejectedValueOnce(new Error('network'));
    await h.runtime.start();
    await h.runtime.tick();
    expect(h.patches).toHaveLength(0);
    h.clock.now += 5_000;
    await h.runtime.tick();
    expect(h.client.setStatus).toHaveBeenCalledTimes(2);
    expect(h.patches.at(-1)?.[1]).toMatchObject({ last_status: 'active' });

    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('busy', 1, h.clock.now) };
    h.client.setStatus.mockRejectedValueOnce(new SessionChannelServiceError(409, 'session_stopped', 'stopped', '/s'));
    await h.runtime.tick();
    expect(h.patches.at(-1)).toEqual(['ag-1', { stopped_at: iso(h.clock.now) }]);
    // Gated now: the same busy stamp (older than the stop) sends nothing more.
    h.clock.now += 5_000;
    await h.runtime.tick();
    expect(h.client.setStatus).toHaveBeenCalledTimes(3);
    await h.runtime.stop();
  });

  it('a channel the service no longer knows is retired and marked archived', async () => {
    const h = harness([row()]);
    h.client.setStatus.mockRejectedValueOnce(new SessionChannelServiceError(404, 'not_found', 'gone', '/s'));
    await h.runtime.start();
    await h.runtime.tick();
    expect(h.runtime.has('ag-1')).toBe(false);
    expect(h.patches.at(-1)).toEqual(['ag-1', { archived_at: iso(T0) }]);
    await h.runtime.stop();
  });

  it('an unavailable feature drops the binding from this process without archiving it', async () => {
    const h = harness([row()]);
    h.client.setStatus.mockRejectedValueOnce(
      new SessionChannelServiceError(409, 'code_channels_unavailable', 'no', '/s'),
    );
    await h.runtime.start();
    await h.runtime.tick();
    expect(h.runtime.has('ag-1')).toBe(false);
    expect(h.patches).toHaveLength(0);
    await h.runtime.stop();
  });

  it('archived rows and rows without credentials are never mirrored', async () => {
    const h = harness([row({ archived_at: iso(T0) }), row({ agent_group_id: 'ag-2', channel_id: 'C2' })], {
      clientFor: (r) => (r.agent_group_id === 'ag-2' ? null : ({} as SessionChannelClient)),
    });
    await h.runtime.start();
    expect(h.runtime.size).toBe(0);
    await h.runtime.stop();
  });
});

describe('diff view after a turn', () => {
  it('renders the diff when a turn completes, skips an unchanged tree, persists the turn seq', async () => {
    const h = harness([row({ last_status: 'active', last_status_at: iso(T0 - 60_000) })]);
    await h.runtime.start();
    h.observation = { running: true, turn: stamp('busy', 1, T0) };
    await h.runtime.tick();
    expect(h.client.putView).not.toHaveBeenCalled();
    expect(h.patches.find(([, p]) => p.last_turn_seq === 1)).toBeTruthy();

    h.clock.now += 5_000;
    h.diff = { content: 'diff --git a/x b/x\n+1\n', truncated: false, headBranch: 'work' };
    h.observation = { running: true, turn: stamp('idle', 2, h.clock.now) };
    await h.runtime.tick();
    expect(h.client.putView).toHaveBeenCalledWith('C1', 'diff', {
      type: 'diff',
      name: 'Changes',
      content: 'diff --git a/x b/x\n+1\n',
      headBranch: 'work',
    });
    expect(h.patches.find(([, p]) => p.last_turn_seq === 2)).toBeTruthy();
    expect(h.client.setStatus).toHaveBeenLastCalledWith('C1', 'active', {});

    // Next turn, same tree: no second PUT.
    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('busy', 3, h.clock.now) };
    await h.runtime.tick();
    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('idle', 4, h.clock.now) };
    await h.runtime.tick();
    expect(h.client.putView).toHaveBeenCalledTimes(1);

    // An empty diff (not a repo, or clean) sends nothing.
    h.diff = null;
    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('busy', 5, h.clock.now) };
    await h.runtime.tick();
    h.observation = { running: true, turn: stamp('idle', 6, h.clock.now) };
    await h.runtime.tick();
    expect(h.client.putView).toHaveBeenCalledTimes(1);
    await h.runtime.stop();
  });

  it('a diff refused because the session is stopped is not an error', async () => {
    const h = harness([row({ last_status: 'active', last_status_at: iso(T0 - 60_000), last_turn_seq: 1 })]);
    h.diff = { content: 'd', truncated: false };
    h.client.putView.mockRejectedValueOnce(new SessionChannelServiceError(409, 'session_stopped', 's', '/v'));
    await h.runtime.start();
    h.observation = { running: true, turn: stamp('idle', 2, T0) };
    await expect(h.runtime.tick()).resolves.toBeUndefined();
    expect(h.runtime.has('ag-1')).toBe(true);
    await h.runtime.stop();
  });
});

describe('stop from the channel', () => {
  it('interrupts the session, persists the stop, holds status, then resumes on the next human turn', async () => {
    const h = harness([row({ last_status: 'processing', last_status_at: iso(T0 - 60_000), last_turn_seq: 3 })]);
    await h.runtime.start();
    h.observation = { running: true, turn: stamp('busy', 3, T0 - 30_000) };

    h.clock.now = T0 + 1_000;
    await h.runtime.handleStop('ag-1', { ts: iso(T0 + 900), user: 'U1' });
    expect(h.interrupt).toHaveBeenCalledWith('ag-1');
    expect(h.patches.at(-1)).toEqual(['ag-1', { stopped_at: iso(T0 + 1_000) }]);

    // The interrupted turn leaves a busy stamp older than the stop: silence.
    h.clock.now += 5_000;
    await h.runtime.tick();
    // Even the container going cold is not reported while stopped.
    h.observation = { running: false, turn: stamp('busy', 3, T0 - 30_000) };
    h.clock.now += 5_000;
    await h.runtime.tick();
    expect(h.client.setStatus).not.toHaveBeenCalled();

    // The next message from the channel wakes the container and starts a turn.
    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('busy', 4, h.clock.now - 100) };
    await h.runtime.tick();
    expect(h.client.setStatus).toHaveBeenCalledWith('C1', 'processing', { resume: true });
    expect(h.patches).toContainEqual([
      'ag-1',
      { last_status: 'processing', last_status_at: iso(h.clock.now), stopped_at: null },
    ]);
    expect(h.patches.at(-1)).toEqual(['ag-1', { last_turn_seq: 4 }]);
    await h.runtime.stop();
  });

  it('an interrupt that fails still records the stop (the gate is the contract)', async () => {
    const h = harness([row()]);
    h.interrupt.mockRejectedValueOnce(new Error('exec failed'));
    await h.runtime.start();
    await h.runtime.handleStop('ag-1');
    expect(h.patches.at(-1)?.[1]).toHaveProperty('stopped_at');
    await h.runtime.stop();
  });

  it('a stop for an unknown group is ignored', async () => {
    const h = harness([]);
    await h.runtime.start();
    await h.runtime.handleStop('ag-nope');
    expect(h.interrupt).not.toHaveBeenCalled();
    await h.runtime.stop();
  });

  it('a binding that starts stopped (host restart) stays gated until a turn newer than the stop', async () => {
    const stoppedAt = iso(T0 - 10_000);
    const h = harness([row({ last_status: 'processing', stopped_at: stoppedAt, last_turn_seq: 2 })]);
    await h.runtime.start();
    h.observation = { running: true, turn: stamp('busy', 2, T0 - 20_000) };
    await h.runtime.tick();
    expect(h.client.setStatus).not.toHaveBeenCalled();
    h.observation = { running: true, turn: stamp('busy', 3, T0) };
    h.clock.now = T0 + 1_000;
    await h.runtime.tick();
    expect(h.client.setStatus).toHaveBeenCalledWith('C1', 'processing', { resume: true });
    await h.runtime.stop();
  });
});

describe('event loop', () => {
  it('consumes the long-poll: a stopped event interrupts and the cursor is persisted', async () => {
    const stopEvent: ChannelEvent = {
      cursor: 'EVT#1',
      type: 'code_channel.stopped',
      channelId: 'C1',
      sessionId: 'ag-1',
      ts: iso(T0),
      user: 'U1',
    };
    let polls = 0;
    // A hand-written long-poll: the first page carries the stop, the second
    // hangs until the runtime aborts it, like the real service would.
    const events = async (_channel: string, opts: { since?: string | null; signal?: AbortSignal }) => {
      polls += 1;
      if (polls === 1) {
        expect(opts.since).toBe('EVT#0');
        return { events: [stopEvent], cursor: 'EVT#1' };
      }
      await new Promise<void>((r) => opts.signal?.addEventListener('abort', () => r(), { once: true }));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const pollingClient = { setStatus: async () => ({}), putView: async () => ({}), events };
    const handled = new Promise<void>((resolve) => {
      const h = harness([row({ events_cursor: 'EVT#0' })], {
        watchEvents: true,
        pollWaitSeconds: 1,
        clientFor: () => pollingClient as unknown as SessionChannelClient,
      });
      void h.runtime.start().then(async () => {
        // The cursor is persisted after the page's events were handled — wait for it.
        const cursorPersisted = () => h.patches.some(([, p]) => p.events_cursor === 'EVT#1');
        for (let i = 0; i < 200 && !cursorPersisted(); i++) await new Promise((r) => setTimeout(r, 10));
        expect(cursorPersisted()).toBe(true);
        expect(h.interrupt).toHaveBeenCalledWith('ag-1');
        expect(h.patches.some(([, p]) => 'stopped_at' in p)).toBe(true);
        await h.runtime.stop();
        resolve();
      });
    });
    await handled;
    expect(polls).toBeGreaterThanOrEqual(1);
  });

  it('a gone channel ends its loop and retires the binding', async () => {
    const h = harness([row()], { watchEvents: true, pollWaitSeconds: 1 });
    h.client.events.mockRejectedValue(new SessionChannelServiceError(404, 'not_found', 'gone', '/e'));
    await h.runtime.start();
    for (let i = 0; i < 20 && h.runtime.has('ag-1'); i++) await new Promise((r) => setImmediate(r));
    expect(h.runtime.has('ag-1')).toBe(false);
    expect(h.patches.at(-1)?.[1]).toHaveProperty('archived_at');
    await h.runtime.stop();
  });
});

describe('event loop — events that are not a stop', () => {
  it('a slash command, a thread stop and an unknown type are logged and dropped: no interrupt, cursor advances', async () => {
    const base = { channelId: 'C1', sessionId: 'ag-1', ts: iso(T0) };
    const page: ChannelEvent[] = [
      { ...base, cursor: 'EVT#1', type: 'code_channel.command', command: '/terminal', text: '', user: 'U1' },
      { ...base, cursor: 'EVT#2', type: 'code_channel.command', command: '/deploy', text: 'staging', user: 'U1' },
      { ...base, cursor: 'EVT#3', type: 'code_channel.stopped', threadTs: '1700000000.000100', user: 'U1' },
      { ...base, cursor: 'EVT#4', type: 'code_channel.something_newer' },
    ];
    let polls = 0;
    const events = async (_channel: string, opts: { since?: string | null; signal?: AbortSignal }) => {
      polls += 1;
      if (polls === 1) return { events: page, cursor: 'EVT#4' };
      await new Promise<void>((r) => opts.signal?.addEventListener('abort', () => r(), { once: true }));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const pollingClient = { setStatus: async () => ({}), putView: async () => ({}), events };
    const h = harness([row()], {
      watchEvents: true,
      pollWaitSeconds: 1,
      clientFor: () => pollingClient as unknown as SessionChannelClient,
    });
    await h.runtime.start();
    const cursorPersisted = () => h.patches.some(([, p]) => p.events_cursor === 'EVT#4');
    for (let i = 0; i < 200 && !cursorPersisted(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(cursorPersisted()).toBe(true);
    expect(h.interrupt).not.toHaveBeenCalled();
    expect(h.patches.some(([, p]) => 'stopped_at' in p)).toBe(false);
    // The binding is still live: nothing in that page was a reason to drop it.
    expect(h.runtime.has('ag-1')).toBe(true);
    await h.runtime.stop();
  });
});
