/**
 * Door-created sandboxes carry an owner of record (provisioning substrate
 * section 9). The gateway resolves session-channel identity from the group's
 * provisioned user — a sandbox without one has every governed egress
 * connection silently reset, so resolution failures must refuse loudly at
 * create time, and only a genuinely empty directory may resolve null.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../container-runner.js')>();
  return { ...orig, wakeContainer: vi.fn(async (): Promise<boolean> => false) };
});
vi.mock('../../drivers/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../drivers/index.js')>();
  return { ...orig, getSessionDriver: vi.fn() };
});
vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-sandbox-owner/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-sandbox-owner/groups',
  };
});

const TEST_ROOT = '/tmp/nanoclaw-test-sandbox-owner';

import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, RequestFrame, ResponseFrame } from '../frame.js';
// Side-effect imports: register the sandboxes-* commands and the code-mode
// migrations the verbs write through.
import './sandboxes.js';
import '../../code-mode/index.js';

const HOST: CallerContext = { caller: 'host' };

function call(command: string, args: Record<string, unknown> = {}): Promise<ResponseFrame> {
  const req: RequestFrame = { id: `r-${Math.random().toString(36).slice(2, 8)}`, command, args };
  return dispatch(req, HOST);
}

function errMsg(res: ResponseFrame): string {
  if (res.ok) throw new Error('expected an error response');
  return res.error.message;
}

async function seedUser(id: string): Promise<void> {
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'slack', ?, ?)`,
    id,
    id,
    new Date().toISOString(),
  );
}

async function ownerRow(folder: string): Promise<string | null> {
  const row = await getDb().get<{ o: string | null }>(
    'SELECT provisioned_user_id AS o FROM agent_groups WHERE folder = ?',
    folder,
  );
  if (!row) throw new Error(`no group row for ${folder}`);
  return row.o;
}

const savedEnv = process.env.NANOCLAW_SANDBOX_OWNER;

describe('sandboxes new — owner of record', () => {
  beforeEach(async () => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(path.join(TEST_ROOT, 'groups'), { recursive: true });
    await runMigrations(await initTestDb());
    delete process.env.NANOCLAW_SANDBOX_OWNER;
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.NANOCLAW_SANDBOX_OWNER;
    else process.env.NANOCLAW_SANDBOX_OWNER = savedEnv;
    await closeDb();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('an empty directory resolves null — plain OSS installs keep working', async () => {
    const res = await call('sandboxes-new', { name: 'bare', 'no-attach': true });
    expect(res.ok).toBe(true);
    expect(await ownerRow('bare')).toBeNull();
  });

  it('--owner sets the provisioned user when the user is known', async () => {
    await seedUser('slack:U1OWNER');
    const res = await call('sandboxes-new', { name: 'owned', owner: 'slack:U1OWNER', 'no-attach': true });
    expect(res.ok).toBe(true);
    expect(await ownerRow('owned')).toBe('slack:U1OWNER');
  });

  it('an unknown --owner refuses and creates nothing', async () => {
    await seedUser('slack:U1OWNER');
    const res = await call('sandboxes-new', { name: 'ghost', owner: 'slack:UNOBODY', 'no-attach': true });
    expect(errMsg(res)).toContain('not a known user');
    expect(await getAgentGroupByFolder('ghost')).toBeUndefined();
  });

  it('NANOCLAW_SANDBOX_OWNER is the flagless fallback', async () => {
    await seedUser('slack:U2ENV');
    process.env.NANOCLAW_SANDBOX_OWNER = 'slack:U2ENV';
    const res = await call('sandboxes-new', { name: 'via-env', 'no-attach': true });
    expect(res.ok).toBe(true);
    expect(await ownerRow('via-env')).toBe('slack:U2ENV');
  });

  it('a sole global owner row resolves without a flag', async () => {
    await seedUser('slack:U3SOLE');
    await getDb().run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
         VALUES (?, 'owner', NULL, NULL, ?)`,
      'slack:U3SOLE',
      new Date().toISOString(),
    );
    const res = await call('sandboxes-new', { name: 'sole', 'no-attach': true });
    expect(res.ok).toBe(true);
    expect(await ownerRow('sole')).toBe('slack:U3SOLE');
  });

  it('a populated directory with no unambiguous owner refuses loudly', async () => {
    await seedUser('slack:U4A');
    await seedUser('slack:U4B');
    const res = await call('sandboxes-new', { name: 'whose', 'no-attach': true });
    const msg = errMsg(res);
    expect(msg).toContain('--owner');
    expect(msg).toContain('NANOCLAW_SANDBOX_OWNER');
    expect(await getAgentGroupByFolder('whose')).toBeUndefined();
  });
});
