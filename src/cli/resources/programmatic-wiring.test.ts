/**
 * Programmatic wiring via ncl — the verbs a converted channel skill calls from
 * `nc:run effect:wire` (so wiring is "collect input + ncl", no nc:wire directive).
 *
 * Covers the three behaviours those skills rely on:
 *   - `messaging-groups create` defaults the NOT NULL `instance` to channel_type
 *     and is idempotent (re-apply returns the same row, no UNIQUE violation).
 *   - `users create` is idempotent on the user id.
 *   - `wirings create` resolves natural keys (channel_type + platform_id → mg;
 *     agent-group folder → ag) and is idempotent on the (mg, ag) pair.
 *
 * Dispatch is invoked with `{ caller: 'host' }` — the same path setup takes —
 * so the create verbs' `access: 'approval'` gate (container agents only) is
 * bypassed, exactly as during `/setup`.
 *
 * The 'resend' channel has no registered declaration in this test env, so
 * engage/policy defaults stay legacy-static (the declaration-aware paths are
 * pinned by wirings.test.ts / messaging-groups.test.ts).
 */
import fs from 'fs';

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-programmatic-wiring' };
});

// groups-create calls initGroupFilesystem, which scaffolds under the real
// groups/ dir — neutralize the FS writes but keep the container_configs row
// the assertions below count.
vi.mock('../../group-init.js', async () => {
  const { ensureContainerConfig } = await import('../../db/container-configs.js');
  return {
    initGroupFilesystem: vi.fn((group: { id: string }) => {
      ensureContainerConfig(group.id);
    }),
  };
});

// wirings' postCommit projects destinations into live session DBs — no
// sessions run in this test, but the module must not open on-disk DB files.
vi.mock('../../modules/agent-to-agent/write-destinations.js', () => ({ writeDestinations: vi.fn() }));

const TEST_DIR = '/tmp/nanoclaw-test-cli-programmatic-wiring';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect imports: register the verbs under test.
import './messaging-groups.js';
import './wirings.js';
import './users.js';
import './groups.js';

const HOST = { caller: 'host' as const };
function now(): string {
  return new Date().toISOString();
}
function send(command: string, args: Record<string, unknown>) {
  return dispatch({ id: 'test', command, args }, HOST);
}
function count(sql: string, ...params: unknown[]): number {
  return (
    getDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

describe('programmatic wiring verbs', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
    createAgentGroup({ id: 'ag-1', name: 'Nano', folder: 'nano', agent_provider: null, created_at: now() });
  });
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('messaging-groups create defaults instance to channel_type and is idempotent', async () => {
    const r1 = await send('messaging-groups-create', {
      channel_type: 'resend',
      platform_id: 'resend:you@example.com',
      is_group: 0,
    });
    expect(r1.ok).toBe(true);
    const mg1 = (r1 as { data: Record<string, unknown> }).data;
    expect(mg1.instance).toBe('resend'); // defaulted from channel_type
    expect(mg1.is_group).toBe(0);

    const r2 = await send('messaging-groups-create', {
      channel_type: 'resend',
      platform_id: 'resend:you@example.com',
      is_group: 0,
    });
    expect(r2.ok).toBe(true);
    expect((r2 as { data: { id: string } }).data.id).toBe((mg1 as { id: string }).id); // same row
    expect(count(`SELECT COUNT(*) c FROM messaging_groups WHERE platform_id = ?`, 'resend:you@example.com')).toBe(1);
  });

  it('users create is idempotent on the user id', async () => {
    const args = { id: 'resend:you@example.com', kind: 'resend', display_name: 'Owner' };
    expect((await send('users-create', args)).ok).toBe(true);
    expect((await send('users-create', args)).ok).toBe(true); // no UNIQUE violation
    expect(count(`SELECT COUNT(*) c FROM users WHERE id = ?`, 'resend:you@example.com')).toBe(1);
  });

  it('wirings create resolves natural keys (platform_id + agent-group folder) and is idempotent', async () => {
    await send('messaging-groups-create', {
      channel_type: 'resend',
      platform_id: 'resend:you@example.com',
      is_group: 0,
    });

    const wireArgs = {
      channel_type: 'resend',
      platform_id: 'resend:you@example.com',
      agent_group: 'nano', // by FOLDER, not synthetic id
      engage_mode: 'pattern',
      engage_pattern: '.',
      session_mode: 'shared',
    };
    const w1 = await send('wirings-create', wireArgs);
    expect(w1.ok).toBe(true);
    const wiring = (w1 as { data: Record<string, unknown> }).data;
    expect(wiring.agent_group_id).toBe('ag-1'); // folder resolved to the agent group id
    expect(wiring.engage_mode).toBe('pattern');
    expect(wiring.engage_pattern).toBe('.');

    const w2 = await send('wirings-create', wireArgs);
    expect(w2.ok).toBe(true);
    expect((w2 as { data: { id: string } }).data.id).toBe((wiring as { id: string }).id); // idempotent on the pair
    expect(count(`SELECT COUNT(*) c FROM messaging_group_agents WHERE agent_group_id = ?`, 'ag-1')).toBe(1);
  });

  it('wirings create fails clearly when the messaging group has not been created yet', async () => {
    const r = await send('wirings-create', {
      channel_type: 'resend',
      platform_id: 'resend:nobody@example.com',
      agent_group: 'nano',
    });
    expect(r.ok).toBe(false);
    expect((r as { error: { message: string } }).error.message).toMatch(/no messaging group/i);
  });

  it('groups create scaffolds the container config and is idempotent on folder', async () => {
    const r1 = await send('groups-create', { folder: 'dm-with-bob', name: 'Bob' });
    expect(r1.ok).toBe(true);
    const ag = (r1 as { data: { id: string } }).data;
    expect(ag.id).toBeTruthy();
    // a working group needs a container_config row — generic create never made one
    expect(count('SELECT COUNT(*) c FROM container_configs WHERE agent_group_id = ?', ag.id)).toBe(1);
    // idempotent on folder
    const r2 = await send('groups-create', { folder: 'dm-with-bob', name: 'Bob' });
    expect((r2 as { data: { id: string } }).data.id).toBe(ag.id);
    expect(count('SELECT COUNT(*) c FROM agent_groups WHERE folder = ?', 'dm-with-bob')).toBe(1);
  });

  it('messaging-groups send errors when no group exists (lookup before routeInbound)', async () => {
    const r = await send('messaging-groups-send', {
      channel_type: 'resend',
      platform_id: 'resend:ghost@example.com',
      text: 'hi',
    });
    expect(r.ok).toBe(false);
    expect((r as { error: { message: string } }).error.message).toMatch(/no messaging group/i);
  });
});
