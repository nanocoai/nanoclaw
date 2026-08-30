import { describe, it, expect, afterEach, vi } from 'vitest';

import type { ResponseFrame } from '../../cli/frame.js';

// The controller consumer dispatches through the trunk's own dispatcher and
// writes the response with the trunk's own mailbox writer; the tests stand
// both in so the claim/dispatch/respond/delete choreography is proved without
// a live registry or session store.
const dispatchMock = vi.fn();
vi.mock('../../cli/dispatch.js', () => ({
  dispatch: (req: unknown, ctx: unknown) => dispatchMock(req, ctx),
}));
const writeSessionMessageMock = vi.fn();
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (agentGroupId: string, sessionId: string, message: unknown) =>
    writeSessionMessageMock(agentGroupId, sessionId, message),
}));

type Round = {
  roleModule: typeof import('./role.js');
  delegation: typeof import('./cli-delegation.js');
  db: typeof import('../../db/index.js');
};

let lastRound: Round | null = null;

/** Same world-per-round harness as dm-delegation.test.ts: reset every module,
 *  re-import under the role, own the whole DB lifecycle. */
async function withRole(role: string | undefined): Promise<Round> {
  vi.resetModules();
  vi.stubEnv('NANOCLAW_ROLE', role ?? '');
  const roleModule = await import('./role.js');
  const delegation = await import('./cli-delegation.js');
  const db = await import('../../db/index.js');
  const driver = await db.initSqliteTestDb();
  await db.runMigrations(driver);
  lastRound = { roleModule, delegation, db };
  return lastRound;
}

afterEach(async () => {
  dispatchMock.mockReset();
  writeSessionMessageMock.mockReset();
  vi.unstubAllEnvs();
  if (lastRound) {
    lastRound.delegation.stopCliDispatchConsumer();
    await lastRound.db.closeDb().catch(() => undefined);
    lastRound = null;
  }
});

const REQ = {
  id: 'cli-1-test',
  command: 'envs-list',
  args: { json: true },
};
const CTX = {
  caller: 'agent' as const,
  sessionId: 'sess-1',
  agentGroupId: 'ag-1',
  messagingGroupId: 'mg-1',
};

async function seedRequest(round: Round, overrides: Record<string, string> = {}): Promise<void> {
  await round.db
    .getDb()
    .run(
      `INSERT INTO controller_cli_requests
         (request_id, command, args_json, session_id, agent_group_id, messaging_group_id, requested_at, claimed_by, claimed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      overrides.request_id ?? REQ.id,
      overrides.command ?? REQ.command,
      overrides.args_json ?? JSON.stringify(REQ.args),
      CTX.sessionId,
      CTX.agentGroupId,
      CTX.messagingGroupId,
      overrides.requested_at ?? new Date().toISOString(),
      overrides.claimed_by ?? null,
      overrides.claimed_at ?? null,
    );
}

describe('isControllerOwnedCommand', () => {
  it('matches the controller-owned resources exactly or as a dash-prefix, never substrings', async () => {
    const round = await withRole(undefined);
    const owned = round.delegation.isControllerOwnedCommand;
    for (const cmd of ['envs', 'envs-list', 'envs-claim', 'stamps-set-pool', 'sandboxes-attach', 'groups-restart']) {
      expect(owned(cmd), cmd).toBe(true);
    }
    // inbox/outbox are DB-backed; user-dms is the gateway's own adapter seam;
    // "envswhatever" must not shred on a substring.
    for (const cmd of ['inbox-read', 'outbox-send', 'user-dms-ensure', 'envswhatever', 'tasks-create']) {
      expect(owned(cmd), cmd).toBe(false);
    }
  });
});

describe('gateway side — deferCliRequestToController', () => {
  it('records the durable request with the full caller context', async () => {
    const round = await withRole('gateway');
    await round.delegation.deferCliRequestToController(REQ, CTX);
    const rows = await round.db
      .getDb()
      .all<Record<string, string>>('SELECT * FROM controller_cli_requests');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_id: REQ.id,
      command: 'envs-list',
      args_json: JSON.stringify({ json: true }),
      session_id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      claimed_by: null,
      claimed_at: null,
    });
    // Nothing is dispatched or answered on this plane.
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(writeSessionMessageMock).not.toHaveBeenCalled();
  });

  it('mailbox redelivery of the same frame is an upsert that resets a stale claim, never a second row', async () => {
    const round = await withRole('gateway');
    await round.delegation.deferCliRequestToController(REQ, CTX);
    await round.db
      .getDb()
      .run('UPDATE controller_cli_requests SET claimed_by = ?, claimed_at = ?', 'dead-controller', '2020-01-01T00:00:00.000Z');
    await round.delegation.deferCliRequestToController(REQ, CTX);
    const rows = await round.db
      .getDb()
      .all<{ request_id: string; claimed_at: string | null }>(
        'SELECT request_id, claimed_at FROM controller_cli_requests',
      );
    expect(rows).toEqual([{ request_id: REQ.id, claimed_at: null }]);
  });
});

describe('controller side — consumeCliRequestsOnce', () => {
  it('claims, dispatches with the recorded agent context, writes the exact response envelope, deletes the row', async () => {
    const round = await withRole('controller');
    await seedRequest(round);
    const frame: ResponseFrame = { id: REQ.id, ok: true, data: { envs: [] } };
    dispatchMock.mockResolvedValue(frame);

    await round.delegation.consumeCliRequestsOnce();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith({ id: REQ.id, command: 'envs-list', args: { json: true } }, CTX);

    // The envelope is delivery-action's, byte for byte — the in-container
    // client must not be able to tell which plane answered.
    expect(writeSessionMessageMock).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, message] = writeSessionMessageMock.mock.calls[0]!;
    expect(agentGroupId).toBe('ag-1');
    expect(sessionId).toBe('sess-1');
    expect(message).toMatchObject({ id: `cli-resp-${REQ.id}`, kind: 'system', trigger: false });
    expect(JSON.parse((message as { content: string }).content)).toEqual({
      type: 'cli_response',
      requestId: REQ.id,
      frame,
    });

    const remaining = await round.db.getDb().all('SELECT request_id FROM controller_cli_requests');
    expect(remaining).toEqual([]);
  });

  it('a fresh claim is not stolen; a stale one is', async () => {
    const round = await withRole('controller');
    const now = new Date().toISOString();
    await seedRequest(round, { claimed_by: 'other-controller', claimed_at: now });
    await round.delegation.consumeCliRequestsOnce();
    expect(dispatchMock).not.toHaveBeenCalled();

    await round.db.getDb().run('UPDATE controller_cli_requests SET claimed_at = ?', '2020-01-01T00:00:00.000Z');
    dispatchMock.mockResolvedValue({ id: REQ.id, ok: true, data: null });
    await round.delegation.consumeCliRequestsOnce();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('an error frame from dispatch is still a written response — refusals travel, they do not strand the client', async () => {
    const round = await withRole('controller');
    await seedRequest(round);
    const refusal: ResponseFrame = {
      id: REQ.id,
      ok: false,
      error: { code: 'handler-error' as never, message: 'no such stamp' },
    };
    dispatchMock.mockResolvedValue(refusal);
    await round.delegation.consumeCliRequestsOnce();
    const [, , message] = writeSessionMessageMock.mock.calls[0]!;
    expect(JSON.parse((message as { content: string }).content).frame).toEqual(refusal);
    const remaining = await round.db.getDb().all('SELECT request_id FROM controller_cli_requests');
    expect(remaining).toEqual([]);
  });

  it('double-starting the consumer is a boot bug, not a silent second timer', async () => {
    const round = await withRole('controller');
    round.delegation.startCliDispatchConsumer(60_000);
    expect(() => round.delegation.startCliDispatchConsumer(60_000)).toThrow(/already started/);
  });
});
