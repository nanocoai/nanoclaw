/**
 * Integration test for the add-dashboard skill's integration point —
 * `startDashboard()`, the single call wired into src/index.ts.
 *
 * Archetype: in-process seam. It drives the *real* entry point against a
 * *real* (in-memory) central DB, the *real* host mailbox seam, and a *fake*
 * dashboard HTTP endpoint. The only things stubbed are the external dashboard
 * package (not needed to prove the wiring) and env-file reads (so the test
 * doesn't depend on the real .env). This proves the skill works once applied:
 * with a secret set it collects a snapshot and posts it; with no secret it
 * does nothing; the per-session message reads go through the mailbox seam;
 * and teardown runs from the host's own shutdown path.
 *
 * Ships with the add-dashboard skill; apply copies it to src/ alongside the
 * pusher so it runs against the composed project.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-dashboard', ASSISTANT_NAME: 'TestBot' };
});
// The dashboard server package isn't needed to prove the integration point.
const dashboardServer = { startDashboard: vi.fn(), stopDashboard: vi.fn(async () => {}) };
vi.mock('@nanoco/nanoclaw-dashboard', () => dashboardServer);
// Don't read the real .env — the test controls config via process.env only.
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));

const TEST_DIR = '/tmp/nanoclaw-test-dashboard';

// The singular mailbox composition slot: the per-session reads below go
// through the real registered mailbox, not a hand-rolled SQLite handle.
import './mailbox/compose.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession } from './db/index.js';
import { stopHostModules } from './host-lifecycle.js';
import { withMailboxSession } from './session-manager.js';
import { startDashboard, startDashboardPusher, stopDashboard } from './dashboard-pusher.js';

function now(): string {
  return new Date().toISOString();
}

interface CapturedPost {
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

/** A fake dashboard server that captures the bodies the pusher POSTs. */
function startFakeDashboard(): Promise<{ port: number; posts: CapturedPost[]; close: () => Promise<void> }> {
  const posts: CapturedPost[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* leave empty */
      }
      posts.push({ path: req.url || '', auth: req.headers.authorization, body });
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, posts, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The snapshot from the first /api/ingest post. */
function ingestOf(posts: CapturedPost[]): Record<string, unknown> {
  return posts.find((p) => p.path === '/api/ingest')!.body;
}

function seedGroup(id = 'ag-1'): Promise<void> {
  return createAgentGroup({ id, name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: now() });
}

function seedSession(id: string, agentGroupId: string, lastActive: string | null): Promise<void> {
  return createSession({
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: lastActive,
    created_at: now(),
  });
}

describe('add-dashboard integration point (startDashboard)', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    dashboardServer.startDashboard.mockClear();
    dashboardServer.stopDashboard.mockClear();
    const db = await initTestDb();
    await runMigrations(db);
  });

  afterEach(async () => {
    await stopDashboard();
    await closeDb();
    delete process.env.DASHBOARD_SECRET;
    delete process.env.DASHBOARD_PORT;
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('posts a snapshot of the seeded state when DASHBOARD_SECRET is set', async () => {
    await seedGroup();

    const dash = await startFakeDashboard();
    process.env.DASHBOARD_SECRET = 'test-secret';
    process.env.DASHBOARD_PORT = String(dash.port);

    await startDashboard();

    await waitFor(() => dash.posts.some((p) => p.path === '/api/ingest'));

    const ingest = dash.posts.find((p) => p.path === '/api/ingest')!;
    expect(ingest.auth).toBe('Bearer test-secret');
    expect(ingest.body.assistant_name).toBe('TestBot');

    const groups = ingest.body.agent_groups as Array<{ id: string }>;
    expect(groups.map((g) => g.id)).toContain('ag-1');

    for (const key of [
      'timestamp',
      'sessions',
      'channels',
      'users',
      'tokens',
      'context_windows',
      'activity',
      'messages',
    ]) {
      expect(ingest.body).toHaveProperty(key);
    }

    await dash.close();
  });

  it('does nothing when DASHBOARD_SECRET is not set', async () => {
    const dash = await startFakeDashboard();
    // no DASHBOARD_SECRET in env, and readEnvFile is stubbed to {}

    await startDashboard();
    await new Promise((r) => setTimeout(r, 100));

    expect(dash.posts).toHaveLength(0);
    await dash.close();
  });

  it('reads per-session messages through the host mailbox seam', async () => {
    await seedGroup();
    await seedSession('sess-1', 'ag-1', now());

    // Write one message per side through the seam the host itself writes with,
    // so the read path under test is the only thing being proven.
    await withMailboxSession('ag-1', 'sess-1', async (mailbox) => {
      await mailbox.insertMessage({
        id: 'in-1',
        kind: 'chat',
        timestamp: now(),
        platformId: 'chat-1',
        channelType: 'echo',
        threadId: null,
        content: JSON.stringify({ text: 'ping from the operator' }),
        processAfter: null,
        recurrence: null,
      });
      await mailbox.writeDirect({
        id: 'out-1',
        kind: 'chat',
        platformId: 'chat-1',
        channelType: 'echo',
        threadId: null,
        content: JSON.stringify({ text: 'pong from the agent' }),
      });
    });

    const dash = await startFakeDashboard();
    process.env.DASHBOARD_SECRET = 'test-secret';
    process.env.DASHBOARD_PORT = String(dash.port);
    await startDashboard();
    await waitFor(() => dash.posts.some((p) => p.path === '/api/ingest'));

    const body = ingestOf(dash.posts);

    const messages = body.messages as Array<{
      agentGroupId: string;
      sessionId: string;
      inbound: Array<{ kind: string; content: string; timestamp: string }>;
      outbound: Array<{ kind: string; content: string; timestamp: string }>;
    }>;
    const entry = messages.find((m) => m.agentGroupId === 'ag-1' && m.sessionId === 'sess-1');
    expect(entry, 'the seeded session must appear in the Messages payload').toBeDefined();
    expect(entry!.inbound.map((m) => m.content)).toContain(JSON.stringify({ text: 'ping from the operator' }));
    expect(entry!.outbound.map((m) => m.content)).toContain(JSON.stringify({ text: 'pong from the agent' }));
    // The dashboard's Messages page renders exactly timestamp + kind + content.
    for (const row of [...entry!.inbound, ...entry!.outbound]) {
      expect(row.kind).toBe('chat');
      expect(Date.parse(row.timestamp)).not.toBeNaN();
    }

    const activity = body.activity as Array<{ hour: string; inbound: number; outbound: number }>;
    expect(activity).toHaveLength(24);
    expect(activity.reduce((n, b) => n + b.inbound, 0)).toBe(1);
    expect(activity.reduce((n, b) => n + b.outbound, 0)).toBe(1);

    await dash.close();
  });

  it('orders sessions most-recently-active first with never-active last', async () => {
    await seedGroup();
    await seedSession('sess-old', 'ag-1', '2020-01-01T00:00:00.000Z');
    await seedSession('sess-never', 'ag-1', null);
    await seedSession('sess-new', 'ag-1', '2030-01-01T00:00:00.000Z');

    const dash = await startFakeDashboard();
    process.env.DASHBOARD_SECRET = 'test-secret';
    process.env.DASHBOARD_PORT = String(dash.port);
    await startDashboard();
    await waitFor(() => dash.posts.some((p) => p.path === '/api/ingest'));

    const sessions = ingestOf(dash.posts).sessions as Array<{ id: string }>;
    expect(sessions.map((s) => s.id)).toEqual(['sess-new', 'sess-old', 'sess-never']);

    await dash.close();
  });

  it('tears down from the host shutdown path and stops pushing', async () => {
    const dash = await startFakeDashboard();
    process.env.DASHBOARD_SECRET = 'test-secret';
    process.env.DASHBOARD_PORT = String(dash.port);

    await startDashboard();
    await waitFor(() => dash.posts.some((p) => p.path === '/api/ingest'));

    // The host's graceful shutdown runs stopHostModules() before it closes the
    // DB — the pusher registers its teardown there, so this is the real path.
    await stopHostModules();
    expect(dashboardServer.stopDashboard).toHaveBeenCalled();

    // And the timers are actually cleared: a fast-interval pusher stops pushing.
    startDashboardPusher({ port: dash.port, secret: 'test-secret', intervalMs: 20 });
    await waitFor(() => dash.posts.filter((p) => p.path === '/api/ingest').length >= 2);
    await stopDashboard();
    // Let any in-flight POST land before taking the baseline.
    await new Promise((r) => setTimeout(r, 100));
    const settled = dash.posts.filter((p) => p.path === '/api/ingest').length;
    await new Promise((r) => setTimeout(r, 150));
    expect(dash.posts.filter((p) => p.path === '/api/ingest').length).toBe(settled);

    await dash.close();
  });
});
