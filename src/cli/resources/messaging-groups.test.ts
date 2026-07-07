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

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `messaging-groups-create` command.
import './messaging-groups.js';

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
