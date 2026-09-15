/**
 * The host loop with every dependency scripted: status sends follow the
 * mapper, the diff view renders after a completed turn (and only when it
 * changed), a Stop interrupts the session and gates sends until the next
 * human turn resumes with `resume: true`, a provider-side stop the host has
 * not seen is honoured, a gone surface retires the binding, a binding
 * restored before its provider registers waits (unpersisted) and goes live
 * on refresh, a failed diff publish is retried and then given up, and the
 * event loop drives the stop from the long-poll.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';

import type { SessionSurfacePatch, SessionSurfaceRow } from './db.js';
import type { DiffView } from './diff-view.js';
import type { MirrorObservation, TurnStamp } from './mapper.js';
import { noopSessionSurface } from './registry.js';
import { MAX_DIFF_ATTEMPTS, SessionSurfaceRuntime, type SessionSurfaceRuntimeDeps } from './runtime.js';
import { SurfaceError, type SessionSurfaceProvider, type SurfaceEvent, type SurfaceHandle } from './types.js';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const stamp = (state: 'idle' | 'busy', seq: number, atMs: number): TurnStamp => ({ state, seq, at: iso(atMs) });
const H1: SurfaceHandle = { surfaceId: 'S1', sessionId: 'ag-1' };

function row(over: Partial<SessionSurfaceRow> = {}): SessionSurfaceRow {
  return {
    agent_group_id: 'ag-1',
    provider: 'chat',
    surface_id: 'S1',
    session_id: 'ag-1',
    messaging_group_id: 'mg-1',
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
  runtime: SessionSurfaceRuntime;
  provider: {
    status: Mock<SessionSurfaceProvider['status']>;
    view: Mock<SessionSurfaceProvider['view']>;
    events: Mock<SessionSurfaceProvider['events']>;
  };
  observation: MirrorObservation;
  diff: DiffView | null;
  interrupt: Mock<(agentGroupId: string) => Promise<boolean>>;
  patches: Array<[string, SessionSurfacePatch]>;
  clock: { now: number };
}

function harness(rows: SessionSurfaceRow[], over: Partial<SessionSurfaceRuntimeDeps> = {}): Harness {
  const provider = {
    status: vi.fn(async () => {}),
    view: vi.fn(async () => {}),
    events: vi.fn(async () => ({ events: [], cursor: null })),
  };
  const h: Harness = {
    runtime: null as unknown as SessionSurfaceRuntime,
    provider,
    observation: { running: true, turn: null },
    diff: null,
    interrupt: vi.fn(async () => true),
    patches: [],
    clock: { now: T0 },
  };
  h.runtime = new SessionSurfaceRuntime({
    providerFor: () => provider as unknown as SessionSurfaceProvider,
    listBindings: async () => rows,
    observe: async () => h.observation,
    collectDiff: async () => ({ ok: true, view: h.diff }),
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
    expect(h.provider.status).toHaveBeenLastCalledWith(H1, 'active', {});
    expect(h.patches.at(-1)).toEqual(['ag-1', { last_status: 'active', last_status_at: iso(T0) }]);

    h.clock.now += 5_000;
    await h.runtime.tick();
    expect(h.provider.status).toHaveBeenCalledTimes(1);

    h.observation = { running: true, turn: stamp('busy', 1, h.clock.now) };
    await h.runtime.tick();
    expect(h.provider.status).toHaveBeenLastCalledWith(H1, 'processing', {});
    await h.runtime.stop();
  });

  it('a failed send is retried on a later tick; a "stopped" refusal marks the binding stopped', async () => {
    const h = harness([row()]);
    h.provider.status.mockRejectedValueOnce(new Error('network'));
    await h.runtime.start();
    await h.runtime.tick();
    expect(h.patches).toHaveLength(0);
    h.clock.now += 5_000;
    await h.runtime.tick();
    expect(h.provider.status).toHaveBeenCalledTimes(2);
    expect(h.patches.at(-1)?.[1]).toMatchObject({ last_status: 'active' });

    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('busy', 1, h.clock.now) };
    h.provider.status.mockRejectedValueOnce(new SurfaceError('stopped', 'stopped'));
    await h.runtime.tick();
    expect(h.patches.at(-1)).toEqual(['ag-1', { stopped_at: iso(h.clock.now) }]);
    // Gated now: the same busy stamp (older than the stop) sends nothing more.
    h.clock.now += 5_000;
    await h.runtime.tick();
    expect(h.provider.status).toHaveBeenCalledTimes(3);
    await h.runtime.stop();
  });

  it('a surface the provider no longer knows is retired and marked archived', async () => {
    const h = harness([row()]);
    h.provider.status.mockRejectedValueOnce(new SurfaceError('gone', 'gone'));
    await h.runtime.start();
    await h.runtime.tick();
    expect(h.runtime.has('ag-1')).toBe(false);
    expect(h.patches.at(-1)).toEqual(['ag-1', { archived_at: iso(T0) }]);
    await h.runtime.stop();
  });

  it('an unavailable feature drops the binding from this process without archiving it', async () => {
    const h = harness([row()]);
    h.provider.status.mockRejectedValueOnce(new SurfaceError('unavailable', 'no'));
    await h.runtime.start();
    await h.runtime.tick();
    expect(h.runtime.has('ag-1')).toBe(false);
    expect(h.patches).toHaveLength(0);
    await h.runtime.stop();
  });

  it('archived rows and rows without a provider are never mirrored', async () => {
    const h = harness([row({ archived_at: iso(T0) }), row({ agent_group_id: 'ag-2', surface_id: 'S2' })], {
      providerFor: (r) => (r.agent_group_id === 'ag-2' ? null : ({} as SessionSurfaceProvider)),
    });
    await h.runtime.start();
    expect(h.runtime.size).toBe(0);
    await h.runtime.stop();
  });
});

describe('a provider that registers after the bindings were restored', () => {
  it('a restored row waits unpersisted, then receives status once its provider registers and refresh runs', async () => {
    let registered: SessionSurfaceProvider | null = null;
    const h = harness([row()], { providerFor: () => registered });
    await h.runtime.start();
    expect(h.runtime.has('ag-1')).toBe(false);
    expect(h.runtime.isWaiting('ag-1')).toBe(true);
    await h.runtime.tick();
    expect(h.provider.status).not.toHaveBeenCalled();
    expect(h.patches).toHaveLength(0);

    registered = h.provider as unknown as SessionSurfaceProvider;
    await h.runtime.refresh('chat');
    expect(h.runtime.has('ag-1')).toBe(true);
    expect(h.runtime.isWaiting('ag-1')).toBe(false);
    await h.runtime.tick();
    expect(h.provider.status).toHaveBeenCalledWith(H1, 'active', {});
    expect(h.patches.at(-1)).toEqual(['ag-1', { last_status: 'active', last_status_at: iso(T0) }]);

    // The provider leaves: the binding goes back to waiting and nothing more is sent or persisted.
    registered = null;
    await h.runtime.refresh('chat');
    expect(h.runtime.has('ag-1')).toBe(false);
    expect(h.runtime.isWaiting('ag-1')).toBe(true);
    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('busy', 1, h.clock.now) };
    await h.runtime.tick();
    expect(h.provider.status).toHaveBeenCalledTimes(1);
    expect(h.patches).toHaveLength(1);
    await h.runtime.stop();
  });

  it('the no-op provider counts as no provider; re-adding the row after registration binds it live', async () => {
    let current: SessionSurfaceProvider = noopSessionSurface;
    const h = harness([row()], { providerFor: () => current });
    await h.runtime.start();
    await h.runtime.tick();
    expect(h.runtime.has('ag-1')).toBe(false);
    expect(h.patches).toHaveLength(0);

    current = h.provider as unknown as SessionSurfaceProvider;
    await h.runtime.add(row());
    await h.runtime.tick();
    expect(h.provider.status).toHaveBeenCalledTimes(1);
    await h.runtime.stop();
  });

  it('refresh of another platform leaves the binding alone', async () => {
    let registered: SessionSurfaceProvider | null = null;
    const h = harness([row()], { providerFor: () => registered });
    await h.runtime.start();
    registered = h.provider as unknown as SessionSurfaceProvider;
    await h.runtime.refresh('other');
    expect(h.runtime.has('ag-1')).toBe(false);
    await h.runtime.stop();
  });
});

describe('diff publish retries', () => {
  it('a failed publish keeps the turn pending: the next healthy tick retries once, then persists the turn', async () => {
    const h = harness([row({ last_status: 'active', last_status_at: iso(T0 - 60_000), last_turn_seq: 1 })]);
    h.diff = { content: 'diff --git a/x b/x\n+1\n', truncated: false };
    h.provider.view.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await h.runtime.start();
    h.observation = { running: true, turn: stamp('idle', 2, T0) };
    await h.runtime.tick();
    expect(h.provider.view).toHaveBeenCalledTimes(1);
    expect(h.patches.find(([, p]) => p.last_turn_seq === 2)).toBeUndefined();

    h.clock.now += 5_000;
    await h.runtime.tick();
    expect(h.provider.view).toHaveBeenCalledTimes(2);
    expect(h.patches.find(([, p]) => p.last_turn_seq === 2)).toBeTruthy();

    h.clock.now += 5_000;
    await h.runtime.tick();
    expect(h.provider.view).toHaveBeenCalledTimes(2);
    await h.runtime.stop();
  });

  it('a failed read of the tree (exec failure) is not a clean tree: it is retried the same way and then published', async () => {
    const h = harness([row({ last_status: 'active', last_status_at: iso(T0 - 60_000), last_turn_seq: 1 })]);
    let collects = 0;
    h.runtime = new SessionSurfaceRuntime({
      providerFor: () => h.provider as unknown as SessionSurfaceProvider,
      listBindings: async () => [row({ last_status: 'active', last_status_at: iso(T0 - 60_000), last_turn_seq: 1 })],
      observe: async () => h.observation,
      collectDiff: async () => {
        collects += 1;
        if (collects === 1) return { ok: false, error: new Error('exec failed') };
        if (collects === 2) throw new Error('exec threw');
        return { ok: true, view: { content: 'd\n', truncated: false } };
      },
      interrupt: h.interrupt,
      persist: async (id, patch) => {
        h.patches.push([id, patch]);
      },
      now: () => h.clock.now,
      watchEvents: false,
    });
    await h.runtime.start();
    h.observation = { running: true, turn: stamp('idle', 2, T0) };
    await h.runtime.tick();
    expect(h.provider.view).not.toHaveBeenCalled();
    expect(h.patches.find(([, p]) => p.last_turn_seq === 2)).toBeUndefined();
    h.clock.now += 5_000;
    await h.runtime.tick();
    expect(h.provider.view).not.toHaveBeenCalled();
    h.clock.now += 5_000;
    await h.runtime.tick();
    expect(h.provider.view).toHaveBeenCalledTimes(1);
    expect(h.patches.at(-1)).toEqual(['ag-1', { last_turn_seq: 2 }]);
    await h.runtime.stop();
  });

  it('after MAX_DIFF_ATTEMPTS failures the turn is given up and persisted, with no further attempts', async () => {
    const h = harness([row({ last_status: 'active', last_status_at: iso(T0 - 60_000), last_turn_seq: 1 })]);
    h.diff = { content: 'd\n', truncated: false };
    h.provider.view.mockRejectedValue(new Error('down'));
    await h.runtime.start();
    h.observation = { running: true, turn: stamp('idle', 2, T0) };
    for (let i = 0; i < MAX_DIFF_ATTEMPTS + 2; i++) {
      await h.runtime.tick();
      h.clock.now += 5_000;
    }
    expect(h.provider.view).toHaveBeenCalledTimes(MAX_DIFF_ATTEMPTS);
    expect(h.patches.find(([, p]) => p.last_turn_seq === 2)).toBeTruthy();
    await h.runtime.stop();
  });

  it('a newer completed turn supersedes the pending one; a busy stamp does not advance the persisted seq past it', async () => {
    const h = harness([row({ last_status: 'active', last_status_at: iso(T0 - 60_000), last_turn_seq: 1 })]);
    h.diff = { content: 'd\n', truncated: false };
    h.provider.view.mockRejectedValueOnce(new Error('down'));
    await h.runtime.start();
    h.observation = { running: true, turn: stamp('idle', 2, T0) };
    await h.runtime.tick();
    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('busy', 3, h.clock.now) };
    await h.runtime.tick();
    expect(h.patches.find(([, p]) => p.last_turn_seq === 3)).toBeUndefined();
    h.clock.now += 5_000;
    h.diff = { content: 'd2\n', truncated: false };
    h.observation = { running: true, turn: stamp('idle', 4, h.clock.now) };
    await h.runtime.tick();
    expect(h.provider.view).toHaveBeenLastCalledWith(H1, expect.objectContaining({ content: 'd2\n' }));
    expect(h.patches.at(-1)).toEqual(['ag-1', { last_turn_seq: 4 }]);
    await h.runtime.stop();
  });
});

describe('diff view after a turn', () => {
  it('renders the diff when a turn completes, skips an unchanged tree, persists the turn seq', async () => {
    const h = harness([row({ last_status: 'active', last_status_at: iso(T0 - 60_000) })]);
    await h.runtime.start();
    h.observation = { running: true, turn: stamp('busy', 1, T0) };
    await h.runtime.tick();
    expect(h.provider.view).not.toHaveBeenCalled();
    expect(h.patches.find(([, p]) => p.last_turn_seq === 1)).toBeTruthy();

    h.clock.now += 5_000;
    h.diff = { content: 'diff --git a/x b/x\n+1\n', truncated: false, headBranch: 'work' };
    h.observation = { running: true, turn: stamp('idle', 2, h.clock.now) };
    await h.runtime.tick();
    expect(h.provider.view).toHaveBeenCalledWith(H1, {
      key: 'diff',
      type: 'diff',
      name: 'Changes',
      content: 'diff --git a/x b/x\n+1\n',
      headBranch: 'work',
    });
    expect(h.patches.find(([, p]) => p.last_turn_seq === 2)).toBeTruthy();
    expect(h.provider.status).toHaveBeenLastCalledWith(H1, 'active', {});

    // Next turn, same tree: no second view.
    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('busy', 3, h.clock.now) };
    await h.runtime.tick();
    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('idle', 4, h.clock.now) };
    await h.runtime.tick();
    expect(h.provider.view).toHaveBeenCalledTimes(1);

    // An empty diff (not a repo, or clean) sends nothing.
    h.diff = null;
    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('busy', 5, h.clock.now) };
    await h.runtime.tick();
    h.observation = { running: true, turn: stamp('idle', 6, h.clock.now) };
    await h.runtime.tick();
    expect(h.provider.view).toHaveBeenCalledTimes(1);
    await h.runtime.stop();
  });

  it('a diff refused because the session is stopped is not an error', async () => {
    const h = harness([row({ last_status: 'active', last_status_at: iso(T0 - 60_000), last_turn_seq: 1 })]);
    h.diff = { content: 'd', truncated: false };
    h.provider.view.mockRejectedValueOnce(new SurfaceError('stopped', 's'));
    await h.runtime.start();
    h.observation = { running: true, turn: stamp('idle', 2, T0) };
    await expect(h.runtime.tick()).resolves.toBeUndefined();
    expect(h.runtime.has('ag-1')).toBe(true);
    await h.runtime.stop();
  });
});

describe('stop from the surface', () => {
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
    expect(h.provider.status).not.toHaveBeenCalled();

    // The next message from the surface wakes the container and starts a turn.
    h.clock.now += 5_000;
    h.observation = { running: true, turn: stamp('busy', 4, h.clock.now - 100) };
    await h.runtime.tick();
    expect(h.provider.status).toHaveBeenCalledWith(H1, 'processing', { resume: true });
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
    expect(h.provider.status).not.toHaveBeenCalled();
    h.observation = { running: true, turn: stamp('busy', 3, T0) };
    h.clock.now = T0 + 1_000;
    await h.runtime.tick();
    expect(h.provider.status).toHaveBeenCalledWith(H1, 'processing', { resume: true });
    await h.runtime.stop();
  });
});

/** A hand-written long-poll: the first page carries `page`, the second hangs until the runtime aborts it. */
function pollingProvider(page: SurfaceEvent[], cursor: string, seen: { since: (string | null)[] }) {
  let polls = 0;
  const events: SessionSurfaceProvider['events'] = async (_handle, since, _wait, signal) => {
    polls += 1;
    seen.since.push(since);
    if (polls === 1) return { events: page, cursor };
    await new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }));
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  return { status: async () => {}, view: async () => {}, events } as unknown as SessionSurfaceProvider;
}

describe('event loop', () => {
  it('consumes the long-poll: a stop event interrupts and the cursor is persisted', async () => {
    const seen = { since: [] as (string | null)[] };
    const provider = pollingProvider([{ type: 'stop', ts: iso(T0), user: 'U1' }], 'EVT#1', seen);
    const h = harness([row({ events_cursor: 'EVT#0' })], {
      watchEvents: true,
      pollWaitSeconds: 1,
      providerFor: () => provider,
    });
    await h.runtime.start();
    const cursorPersisted = () => h.patches.some(([, p]) => p.events_cursor === 'EVT#1');
    for (let i = 0; i < 200 && !cursorPersisted(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(cursorPersisted()).toBe(true);
    expect(seen.since[0]).toBe('EVT#0');
    expect(h.interrupt).toHaveBeenCalledWith('ag-1');
    expect(h.patches.some(([, p]) => 'stopped_at' in p)).toBe(true);
    await h.runtime.stop();
  });

  it('a gone surface ends its loop and retires the binding', async () => {
    const h = harness([row()], { watchEvents: true, pollWaitSeconds: 1 });
    h.provider.events.mockRejectedValue(new SurfaceError('gone', 'gone'));
    await h.runtime.start();
    for (let i = 0; i < 20 && h.runtime.has('ag-1'); i++) await new Promise((r) => setImmediate(r));
    expect(h.runtime.has('ag-1')).toBe(false);
    expect(h.patches.at(-1)?.[1]).toHaveProperty('archived_at');
    await h.runtime.stop();
  });

  it('a "stopped" refusal from the poll is honoured as a stop, and the loop goes on', async () => {
    const h = harness([row()], { watchEvents: true, pollWaitSeconds: 1 });
    h.provider.events.mockRejectedValueOnce(new SurfaceError('stopped', 'stopped'));
    await h.runtime.start();
    for (let i = 0; i < 200 && !h.interrupt.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.interrupt).toHaveBeenCalledWith('ag-1');
    expect(h.patches.some(([, p]) => 'stopped_at' in p)).toBe(true);
    expect(h.runtime.has('ag-1')).toBe(true);
    await h.runtime.stop();
  });

  it('a command, a membership change, a thread stop and an unknown type are logged and dropped', async () => {
    const page: SurfaceEvent[] = [
      { type: 'command', command: '/terminal', text: '', user: 'U1' },
      { type: 'member_joined', member: { id: 'U2' } },
      { type: 'stop', threadId: '1700000000.000100', user: 'U1' },
      { type: 'something_newer' } as unknown as SurfaceEvent,
    ];
    const seen = { since: [] as (string | null)[] };
    const h = harness([row()], {
      watchEvents: true,
      pollWaitSeconds: 1,
      providerFor: () => pollingProvider(page, 'EVT#4', seen),
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
