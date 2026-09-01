import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-nanoco-approver-bindings' };
});

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { GatewayApprovalStore } from '../../nanoco/approval-store.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import './nanoco-approver-bindings.js';

const HOST = { caller: 'host' as const };
const AGENT = {
  caller: 'agent' as const,
  sessionId: 'session-1',
  agentGroupId: 'agent-1',
  messagingGroupId: 'messaging-1',
};

function bind(args: Record<string, unknown>, caller: CallerContext = HOST) {
  return dispatch(
    {
      id: 'bind-1',
      command: 'nanoco-approver-bindings-set',
      args,
    },
    caller,
  );
}

describe('NanoCo approver binding CLI seam', () => {
  beforeEach(async () => {
    await runMigrations(await initTestDb());
    await getDb().run(
      `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (?, 'cli', 'Smoke Approver', ?)`,
      'cli:local',
      new Date().toISOString(),
    );
  });

  afterEach(async () => closeDb());

  it('lets only the trusted host bind an exact principal to an existing user', async () => {
    const args = {
      issuer: 'https://smoke.invalid',
      subject: 'smoke-approver',
      user_id: 'cli:local',
    };
    expect(await bind({ spec: JSON.stringify(args) })).toMatchObject({ ok: true });
    expect(
      await new GatewayApprovalStore(getDb(), 'deployment-smoke').resolveApprover(args.issuer, args.subject),
    ).toEqual({ status: 'unique', userId: 'cli:local' });

    expect(await bind({ spec: JSON.stringify(args) }, AGENT)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
  });

  it('fails closed for an invalid issuer or a missing delivery user', async () => {
    expect(
      await bind({
        spec: JSON.stringify({
          issuer: 'okta:smoke.invalid',
          subject: 'smoke-approver',
          user_id: 'cli:local',
        }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(
      await bind({
        spec: JSON.stringify({
          issuer: 'https://smoke.invalid',
          subject: 'smoke-approver',
          user_id: 'cli:missing',
        }),
      }),
    ).toMatchObject({ ok: false, error: { code: 'handler-error' } });
  });
});
