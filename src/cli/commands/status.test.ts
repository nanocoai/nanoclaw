import { realpathSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../host-instance.js', () => ({ getHostInstanceId: () => 'running-instance' }));
vi.mock('../../db/container-configs.js', () => ({ getContainerConfig: async () => ({ cli_scope: 'global' }) }));
vi.mock('../../channels/channel-registry.js', () => ({
  getActiveAdapters: () => [
    { channelType: 'mattermost', isConnected: () => true },
    { channelType: 'slack', instance: 'team-two', isConnected: () => false },
  ],
}));

import './status.js';
import './help.js';
import { dispatch } from '../dispatch.js';

describe('host status', () => {
  it('reports the live process and adapter connection state through dispatch', async () => {
    expect(await dispatch({ id: 'probe', command: 'status', args: {} }, { caller: 'host' })).toMatchObject({
      id: 'probe',
      ok: true,
      data: {
        pid: process.pid,
        instance_id: 'running-instance',
        project_root: realpathSync(process.cwd()),
        channels: [
          { instance: 'mattermost', type: 'mattermost', connected: true },
          { instance: 'team-two', type: 'slack', connected: false },
        ],
      },
    });
  });

  it('rejects container callers before exposing host status', async () => {
    expect(
      await dispatch(
        { id: 'probe', command: 'status', args: {} },
        {
          caller: 'agent',
          sessionId: 'session',
          agentGroupId: 'group',
          messagingGroupId: 'chat',
        },
      ),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('does not advertise the internal status command in help', async () => {
    const response = await dispatch({ id: 'help', command: 'help', args: {} }, { caller: 'host' });
    expect(response).toMatchObject({ id: 'help', ok: true });
    expect(response.ok && response.data).not.toContain('status');
  });
});
