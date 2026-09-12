import { realpathSync } from 'node:fs';

import { getActiveAdapters } from '../../channels/channel-registry.js';
import { getHostInstanceId } from '../../host-instance.js';
import { register } from '../registry.js';

// Served over the existing host-only local ncl socket after startup completes.
// A socket file or service-manager success alone cannot prove a new host
// loaded a channel. The instance id also distinguishes restarts with PID reuse.
register({
  name: 'status',
  description: 'Show the running host process and connected channel adapters.',
  access: 'hidden',
  hostOnly: true,
  parseArgs: () => ({}),
  handler: async () => ({
    pid: process.pid,
    instance_id: getHostInstanceId(),
    project_root: realpathSync(process.cwd()),
    channels: getActiveAdapters().map((adapter) => ({
      instance: adapter.instance ?? adapter.channelType,
      type: adapter.channelType,
      connected: adapter.isConnected(),
    })),
  }),
});
