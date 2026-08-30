import { describe, expect, it } from 'vitest';

import { bindWorkspaceSpec, labelId, validateWorkspacePaths, validateWorkspaceRelay, workspacePaths, type WorkspaceAssignment } from './workspace-plane.js';
import type { SessionSpec } from '../drivers/types.js';

const assignment: WorkspaceAssignment = {
  groupId: 'group-a', sessionId: 'session-1', nodeName: 'node-a', generation: 3,
  plainHostPath: '/var/lib/nanoco/workspaces/group-a/generations/3/plain', runtimeTier: 'container',
};

describe('workspace plane binding', () => {
  it('binds a relay to the exact group and session lineage', () => {
    const relay = {
      claim: 'opaque.claim', requestCapability: 'c'.repeat(64), deploymentId: 'deployment-1',
      agentId: 'group-a', sessionId: 'session-1', containerInstanceId: 'workspace-1', channelId: 'workspace-1',
      claimUrl: 'https://gateway-claim.system.svc.cluster.local:9446', claimServerName: 'gateway.internal',
      gatewayAddress: 'gateway-session.system.svc.cluster.local:9443', gatewayServerName: 'gateway.internal',
      sidecarImage: `sidecar@sha256:${'b'.repeat(64)}`,
    };
    expect(() => validateWorkspaceRelay(relay, { groupId: 'group-a', sessionId: 'session-1' })).not.toThrow();
    expect(() => validateWorkspaceRelay(relay, { groupId: 'group-b', sessionId: 'session-1' })).toThrow('does not belong');
  });

  it('binds durable group and session volumes to one fenced generation', () => {
    const spec = {
      key: { installSlug: 'test', agentGroupId: 'group-a', sessionId: 'session-1' },
      labels: {}, projectDocument: undefined,
      containers: [{ role: 'agent', image: 'agent', env: {}, command: [], args: [], contributedEnv: {}, labels: {}, mounts: [
        { class: 'group-state', groupScope: 'group-a', hostPath: '/runtime/group-state', containerPath: '/workspace/agent', mode: 'rw', source: { kind: 'emptyDir', name: 'group-state' } },
        { class: 'group-state', groupScope: 'group-a', hostPath: '/runtime/session-state', containerPath: '/workspace', mode: 'rw', source: { kind: 'emptyDir', name: 'session-state' } },
        { class: 'group-state', groupScope: 'group-a', hostPath: '/runtime/provider', containerPath: '/home/node/.claude', mode: 'rw', source: { kind: 'emptyDir', name: 'claude-state' } },
      ] }],
      network: 'shared-private', hardening: 'standard', resources: {}, runtimeTier: 'container', stopGraceSeconds: 10,
    } as SessionSpec;
    bindWorkspaceSpec(spec, assignment);
    expect(spec.workspace).toEqual(assignment);
    expect(spec.containers[0].mounts.map((mount) => mount.hostPath)).toEqual([
      `${assignment.plainHostPath}/agent`, '/runtime/session-state', `${assignment.plainHostPath}/provider-state/claude-state`,
    ]);
    expect(spec.containers[0].mounts.map((mount) => mount.source?.kind)).toEqual(['hostPath', 'emptyDir', 'hostPath']);
    expect(workspacePaths(spec, assignment)).toEqual(['agent', 'provider-state/claude-state']);
    expect(() => validateWorkspacePaths(['../other-group'])).toThrow('invalid workspace path');
    expect(spec.labels['nanoco.ai/workspace-group']).toBe(labelId('group-a'));
  });
});
