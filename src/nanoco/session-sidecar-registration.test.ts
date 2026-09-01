/**
 * The registration seam, end to end: registerNanoCoSessionSidecar →
 * prepareSessionEgress → the handle the container runner composes from.
 *
 * This is the right place to pin the agent's proxy URL, because the URL is no
 * longer a constant — it is derived from the topology the session driver
 * realized. Asserting `http://sidecar:15001` here would have passed for the
 * wrong reason: it is correct only because the injected driver does not share a
 * network namespace. Both shapes are driven, so the derivation itself is what
 * the case pins.
 *
 * Each case re-imports the module graph: `registerSessionEgressFactory` refuses
 * a second registration by design, so network identity can never become
 * import-order dependent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerSpec } from '../drivers/types.js';
import type { PrepareSessionEgressContext } from '../session-egress.js';
import type {
  SessionChannelProvisioner,
  SessionSidecarDriver,
  SessionSidecarProcess,
} from './session-sidecar.js';

const processHandle: SessionSidecarProcess = {
  on: vi.fn(function (this: SessionSidecarProcess) {
    return this;
  }),
};

/**
 * The Docker shape: the sidecar is a separate netns bridged to an uplink the
 * agent must not reach, so the agent stays on its own internal network.
 */
function dockerShapedDriver(): SessionSidecarDriver {
  return {
    sharesNetworkNamespace: false,
    contributedContainers: () => [],
    agentNetworkArgs: (privateNetwork: string) => ['--network', privateNetwork],
    createNetwork: vi.fn(),
    createSidecar: vi.fn(),
    startSidecar: vi.fn(() => processHandle),
    stopSidecar: vi.fn(),
    removeSidecar: vi.fn(),
    removeNetwork: vi.fn(),
  };
}

/**
 * The pod shape: the session driver realizes the sidecar as a container in the
 * agent's own pod, so this driver creates nothing and the two share a namespace.
 */
function podShapedDriver(sidecar: ContainerSpec): SessionSidecarDriver {
  return {
    sharesNetworkNamespace: true,
    contributedContainers: () => [sidecar],
    agentNetworkArgs: () => [],
    createNetwork: vi.fn(),
    createSidecar: vi.fn(),
    startSidecar: vi.fn(() => processHandle),
    stopSidecar: vi.fn(),
    removeSidecar: vi.fn(),
    removeNetwork: vi.fn(),
  };
}

const sidecarSpec: ContainerSpec = {
  role: 'egress-sidecar',
  image: 'nanoco-sidecar:test',
  env: { NANOCO_SIDECAR_LISTEN_ADDR: '0.0.0.0:15001' },
  mounts: [
    {
      class: 'identity-material',
      hostPath: '/secrets/session-key.pem',
      containerPath: '/run/nanoco/session-key.pem',
      mode: 'ro',
      groupScope: 'agent-1',
    },
  ],
};

const provisioner: SessionChannelProvisioner = {
  async provision(lineage) {
    const { SessionChannelMaterials } = await import('./session-sidecar.js');
    return {
      lineage,
      gatewayAddress: 'gateway.example:9443',
      gatewayServerName: 'gateway.example',
      expiresAt: '2099-01-01T00:00:00.000Z',
      // The channel's real ceiling: renewal is gated on this, not on lease expiry.
      certificateNotAfter: '2099-01-01T01:00:00.000Z',
      leaseVersion: 1,
      materials: new SessionChannelMaterials({
        gatewayCaPath: '/secrets/gateway-ca.pem',
        clientCertificatePath: '/secrets/session-cert.pem',
        clientPrivateKeyPath: '/secrets/session-key.pem',
        proxyCaPath: '/public/proxy-ca.pem',
      }),
    };
  },
  async renew(channel) {
    return { ...channel, leaseVersion: channel.leaseVersion + 1 };
  },
  revoke: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
};

const context: PrepareSessionEgressContext = {
  session: {
    id: 'session-1',
    agent_group_id: 'agent-1',
    messaging_group_id: 'messaging-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-07-22T00:00:00.000Z',
  },
  agentGroup: {
    id: 'agent-1',
    name: 'Agent One',
    folder: 'agent-one',
    agent_provider: null,
    created_at: '2026-07-22T00:00:00.000Z',
  },
  containerName: 'agent-container-1',
};

/** Register into a fresh module graph and prepare one session's egress. */
async function registerAndPrepare(driver: SessionSidecarDriver) {
  vi.resetModules();
  const sidecarModule = await import('./session-sidecar.js');
  const egressModule = await import('../session-egress.js');
  sidecarModule.registerNanoCoSessionSidecar(
    { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
    provisioner,
    driver,
  );
  return egressModule.prepareSessionEgress(context);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('session egress registration', () => {
  it('routes the agent through the sidecar alias when the namespace is not shared', async () => {
    const handle = await registerAndPrepare(dockerShapedDriver());

    expect(handle.agentEnvironment.HTTP_PROXY).toBe('http://sidecar:15001');
    expect(handle.agentEnvironment.HTTPS_PROXY).toBe('http://sidecar:15001');
    expect(handle.agentNetworkArgs).toEqual(['--network', expect.stringMatching(/-session$/)]);
    // Nothing to hand the session driver: this driver made the sidecar itself.
    expect(handle.containers).toEqual([]);

    await handle.close('docker-shape-complete');
  });

  it('routes the agent through loopback when the namespace is shared', async () => {
    // A Docker network alias resolves to nothing inside a shared namespace, so
    // this is not a preference — it is the only address that works there.
    const handle = await registerAndPrepare(podShapedDriver(sidecarSpec));

    expect(handle.agentEnvironment.HTTP_PROXY).toBe('http://127.0.0.1:15001');
    expect(handle.agentEnvironment.HTTPS_PROXY).toBe('http://127.0.0.1:15001');
    // The pod is the boundary; raw Docker network flags would be rejected by
    // the Pod session driver anyway.
    expect(handle.agentNetworkArgs).toEqual([]);
    expect(handle.containers).toEqual([sidecarSpec]);

    await handle.close('pod-shape-complete');
  });

  it('gives the agent the public trust anchor and its lineage, and nothing else', async () => {
    const handle = await registerAndPrepare(dockerShapedDriver());

    expect(handle.agentMounts).toEqual([
      {
        class: 'allowlisted-extra',
        hostPath: '/public/proxy-ca.pem',
        containerPath: '/run/nanoco/proxy-ca.pem',
        mode: 'ro',
        groupScope: 'agent-1',
      },
    ]);
    expect(handle.agentLabels).toMatchObject({ 'nanoco-channel': expect.stringMatching(/^channel-/) });

    await handle.close('agent-surface-complete');
  });

  it('never puts a credential or a private key on the agent boundary', async () => {
    for (const driver of [dockerShapedDriver(), podShapedDriver(sidecarSpec)]) {
      const handle = await registerAndPrepare(driver);

      // Everything the container runner will compose into the agent container.
      const agentBoundary = JSON.stringify({
        environment: handle.agentEnvironment,
        network: handle.agentNetworkArgs,
        mounts: handle.agentMounts,
        labels: handle.agentLabels,
      });
      expect(agentBoundary).not.toContain('Proxy-Authorization');
      expect(agentBoundary).not.toContain('session-key.pem');
      expect(agentBoundary).not.toContain('session-cert.pem');
      expect(agentBoundary).not.toContain('/secrets/');

      await handle.close('credential-free-complete');
    }
  });

  it('reports the channel ceiling the renewal budget runs to', async () => {
    const handle = await registerAndPrepare(dockerShapedDriver());

    expect(handle.egressState?.()).toMatchObject({
      degradedSince: null,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      certificateNotAfter: '2099-01-01T01:00:00.000Z',
    });

    await handle.close('egress-state-complete');
  });
});
