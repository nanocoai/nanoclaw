/** Select the one gateway definition NanoClaw will orchestrate. */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import {
  getGatewayProviderRegistration,
  listGatewayProviderKinds,
  listGatewayProviderRegistrations,
  type GatewayProviderDefinition,
  type GatewayProviderKind,
} from './gateway-provider-registry.js';
// Side-effect import: installable gateway packages append one registration.
import './installed.js';

export function configuredGatewayProviderKind(env: NodeJS.ProcessEnv = process.env): GatewayProviderKind {
  const configured =
    env.NANOCLAW_GATEWAY_PROVIDER?.trim() ||
    readEnvFile(['NANOCLAW_GATEWAY_PROVIDER']).NANOCLAW_GATEWAY_PROVIDER?.trim() ||
    '';
  if (configured) return configured.toLowerCase();
  const installed = listGatewayProviderKinds();
  if (installed.length === 0) throw new Error('No gateway provider is registered in this build');
  if (installed.length > 1) {
    throw new Error(
      `Multiple gateway providers are registered (${installed.join(', ')}); set NANOCLAW_GATEWAY_PROVIDER explicitly`,
    );
  }
  return installed[0];
}

let selected: GatewayProviderDefinition | null = null;

export function getGatewayProvider(): GatewayProviderDefinition {
  if (!selected) {
    const kind = configuredGatewayProviderKind();
    const definition = getGatewayProviderRegistration(kind);
    if (!definition) {
      throw new Error(
        `NANOCLAW_GATEWAY_PROVIDER='${kind}' but no gateway provider is registered for '${kind}'; ` +
          `installed: ${listGatewayProviderKinds().join(', ')}. ` +
          'Other gateways arrive as overlays — install the gateway skill or unset the variable.',
      );
    }
    selected = definition;
    log.info('Gateway provider selected', { gatewayProvider: selected.kind });
  }
  return selected;
}

/** Expose only the active gateway's agent skills; drop any other gateway's. */
export function selectGatewayAgentSkills(skills: readonly string[]): string[] {
  const gatewaySkills = new Set(listGatewayProviderRegistrations().flatMap((entry) => entry.agentSkills));
  const required = getGatewayProvider().agentSkills;
  return [...new Set([...skills.filter((skill) => !gatewaySkills.has(skill)), ...required])];
}

/** Test seam: drop the memoized selection so a suite can inject another one. */
export function resetGatewayProvider(next: GatewayProviderDefinition | null = null): void {
  selected = next;
}

export * from './gateway-provider-registry.js';
