import { runGatewayAuth } from './install.js';
import { ensureExplicitGatewaySelection } from './selection.js';
import { emitStatus } from '../status.js';

export async function run(args: string[]): Promise<void> {
  const gateway =
    process.env.NANOCLAW_GATEWAY_PROVIDER?.trim().toLowerCase() || ensureExplicitGatewaySelection(process.cwd());
  const provider = args[0]?.trim().toLowerCase() || 'claude';
  runGatewayAuth(gateway, provider);
  emitStatus('GATEWAY_AUTH', { STATUS: 'success', GATEWAY: gateway, PROVIDER: provider });
}
