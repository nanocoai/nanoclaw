/**
 * `ncl sandboxes remote …` through the real dispatch path with the door
 * itself mocked: every verb is operator-only, the account name is validated
 * before the door is touched, and arguments reach the door verbs intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../code-mode/door/index.js', () => ({
  enableDoor: vi.fn(),
  disableDoor: vi.fn(),
  doorStatus: vi.fn(),
  listDoorKeys: vi.fn(),
  addDoorKey: vi.fn(),
  approveDoorKey: vi.fn(),
  revokeDoorKey: vi.fn(),
}));

import {
  addDoorKey,
  approveDoorKey,
  disableDoor,
  doorStatus,
  enableDoor,
  listDoorKeys,
  revokeDoorKey,
} from '../../code-mode/door/index.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, RequestFrame, ResponseFrame } from '../frame.js';
import './sandboxes.js';

const HOST: CallerContext = { caller: 'host' };
const AGENT: CallerContext = { caller: 'agent', sessionId: 's1', agentGroupId: 'g-agent', messagingGroupId: 'mg1' };

function call(command: string, args: Record<string, unknown> = {}, ctx: CallerContext = HOST): Promise<ResponseFrame> {
  const req: RequestFrame = { id: `r-${Math.random().toString(36).slice(2, 8)}`, command, args };
  return dispatch(req, ctx);
}

const human = (res: ResponseFrame): string | undefined => (res.ok ? res.human : undefined);

const summary = {
  enabled: true,
  name: 'alice',
  doorPort: 33022,
  hostKeyFingerprint: 'SHA256:abc',
  approvalUrl: 'https://example.test/terminals',
  terminal: { enabled: true, name: 'alice', hostKeyFingerprint: 'SHA256:abc', doorPort: 33022, updatedAt: 't' },
  door: { running: true, port: 33022, connections: 1, sessions: 1 },
  keys: { approved: 0, browser: 0, pending: 1, rooms: 1 },
};

beforeEach(async () => {
  await runMigrations(await initTestDb());
  vi.mocked(enableDoor).mockResolvedValue(summary);
  vi.mocked(disableDoor).mockResolvedValue({ ...summary, enabled: false, door: { running: false } });
  vi.mocked(doorStatus).mockResolvedValue(summary);
  vi.mocked(listDoorKeys).mockResolvedValue({ version: 1, approved: [], pending: [] });
  vi.mocked(addDoorKey).mockResolvedValue({ fingerprint: 'SHA256:added', publicKey: 'k', label: 'l', approvedAt: 't' });
  vi.mocked(approveDoorKey).mockResolvedValue({
    fingerprint: 'SHA256:ok',
    publicKey: 'k',
    label: 'l',
    approvedAt: 't',
  });
  vi.mocked(revokeDoorKey).mockResolvedValue({ fingerprint: 'SHA256:gone' });
});

afterEach(async () => {
  vi.clearAllMocks();
  await closeDb();
});

describe('sandboxes remote — operator-only surface', () => {
  it.each([
    'sandboxes-remote-enable',
    'sandboxes-remote-disable',
    'sandboxes-remote-status',
    'sandboxes-remote-keys-list',
    'sandboxes-remote-keys-add',
    'sandboxes-remote-keys-approve',
    'sandboxes-remote-keys-revoke',
  ])('%s refuses an agent caller before any handler runs', async (command) => {
    const res = await call(command, { name: 'alice', id: 'x' }, AGENT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expect(enableDoor).not.toHaveBeenCalled();
    expect(addDoorKey).not.toHaveBeenCalled();
  });
});

describe('sandboxes remote enable', () => {
  it('validates the account name before the door is touched', async () => {
    for (const [args, pattern] of [
      [{ name: 'ab' }, /3–32/],
      [{ name: 'My-Box' }, /lowercase/],
      [{ id: '-abc' }, /hyphen/],
    ] as const) {
      const res = await call('sandboxes-remote-enable', args);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toMatch(pattern);
    }
    expect(enableDoor).not.toHaveBeenCalled();
  });

  it('enables under the flag or positional name and renders the summary', async () => {
    const flagged = await call('sandboxes-remote-enable', { name: 'alice' });
    expect(flagged.ok).toBe(true);
    expect(enableDoor).toHaveBeenLastCalledWith({ name: 'alice' });
    expect(human(flagged)).toContain('enabled for "alice"');
    expect(human(flagged)).toContain('127.0.0.1:33022');
    expect(human(flagged)).toContain('SHA256:abc');
    expect(human(flagged)).toContain('0 approved here, 0 approved in the browser, 1 pending');

    // `ncl sandboxes remote enable bob` arrives as the trailing positional.
    const positional = await call('sandboxes-remote-enable-bob');
    expect(positional.ok).toBe(true);
    expect(enableDoor).toHaveBeenLastCalledWith({ name: 'bob' });
  });

  it('enables without a name (the account assigns one) and prints the address and a rename', async () => {
    vi.mocked(enableDoor).mockResolvedValueOnce({
      ...summary,
      name: 'alice-2',
      host: 'alice-2.example.test',
      previousName: 'alice',
    });
    const res = await call('sandboxes-remote-enable');
    expect(res.ok).toBe(true);
    expect(enableDoor).toHaveBeenLastCalledWith({});
    expect(human(res)).toContain('enabled for "alice-2"');
    expect(human(res)).toContain('ssh alice-2.example.test');
    expect(human(res)).toContain('from "alice" — your address changed');
    expect(human(res)).not.toContain('loopback only');
  });
});

describe('sandboxes remote disable / status', () => {
  it('disables and reports', async () => {
    const off = await call('sandboxes-remote-disable');
    expect(off.ok).toBe(true);
    expect(disableDoor).toHaveBeenCalledTimes(1);
    expect(human(off)).toContain('disabled');
    const status = await call('sandboxes-remote-status');
    expect(status.ok).toBe(true);
    expect(doorStatus).toHaveBeenCalledTimes(1);
    expect(human(status)).toContain('listening, 1 session');
  });
});

describe('sandboxes remote keys', () => {
  it('adds from a positional key or --key with an optional label', async () => {
    const res = await call('sandboxes-remote-keys-add', { id: 'ssh-ed25519 AAAA test', label: 'laptop' });
    expect(res.ok).toBe(true);
    expect(addDoorKey).toHaveBeenLastCalledWith('ssh-ed25519 AAAA test', 'laptop');
    expect(human(res)).toBe('approved SHA256:added');
    await call('sandboxes-remote-keys-add', { key: '/home/alice/.ssh/id_ed25519.pub' });
    expect(addDoorKey).toHaveBeenLastCalledWith('/home/alice/.ssh/id_ed25519.pub', undefined);
    const usage = await call('sandboxes-remote-keys-add');
    expect(usage.ok).toBe(false);
    if (!usage.ok) expect(usage.error.message).toMatch(/usage/);
  });

  it('approves and revokes by fingerprint, keeping the fingerprint intact through the dispatch fallback', async () => {
    const approve = await call('sandboxes-remote-keys-approve-SHA256:ab-cd');
    expect(approve.ok).toBe(true);
    expect(approveDoorKey).toHaveBeenLastCalledWith('SHA256:ab-cd', undefined);
    const revoke = await call('sandboxes-remote-keys-revoke', { id: 'SHA256:gone' });
    expect(revoke.ok).toBe(true);
    expect(revokeDoorKey).toHaveBeenLastCalledWith('SHA256:gone');
    expect(human(revoke)).toBe('revoked SHA256:gone');
  });

  it('lists with an empty-state hint', async () => {
    const res = await call('sandboxes-remote-keys-list');
    expect(res.ok).toBe(true);
    expect(human(res)).toContain('no terminal keys');
    expect(listDoorKeys).toHaveBeenCalledTimes(1);
  });
});
