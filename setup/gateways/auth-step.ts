import { runGatewayAuth } from './install.js';
import { ensureExplicitGatewaySelection } from './selection.js';

export async function run(args: string[]): Promise<void> {
  const gateway =
    process.env.NANOCLAW_GATEWAY_PROVIDER?.trim().toLowerCase() || ensureExplicitGatewaySelection(process.cwd());
  runGatewayAuth(gateway, args[0]?.trim().toLowerCase() || 'claude');
}
