/**
 * pr-factory recipe — composed-stack guards.
 *
 * Each component's own tests prove it works alone; this suite proves the
 * components compose. It runs the FULL migration barrel on a fresh DB
 * (core instance substrate + both component migrations), imports the REAL
 * modules barrel with the PR Factory env primed, fires the real bootstrap
 * through the delivery-adapter-ready callback, and asserts the
 * cross-component invariants no single component test owns:
 *
 *   1. the migration chain composes in barrel order on a fresh DB and yields
 *      the composed schema (instance column, v2 pr_threads);
 *   2. bootstrap on that schema lands all three bot instances on ONE Slack
 *      channel row-set with exact-instance resolution (the UNIQUE triple
 *      from 016 holding under the recipe's full wiring);
 *   3. core's single-slot delivery file transform has exactly one registrant
 *      across every module in the tree (a second registrant would silently
 *      clobber the slack-canvas conversion);
 *   4. every skill manifest's files/ mirror is in sync
 *      (scripts/sync-skill-files.sh --all --check) — canon edits that skip
 *      the sync script fail here, not in review.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-prf-stack/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-prf-stack/groups',
  };
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = '/tmp/nanoclaw-test-prf-stack';
const WORKER_CHANNEL = 'C0STACKWORK';
const SUPERVISOR_CHANNEL = 'C0STACKADMIN';
const WORKER_PLATFORM_ID = `slack:${WORKER_CHANNEL}`;
const PORT = 21000 + Math.floor(Math.random() * 20000);

let db: import('better-sqlite3').Database;
let closeDb: () => void;
let stopWebhookServer: () => Promise<void>;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // The reactions/canvas paths call Slack over fetch; none of these legs
  // assert on Slack, so a generic ok response keeps them quiet.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  );

  // Prime env BEFORE the barrel import — registration is import-time.
  process.env.GITHUB_WEBHOOK_SECRET = 'stack-secret';
  process.env.PR_FACTORY_SLACK_CHANNEL_ID = WORKER_CHANNEL;
  process.env.PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID = SUPERVISOR_CHANNEL;
  process.env.SLACK_BOT_TOKEN = 'xoxb-stack-test';
  process.env.WEBHOOK_PORT = String(PORT);

  const dbMod = await import('./db/index.js');
  db = dbMod.initTestDb();
  dbMod.runMigrations(db);
  closeDb = dbMod.closeDb;

  // The operator-created tester agent group exists before boot, so the
  // composed bootstrap wires all three instances.
  dbMod.createAgentGroup({
    id: 'ag-stack-tester',
    name: 'PR Tester',
    folder: 'pr-tester',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });

  await import('./modules/index.js'); // the real modules barrel
  const delivery = await import('./delivery.js');
  const webhookServer = await import('./webhook-server.js');
  stopWebhookServer = webhookServer.stopWebhookServer;

  // Setting the adapter fires onDeliveryAdapterReady → the real pr-factory
  // bootstrap runs against the freshly migrated DB.
  delivery.setDeliveryAdapter({
    async deliver() {
      return 'plat-msg-stack';
    },
  });
  await new Promise((r) => setTimeout(r, 50)); // adapter-ready callbacks are async
});

afterAll(async () => {
  await stopWebhookServer?.();
  closeDb?.();
  vi.unstubAllGlobals();
  delete process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.PR_FACTORY_SLACK_CHANNEL_ID;
  delete process.env.PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.WEBHOOK_PORT;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('pr-factory recipe — composed stack', () => {
  it('fresh-DB migration chain: both component migrations compose with the core train, in order', () => {
    const recorded = db.prepare('SELECT name, version FROM schema_version ORDER BY version').all() as Array<{
      name: string;
      version: number;
    }>;
    const versionOf = (name: string): number => {
      const row = recorded.find((r) => r.name === name);
      expect(row, `migration '${name}' recorded in schema_version`).toBeDefined();
      return row!.version;
    };

    // slack-bots' fork-upgrade shim runs immediately before 016;
    // pr-factory-core's table migration runs last.
    expect(versionOf('module-slack-bots-bot-id-to-instance')).toBeLessThan(versionOf('messaging-group-instance'));
    expect(versionOf('messaging-group-instance')).toBeLessThan(versionOf('module-pr-factory-pr-threads-v2'));

    // Composed schema shape.
    const mgCols = (db.pragma('table_info(messaging_groups)') as Array<{ name: string }>).map((c) => c.name);
    expect(mgCols).toContain('instance');
    const prCols = (db.pragma('table_info(pr_threads)') as Array<{ name: string }>).map((c) => c.name);
    expect(prCols).toContain('repo_full_name');
    expect(prCols).not.toContain('bot_id');
  });

  it('bootstrap on the composed tree: worker, supervisor, and tester instances coexist on one channel', async () => {
    const { getMessagingGroupByPlatform } = await import('./db/messaging-groups.js');
    const { getAgentGroupByFolder } = await import('./db/agent-groups.js');
    const { WORKER_FOLDER } = await import('./modules/pr-factory/bootstrap.js');
    const { SUPERVISOR_INSTANCE } = await import('./channels/slack-supervisor.js');
    const { TESTER_INSTANCE } = await import('./channels/slack-tester.js');

    // Three rows share the PR channel's platform_id, distinguished only by
    // instance — exact lookups must return three distinct rows.
    const worker = getMessagingGroupByPlatform('slack', WORKER_PLATFORM_ID, 'slack');
    const supervisor = getMessagingGroupByPlatform('slack', WORKER_PLATFORM_ID, SUPERVISOR_INSTANCE);
    const tester = getMessagingGroupByPlatform('slack', WORKER_PLATFORM_ID, TESTER_INSTANCE);
    expect(worker).toBeDefined();
    expect(supervisor).toBeDefined();
    expect(tester).toBeDefined();
    expect(new Set([worker!.id, supervisor!.id, tester!.id]).size).toBe(3);

    // The supervisor's admin channel rides its own platform_id.
    const admin = getMessagingGroupByPlatform('slack', `slack:${SUPERVISOR_CHANNEL}`, SUPERVISOR_INSTANCE);
    expect(admin).toBeDefined();

    // Bootstrap created the worker agent group on the composed schema.
    const workerAg = getAgentGroupByFolder(WORKER_FOLDER);
    expect(workerAg).toBeDefined();
  });

  it('exactly one module registers on the single-slot delivery file transform', () => {
    const registrants: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        // delivery.ts owns the slot (declaration + application), not a registration.
        if (path.relative(REPO_ROOT, full) === path.join('src', 'delivery.ts')) continue;
        if (/\bregisterFileTransform\s*\(/.test(fs.readFileSync(full, 'utf8'))) {
          registrants.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    walk(path.join(REPO_ROOT, 'src'));
    expect(registrants).toEqual([path.join('src', 'modules', 'pr-factory', 'slack-canvas.ts')]);
  });

  it('every skill manifest mirror is in sync (sync-skill-files.sh --all --check)', () => {
    const res = spawnSync('bash', [path.join(REPO_ROOT, 'scripts', 'sync-skill-files.sh'), '--all', '--check'], {
      encoding: 'utf8',
    });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });
});
