import type { SessionKey, SessionSpec } from '../drivers/types.js';
import { registerGatewayProvider, type GatewayProvider, type GatewayProviderInput } from './gateway-provider-registry.js';
import { registerConfiguredNanoCoSessionSidecar } from '../nanoco/gateway-provisioner.js';
import {
  adoptSessionEgress,
  boundedAdoptedEgress,
  prepareSessionEgress,
  type SessionEgressHandle,
} from '../session-egress.js';

const configured = registerConfiguredNanoCoSessionSidecar();
const handles = new Map<string, SessionEgressHandle>();

function keyOf(key: SessionKey): string {
  return `${key.installSlug}\u0000${key.agentGroupId}\u0000${key.sessionId}`;
}

function track(key: SessionKey, handle: SessionEgressHandle): SessionEgressHandle {
  const id = keyOf(key);
  const tracked: SessionEgressHandle = {
    ...handle,
    async close(reason: string): Promise<void> {
      try {
        await handle.close(reason);
      } finally {
        if (handles.get(id) === tracked) handles.delete(id);
      }
    },
    async detach(): Promise<void> {
      try {
        await handle.detach();
      } finally {
        if (handles.get(id) === tracked) handles.delete(id);
      }
    },
  };
  handles.set(id, tracked);
  return tracked;
}

function context(input: GatewayProviderInput) {
  return {
    session: { id: input.key.sessionId },
    agentGroup: { id: input.key.agentGroupId },
    containerName: input.containerName,
    requestCapability: input.requestCapability,
  };
}

export function networkArgsForNanoCoSession(spec: SessionSpec): string[] {
  return [...(handles.get(keyOf(spec.key))?.agentNetworkArgs ?? [])];
}

export function createNanoCoGatewayProvider(): GatewayProvider {
  return {
    kind: 'nanoco',
    async contribute(input) {
      if (!configured.configured) {
        throw new Error('NanoCo session egress is selected but its configuration is absent');
      }
      const handle = track(input.key, await prepareSessionEgress(context(input)));
      return {
        env: { ...handle.agentEnvironment },
        mounts: [...(handle.agentMounts ?? [])],
        containers: [...(handle.containers ?? [])],
        labels: { ...(handle.agentLabels ?? {}) },
        lifecycle: handle,
      };
    },
    async adopt(input) {
      if (!configured.configured) return null;
      const adopted = (await adoptSessionEgress(context(input))) ?? boundedAdoptedEgress();
      return track(input.key, adopted);
    },
    reapOrphans() {
      configured.reapOrphans();
    },
  };
}

registerGatewayProvider('nanoco', createNanoCoGatewayProvider);
