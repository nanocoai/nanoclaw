/**
 * Integration test for the add-dashboard skill's integration point —
 * `startDashboard()`, the single call wired into src/index.ts.
 *
 * Archetype: in-process seam. It drives the *real* entry point against a
 * *real* (in-memory) central DB and a *fake* dashboard HTTP endpoint. The
 * only things stubbed are the external dashboard package (not needed to prove
 * the wiring) and env-file reads (so the test doesn't depend on the real
 * .env). This proves the skill works once applied: with a secret set it
 * collects a DB snapshot and posts it; with no secret it does nothing.
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
vi.mock('@nanoco/nanoclaw-dashboard', () => ({ startDashboard: vi.fn() }));
// Don't read the real .env — the test controls config via process.env only.
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));

const TEST_DIR = '/tmp/nanoclaw-test-dashboard';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { startDashboard, stopDashboardPusher } from './dashboard-pusher.js';

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

describe('add-dashboard integration point (startDashboard)', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
  });

  afterEach(async () => {
    stopDashboardPusher();
    await closeDb();
    delete process.env.DASHBOARD_SECRET;
    delete process.env.DASHBOARD_PORT;
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('posts a snapshot of the seeded state when DASHBOARD_SECRET is set', async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });

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

  describe('transcripts', () => {
    const projects = (ag: string) => `${TEST_DIR}/v2-sessions/${ag}/.claude-shared/projects/-workspace-agent`;
    // A new file name per test: the pusher keeps per-file state for the life of the module.
    let n = 0;
    let transcript = '';
    const usage = (out: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: now(),
        message: { model: 'claude-test', usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 2 } },
      }) + '\n';
    // A tool-result line with no usage, like the large image results that make transcripts grow.
    const filler = (bytes: number) =>
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(bytes) }] } }) +
      '\n';

    /** One snapshot through the real entry point. The pusher's per-file state survives between calls. */
    async function snapshot(): Promise<Record<string, any>> {
      const dash = await startFakeDashboard();
      process.env.DASHBOARD_SECRET = 'test-secret';
      process.env.DASHBOARD_PORT = String(dash.port);
      await startDashboard();
      await waitFor(() => dash.posts.some((p) => p.path === '/api/ingest'));
      stopDashboardPusher();
      await dash.close();
      return dash.posts.find((p) => p.path === '/api/ingest')!.body;
    }

    /** Bytes read from `file` while `fn` runs: chunked reads, plus the whole file per readFileSync. */
    async function bytesReadFrom(file: string, fn: () => Promise<unknown>): Promise<number> {
      const open = vi.spyOn(fs, 'openSync');
      const read = vi.spyOn(fs, 'readSync');
      const readWhole = vi.spyOn(fs, 'readFileSync');
      try {
        await fn();
        const fds = new Set(open.mock.calls.flatMap((c, i) => (c[0] === file ? [open.mock.results[i].value] : [])));
        const chunked = read.mock.calls.reduce(
          (sum, c, i) => (fds.has(c[0]) ? sum + (read.mock.results[i].value as number) : sum),
          0,
        );
        return chunked + readWhole.mock.calls.filter((c) => c[0] === file).length * fs.statSync(file).size;
      } finally {
        open.mockRestore();
        read.mockRestore();
        readWhole.mockRestore();
      }
    }

    beforeEach(() => {
      fs.mkdirSync(projects('ag-1'), { recursive: true });
      transcript = `${projects('ag-1')}/sess-${++n}.jsonl`;
    });

    it('finds the last usage line behind a long tail, without reading the transcript whole', async () => {
      // 1.2 MB of usage-free lines after the usage line: the 256 KB tail window has to grow.
      fs.writeFileSync(transcript, usage(42) + filler(100_000).repeat(12));
      const readWhole = vi.spyOn(fs, 'readFileSync');
      try {
        const body = await snapshot();
        expect(readWhole.mock.calls.some((c) => c[0] === transcript)).toBe(false);
        expect(body.context_windows).toEqual([expect.objectContaining({ agentGroupId: 'ag-1', outputTokens: 42 })]);
        expect(body.tokens.totals.requests).toBe(1);
      } finally {
        readWhole.mockRestore();
      }
    });

    it('reads only appended bytes, and counts a half-written line once it is complete', async () => {
      const last = usage(3);
      fs.writeFileSync(transcript, filler(600_000) + usage(1) + usage(2) + last.slice(0, 20));
      let body = await snapshot();
      expect(body.tokens.totals.requests).toBe(2);
      expect(body.context_windows[0].outputTokens).toBe(2);

      fs.appendFileSync(transcript, last.slice(20) + usage(4));
      const appended = last.length - 20 + usage(4).length;
      // Token totals read the appended bytes plus the 20 left unfinished; the context
      // window reads its 256 KB tail. Nothing re-reads the 600 KB line at the start.
      const read = await bytesReadFrom(transcript, async () => {
        body = await snapshot();
      });
      expect(read).toBeLessThanOrEqual(20 + appended + 256 * 1024);
      expect(body.tokens.totals.requests).toBe(4);
      expect(body.tokens.totals.outputTokens).toBe(1 + 2 + 3 + 4);
      expect(body.context_windows[0].outputTokens).toBe(4);
    });

    it('reads a line several chunks long, finished or still being written', async () => {
      // 3.5 MB: longer than three 1 MB read chunks, so the line crosses several chunk edges.
      const long = filler(3_500_000);
      const last = usage(3);
      fs.writeFileSync(transcript, usage(1) + long + usage(2) + long.slice(0, 2_500_000));
      let body = await snapshot();
      expect(body.tokens.totals.requests).toBe(2);
      expect(body.context_windows[0].outputTokens).toBe(2);

      fs.appendFileSync(transcript, long.slice(2_500_000) + last);
      body = await snapshot();
      expect(body.tokens.totals.requests).toBe(3);
      expect(body.tokens.totals.outputTokens).toBe(1 + 2 + 3);
      expect(body.context_windows[0].outputTokens).toBe(3);

      // Usage behind a long last line: the tail window has to grow past it.
      fs.appendFileSync(transcript, long);
      body = await snapshot();
      expect(body.context_windows[0].outputTokens).toBe(3);
    });

    it('starts over when a transcript is replaced by a smaller one', async () => {
      fs.writeFileSync(transcript, usage(1) + usage(2) + usage(3));
      expect((await snapshot()).tokens.totals.requests).toBe(3);

      fs.writeFileSync(transcript, usage(7));
      const body = await snapshot();
      expect(body.tokens.totals.requests).toBe(1);
      expect(body.tokens.totals.outputTokens).toBe(7);
    });

    it('still posts the snapshot when a transcript vanishes mid-read', async () => {
      fs.writeFileSync(transcript, usage(5));
      // ag-2's only transcript is gone by the time it is read (e.g. rotated away).
      fs.mkdirSync(projects('ag-2'), { recursive: true });
      fs.symlinkSync(`${TEST_DIR}/missing`, `${projects('ag-2')}/sess-2.jsonl`);

      const body = await snapshot();
      expect(body.context_windows).toEqual([expect.objectContaining({ agentGroupId: 'ag-1', outputTokens: 5 })]);
    });
  });

  it('does nothing when DASHBOARD_SECRET is not set', async () => {
    const dash = await startFakeDashboard();
    // no DASHBOARD_SECRET in env, and readEnvFile is stubbed to {}

    await startDashboard();
    await new Promise((r) => setTimeout(r, 100));

    expect(dash.posts).toHaveLength(0);
    await dash.close();
  });
});
