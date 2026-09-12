/**
 * `ncl sandboxes new` and the chat surface for its coding session, through
 * the real dispatch path: with a managed Slack app the channel is opened and
 * wired; `--no-channel` and a host without an install leave a plain sandbox;
 * a service that cannot do it degrades silently; `sandboxes channel
 * status|archive` read and close it.
 *
 * Same mocks as sandboxes.test.ts (DATA_DIR/GROUPS_DIR, driver, wake); the
 * service and the install detection go through setSessionChannelDeps.
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
    DATA_DIR: '/tmp/nanoclaw-test-sandboxes-channel/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-sandboxes-channel/groups',
  };
});

// The sandbox's own address is the account service's business; here it only
// answers (not enabled, or a refused name) so the verb's warning can be seen.
// Composing the address from the door's state is pure and stays real.
vi.mock('../../code-mode/remote/sandboxes.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../code-mode/remote/sandboxes.js')>();
  return {
    ...orig,
    registerSandbox: vi.fn(async () => ({ done: false, code: 'not_enabled' })),
    unregisterSandbox: vi.fn(async () => ({ done: false, code: 'not_enabled' })),
  };
});

const TEST_ROOT = '/tmp/nanoclaw-test-sandboxes-channel';

import {
  announceTerminalAddresses,
  getSessionChannelByGroup,
  getSessionChannelRuntime,
  setSessionChannelDeps,
  setSessionChannelRuntime,
} from '../../code-mode/session-channel/index.js';
import {
  SessionChannelServiceError,
  type ChannelRecord,
  type SessionChannelClient,
} from '../../code-mode/session-channel/client.js';
import { registerSandbox } from '../../code-mode/remote/sandboxes.js';
import { SessionChannelRuntime } from '../../code-mode/session-channel/runtime.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getSessionDriver } from '../../drivers/index.js';
import type { SessionEventsDriver } from '../../drivers/session-events.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, RequestFrame, ResponseFrame } from '../frame.js';
import './sandboxes.js';
import '../../code-mode/index.js';

const HOST: CallerContext = { caller: 'host' };
const CREDS = { serviceBase: 'https://slack.example.test', appId: 'A1', token: 'tok' };

function call(command: string, args: Record<string, unknown> = {}): Promise<ResponseFrame> {
  const req: RequestFrame = { id: `r-${Math.random().toString(36).slice(2, 8)}`, command, args };
  return dispatch(req, HOST);
}

function dataOf<T>(res: ResponseFrame): T {
  if (!res.ok) throw new Error(`expected ok, got: ${res.error.message}`);
  return res.data as T;
}

function fakeClient() {
  let n = 0;
  const created = new Map<string, ChannelRecord>();
  const client = {
    create: vi.fn(async (input: { sessionId: string; title: string }) => {
      const existing = created.get(input.sessionId);
      if (existing) return { channel: existing, created: false };
      n += 1;
      const channel: ChannelRecord = {
        channelId: `C${n}`,
        sessionId: input.sessionId,
        status: 'active',
        title: input.title,
      };
      created.set(input.sessionId, channel);
      return { channel, created: true };
    }),
    get: vi.fn(async (channelId: string) => {
      const rec = [...created.values()].find((c) => c.channelId === channelId);
      if (!rec) throw new SessionChannelServiceError(404, 'not_found', 'no', '/g');
      return { ...rec, views: [{ viewKey: 'diff', type: 'diff' }] };
    }),
    archive: vi.fn(async (channelId: string) => ({
      channelId,
      sessionId: 'x',
      status: 'closed',
      archived: true,
      archivedAt: '2026-09-11T12:00:00.000Z',
    })),
    setStatus: vi.fn(async () => ({})),
    putView: vi.fn(async () => ({})),
    events: vi.fn(async () => ({ events: [], cursor: null })),
    updateMember: vi.fn(
      async (channelId: string, botUserId: string, fields: { terminalAddress?: string; sandboxName?: string }) => ({
        channelId,
        member: { botUserId, role: 'owner', ...fields },
      }),
    ),
  };
  return client;
}

let client: ReturnType<typeof fakeClient>;

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'groups'), { recursive: true });
  await runMigrations(await initTestDb());
  vi.mocked(getSessionDriver).mockReturnValue({
    kind: 'fake',
    listSessions: vi.fn(async () => []),
    watchSessions: () => ({ stop: () => {} }),
  } as unknown as SessionEventsDriver);
  client = fakeClient();
  vi.mocked(registerSandbox).mockReset();
  vi.mocked(registerSandbox).mockResolvedValue({ done: false, code: 'not_enabled' });
  installDeps();
});

/** The seams for a host with an install and a running adapter; setSessionChannelDeps replaces, so pass the whole set. */
function installDeps(extra: Parameters<typeof setSessionChannelDeps>[0] = {}): void {
  setSessionChannelDeps({
    readCredentials: async () => CREDS,
    createClient: () => client as unknown as SessionChannelClient,
    // The live adapter's spelling of a channel, as the Slack chat adapter encodes it.
    channelAddressing: () => (id) => ({ platformId: `slack:${id}`, instance: 'slack' }),
    // Remote access off unless a test turns it on: no sandbox has an address.
    doorState: async () => ({ enabled: false }),
    ...extra,
  });
}

afterEach(async () => {
  await getSessionChannelRuntime()?.stop();
  setSessionChannelRuntime(null);
  setSessionChannelDeps(null);
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('sandboxes new — chat surface', () => {
  it('with a managed Slack app: opens the channel, stores the binding, wires the group, joins the running mirror', async () => {
    const runtime = new SessionChannelRuntime({
      clientFor: () => client as unknown as SessionChannelClient,
      listBindings: async () => [],
      observe: async () => ({ running: false, turn: null }),
      collectDiff: async () => null,
      interrupt: async () => false,
      persist: async () => {},
      watchEvents: false,
    });
    await runtime.start();
    setSessionChannelRuntime(runtime);

    const res = dataOf<{ sandbox: string; id: string; channel: { channelId: string; created: boolean } | null }>(
      await call('sandboxes-new', { name: 't1', 'no-attach': true }),
    );
    expect(res.channel).toEqual({ channelId: 'C1', created: true });
    expect(client.create).toHaveBeenCalledWith({ appId: 'A1', sessionId: res.id, title: 't1' });

    const row = await getSessionChannelByGroup(res.id);
    expect(row).toMatchObject({ channel_id: 'C1', title: 't1', service_base: CREDS.serviceBase });
    // The wiring row carries the adapter's spelling of the channel, never the bare id.
    const mg = await getMessagingGroupByPlatform('slack', 'slack:C1', 'slack');
    expect((await getMessagingGroupAgents(mg!.id))[0]).toMatchObject({
      agent_group_id: res.id,
      session_mode: 'sandbox',
    });
    expect(await getMessagingGroupByPlatform('slack', 'C1', 'slack')).toBeUndefined();
    expect(runtime.has(res.id)).toBe(true);
  });

  it('without a running chat adapter nothing is asked of the service: the sandbox has no channel', async () => {
    setSessionChannelDeps({ channelAddressing: () => null });
    const res = dataOf<{ id: string; channel: unknown }>(
      await call('sandboxes-new', { name: 't1a', 'no-attach': true }),
    );
    expect(res.channel).toBeNull();
    expect(client.create).not.toHaveBeenCalled();
    expect(await getAgentGroupByFolder('t1a')).toBeTruthy();
  });

  it('--no-channel leaves a plain sandbox even with an install', async () => {
    const res = dataOf<{ id: string; channel: unknown }>(
      await call('sandboxes-new', { name: 't2', 'no-attach': true, 'no-channel': true }),
    );
    expect(res.channel).toBeNull();
    expect(client.create).not.toHaveBeenCalled();
    expect(await getSessionChannelByGroup(res.id)).toBeUndefined();
  });

  it('without a managed Slack app (or sign-in) nothing is asked of the service', async () => {
    setSessionChannelDeps({ readCredentials: async () => null });
    const res = dataOf<{ id: string; channel: unknown }>(
      await call('sandboxes-new', { name: 't3', 'no-attach': true }),
    );
    expect(res.channel).toBeNull();
    expect(client.create).not.toHaveBeenCalled();
    expect(await getAgentGroupByFolder('t3')).toBeTruthy();
  });

  it('a workspace that cannot open channels degrades silently: the sandbox still exists, no binding', async () => {
    client.create.mockRejectedValueOnce(new SessionChannelServiceError(409, 'code_channels_unavailable', 'no', '/c'));
    const res = dataOf<{ id: string; channel: unknown }>(
      await call('sandboxes-new', { name: 't4', 'no-attach': true }),
    );
    expect(res.channel).toBeNull();
    expect(await getAgentGroupByFolder('t4')).toBeTruthy();
    expect(await getSessionChannelByGroup(res.id)).toBeUndefined();
  });

  it('a service that is down degrades the same way', async () => {
    client.create.mockRejectedValueOnce(new SessionChannelServiceError(0, 'unreachable', 'down', '/c'));
    const res = dataOf<{ id: string; channel: unknown }>(
      await call('sandboxes-new', { name: 't5', 'no-attach': true }),
    );
    expect(res.channel).toBeNull();
    expect(await getAgentGroupByFolder('t5')).toBeTruthy();
  });
});

describe('sandboxes new — the address', () => {
  it('a name the account reserves for addresses is a warning in the verb, not a silent log', async () => {
    vi.mocked(registerSandbox).mockResolvedValue({ done: false, code: 'invalid_name' });
    const res = dataOf<{ id: string; warnings?: string[] }>(
      await call('sandboxes-new', { name: 'terminal', 'no-attach': true, 'no-channel': true }),
    );
    expect(res.warnings).toEqual([
      "sandbox name 'terminal' is reserved for addresses — sandbox created without its own address",
    ]);
    expect(await getAgentGroupByFolder('terminal')).toBeTruthy(); // the sandbox itself is fine
  });

  it('an address that lands (or is simply not enabled) adds no warning', async () => {
    vi.mocked(registerSandbox).mockResolvedValue({ done: true, address: 'box.example.test' });
    const ok = dataOf<{ warnings?: string[] }>(
      await call('sandboxes-new', { name: 't8', 'no-attach': true, 'no-channel': true }),
    );
    expect(ok.warnings).toBeUndefined();
    vi.mocked(registerSandbox).mockResolvedValue({ done: false, code: 'not_enabled' });
    const plain = dataOf<{ warnings?: string[] }>(
      await call('sandboxes-new', { name: 't9', 'no-attach': true, 'no-channel': true }),
    );
    expect(plain.warnings).toBeUndefined();
  });
});

describe('sandboxes channel status / archive', () => {
  it('status reports the binding and the service view; archive closes it and reports closed afterwards', async () => {
    const made = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't6', 'no-attach': true }));

    const status = dataOf<Record<string, unknown>>(await call('sandboxes-channel-status', { id: 't6' }));
    expect(status).toMatchObject({
      sandbox: 't6',
      channelId: 'C1',
      title: 't6',
      status: 'active',
      lastStatusSent: null,
      archivedAt: null,
      mirrored: false,
      views: [{ viewKey: 'diff', type: 'diff' }],
    });

    const archived = dataOf<Record<string, unknown>>(
      await call('sandboxes-channel-archive', { id: made.id, summary: 'Shipped the portal page.' }),
    );
    expect(archived).toEqual({
      sandbox: 't6',
      channelId: 'C1',
      archived: true,
      archivedAt: '2026-09-11T12:00:00.000Z',
    });
    expect(client.archive).toHaveBeenCalledWith('C1', { summary: 'Shipped the portal page.' });
    expect((await getSessionChannelByGroup(made.id))!.archived_at).toBe('2026-09-11T12:00:00.000Z');

    const after = dataOf<Record<string, unknown>>(await call('sandboxes-channel-status', { id: 't6' }));
    expect(after).toMatchObject({ status: 'closed', archivedAt: '2026-09-11T12:00:00.000Z' });
    // Archiving twice is a no-op that reports the same close.
    const again = dataOf<Record<string, unknown>>(await call('sandboxes-channel-archive', { id: 't6' }));
    expect(again).toMatchObject({ archived: true, archivedAt: '2026-09-11T12:00:00.000Z' });
    expect(client.archive).toHaveBeenCalledTimes(1);
  });

  it('a sandbox without a channel says so; an unknown sandbox is refused', async () => {
    await call('sandboxes-new', { name: 't7', 'no-attach': true, 'no-channel': true });
    expect(dataOf(await call('sandboxes-channel-status', { id: 't7' }))).toEqual({ sandbox: 't7', channel: null });
    const archive = await call('sandboxes-channel-archive', { id: 't7' });
    expect(archive.ok).toBe(false);
    if (!archive.ok) expect(archive.error.message).toMatch(/no session channel/);
    const missing = await call('sandboxes-channel-status', { id: 'nope' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toMatch(/no sandbox 'nope'/);
  });

  it('the channel verbs are operator-only', async () => {
    for (const command of ['sandboxes-channel-status', 'sandboxes-channel-archive']) {
      const res = await dispatch(
        { id: 'r', command, args: { id: 'x' } },
        { caller: 'agent', sessionId: 's1', agentGroupId: 'g', messagingGroupId: 'mg' },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toMatch(/operator-only/);
    }
  });
});

describe('the terminal address on the channel', () => {
  const DOOR = { enabled: true, name: 'alice', host: 'alice.example.test' };

  it('with remote access enabled the create names the sandbox and its address; off, it does not', async () => {
    installDeps({ doorState: async () => DOOR });
    const res = dataOf<{ id: string }>(await call('sandboxes-new', { name: 'Web-App', 'no-attach': true }));
    expect(client.create).toHaveBeenCalledWith({
      appId: 'A1',
      sessionId: res.id,
      title: 'Web-App',
      sandboxName: 'web-app',
      terminalAddress: 'web-app.alice.example.test',
    });
    expect(client.updateMember).not.toHaveBeenCalled();

    installDeps({ doorState: async () => ({ enabled: false }) });
    const plain = dataOf<{ id: string }>(await call('sandboxes-new', { name: 't10', 'no-attach': true }));
    expect(client.create).toHaveBeenLastCalledWith({ appId: 'A1', sessionId: plain.id, title: 't10' });
  });

  it('remote access enabled after the channels exist: every open binding learns its address', async () => {
    const first = dataOf<{ id: string }>(await call('sandboxes-new', { name: 'api', 'no-attach': true }));
    const second = dataOf<{ id: string }>(await call('sandboxes-new', { name: 'my_box', 'no-attach': true }));
    await call('sandboxes-new', { name: 'plain', 'no-attach': true, 'no-channel': true });
    const archived = dataOf<{ id: string }>(await call('sandboxes-new', { name: 'old', 'no-attach': true }));
    await call('sandboxes-channel-archive', { id: archived.id });
    expect(client.create.mock.calls.every(([input]) => !('terminalAddress' in input))).toBe(true);

    // The door is up now; the host knows its bot.
    installDeps({ doorState: async () => DOOR, resolveBotIdentity: async () => ({ botUserId: 'U0BOT1' }) });
    expect(await announceTerminalAddresses()).toEqual({ announced: 1, skipped: 1, failed: 0 });
    // `api` is a label and gets its address; `my_box` is not and is skipped;
    // the plain sandbox has no channel and the archived one is history.
    expect(client.updateMember.mock.calls).toEqual([
      ['C1', 'U0BOT1', { sandboxName: 'api', terminalAddress: 'api.alice.example.test' }],
    ]);
    expect((await getSessionChannelByGroup(first.id))!.channel_id).toBe('C1');
    expect((await getSessionChannelByGroup(second.id))!.channel_id).toBe('C2');

    // Without an identity the channel record names the bot; a record that
    // names none is a skip-with-a-log, never an error.
    installDeps({ doorState: async () => DOOR, resolveBotIdentity: async () => null });
    expect(await announceTerminalAddresses()).toEqual({ announced: 0, skipped: 1, failed: 1 });
    expect(client.get).toHaveBeenCalledWith('C1');
  });

  it('the sweep is a quiet no-op while remote access is off or nothing is bound', async () => {
    expect(await announceTerminalAddresses()).toEqual({ announced: 0, skipped: 0, failed: 0 });
    await call('sandboxes-new', { name: 'api', 'no-attach': true });
    expect(await announceTerminalAddresses()).toEqual({ announced: 0, skipped: 0, failed: 0 });
    expect(client.updateMember).not.toHaveBeenCalled();
  });
});
