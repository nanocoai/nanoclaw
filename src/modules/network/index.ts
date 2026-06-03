/**
 * Network policy provider barrel.
 *
 * Core ships with no provider registered.
 * Skills implementing `NetworkPolicyProvider` append self-registration here.
 * Example: Squid backend of `/agent-network`
 */

export type { ContainerArgsContext, NetworkPolicyProvider } from './types.js';
export {
  getNetworkPolicyProvider,
  registerNetworkPolicyProvider,
  resetNetworkPolicyProviderForTests,
} from './registry.js';

import './squid-policy-provider.js';
