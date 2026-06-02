import { execFile } from 'child_process';
import { promisify } from 'util';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const execFileAsync = promisify(execFile);

const CHANNEL_TYPE = 'server_roni';
const PLATFORM_ID = 'roni';

function extractText(message: OutboundMessage): string | null {
  const content = message.content as { text?: unknown } | null;
  return typeof content?.text === 'string' && content.text.trim() ? content.text : null;
}

function createAdapter(): ChannelAdapter | null {
  const env = readEnvFile([
    'SERVER_RONI_SSH_TARGET',
    'SERVER_RONI_PROJECT_ROOT',
    'SERVER_RONI_AGENT_ID',
    'LOCAL_CODY_AGENT_ID',
  ]);
  const sshTarget = env.SERVER_RONI_SSH_TARGET;
  const projectRoot = env.SERVER_RONI_PROJECT_ROOT || '/opt/nanoclaw';
  const agentId = env.SERVER_RONI_AGENT_ID || 'ag-1779753187257-7xmvcg';
  const fromAgentId = env.LOCAL_CODY_AGENT_ID || 'ag-1779782931755-x43x64';

  if (!sshTarget) return null;

  return {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(_config: ChannelSetup): Promise<void> {
      log.info('Server Roni bridge ready', { sshTarget, projectRoot, agentId });
    },

    async teardown(): Promise<void> {
      // No persistent connection.
    },

    isConnected(): boolean {
      return true;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      const text = extractText(message);
      if (!text) return undefined;

      const payload = Buffer.from(
        JSON.stringify({
          agentId,
          fromAgentId,
          fromName: 'Cody',
          text,
        }),
        'utf8',
      ).toString('base64');

      await execFileAsync(
        'ssh',
        [
          '-o',
          'BatchMode=yes',
          sshTarget,
          `cd ${JSON.stringify(projectRoot)} && pnpm exec tsx scripts/inject-remote-agent-message.ts ${payload}`,
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      return `server-roni:${Date.now()}`;
    },
  };
}

registerChannelAdapter(CHANNEL_TYPE, {
  factory: createAdapter,
});
