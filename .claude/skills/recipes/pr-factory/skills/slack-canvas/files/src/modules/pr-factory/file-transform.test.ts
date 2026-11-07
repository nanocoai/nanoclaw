/**
 * slack-canvas component guard — the delivery fileTransform reach-in
 * (FileTransformFn type, registerFileTransform, the application block in
 * deliverMessage with its try/catch fallback), the component's canvas
 * provider registration on core's canvas seam, and the .md→canvas transform's
 * worker-session scoping.
 *
 * Imports the REAL modules barrel with the env trio primed, fires
 * onDeliveryAdapterReady via setDeliveryAdapter (which runs the real
 * pr-factory bootstrap), then drives real deliverSessionMessages over on-disk
 * session DBs with a real outbox file. Slack's canvas APIs are the only fake.
 *
 * SINGLE-SLOT GUARD: registerFileTransform holds one transform — a second
 * registrant silently clobbers the first. The worker-session leg here doubles
 * as the composed-stack assertion: if any other module in the barrel
 * registers a transform after this component's, the canvas conversion stops
 * happening and this test goes red.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
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
    DATA_DIR: '/tmp/nanoclaw-test-prf-transform/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-prf-transform/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-prf-transform';
const WORKER_CHANNEL = 'C0WORK';
const PORT = 21000 + Math.floor(Math.random() * 20000);

type Delivered = {
  kind: string;
  content: Record<string, unknown>;
  files?: Array<{ filename: string }>;
  instance?: string;
};
const delivered: Delivered[] = [];

let core: {
  deliverSessionMessages: typeof import('../../delivery.js').deliverSessionMessages;
  registerFileTransform: typeof import('../../delivery.js').registerFileTransform;
  createCanvas: typeof import('./canvas.js').createCanvas;
  resolveSession: typeof import('../../session-manager.js').resolveSession;
  sessionDir: typeof import('../../session-manager.js').sessionDir;
  outboundDbPath: typeof import('../../session-manager.js').outboundDbPath;
  closeDb: () => void;
  stopWebhookServer: () => Promise<void>;
  workerAgentGroupId: string;
  workerMessagingGroupId: string;
};

function now(): string {
  return new Date().toISOString();
}

function insertOutboundWithFile(agentGroupId: string, sessionId: string, msgId: string, filename: string): void {
  const outboxDir = path.join(core.sessionDir(agentGroupId, sessionId), 'outbox', msgId);
  fs.mkdirSync(outboxDir, { recursive: true });
  fs.writeFileSync(path.join(outboxDir, filename), '# Review\n\nLooks good.\n');

  const db = new Database(core.outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, datetime('now'), 'chat', ?, 'slack', ?, ?)`,
  ).run(
    msgId,
    `slack:${WORKER_CHANNEL}`,
    `slack:${WORKER_CHANNEL}:123.456`,
    JSON.stringify({ text: 'Review done', files: [filename] }),
  );
  db.close();
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Slack canvas API fake: create → access.set → files.info permalink.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('canvases.create')) {
        return new Response(JSON.stringify({ ok: true, canvas_id: 'F0CANVAS' }), { status: 200 });
      }
      if (u.includes('canvases.access.set')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.includes('files.info')) {
        return new Response(JSON.stringify({ ok: true, file: { permalink: 'https://acme.slack.com/docs/F0CANVAS' } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );

  // Prime env BEFORE the barrel import — registration is import-time.
  process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
  process.env.PR_FACTORY_SLACK_CHANNEL_ID = WORKER_CHANNEL;
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.WEBHOOK_PORT = String(PORT);

  const dbMod = await import('../../db/index.js');
  const db = dbMod.initTestDb();
  dbMod.runMigrations(db);

  await import('../index.js'); // the real modules barrel
  const delivery = await import('../../delivery.js');
  const canvasSeam = await import('./canvas.js');
  const sessionManager = await import('../../session-manager.js');
  const webhookServer = await import('../../webhook-server.js');

  // Setting the adapter fires onDeliveryAdapterReady → real bootstrap runs.
  delivery.setDeliveryAdapter({
    async deliver(_channelType, _platformId, _threadId, kind, content, files, instance) {
      delivered.push({ kind, content: JSON.parse(content) as Record<string, unknown>, files, instance });
      return 'plat-msg-1';
    },
  });
  await new Promise((r) => setTimeout(r, 50)); // adapter-ready callbacks are async

  const { getAgentGroupByFolder } = await import('../../db/agent-groups.js');
  const { getMessagingGroupByPlatform } = await import('../../db/messaging-groups.js');
  const bootstrapMod = await import('./bootstrap.js');
  const worker = getAgentGroupByFolder(bootstrapMod.WORKER_FOLDER);
  // Default instance: the worker bot's row (instance = channel_type).
  const workerMg = getMessagingGroupByPlatform('slack', `slack:${WORKER_CHANNEL}`, 'slack');
  expect(worker).toBeDefined();
  expect(workerMg).toBeDefined();

  core = {
    deliverSessionMessages: delivery.deliverSessionMessages,
    registerFileTransform: delivery.registerFileTransform,
    createCanvas: canvasSeam.createCanvas,
    resolveSession: sessionManager.resolveSession,
    sessionDir: sessionManager.sessionDir,
    outboundDbPath: sessionManager.outboundDbPath,
    closeDb: dbMod.closeDb,
    stopWebhookServer: webhookServer.stopWebhookServer,
    workerAgentGroupId: worker!.id,
    workerMessagingGroupId: workerMg!.id,
  };
});

afterAll(async () => {
  await core.stopWebhookServer();
  vi.unstubAllGlobals();
  core.closeDb();
  for (const key of ['GITHUB_WEBHOOK_SECRET', 'PR_FACTORY_SLACK_CHANNEL_ID', 'SLACK_BOT_TOKEN', 'WEBHOOK_PORT']) {
    delete process.env[key];
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('slack-canvas provider on the core canvas seam', () => {
  it('createCanvas resolves through the registered provider (create → share → permalink)', async () => {
    const result = await core.createCanvas('Test Plan — PR #1', '# Plan\n1. step', WORKER_CHANNEL);
    expect(result).toEqual({ canvasId: 'F0CANVAS', permalink: 'https://acme.slack.com/docs/F0CANVAS' });
  });
});

describe('pr-factory file transform through real delivery', () => {
  it('converts a worker-session .md outbox file into a canvas link and strips the file', async () => {
    delivered.length = 0;
    const { session } = core.resolveSession(
      core.workerAgentGroupId,
      core.workerMessagingGroupId,
      `slack:${WORKER_CHANNEL}:123.456`,
      'per-thread',
    );
    insertOutboundWithFile(core.workerAgentGroupId, session.id, 'out-md-1', 'review-pr-42.md');

    await core.deliverSessionMessages(session);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].files).toBeUndefined();
    const text = String(delivered[0].content.text);
    expect(text).toContain('Review done');
    expect(text).toContain('[View review](https://acme.slack.com/docs/F0CANVAS)');
    // Exact-instance dispatch: the worker session delivers through the
    // default instance.
    expect(delivered[0].instance).toBe('slack');
  });

  it('passes non-worker sessions through untouched', async () => {
    delivered.length = 0;
    const dbMod = await import('../../db/index.js');
    dbMod.createAgentGroup({ id: 'ag-other', name: 'Other', folder: 'other', agent_provider: null, created_at: now() });
    dbMod.createMessagingGroup({
      id: 'mg-other',
      channel_type: 'slack',
      platform_id: `slack:${WORKER_CHANNEL}`,
      instance: 'other-bot',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session } = core.resolveSession('ag-other', 'mg-other', null, 'shared');
    insertOutboundWithFile('ag-other', session.id, 'out-md-2', 'notes-pr-7.md');

    await core.deliverSessionMessages(session);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].files?.map((f) => f.filename)).toEqual(['notes-pr-7.md']);
    expect(String(delivered[0].content.text)).not.toContain('](');
    expect(delivered[0].instance).toBe('other-bot');
  });

  it('falls back to the original message when the transform throws', async () => {
    delivered.length = 0;
    // Clobber the single slot with a throwing transform — this is the
    // documented hazard; delivery must fall back to the untransformed message.
    core.registerFileTransform(async () => {
      throw new Error('transform exploded');
    });

    const { session } = core.resolveSession(
      core.workerAgentGroupId,
      core.workerMessagingGroupId,
      `slack:${WORKER_CHANNEL}:123.456`,
      'per-thread',
    );
    insertOutboundWithFile(core.workerAgentGroupId, session.id, 'out-md-3', 'review-pr-43.md');

    await core.deliverSessionMessages(session);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].files?.map((f) => f.filename)).toEqual(['review-pr-43.md']);
    expect(String(delivered[0].content.text)).toBe('Review done');
  });
});
