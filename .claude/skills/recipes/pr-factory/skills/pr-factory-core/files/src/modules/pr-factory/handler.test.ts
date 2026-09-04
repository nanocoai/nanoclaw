/**
 * pr-factory-core guard — handler.ts's consumption of core seams:
 * resolveSession / writeSessionMessage / the sessions + pr_threads schema,
 * plus the cross-process PR_CONTEXT trigger contract the worker's
 * group instructions (or an operator review skill) parse.
 *
 * Real migrated central DB, real bootstrap output, real on-disk session DBs
 * under a mocked DATA_DIR. Only the external edges are faked: global fetch
 * (Slack opener/reactions + GitHub diff/stats; OneCLI admin API down → the
 * direct-fetch fallback path) and the container runtime (wake/kill).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    DATA_DIR: '/tmp/nanoclaw-test-prf-handler/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-prf-handler/groups',
  };
});

// Keep the test hermetic: no repo-mirror git calls, no NDJSON files in the
// real data/ directory. triageDirective stays REAL — the trigger-text
// assertions below pin the default (group-instructions) directive.
vi.mock('./defaults.js', async () => {
  const actual = await vi.importActual<typeof import('./defaults.js')>('./defaults.js');
  return {
    ...actual,
    DEFAULT_REPO: 'acme/widgets',
    REPO_MIRROR_DIR: '/tmp/nanoclaw-test-prf-handler/no-mirror',
  };
});
vi.mock('./activity-log.js', () => ({ prLog: vi.fn() }));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getPrThreadByRepoPr } from '../../db/pr-threads.js';
import { getSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../session-manager.js';
import { killContainer, wakeContainer } from '../../container-runner.js';
import { bootstrapPrFactory, type BootstrapResult } from './bootstrap.js';
import { handlePullRequest, type HandlerConfig } from './handler.js';
import type { PREvent } from './webhook.js';

const TEST_DIR = '/tmp/nanoclaw-test-prf-handler';
const WORKER_CHANNEL = 'C0WORK';

let bootstrap: BootstrapResult;
let cfg: HandlerConfig;
let slackTs: number;

function prEvent(overrides: Partial<PREvent> = {}): PREvent {
  return {
    action: 'opened',
    number: 42,
    title: 'Add widgets',
    body: 'Adds the widgets.',
    author: 'octocat',
    repoFullName: 'acme/widgets',
    headSha: 'abc123',
    diffUrl: 'https://github.com/acme/widgets/pull/42.diff',
    htmlUrl: 'https://github.com/acme/widgets/pull/42',
    merged: false,
    draft: false,
    ...overrides,
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function readInbound(sessionId: string): Array<{ id: string; kind: string; content: string }> {
  const session = getSession(sessionId)!;
  const db = new Database(inboundDbPath(session.agent_group_id, sessionId), { readonly: true });
  const rows = db.prepare('SELECT id, kind, content FROM messages_in ORDER BY rowid').all() as Array<{
    id: string;
    kind: string;
    content: string;
  }>;
  db.close();
  return rows;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  slackTs = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
      const u = String(url);
      if (u.includes('/api/agents/default')) return jsonRes({ error: 'down' }, 500); // OneCLI absent → direct fetch
      if (u.includes('slack.com/api/chat.postMessage')) {
        slackTs += 1;
        return jsonRes({ ok: true, ts: `1700000000.00010${slackTs}` });
      }
      if (u.includes('slack.com/api/')) return jsonRes({ ok: true });
      if (u.includes('api.github.com')) {
        if (u.includes('/files?')) return jsonRes([{ filename: 'src/widgets.ts' }]);
        if ((init?.headers?.Accept || '').includes('diff')) {
          return new Response('diff --git a/src/widgets.ts b/src/widgets.ts', { status: 200 });
        }
        return jsonRes({ commits: 1, changed_files: 1, additions: 5, deletions: 2 });
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    }),
  );

  bootstrap = bootstrapPrFactory({ workerChannelId: WORKER_CHANNEL });
  cfg = { workerBotToken: 'xoxb-test', workerChannelId: WORKER_CHANNEL, bootstrap };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('handlePullRequest', () => {
  it('opened: records pr_threads, writes the PR_CONTEXT trigger to the session inbound DB, wakes the container', async () => {
    await handlePullRequest(prEvent(), cfg);

    const thread = getPrThreadByRepoPr('acme/widgets', 42);
    expect(thread).toBeDefined();
    expect(thread!.channel_id).toBe(bootstrap.workerPlatformId);
    expect(thread!.thread_ts).toBe('1700000000.000101');

    const session = getSession(thread!.session_id);
    expect(session?.agent_group_id).toBe(bootstrap.workerAgentGroupId);

    const messages = readInbound(thread!.session_id);
    expect(messages).toHaveLength(1);
    const text = (JSON.parse(messages[0].content) as { text: string }).text;
    // Default directive: no PR_FACTORY_REVIEW_SKILL → the seeded group
    // instructions own the workflow.
    expect(text).toContain('PR triage workflow in your group instructions');
    expect(text).toContain('diff --git');
    expect(text).toContain(
      `[PR_CONTEXT: channel=${bootstrap.workerPlatformId} thread=${thread!.thread_ts} repo=acme/widgets pr=42]`,
    );

    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
  });

  it('opened: a redelivered webhook for an existing PR thread is a no-op', async () => {
    await handlePullRequest(prEvent(), cfg);
    const first = getPrThreadByRepoPr('acme/widgets', 42)!;

    await handlePullRequest(prEvent(), cfg);
    const second = getPrThreadByRepoPr('acme/widgets', 42)!;
    expect(second.session_id).toBe(first.session_id);
    expect(readInbound(first.session_id)).toHaveLength(1);
  });

  it('synchronize: kills the old container, re-creates the session in the same thread, repoints pr_threads', async () => {
    await handlePullRequest(prEvent(), cfg);
    const before = getPrThreadByRepoPr('acme/widgets', 42)!;

    await handlePullRequest(prEvent({ action: 'synchronize' }), cfg);

    expect(vi.mocked(killContainer)).toHaveBeenCalledWith(before.session_id, expect.stringContaining('synchronize'));
    const after = getPrThreadByRepoPr('acme/widgets', 42)!;
    expect(after.thread_ts).toBe(before.thread_ts);
    expect(after.session_id).not.toBe(before.session_id);
    expect(getSession(before.session_id)).toBeUndefined();

    const messages = readInbound(after.session_id);
    expect(messages).toHaveLength(1);
    const text = (JSON.parse(messages[0].content) as { text: string }).text;
    expect(text).toContain('re-triage PR #42');
    expect(text).toContain(`thread=${after.thread_ts}`);
  });

  it('draft opened: creates the thread and pr_threads row but defers triage (no trigger message)', async () => {
    await handlePullRequest(prEvent({ draft: true }), cfg);

    const thread = getPrThreadByRepoPr('acme/widgets', 42);
    expect(thread).toBeDefined();
    expect(readInbound(thread!.session_id)).toHaveLength(0);
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });
});
