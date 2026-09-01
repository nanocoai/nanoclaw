import { registerAgentMailbox } from '../../mailbox/index.js';
import { loadS3MailboxConfig } from './config.js';
import { gatewaySignedHostFetch } from './gateway-host-fetch.js';
import { roleBackedS3Fetch } from './role-fetch.js';
import { S3AgentMailbox, type SignedFetch } from './store.js';

function mailboxFetch(region: string): { client: SignedFetch; initialCapability?: string } {
  const mode = process.env.NANOCLAW_MAILBOX_S3_TRANSPORT?.trim() || 'role';
  if (mode === 'role') return { client: roleBackedS3Fetch(region) };
  if (mode !== 'gateway') throw new Error(`unknown Host S3 mailbox transport: ${mode}`);
  const capability = process.env.NANOCLAW_STORAGE_CAPABILITY ?? '';
  return { client: gatewaySignedHostFetch({
    proxy: process.env.NANOCLAW_MAILBOX_GATEWAY_PROXY ?? '',
    proxyCaPath: process.env.NANOCLAW_MAILBOX_GATEWAY_CA ?? '',
    capability,
  }), initialCapability: capability };
}

registerAgentMailbox(() => {
  const config = loadS3MailboxConfig();
  const transport = mailboxFetch(config.region);
  return new S3AgentMailbox({
    ...config,
    initialCapability: transport.initialCapability,
    // The parent relay is scoped to the whole child environment. Governance
    // authorizes ListObjects at that environment's agent-group root; the store
    // filters the response back to the requested child session before loading.
    delegatedListPrefix: transport.initialCapability
      ? `${config.prefix}/v2/agent-groups`
      : undefined,
  }, transport.client);
});

export { S3AgentMailbox } from './store.js';
