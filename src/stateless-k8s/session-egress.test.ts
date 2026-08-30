import { describe, expect, it } from 'vitest';

import { statelessEgressContainers } from './session-egress.js';

describe('stateless session identity', () => {
  it('keeps the private identity volume away from the agent', () => {
    const result = statelessEgressContainers({
      deploymentId: 'deployment',
      groupId: 'group',
      sessionId: 'session',
      containerInstanceId: 'container',
      channelId: 'channel',
      claim: 'ab'.repeat(64),
      claimUrl: 'https://gateway-claim.system.svc.cluster.local:9446',
      claimServerName: 'gateway.internal',
      gatewayAddress: 'gateway-session.system.svc.cluster.local:9443',
      gatewayServerName: 'gateway.internal',
      sidecarImage: `sidecar@sha256:${'a'.repeat(64)}`,
      materializerImage: `materializer@sha256:${'b'.repeat(64)}`,
    });
    expect(result.containers.map(({ role }) => role)).toEqual(['identity-manager', 'egress-sidecar']);
    expect(result.containers[0].sensitiveEnv).toEqual({ NANOCO_IDENTITY_CLAIM: 'ab'.repeat(64) });
    const identityMounts = result.containers[1].mounts.filter(({ source }) => source?.name === 'session-identity');
    expect(identityMounts).toEqual([
      expect.objectContaining({ containerPath: '/run/nanoco/identity', mode: 'ro' }),
    ]);
    expect(identityMounts[0]).not.toHaveProperty('subPath');
    expect(result.agentMount.source).toMatchObject({ kind: 'secret', key: 'proxy-ca.pem' });
  });
});
