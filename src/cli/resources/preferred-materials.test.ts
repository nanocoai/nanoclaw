/**
 * Security regression coverage: preferred-materials create/update must hold
 * for a real Kirk approval, for every agent caller -- including a
 * cli_scope: 'global' agent (Pepper's own scope today), which
 * GROUP_SCOPE_RESOURCES never gates (see preferred-materials.ts's header
 * comment, and away-mode-security.test.ts for the same reasoning applied
 * to Away Mode). Drives the real dispatch()/guard()/crud path against the
 * real registered commands -- not a synthetic stand-in.
 *
 * Ported from old commit 3ff49bd0. Adapted from the pre-async central DB
 * (`getDb().prepare(sql).get(...)`) to the current async DbDriver
 * (`await getDb().get(sql, ...)`) -- no behavior change.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { upsertUserDm } from '../../modules/permissions/db/user-dms.js';
import { grantRole } from '../../modules/permissions/db/user-roles.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
// Side-effect import: register the real preferred-materials command.
import './preferred-materials.js';
// Side-effect import: registerMigration() must run before runMigrations()
// below sees the lowes-materials tables. In production this happens via
// src/modules/index.ts at startup; isolated test files that don't import
// the full modules barrel need this narrower import instead.
import '../../modules/lowes-materials/index.js';

const HOST: CallerContext = { caller: 'host' };
const GLOBAL_AGENT_ID = 'ag-global-pm-1';
const KIRK_USER_ID = 'telegram:8855929473';

function now(): string {
  return new Date().toISOString();
}

function send(command: string, args: Record<string, unknown>, ctx: CallerContext) {
  return dispatch({ id: 'test', command, args }, ctx);
}

let delivered: Array<{ channelType: string; platformId: string; content: string }>;
const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, _threadId, _kind, content) {
    delivered.push({ channelType, platformId, content });
    return 'pm-1';
  },
};

function candidateArgs(overrides: Record<string, unknown> = {}) {
  return {
    category: 'exterior_paint',
    brand: 'Sherwin-Williams',
    source: 'kirk_explicit',
    status: 'approved',
    ...overrides,
  };
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  delivered = [];
  setDeliveryAdapter(fakeAdapter);

  await createAgentGroup({
    id: GLOBAL_AGENT_ID,
    name: 'Global Agent',
    folder: 'global',
    agent_provider: null,
    created_at: now(),
  });
  await ensureContainerConfig(GLOBAL_AGENT_ID);
  await updateContainerConfigScalars(GLOBAL_AGENT_ID, { cli_scope: 'global' });
  await createSession({
    id: 'sess-global-pm',
    agent_group_id: GLOBAL_AGENT_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });

  // A real, resolvable Kirk approver -- so requestApproval genuinely
  // succeeds and a real pending_approvals card is created, not just "the
  // direct write fails for some unrelated reason."
  await upsertUser({ id: KIRK_USER_ID, kind: 'telegram', display_name: 'Kirk', created_at: now() });
  await grantRole({ user_id: KIRK_USER_ID, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  await createMessagingGroup({
    id: 'mg-kirk-dm-pm',
    channel_type: 'telegram',
    platform_id: '8855929473',
    name: 'Kirk DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: KIRK_USER_ID,
    channel_type: 'telegram',
    messaging_group_id: 'mg-kirk-dm-pm',
    resolved_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
});

function globalAgent(): CallerContext {
  return { caller: 'agent', sessionId: 'sess-global-pm', agentGroupId: GLOBAL_AGENT_ID, messagingGroupId: 'mg-x' };
}

describe('preferred-materials create/update require Kirk approval for every agent caller', () => {
  it('a global-scope agent cannot directly create a preferred material -- it holds for approval instead', async () => {
    const resp = await send('preferred-materials-create', candidateArgs(), globalAgent());

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');

    // No row was written -- the create handler never ran.
    const count = (await getDb().get<{ c: number }>('SELECT COUNT(*) AS c FROM preferred_materials'))!.c;
    expect(count).toBe(0);

    // A real, structured approval card was created -- not silently dropped.
    const card = await getDb().get<{ action: string; title: string }>(
      "SELECT action, title FROM pending_approvals WHERE status = 'pending'",
    );
    expect(card).toBeDefined();
    expect(card?.action).toBe('cli_command');
    expect(delivered).toHaveLength(1);
  });

  it('a global-scope agent cannot directly update a preferred material -- it holds for approval instead', async () => {
    // Seed an existing candidate row directly (bypassing the CLI, simulating
    // a prior host- or approval-created row) to attempt an update against.
    const id = 'pm-existing-1';
    await getDb().run(
      `INSERT INTO preferred_materials (id, category, brand, status, source, created_at, updated_at)
       VALUES (?, 'exterior_paint', 'Sherwin-Williams', 'candidate', 'kirk_explicit', ?, ?)`,
      id,
      now(),
      now(),
    );

    const resp = await send('preferred-materials-update', { id, status: 'approved' }, globalAgent());

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');

    // The row's status was NOT changed -- still 'candidate', never silently promoted.
    const row = await getDb().get<{ status: string }>('SELECT status FROM preferred_materials WHERE id = ?', id);
    expect(row!.status).toBe('candidate');
  });

  it('list and get remain open for a global-scope agent -- only create/update are gated', async () => {
    const id = 'pm-existing-2';
    await getDb().run(
      `INSERT INTO preferred_materials (id, category, brand, status, source, created_at, updated_at)
       VALUES (?, 'exterior_paint', 'Sherwin-Williams', 'approved', 'kirk_explicit', ?, ?)`,
      id,
      now(),
      now(),
    );

    const list = await send('preferred-materials-list', {}, globalAgent());
    expect(list.ok).toBe(true);

    const get = await send('preferred-materials-get', { id }, globalAgent());
    expect(get.ok).toBe(true);
  });

  it('the host caller can still create and update directly, unaffected by the approval gate', async () => {
    const create = await send('preferred-materials-create', candidateArgs(), HOST);
    expect(create.ok).toBe(true);

    const created = await getDb().get<{ id: string; status: string }>(
      'SELECT id, status FROM preferred_materials',
    );
    expect(created!.status).toBe('approved');

    const update = await send('preferred-materials-update', { id: created!.id, status: 'deprecated' }, HOST);
    expect(update.ok).toBe(true);

    const row = await getDb().get<{ status: string }>('SELECT status FROM preferred_materials WHERE id = ?', created!.id);
    expect(row!.status).toBe('deprecated');
  });
});
