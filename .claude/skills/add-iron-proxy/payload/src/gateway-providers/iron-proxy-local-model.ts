import { readEnvFile } from '../env.js';
import { listProviderHostContracts, type ProviderHostContract } from '../provider-contracts/index.js';

/** Docker's name for the machine running the containers. */
export const LOCAL_MODEL_HOST = 'host.docker.internal';

/** Ports on this machine that belong to NanoClaw's gateways; a local model may never be one. */
export function gatewayPorts(approvalPort: number | undefined, env: NodeJS.ProcessEnv = process.env): number[] {
  const file = readEnvFile(['NANOCLAW_IRON_CONTROL_PORT', 'ONECLI_URL']);
  const ports = [Number(env.NANOCLAW_IRON_CONTROL_PORT || file.NANOCLAW_IRON_CONTROL_PORT || 10257), 10254, 10255];
  if (approvalPort) ports.push(approvalPort);
  const onecli = env.ONECLI_URL || file.ONECLI_URL;
  if (onecli) {
    try {
      const url = new URL(onecli);
      // Reserved whatever the host: a local OneCLI may be addressed by a LAN IP or alias,
      // and over-reserving only blocks a model that shares a remote OneCLI's port.
      ports.push(Number(url.port || (url.protocol === 'https:' ? 443 : 80)));
    } catch {
      /* A malformed ONECLI_URL is OneCLI's own setup error. */
    }
  }
  return [...new Set(ports)];
}

/** Derived from providers' declared authorities at host start, so no pin outlives its endpoint. */
export function localModelOrigins(
  approvalPort: number | undefined,
  contracts: readonly Pick<ProviderHostContract, 'modelAuthorities'>[] = listProviderHostContracts(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const refused = new Set(gatewayPorts(approvalPort, env));
  return [...new Set(contracts.flatMap((contract) => contract.modelAuthorities ?? []))]
    .filter((authority) => {
      const [host, port] = authority.split(':');
      return host === LOCAL_MODEL_HOST && port !== '80' && !refused.has(Number(port));
    })
    .sort();
}
