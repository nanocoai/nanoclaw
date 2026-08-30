/**
 * Guard for the home-surface forwarding wiring in the Chat SDK bridge.
 *
 * Drives the REAL seam: `createChatSdkBridge(...).setup()` builds a real Chat
 * instance (real SqliteStateAdapter on an in-memory central DB, stub platform
 * adapter) and must register the home-surface forwarders
 * (`registerHomeSurfaceForwarding`). The test then dispatches an
 * app_home_opened event and home-surface block_actions through the Chat
 * instance's public process* entry points and asserts the governance service
 * (a local HTTP server standing in for HOME_EVENTS_URL) receives the forwarded
 * POSTs with the shared-secret header. Goes red if the bridge's registration
 * call is deleted, the module moves, or the forward payload shape drifts.
 *
 * The last describe guards the other half of the config integration: the
 * HOME_EVENTS_URL / HOME_EVENTS_SECRET entries in src/config.ts's
 * `readEnvFile([...])` list. It loads the real config module from a cwd whose
 * `.env` sets both keys (environment unset) and asserts the exports pick them
 * up — deleting either list entry turns the exports empty and goes red.
 */
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
// The shared webhook server binds a real port on adapter registration —
// external to the wiring under guard, so stub it out.
vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
  registerWebhookHandler: vi.fn(),
}));

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
const received: Received[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // Must be set before src/config.ts loads — every module import in the tests
  // below is dynamic, so this runs first.
  process.env.HOME_EVENTS_URL = `http://127.0.0.1:${port}/events`;
  process.env.HOME_EVENTS_SECRET = 'shh-guard';
});

afterAll(async () => {
  delete process.env.HOME_EVENTS_URL;
  delete process.env.HOME_EVENTS_SECRET;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  received.length = 0;
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The Chat instance's public process* surface the test dispatches through. */
interface ChatProcessSurface {
  processAppHomeOpened(event: unknown, options?: { waitUntil?: (p: Promise<unknown>) => void }): void;
  processAction(event: unknown, options?: unknown): Promise<unknown>;
}

async function setupBridge(): Promise<ChatProcessSurface> {
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());

  const { createChatSdkBridge } = await import('./chat-sdk-bridge.js');
  let captured: ChatProcessSurface | undefined;
  const adapter = {
    name: 'slack',
    userName: 'nanoclaw',
    initialize: async (chatInstance: unknown) => {
      captured = chatInstance as ChatProcessSurface;
    },
    channelIdFromThreadId: (id: string) => id,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bridge = createChatSdkBridge({ adapter: adapter as any, supportsThreads: true });
  await bridge.setup({
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  });
  if (!captured) throw new Error('adapter.initialize never received the Chat instance');
  return captured;
}

function actionEvent(actionId: string, raw: unknown = {}): Record<string, unknown> {
  return {
    actionId,
    adapter: { name: 'slack' },
    messageId: '',
    threadId: '',
    value: '',
    raw,
    user: { userId: 'U7', userName: 'dana', fullName: 'Dana', isBot: false, isMe: false },
    thread: null,
  };
}

describe('chat-sdk bridge — home-surface forwarding wiring', () => {
  it('forwards app_home_opened to the governance service with the shared secret', async () => {
    const chat = await setupBridge();
    const pending: Promise<unknown>[] = [];
    chat.processAppHomeOpened(
      { adapter: { name: 'slack' }, channelId: 'C1', userId: 'U7' },
      { waitUntil: (p) => pending.push(p) },
    );
    await Promise.all(pending);
    await waitFor(() => received.length === 1);
    expect(received[0].headers['x-home-events-secret']).toBe('shh-guard');
    expect(JSON.parse(received[0].body)).toMatchObject({ v: 1, type: 'home_opened', slackUserId: 'U7' });
  });

  it('forwards home:* and connect-* block_actions with view-state values', async () => {
    const chat = await setupBridge();
    const raw = {
      view: {
        state: {
          values: {
            b1: { 'home:mem:input': { type: 'plain_text_input', value: '# memory' } },
            b2: { 'home:prov:template': { type: 'static_select', selected_option: { value: 'sdr' } } },
          },
        },
      },
    };
    await chat.processAction(actionEvent('home:tab:memory', raw));
    await waitFor(() => received.length === 1);
    expect(JSON.parse(received[0].body)).toMatchObject({
      type: 'action',
      slackUserId: 'U7',
      actionId: 'home:tab:memory',
      value: '# memory',
      state: { 'home:mem:input': '# memory', 'home:prov:template': 'sdr' },
    });

    await chat.processAction(actionEvent('connect-gmail'));
    await waitFor(() => received.length === 2);
    expect(JSON.parse(received[1].body)).toMatchObject({ type: 'action', actionId: 'connect-gmail' });
  });

  it('does not forward unrelated actions', async () => {
    const chat = await setupBridge();
    await chat.processAction(actionEvent('some-other-button'));
    await new Promise((r) => setTimeout(r, 150));
    expect(received.length).toBe(0);
  });
});

describe('config — home-events keys read from .env', () => {
  it('reads HOME_EVENTS_URL / HOME_EVENTS_SECRET from the .env file when unset in the environment', async () => {
    const prevCwd = process.cwd();
    const prevUrl = process.env.HOME_EVENTS_URL;
    const prevSecret = process.env.HOME_EVENTS_SECRET;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-events-env-'));
    fs.writeFileSync(
      path.join(dir, '.env'),
      'HOME_EVENTS_URL=http://127.0.0.1:1/from-env-file\nHOME_EVENTS_SECRET=env-file-secret\n',
    );
    delete process.env.HOME_EVENTS_URL;
    delete process.env.HOME_EVENTS_SECRET;
    process.chdir(dir);
    // Fresh module registry so src/config.ts re-runs its readEnvFile([...])
    // against the temp cwd's .env — the list entries are what's under guard.
    vi.resetModules();
    try {
      const cfg = await import('../config.js');
      expect(cfg.HOME_EVENTS_URL).toBe('http://127.0.0.1:1/from-env-file');
      expect(cfg.HOME_EVENTS_SECRET).toBe('env-file-secret');
    } finally {
      process.chdir(prevCwd);
      if (prevUrl !== undefined) process.env.HOME_EVENTS_URL = prevUrl;
      if (prevSecret !== undefined) process.env.HOME_EVENTS_SECRET = prevSecret;
      vi.resetModules();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
