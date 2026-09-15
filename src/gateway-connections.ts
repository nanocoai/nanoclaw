import { getAgentGroup } from './db/agent-groups.js';
import { getGatewayProvider } from './gateway-providers/index.js';
import type { GatewayConnectionResult } from './gateway-providers/gateway-provider-registry.js';

/** Shared account-connection handoff for every service and gateway. */
export async function connectGatewayAccount(agentGroupId: string, rawHost: string): Promise<GatewayConnectionResult> {
  const host = rawHost.trim().toLowerCase();
  if (host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) {
    throw new Error('Supply a hostname only, without URL, port, path, or credentials');
  }
  if (!(await getAgentGroup(agentGroupId))) throw new Error('Agent group not found');
  const gateway = getGatewayProvider();
  if (!gateway.connections)
    return { status: 'unsupported', message: 'This gateway does not implement account connection handoff.' };
  const result = await gateway.connections.connect({ agentGroupId, host });
  if (!result || typeof result.message !== 'string' || result.message.length > 2000)
    throw new Error('Invalid gateway connection result');
  if (result.status === 'unsupported') return { status: 'unsupported', message: result.message };
  if (result.status !== 'action_required' || !['operator_console', 'oauth'].includes(result.action))
    throw new Error('Invalid gateway connection action');
  const url = new URL(result.connect_url);
  if (
    url.username ||
    url.password ||
    result.connect_url.length > 4096 ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new Error('Gateway returned an unsafe connection URL');
  }
  return { status: 'action_required', action: result.action, connect_url: result.connect_url, message: result.message };
}
