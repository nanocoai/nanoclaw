/**
 * pr-factory-core guard — the modules-barrel line (`import
 * './pr-factory/index.js'` in src/modules/index.ts), the four pr_* delivery
 * actions, the three core-owned pr_* approval handlers, the gh-action seam's
 * not-installed fallback, and the GITHUB_WEBHOOK_SECRET env gate.
 *
 * Imports the REAL modules barrel (unmocked module graph — also exercises the
 * undici dependency through handler.ts) and asserts both registries through
 * their read sides (getDeliveryAction / getApprovalHandler). Deleting the
 * barrel line, any registerDeliveryAction call, or any registerApprovalHandler
 * call goes red.
 *
 * Env-gated import-time registration: process.env is primed BEFORE the import
 * and the legs are isolated with vi.resetModules() + a chdir to an .env-less
 * temp dir, so a developer's real .env can never flip the inert leg.
 *
 * Also pins the host side of the repo-default contract: the container tools
 * omit `repo` when the agent doesn't pass one, and the HOST action handlers
 * apply PR_FACTORY_DEFAULT_REPO (pairs with
 * container/agent-runner/src/mcp-tools/pr-factory-tools.test.ts).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-prf-registration/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-prf-registration/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-prf-registration';
const ORIGINAL_CWD = process.cwd();

const DELIVERY_ACTIONS = [
  'pr_send_to_testing',
  'pr_propose_skill_edit',
  'pr_gh',
  'pr_submit_test_results',
];

// pr_gh's approval handler belongs to the gh-action-approval component —
// core only owns the delivery-action seam for it.
const APPROVAL_ACTIONS = ['pr_send_to_testing', 'pr_retry_test', 'pr_propose_skill_edit'];

const ENV_KEYS = ['GITHUB_WEBHOOK_SECRET', 'PR_FACTORY_SLACK_CHANNEL_ID', 'SLACK_BOT_TOKEN', 'PR_FACTORY_DEFAULT_REPO'];

beforeAll(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // readEnvFile resolves .env from cwd — run from a dir guaranteed to have none.
  process.chdir(TEST_DIR);
});

afterAll(() => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('pr-factory module registration via the real modules barrel', () => {
  it('without GITHUB_WEBHOOK_SECRET the module is inert: approval handlers register, delivery actions do not', async () => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];

    await import('../index.js');
    const { getDeliveryAction } = await import('../../delivery.js');
    const { getApprovalHandler } = await import('../approvals/primitive.js');

    for (const action of DELIVERY_ACTIONS) {
      expect(getDeliveryAction(action), `${action} must NOT be registered in inert mode`).toBeUndefined();
    }
    // The approval handlers live at module top level (outside the env gate):
    // they are bound whenever the module file loads, env or not.
    for (const action of APPROVAL_ACTIONS) {
      expect(getApprovalHandler(action), `approval handler ${action} missing`).toBeDefined();
    }
  });

  it('with the env trio primed before import, all four pr_* delivery actions register', async () => {
    vi.resetModules();
    process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
    process.env.PR_FACTORY_SLACK_CHANNEL_ID = 'C0TEST';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';

    await import('../index.js');
    const { getDeliveryAction } = await import('../../delivery.js');
    const { getApprovalHandler } = await import('../approvals/primitive.js');

    for (const action of DELIVERY_ACTIONS) {
      expect(getDeliveryAction(action), `delivery action ${action} missing`).toBeDefined();
    }
    for (const action of APPROVAL_ACTIONS) {
      expect(getApprovalHandler(action), `approval handler ${action} missing`).toBeDefined();
    }
  });

  it('applies PR_FACTORY_DEFAULT_REPO host-side when an action payload omits repo', async () => {
    vi.resetModules();
    process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
    process.env.PR_FACTORY_SLACK_CHANNEL_ID = 'C0TEST';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    // Primed BEFORE the barrel import — defaults.ts reads it at module load.
    process.env.PR_FACTORY_DEFAULT_REPO = 'acme/defaulted';

    const { initTestDb, runMigrations, closeDb } = await import('../../db/index.js');
    const db = initTestDb();
    runMigrations(db);
    try {
      const now = new Date().toISOString();
      const { createAgentGroup } = await import('../../db/agent-groups.js');
      const { createSession } = await import('../../db/sessions.js');
      const { createPrThread } = await import('../../db/pr-threads.js');
      const { initSessionFolder, outboundDbPath } = await import('../../session-manager.js');
      createAgentGroup({
        id: 'ag-prf',
        name: 'Worker',
        folder: 'pr-factory-worker',
        agent_provider: null,
        created_at: now,
      });
      createSession({
        id: 'sess-prf',
        agent_group_id: 'ag-prf',
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: now,
      });
      initSessionFolder('ag-prf', 'sess-prf');
      // The pr_threads row is keyed by the DEFAULT repo — only a handler that
      // fills the omitted `repo` with PR_FACTORY_DEFAULT_REPO can find it.
      createPrThread({
        channel_id: 'C0TEST',
        thread_ts: '111.222',
        channel_type: 'slack',
        repo_full_name: 'acme/defaulted',
        pr_number: 42,
        session_id: 'sess-prf',
        created_at: now,
      });

      await import('../index.js');
      const { getDeliveryAction } = await import('../../delivery.js');
      const handler = getDeliveryAction('pr_submit_test_results');
      expect(handler).toBeDefined();

      const session = { id: 'sess-prf', agent_group_id: 'ag-prf' };
      // No `repo` in the payload — the handler must default it to acme/defaulted
      // to find the pr_threads row keyed by that repo and post the verdict.
      await handler!({ pr_number: 42, verdict: 'PASS', content: '## results' }, session as never, undefined as never);

      const outDb = new Database(outboundDbPath('ag-prf', 'sess-prf'), { readonly: true });
      const rows = outDb.prepare('SELECT content FROM messages_out').all() as Array<{ content: string }>;
      outDb.close();
      expect(rows.length, 'verdict summary should reach the worker session resolved via the default repo').toBe(1);
      expect((JSON.parse(rows[0].content) as { text: string }).text).toContain('PASS');
    } finally {
      closeDb();
    }
  });

  it('pr_gh without the gh-action-approval component notifies the agent instead of dropping silently', async () => {
    vi.resetModules();
    process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
    process.env.PR_FACTORY_SLACK_CHANNEL_ID = 'C0TEST';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';

    const { initTestDb, runMigrations, closeDb } = await import('../../db/index.js');
    const db = initTestDb();
    runMigrations(db);
    try {
      const now = new Date().toISOString();
      const { createAgentGroup } = await import('../../db/agent-groups.js');
      const { createSession, getSession } = await import('../../db/sessions.js');
      const { initSessionFolder, inboundDbPath } = await import('../../session-manager.js');
      createAgentGroup({ id: 'ag-gh', name: 'Worker', folder: 'gh-worker', agent_provider: null, created_at: now });
      createSession({
        id: 'sess-gh',
        agent_group_id: 'ag-gh',
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: now,
      });
      initSessionFolder('ag-gh', 'sess-gh');

      await import('../index.js');
      // In a composed tree the gh-action-approval component may be installed
      // (its barrel import registers an executor on the seam) — clear the
      // seam so this case pins core's not-installed fallback either way.
      const { setGhActionHandler } = await import('../pr-factory/gh-action.js');
      setGhActionHandler(null);
      const { getDeliveryAction } = await import('../../delivery.js');
      const handler = getDeliveryAction('pr_gh');
      expect(handler).toBeDefined();

      const session = getSession('sess-gh')!;
      await handler!({ commands: ['gh pr view 42'], description: 'view' }, session, undefined as never);

      // The seam's fallback notifies the agent via its real inbound DB.
      const inDb = new Database(inboundDbPath('ag-gh', 'sess-gh'), { readonly: true });
      const rows = inDb.prepare('SELECT content FROM messages_in').all() as Array<{ content: string }>;
      inDb.close();
      expect(rows).toHaveLength(1);
      expect((JSON.parse(rows[0].content) as { text: string }).text).toContain(
        'gh-action-approval component is not installed',
      );
    } finally {
      closeDb();
    }
  });
});
