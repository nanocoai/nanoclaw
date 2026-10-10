/**
 * The pair-dial wizard is the trusted owner-granting authority: it runs on the
 * operator's host, observes the consumed pairing, and grants owner to the paired
 * number — something the adapter's inbound handler must never do. It grants at
 * most one owner, so a second paired phone can never silently take over.
 *
 * Runs in trunk with no Dial adapter present: pair-dial.ts imports the pairing
 * store lazily (inside run()), and watchLineLock takes its lock reader as an
 * argument, so nothing here needs src/channels/dial-pairing.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../src/db/index.js';
import { getOwners, hasAnyOwner } from '../src/modules/permissions/db/user-roles.js';
import { grantOwnerFromPairing, watchLineLock } from './pair-dial.js';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@clack/prompts', () => ({
  note: vi.fn(),
  log: { message: vi.fn(), success: vi.fn(), warn, error: vi.fn() },
}));

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('pair-dial wizard — grants owner from the consumed pairing', () => {
  it('grants owner to the paired number with non-null provenance', async () => {
    expect(await hasAnyOwner()).toBe(false);

    const res = await grantOwnerFromPairing('+15551239999');
    expect(res.granted).toBe(true);
    expect(res.userId).toBe('dial:+15551239999');

    const owners = await getOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0].user_id).toBe('dial:+15551239999');
    expect(owners[0].agent_group_id).toBeNull();
    // Provenance is the wizard, not a self-grant's null.
    expect(owners[0].granted_by).toBe('setup:pair-dial');
    expect(owners[0].granted_by).not.toBeNull();
  });

  it('does nothing when an owner already exists', async () => {
    await grantOwnerFromPairing('+15551239999');

    const res = await grantOwnerFromPairing('+15550000000');
    expect(res.granted).toBe(false);

    const owners = await getOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0].user_id).toBe('dial:+15551239999'); // unchanged
  });
});

/**
 * A guess lockout never touches the pairing record `waitForPairing` watches, so
 * the wizard would otherwise sit on "Waiting for your text…" through the cooldown
 * with nothing explaining why the operator's own correct code stopped working.
 * The terminal is the only place it's reported — nothing goes back to the sender.
 */
describe('pair-dial wizard — reports a guess lockout in the terminal', () => {
  const LINE = '+13165550000';

  beforeEach(() => {
    warn.mockClear();
  });

  it('warns once, naming the line and the remaining minutes', async () => {
    // Stands in for getLineLock: unlocked, then locked 15 minutes out.
    let until: string | null = null;
    const readLock = vi.fn((line: string) => (line === LINE ? until : null));

    const stop = watchLineLock(LINE, readLock, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(warn).not.toHaveBeenCalled(); // not locked yet — stays quiet

    until = new Date(Date.now() + 15 * 60_000).toISOString();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1), { timeout: 1000 });
    stop();

    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain(LINE);
    expect(msg).toMatch(/paused for about 15 min/);
    expect(msg).toMatch(/even the correct code is refused/);

    // Reported once, not once per poll.
    await new Promise((r) => setTimeout(r, 30));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no line was given', async () => {
    const readLock = vi.fn(() => new Date(Date.now() + 15 * 60_000).toISOString());
    const stop = watchLineLock(null, readLock, 5);
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(readLock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
