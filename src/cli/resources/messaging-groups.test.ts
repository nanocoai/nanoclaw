/**
 * Regression test: `ncl messaging-groups create` must satisfy the NOT NULL
 * `instance` column without an operator-supplied `--instance`. The column has
 * no CLI flag at the operator's altitude (the default instance IS the channel
 * type), so the generic CRUD insert defaults it to `channel_type` — matching
 * `createMessagingGroup`'s `instance ?? channel_type` fallback on the router
 * path. Delete the `instance` column / `defaultFrom` wiring in
 * `messaging-groups.ts` and this goes red: the insert fails the NOT NULL.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-msggroups' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-msggroups';

import type { ChannelDefaults } from '../../channels/adapter.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `messaging-groups-create` command.
import './messaging-groups.js';

// Registration-tier declaration (no live adapter) — the environment `ncl`
// sees for offline instances and setup scripts.
const declared: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('declchan-mg', { factory: () => null, defaults: declared });

describe('messaging-groups CLI create defaults instance to channel_type', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('create without --instance sets instance = channel_type', async () => {
    // caller: 'host' is the post-approval re-entry path for create (approval op).
    const resp = await dispatch(
      {
        id: 'req-1',
        command: 'messaging-groups-create',
        args: { channel_type: 'telegram', platform_id: '12345' },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const row = getMessagingGroupByPlatform('telegram', '12345');
    expect(row).toBeDefined();
    expect(row?.instance).toBe('telegram');
  });

  it('create with an explicit --instance keeps that value', async () => {
    const resp = await dispatch(
      {
        id: 'req-2',
        command: 'messaging-groups-create',
        args: { channel_type: 'telegram', platform_id: '67890', instance: 'work' },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect(getMessagingGroupByPlatform('telegram', '67890', 'work')?.instance).toBe('work');
  });
});

describe('messaging-groups CLI create resolves unknown_sender_policy from the channel declaration', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  const create = (args: Record<string, unknown>, id: string) =>
    dispatch({ id, command: 'messaging-groups-create', args }, { caller: 'host' });

  it('DM context takes the declared dm policy', async () => {
    const resp = await create({ channel_type: 'declchan-mg', platform_id: 'dm-1' }, 'req-d1');
    expect(resp.ok).toBe(true);
    expect(getMessagingGroupByPlatform('declchan-mg', 'dm-1')?.unknown_sender_policy).toBe('public');
  });

  it('group context takes the declared group policy', async () => {
    const resp = await create({ channel_type: 'declchan-mg', platform_id: 'g-1', is_group: '1' }, 'req-d2');
    expect(resp.ok).toBe(true);
    expect(getMessagingGroupByPlatform('declchan-mg', 'g-1')?.unknown_sender_policy).toBe('request_approval');
  });

  it('explicit --unknown-sender-policy wins over the declaration', async () => {
    const resp = await create(
      { channel_type: 'declchan-mg', platform_id: 'dm-2', unknown_sender_policy: 'strict' },
      'req-d3',
    );
    expect(resp.ok).toBe(true);
    expect(getMessagingGroupByPlatform('declchan-mg', 'dm-2')?.unknown_sender_policy).toBe('strict');
  });

  it("undeclared channels keep the legacy static 'strict' default (back-compat)", async () => {
    const resp = await create({ channel_type: 'stalechan-mg', platform_id: 's-1' }, 'req-d4');
    expect(resp.ok).toBe(true);
    expect(getMessagingGroupByPlatform('stalechan-mg', 's-1')?.unknown_sender_policy).toBe('strict');
  });
});
