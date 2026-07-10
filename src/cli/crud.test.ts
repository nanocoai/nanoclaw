import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `groups.ts`'s postCreate calls `initGroupFilesystem`, which touches the
// real filesystem (groups/<folder>, data/v2-sessions/<id>/.claude-shared).
// We're not testing the filesystem layout here — we're testing that the
// hook fires with the inserted row — so mock the FS-touching helper and
// keep only the DB side effect (`ensureContainerConfig`) as the observable.
const ensureContainerConfigSpy = vi.fn();
vi.mock('../group-init.js', async () => {
  const { ensureContainerConfig } = await import('../db/container-configs.js');
  return {
    initGroupFilesystem: vi.fn((group: { id: string }) => {
      ensureContainerConfigSpy(group.id);
      ensureContainerConfig(group.id);
    }),
  };
});

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// `wirings.ts`'s postCommit projects the new destination into every running
// session's `inbound.db` via the agent-to-agent module's `writeDestinations`.
// That helper opens on-disk session DB files we don't have in a unit test, so
// mock it and observe that the projection is invoked per live session.
const writeDestinationsSpy = vi.fn();
vi.mock('../modules/agent-to-agent/write-destinations.js', () => ({
  writeDestinations: (...args: unknown[]) => writeDestinationsSpy(...args),
}));

import { initTestDb, closeDb, getDb, runMigrations, createAgentGroup, createMessagingGroup } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import { getContainerConfig } from '../db/container-configs.js';
import { getDestinations } from '../modules/agent-to-agent/db/agent-destinations.js';
import { registerResource } from './crud.js';
import { lookup } from './registry.js';

// Importing these for side effects: each calls `registerResource` at
// module top-level, which wires up the `groups-create` / `wirings-create`
// handlers we exercise below.
import '../cli/resources/groups.js';
import '../cli/resources/wirings.js';

const hostCtx = { caller: 'host' as const };

// Synthetic resource exercising the two-pass create: pass 1 collects explicit
// args, pass 2 runs the resolveDefaults hook, pass 3 fills static defaults.
// Registered once at module load like the real resources above; its table is
// created per-test in the describe's beforeEach.
const hookCalls: Record<string, unknown>[] = [];
registerResource({
  name: 'hooktest',
  plural: 'hooktests',
  table: 'hooktest_rows',
  description: 'Synthetic resource for resolveDefaults hook-ordering tests.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'kind', type: 'string', description: 'test input', required: true },
    { name: 'mode', type: 'string', description: 'hook-fillable column', default: 'static' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { create: 'open' },
  resolveDefaults: (values) => {
    hookCalls.push({ ...values });
    if (values.kind === 'boom') throw new Error('hook rejected');
    if (values.mode === undefined && values.kind === 'fill') values.mode = 'hooked';
  },
});

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  ensureContainerConfigSpy.mockClear();
  writeDestinationsSpy.mockClear();
});

afterEach(() => {
  closeDb();
});

describe('genericCreate postCreate hook', () => {
  it('groups-create writes the companion container_configs row', async () => {
    const cmd = lookup('groups-create');
    expect(cmd, 'groups-create command must be registered').toBeDefined();

    const result = (await cmd!.handler({ name: 'Test', folder: 'test' }, hostCtx)) as { id: string };

    // Hook fired with the just-inserted row (incl. generated `id`).
    expect(ensureContainerConfigSpy).toHaveBeenCalledWith(result.id);

    // Visible side effect: container_configs row exists for the new group.
    // Without postCreate, this was empty and the first spawn threw
    // "Container config not found" — issue #2415.
    const config = getContainerConfig(result.id);
    expect(config).toBeDefined();
    expect(config!.agent_group_id).toBe(result.id);
  });

  it('wirings-create writes the companion agent_destinations row', async () => {
    // Seed the FKs that the wiring references.
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent One',
      folder: 'agent-one',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'channel-123',
      name: 'general',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });

    const cmd = lookup('wirings-create');
    expect(cmd, 'wirings-create command must be registered').toBeDefined();

    await cmd!.handler({ messaging_group_id: 'mg-1', agent_group_id: 'ag-1' }, hostCtx);

    // Visible side effect: a destination row was created so the agent can
    // address this chat as a delivery target. Without postCreate, this was
    // empty and the agent's replies were silently dropped by the delivery
    // ACL — issue #2389.
    const destinations = getDestinations('ag-1');
    expect(destinations).toHaveLength(1);
    expect(destinations[0].target_type).toBe('channel');
    expect(destinations[0].target_id).toBe('mg-1');
  });
});

describe('genericCreate postCommit hook', () => {
  it('wirings-create projects the new destination into live sessions', async () => {
    createAgentGroup({
      id: 'ag-1',
      name: 'Agent One',
      folder: 'agent-one',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'channel-123',
      name: 'general',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    // A container is already running for this agent — its session inbound.db
    // holds a stale destination projection.
    createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    const cmd = lookup('wirings-create');
    await cmd!.handler({ messaging_group_id: 'mg-1', agent_group_id: 'ag-1' }, hostCtx);

    // Live-refresh parity with `ncl destinations add`: without postCommit the
    // running container keeps serving the stale projection and drops replies
    // to this chat as "unknown destination" until a restart — issue #2389.
    expect(writeDestinationsSpy).toHaveBeenCalledWith('ag-1', 'sess-1');
  });

  it('wirings-create projection is a no-op when no sessions are running', async () => {
    createAgentGroup({
      id: 'ag-2',
      name: 'Agent Two',
      folder: 'agent-two',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'channel-456',
      name: 'ops',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });

    const cmd = lookup('wirings-create');
    await cmd!.handler({ messaging_group_id: 'mg-2', agent_group_id: 'ag-2' }, hostCtx);

    // No live session for ag-2 → nothing to project, and the central
    // destination row was still written (covered above).
    expect(writeDestinationsSpy).not.toHaveBeenCalled();
  });
});

describe('genericCreate resolveDefaults hook (two-pass create)', () => {
  beforeEach(() => {
    getDb().exec(
      `CREATE TABLE hooktest_rows (id TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT, created_at TEXT NOT NULL)`,
    );
    hookCalls.length = 0;
  });

  it('runs between explicit args and static defaults — a hook fill beats the static default', async () => {
    const row = (await lookup('hooktests-create')!.handler({ kind: 'fill' }, hostCtx)) as { mode: string };
    expect(row.mode).toBe('hooked');
    // The hook saw the pre-static-default state: mode still unset. Were the
    // static default applied first, the hook could never fill it.
    expect(hookCalls[0].mode).toBeUndefined();
  });

  it('static default still applies when the hook leaves the column unset', async () => {
    const row = (await lookup('hooktests-create')!.handler({ kind: 'plain' }, hostCtx)) as { mode: string };
    expect(row.mode).toBe('static');
  });

  it('explicit args always win over the hook', async () => {
    const row = (await lookup('hooktests-create')!.handler({ kind: 'fill', mode: 'explicit' }, hostCtx)) as {
      mode: string;
    };
    expect(row.mode).toBe('explicit');
    expect(hookCalls[0].mode).toBe('explicit');
  });

  it('a hook throw rejects the create and nothing is inserted', async () => {
    await expect(lookup('hooktests-create')!.handler({ kind: 'boom' }, hostCtx)).rejects.toThrow('hook rejected');
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM hooktest_rows').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
