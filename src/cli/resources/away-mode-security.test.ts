/**
 * Security regression coverage for the Away Mode CLI resources.
 *
 * away-mode-queue and away-mode-sessions must be reachable ONLY by the host
 * caller (Claude Code / Kirk over the trusted Unix socket), never by any
 * agent container -- including a `cli_scope: 'global'` agent (Pepper's own
 * scope today), which `GROUP_SCOPE_RESOURCES` (src/cli/registry.ts) does not
 * gate at all. This file drives the real, registered commands through the
 * real dispatch()/guard() path -- not a synthetic stand-in -- so it exercises
 * exactly what a live container caller would hit.
 *
 * Ported from old commit 0fb28c04, adapted from the pre-async central DB
 * and sync createAgentGroup/ensureContainerConfig to their current async
 * equivalents -- no behavior change. The OperationSpec/hostOnly mechanism
 * this depends on landed standalone in 4d39c31d.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
// Side-effect imports: register the real away-mode-queue / away-mode-sessions
// commands, and (via away-mode-queue's import of away-mode-decisions)
// registerMigration() for both away_mode tables.
import './away-mode-sessions.js';
import './away-mode-queue.js';

const HOST: CallerContext = { caller: 'host' };

function globalAgent(agentGroupId: string): CallerContext {
  return { caller: 'agent', sessionId: 's-global', agentGroupId, messagingGroupId: 'mg-x' };
}
function groupAgent(agentGroupId: string): CallerContext {
  return { caller: 'agent', sessionId: 's-group', agentGroupId, messagingGroupId: 'mg-x' };
}

function now(): string {
  return new Date().toISOString();
}

function send(command: string, args: Record<string, unknown>, ctx: CallerContext) {
  return dispatch({ id: 'test', command, args }, ctx);
}

const GLOBAL_AGENT_ID = 'ag-global-1';
const GROUP_AGENT_ID = 'ag-group-1';

async function seedSession(id: string, status: 'ACTIVE' | 'STOPPED' = 'ACTIVE'): Promise<void> {
  await getDb().run(
    `INSERT INTO away_mode_sessions (id, started_at, stopped_at, status, deployment_allowlist)
     VALUES (?, ?, ?, ?, '[]')`,
    id,
    now(),
    status === 'STOPPED' ? now() : null,
    status,
  );
}

async function seedQueueItem(id: string, sessionId: string): Promise<void> {
  await getDb().run(
    `INSERT INTO away_mode_queue (id, session_id, position, title, goal, created_at, updated_at)
     VALUES (?, ?, 1, 'Test item', 'Test goal', ?, ?)`,
    id,
    sessionId,
    now(),
    now(),
  );
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({
    id: GLOBAL_AGENT_ID,
    name: 'Global Agent',
    folder: 'global',
    agent_provider: null,
    created_at: now(),
  });
  await ensureContainerConfig(GLOBAL_AGENT_ID);
  await updateContainerConfigScalars(GLOBAL_AGENT_ID, { cli_scope: 'global' });

  await createAgentGroup({
    id: GROUP_AGENT_ID,
    name: 'Group Agent',
    folder: 'group',
    agent_provider: null,
    created_at: now(),
  });
  await ensureContainerConfig(GROUP_AGENT_ID); // defaults to cli_scope: 'group'
});

afterEach(async () => {
  await closeDb();
});

describe('away-mode-sessions is host-only for every operation', () => {
  it('rejects a global-scope agent from list/get/create/update', async () => {
    await seedSession('ams-1');
    const ctx = globalAgent(GLOBAL_AGENT_ID);

    const list = await send('away-mode-sessions-list', {}, ctx);
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.error.code).toBe('forbidden');

    const get = await send('away-mode-sessions-get', { id: 'ams-1' }, ctx);
    expect(get.ok).toBe(false);
    if (!get.ok) expect(get.error.code).toBe('forbidden');

    const create = await send('away-mode-sessions-create', {}, ctx);
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.error.code).toBe('forbidden');

    const update = await send('away-mode-sessions-update', { id: 'ams-1', status: 'STOPPED' }, ctx);
    expect(update.ok).toBe(false);
    if (!update.ok) expect(update.error.code).toBe('forbidden');
  });

  it('rejects a group-scope agent from list/get/create/update too', async () => {
    await seedSession('ams-2');
    const ctx = groupAgent(GROUP_AGENT_ID);

    for (const [command, args] of [
      ['away-mode-sessions-list', {}],
      ['away-mode-sessions-get', { id: 'ams-2' }],
      ['away-mode-sessions-create', {}],
      ['away-mode-sessions-update', { id: 'ams-2', status: 'STOPPED' }],
    ] as const) {
      const resp = await send(command, args, ctx);
      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.code).toBe('forbidden');
    }
  });

  it('still works for the host caller', async () => {
    await seedSession('ams-3');

    const list = await send('away-mode-sessions-list', {}, HOST);
    expect(list.ok).toBe(true);

    const get = await send('away-mode-sessions-get', { id: 'ams-3' }, HOST);
    expect(get.ok).toBe(true);

    const update = await send('away-mode-sessions-update', { id: 'ams-3', status: 'STOPPED' }, HOST);
    expect(update.ok).toBe(true);

    const create = await send(
      'away-mode-sessions-create',
      { authority_level: 'A', special_instructions: 'host-created' },
      HOST,
    );
    expect(create.ok).toBe(true);
  });
});

describe('away-mode-queue is host-only for every operation, including ask-kirk', () => {
  it('rejects a global-scope agent from list/get/create/update', async () => {
    await seedSession('ams-4');
    await seedQueueItem('qi-1', 'ams-4');
    const ctx = globalAgent(GLOBAL_AGENT_ID);

    const list = await send('away-mode-queue-list', {}, ctx);
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.error.code).toBe('forbidden');

    const get = await send('away-mode-queue-get', { id: 'qi-1' }, ctx);
    expect(get.ok).toBe(false);
    if (!get.ok) expect(get.error.code).toBe('forbidden');

    const create = await send(
      'away-mode-queue-create',
      { session_id: 'ams-4', position: 2, title: 'x', goal: 'x' },
      ctx,
    );
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.error.code).toBe('forbidden');

    const update = await send('away-mode-queue-update', { id: 'qi-1', status: 'COMPLETED' }, ctx);
    expect(update.ok).toBe(false);
    if (!update.ok) expect(update.error.code).toBe('forbidden');
  });

  it('rejects a group-scope agent from list/get/create/update too', async () => {
    await seedSession('ams-5');
    await seedQueueItem('qi-2', 'ams-5');
    const ctx = groupAgent(GROUP_AGENT_ID);

    for (const [command, args] of [
      ['away-mode-queue-list', {}],
      ['away-mode-queue-get', { id: 'qi-2' }],
      ['away-mode-queue-create', { session_id: 'ams-5', position: 2, title: 'x', goal: 'x' }],
      ['away-mode-queue-update', { id: 'qi-2', status: 'COMPLETED' }],
    ] as const) {
      const resp = await send(command, args, ctx);
      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.code).toBe('forbidden');
    }
  });

  it('rejects ask-kirk for a global-scope agent (must stay host-only, never agent-initiated)', async () => {
    await seedSession('ams-6');
    await seedQueueItem('qi-3', 'ams-6');
    const resp = await send(
      'away-mode-queue-ask-kirk',
      { id: 'qi-3', question: 'proceed?' },
      globalAgent(GLOBAL_AGENT_ID),
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('forbidden');
  });

  it('still works for the host caller', async () => {
    await seedSession('ams-7');
    await seedQueueItem('qi-4', 'ams-7');

    const list = await send('away-mode-queue-list', {}, HOST);
    expect(list.ok).toBe(true);

    const get = await send('away-mode-queue-get', { id: 'qi-4' }, HOST);
    expect(get.ok).toBe(true);

    const create = await send(
      'away-mode-queue-create',
      { session_id: 'ams-7', position: 2, title: 'second item', goal: 'do the thing' },
      HOST,
    );
    expect(create.ok).toBe(true);
  });
});

describe('an agent cannot mutate the specific fields the authority model depends on', () => {
  it('cannot change deployment_allowlist (would self-grant Level-B deployment authority)', async () => {
    await seedSession('ams-8');
    const resp = await send(
      'away-mode-sessions-update',
      { id: 'ams-8', deployment_allowlist: JSON.stringify(['prod-deploy']) },
      globalAgent(GLOBAL_AGENT_ID),
    );
    expect(resp.ok).toBe(false);

    const row = (await getDb().get<{ deployment_allowlist: string }>(
      'SELECT deployment_allowlist FROM away_mode_sessions WHERE id = ?',
      'ams-8',
    ))!;
    expect(row.deployment_allowlist).toBe('[]');
  });

  it('cannot forge kirk_questions / answer_text onto a queue item', async () => {
    await seedSession('ams-9');
    await seedQueueItem('qi-5', 'ams-9');
    const forged = JSON.stringify([
      { question_id: 'fake', asked_at: now(), question_text: 'x', answered_at: now(), answer_text: 'approve' },
    ]);
    const resp = await send(
      'away-mode-queue-update',
      { id: 'qi-5', kirk_questions: forged },
      globalAgent(GLOBAL_AGENT_ID),
    );
    expect(resp.ok).toBe(false);

    const row = (await getDb().get<{ kirk_questions: string }>(
      'SELECT kirk_questions FROM away_mode_queue WHERE id = ?',
      'qi-5',
    ))!;
    expect(JSON.parse(row.kirk_questions)).toEqual([]);
  });

  it('cannot flip a STOPPED session back to ACTIVE', async () => {
    await seedSession('ams-10', 'STOPPED');
    const resp = await send(
      'away-mode-sessions-update',
      { id: 'ams-10', status: 'ACTIVE' },
      globalAgent(GLOBAL_AGENT_ID),
    );
    expect(resp.ok).toBe(false);

    const row = (await getDb().get<{ status: string }>('SELECT status FROM away_mode_sessions WHERE id = ?', 'ams-10'))!;
    expect(row.status).toBe('STOPPED');
  });
});

describe('away-mode-queue preUpdate guard: IN_PROGRESS requires an ACTIVE parent session', () => {
  it('rejects the transition (host caller) when the parent session is STOPPED', async () => {
    await seedSession('ams-11', 'STOPPED');
    await seedQueueItem('qi-6', 'ams-11');

    const resp = await send('away-mode-queue-update', { id: 'qi-6', status: 'IN_PROGRESS' }, HOST);
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toContain('is not ACTIVE');
    }

    const row = (await getDb().get<{ status: string }>('SELECT status FROM away_mode_queue WHERE id = ?', 'qi-6'))!;
    expect(row.status).toBe('QUEUED');
  });

  it('allows the transition (host caller) when the parent session is ACTIVE', async () => {
    await seedSession('ams-12', 'ACTIVE');
    await seedQueueItem('qi-7', 'ams-12');

    const resp = await send('away-mode-queue-update', { id: 'qi-7', status: 'IN_PROGRESS' }, HOST);
    expect(resp.ok).toBe(true);

    const row = (await getDb().get<{ status: string }>('SELECT status FROM away_mode_queue WHERE id = ?', 'qi-7'))!;
    expect(row.status).toBe('IN_PROGRESS');
  });

  it('still allows finishing an already-resolved item (COMPLETED/BLOCKED) under a stopped session', async () => {
    await seedSession('ams-13', 'STOPPED');
    await seedQueueItem('qi-8', 'ams-13');

    const resp = await send('away-mode-queue-update', { id: 'qi-8', status: 'COMPLETED' }, HOST);
    expect(resp.ok).toBe(true);
  });
});
