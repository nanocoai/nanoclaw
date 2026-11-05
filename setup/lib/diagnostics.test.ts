import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const child = vi.hoisted(() => ({
  spawn: vi.fn(),
  handlers: {} as Record<string, () => void>,
  unref: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: child.spawn,
}));

const ENV_KEYS = ['NANOCLAW_NO_DIAGNOSTICS', 'NANOCLAW_SETUP_RUN_ID', 'NANOCLAW_UPDATE_CHANNEL'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

async function load() {
  vi.resetModules();
  return import('./diagnostics.js');
}

function sentBody(call = 0): { event: string; properties: Record<string, unknown> } {
  const args = child.spawn.mock.calls[call][1] as string[];
  return JSON.parse(args[args.indexOf('-d') + 1]);
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  child.handlers = {};
  child.spawn.mockReset().mockImplementation(() => ({
    on: (event: string, cb: () => void) => {
      child.handlers[event] = cb;
    },
    unref: child.unref,
  }));
  child.unref.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

describe('emit', () => {
  it('sends through a detached curl that outlives the process', async () => {
    const { emit } = await load();
    emit('setup_started', {}, { persistId: false });

    expect(child.spawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = child.spawn.mock.calls[0];
    expect(cmd).toBe('curl');
    expect(args).toEqual(
      expect.arrayContaining(['--max-time', '3', '-X', 'POST', 'https://us.i.posthog.com/capture/']),
    );
    expect(opts).toMatchObject({ stdio: 'ignore', detached: process.platform !== 'win32' });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('adds version, channel, run id and arch to every event', async () => {
    process.env.NANOCLAW_SETUP_RUN_ID = 'run-from-nanoclaw-sh';
    process.env.NANOCLAW_UPDATE_CHANNEL = 'Beta';
    const { version } = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    const { emit } = await load();
    emit('step_completed', { step: 'container', skipped: undefined }, { persistId: false });

    expect(sentBody()).toMatchObject({
      event: 'step_completed',
      properties: {
        step: 'container',
        platform: process.platform,
        arch: process.arch,
        nanoclaw_version: version,
        release_channel: 'beta',
        run_id: 'run-from-nanoclaw-sh',
      },
    });
    expect(sentBody().properties).not.toHaveProperty('skipped');
  });

  it('starts a run id when none was passed down and exports it to children', async () => {
    const { emit } = await load();
    emit('a', {}, { persistId: false });
    emit('b', {}, { persistId: false });

    const runId = sentBody(0).properties.run_id;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sentBody(1).properties.run_id).toBe(runId);
    expect(process.env.NANOCLAW_SETUP_RUN_ID).toBe(runId);
  });

  it('reports an unknown channel instead of throwing', async () => {
    process.env.NANOCLAW_UPDATE_CHANNEL = 'nightly';
    const { emit } = await load();
    emit('a', {}, { persistId: false });
    expect(sentBody().properties.release_channel).toBe('unknown');
  });

  it('sends nothing when diagnostics are off', async () => {
    process.env.NANOCLAW_NO_DIAGNOSTICS = '1';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { emit } = await load();
    emit('a', {}, { persistId: false });
    expect(child.spawn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to fetch when curl cannot start', async () => {
    const fetchMock = vi.fn(async () => new Response(null));
    vi.stubGlobal('fetch', fetchMock);
    const { emit } = await load();
    emit('a', {}, { persistId: false });
    expect(fetchMock).not.toHaveBeenCalled();

    child.handlers.error();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://us.i.posthog.com/capture/');
    expect(JSON.parse(init.body as string).event).toBe('a');
  });
});
