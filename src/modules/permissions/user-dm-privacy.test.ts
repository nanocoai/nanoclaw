import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  openDM: vi.fn(async () => {
    throw new Error('sdk response contained token=secret and handle=U-private');
  }),
}));

vi.mock('../../log.js', () => ({
  log: { error: mocks.error, warn: mocks.warn, info: mocks.info, debug: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: () => ({ channelType: 'slack', openDM: mocks.openDM }),
}));

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn(),
  getMessagingGroupByPlatform: vi.fn(),
  createMessagingGroup: vi.fn(),
}));

vi.mock('./db/users.js', () => ({
  getUser: () => ({ id: 'slack:U-private', kind: 'slack', display_name: 'Private', created_at: 'now' }),
}));

vi.mock('./db/user-dms.js', () => ({ getUserDm: vi.fn(), upsertUserDm: vi.fn() }));

import { ensureUserDm } from './user-dm.js';

beforeEach(() => vi.clearAllMocks());

it('sanitizes mapped identity and platform SDK errors for the Gateway approval path', async () => {
  await expect(ensureUserDm('slack:U-private', { privacySafeLogs: true })).resolves.toBeNull();

  expect(mocks.error).toHaveBeenCalledWith('ensureUserDm: adapter.openDM failed', {
    channelType: 'slack',
  });
  const logged = JSON.stringify(mocks.error.mock.calls);
  expect(logged).not.toContain('U-private');
  expect(logged).not.toContain('token=secret');
});
