import { inspect } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  NanoCoSessionSidecarManager,
  SessionChannelMaterials,
  reapOrphanedSessionNetworks,
  SessionChannelRenewalError,
  type ProvisionedSessionChannel,
  type SessionChannelLineage,
  type SessionChannelProvisioner,
  type SessionSidecarDriver,
  type SessionSidecarProcess,
  type SidecarContainerSpec,
} from './session-sidecar.js';
import type { ContainerSpec } from '../drivers/types.js';
import { log } from '../log.js';
import type { PrepareSessionEgressContext } from '../session-egress.js';
import { INSTALL_SLUG } from '../config.js';

class FakeSidecarProcess implements SessionSidecarProcess {
  readonly closeListeners: Array<(code: number | null) => void> = [];
  readonly errorListeners: Array<(error: Error) => void> = [];

  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close' | 'error', listener: ((code: number | null) => void) | ((error: Error) => void)): this {
    if (event === 'close') this.closeListeners.push(listener as (code: number | null) => void);
    else this.errorListeners.push(listener as (error: Error) => void);
    return this;
  }

  emitClose(code: number | null): void {
    for (const listener of this.closeListeners) listener(code);
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

class FakeDriver implements SessionSidecarDriver {
  readonly sharesNetworkNamespace = false;
  readonly events: string[] = [];
  readonly process = new FakeSidecarProcess();
  readonly networks: Array<{ name: string; internal: boolean }> = [];
  sidecarSpec: SidecarContainerSpec | null = null;
  failAt: 'network' | 'sidecar' | 'start' | null = null;

  createNetwork(name: string, internal: boolean): void {
    this.events.push(`network:create:${internal ? 'internal' : 'uplink'}:${name}`);
    if (this.failAt === 'network') throw new Error('driver network details must not escape');
    this.networks.push({ name, internal });
  }

  createSidecar(spec: SidecarContainerSpec): void {
    this.events.push(`sidecar:create:${spec.name}`);
    if (this.failAt === 'sidecar') throw new Error('driver create details must not escape');
    this.sidecarSpec = spec;
  }

  startSidecar(name: string): SessionSidecarProcess {
    this.events.push(`sidecar:start:${name}`);
    if (this.failAt === 'start') throw new Error('driver start details must not escape');
    return this.process;
  }

  stopSidecar(name: string): void {
    this.events.push(`sidecar:stop:${name}`);
  }

  removeSidecar(name: string): void {
    this.events.push(`sidecar:remove:${name}`);
  }

  removeNetwork(name: string): void {
    this.events.push(`network:remove:${name}`);
  }

  contributedContainers(): readonly ContainerSpec[] {
    return [];
  }

  agentNetworkArgs(privateNetwork: string): readonly string[] {
    return ['--network', privateNetwork];
  }
}

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

function provisioned(lineage: SessionChannelLineage): ProvisionedSessionChannel {
  return {
    lineage: { ...lineage },
    gatewayAddress: 'gateway.example:9443',
    gatewayServerName: 'gateway.example',
    expiresAt: '2099-01-01T00:00:00.000Z',
    certificateNotAfter: '2099-01-01T01:00:00.000Z',
    leaseVersion: 1,
    materials: new SessionChannelMaterials({
      gatewayCaPath: '/secrets/gateway-ca.pem',
      clientCertificatePath: '/secrets/session-cert.pem',
      clientPrivateKeyPath: '/secrets/session-key.pem',
      proxyCaPath: '/public/proxy-ca.pem',
    }),
  };
}

function makeProvisioner(events: string[]): SessionChannelProvisioner & {
  provision: ReturnType<typeof vi.fn>;
  renew: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    provision: vi.fn(async (lineage: SessionChannelLineage) => {
      events.push(`provision:${lineage.channelId}`);
      return provisioned(lineage);
    }),
    renew: vi.fn(async (channel: ProvisionedSessionChannel) => ({
      ...channel,
      leaseVersion: channel.leaseVersion + 1,
    })),
    revoke: vi.fn(async (channel: ProvisionedSessionChannel, reason: string) => {
      events.push(`revoke:${channel.lineage.channelId}:${reason}`);
    }),
    release: vi.fn(async (channel: ProvisionedSessionChannel) => {
      events.push(`release:${channel.lineage.channelId}`);
    }),
  };
}

/**
 * A prepared session on fake timers with a one-minute lease, so the first
 * renewal lands at t+30s and the retry window closes just before t+60s.
 */
async function startWithLeaseWindow(token: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
  provisioner.provision.mockImplementationOnce(async (lineage: SessionChannelLineage) => {
    const channel = provisioned(lineage);
    channel.expiresAt = '2026-07-22T00:01:00.000Z';
    // The Gateway renews on status + certificate_not_after, never on lease
    // expiry, so this — not expiresAt — is what bounds recovery.
    channel.certificateNotAfter = '2026-07-22T00:10:00.000Z';
    return channel;
  });
  const manager = new NanoCoSessionSidecarManager(
    { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
    provisioner,
    driver,
    () => token,
  );
  return manager.prepare(context);
}

let driver: FakeDriver;
let provisionerEvents: string[];
let provisioner: ReturnType<typeof makeProvisioner>;

beforeEach(() => {
  driver = new FakeDriver();
  provisionerEvents = [];
  provisioner = makeProvisioner(provisionerEvents);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NanoCoSessionSidecarManager', () => {
  it('creates isolated session and uplink networks and exposes only a credential-free proxy to the agent', async () => {
    const manager = new NanoCoSessionSidecarManager(
      { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
      provisioner,
      driver,
      () => '11111111-2222-3333-4444-555555555555',
    );

    const handle = await manager.prepare(context);

    expect(provisioner.provision).toHaveBeenCalledExactlyOnceWith({
      deploymentId: 'deployment-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      containerInstanceId: 'container-11111111-2222-3333-4444-555555555555',
      channelId: 'channel-11111111-2222-3333-4444-555555555555',
    });
    expect(driver.networks).toEqual([
      { name: `nc-${INSTALL_SLUG}-1111111122223333-session`, internal: true },
      { name: `nc-${INSTALL_SLUG}-1111111122223333-uplink`, internal: false },
    ]);
    expect(handle.agentNetworkArgs).toEqual(['--network', `nc-${INSTALL_SLUG}-1111111122223333-session`]);
    expect(handle.agentEnvironment.HTTP_PROXY).toBe('http://sidecar:15001');
    expect(handle.agentEnvironment.HTTPS_PROXY).toBe('http://sidecar:15001');
    expect(handle.agentEnvironment.GIT_SSL_CAINFO).toBe('/run/nanoco/proxy-ca.pem');
    expect(Object.values(handle.agentEnvironment).join(' ')).not.toContain('@');
    expect(handle.agentLabels?.['nanoco-channel']).toBe('channel-11111111-2222-3333-4444-555555555555');
    expect(handle.agentMounts).toEqual([
      {
        class: 'allowlisted-extra',
        hostPath: '/public/proxy-ca.pem',
        containerPath: '/run/nanoco/proxy-ca.pem',
        mode: 'ro',
        groupScope: 'agent-1',
      },
    ]);
    // The Docker realization creates the sidecar itself, so it contributes no
    // container to the session spec.
    expect(handle.containers).toEqual([]);

    const serializedAgentBoundary = JSON.stringify({
      environment: handle.agentEnvironment,
      network: handle.agentNetworkArgs,
      mounts: handle.agentMounts,
      labels: handle.agentLabels,
    });
    expect(serializedAgentBoundary).not.toContain('session-key.pem');
    expect(serializedAgentBoundary).not.toContain('session-cert.pem');
    expect(serializedAgentBoundary).not.toContain('/secrets/');

    // Two roots, two classes. Classing all three as identity-material pins the
    // Gateway server CA to the material root it does not live in, which the
    // drivers correctly refuse -- denying every spawn.
    expect(driver.sidecarSpec?.mounts.map((m) => [m.containerPath, m.class])).toEqual([
      ['/run/nanoco/gateway-ca.pem', 'allowlisted-extra'],
      ['/run/nanoco/session-cert.pem', 'identity-material'],
      ['/run/nanoco/session-key.pem', 'identity-material'],
    ]);

    expect(driver.sidecarSpec?.privateNetwork).toBe(`nc-${INSTALL_SLUG}-1111111122223333-session`);
    expect(driver.sidecarSpec?.uplinkNetwork).toBe(`nc-${INSTALL_SLUG}-1111111122223333-uplink`);
    expect(driver.sidecarSpec?.name).toBe('agent-container-1-sidecar');
    expect(driver.sidecarSpec?.environment.NANOCO_SIDECAR_CLIENT_KEY).toBe('/run/nanoco/session-key.pem');
    expect(driver.sidecarSpec?.mounts).toContainEqual({
      hostPath: '/secrets/session-key.pem',
      containerPath: '/run/nanoco/session-key.pem',
      // The private key is the one file the class exists for.
      class: 'identity-material',
    });
  });

  it('redacts certificate and private-key paths from JSON and inspect output', () => {
    const channel = provisioned({
      deploymentId: 'deployment-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      containerInstanceId: 'container-1',
      channelId: 'channel-1',
    });

    expect(JSON.stringify(channel)).not.toContain('/secrets/');
    expect(inspect(channel)).not.toContain('/secrets/');
    expect(JSON.stringify(channel)).toContain('SessionChannelMaterials([redacted])');
  });

  it('signals the agent lifecycle when its sidecar exits unexpectedly', async () => {
    const manager = new NanoCoSessionSidecarManager(
      { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
      provisioner,
      driver,
      () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    const handle = await manager.prepare(context);
    const unavailable = vi.fn();
    handle.onUnavailable(unavailable);

    driver.process.emitClose(17);

    expect(unavailable).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'NanoCo session sidecar exited unexpectedly (code 17)' }),
    );
    await handle.close('session-egress-unavailable');
  });

  it('fails the agent lifecycle closed when the session lease expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
    provisioner.provision.mockImplementationOnce(async (lineage: SessionChannelLineage) => {
      const channel = provisioned(lineage);
      channel.expiresAt = '2026-07-22T00:00:01.000Z';
      return channel;
    });
    const manager = new NanoCoSessionSidecarManager(
      { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
      provisioner,
      driver,
      () => 'abababab-1111-2222-3333-444444444444',
    );
    const handle = await manager.prepare(context);
    const unavailable = vi.fn();
    handle.onUnavailable(unavailable);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(unavailable).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'NanoCo session channel lease expired' }),
    );
    await handle.close('session-lease-expired');
  });

  it('renews a live lease before expiry without changing the sidecar material', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
    provisioner.provision.mockImplementationOnce(async (lineage: SessionChannelLineage) => {
      const channel = provisioned(lineage);
      channel.expiresAt = '2026-07-22T00:00:10.000Z';
      return channel;
    });
    provisioner.renew.mockImplementationOnce(async (channel: ProvisionedSessionChannel) => ({
      ...channel,
      expiresAt: '2026-07-22T00:00:20.000Z',
      leaseVersion: 2,
    }));
    const manager = new NanoCoSessionSidecarManager(
      { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
      provisioner,
      driver,
      () => 'acacacac-1111-2222-3333-444444444444',
    );
    const handle = await manager.prepare(context);
    const unavailable = vi.fn();
    handle.onUnavailable(unavailable);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(provisioner.renew).toHaveBeenCalledTimes(1);
    expect(provisioner.renew).toHaveBeenCalledWith(
      expect.objectContaining({ leaseVersion: 1, materials: expect.any(SessionChannelMaterials) }),
    );
    expect(unavailable).not.toHaveBeenCalled();
    await handle.close('renewal-test-complete');
    expect(provisioner.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ leaseVersion: 2 }),
      'renewal-test-complete',
    );
  });

  it('survives a transient renewal failure and re-arms the timer on the late success', async () => {
    const handle = await startWithLeaseWindow('ba000001-1111-2222-3333-444444444444');
    const unavailable = vi.fn();
    handle.onUnavailable(unavailable);
    provisioner.renew
      .mockRejectedValueOnce(new SessionChannelRenewalError('transient', { code: 'ECONNREFUSED' }))
      .mockImplementationOnce(async (channel: ProvisionedSessionChannel) => ({
        ...channel,
        expiresAt: '2026-07-22T00:02:00.000Z',
        leaseVersion: 2,
      }));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(provisioner.renew).toHaveBeenCalledTimes(1);
    expect(unavailable).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(provisioner.renew).toHaveBeenCalledTimes(2);
    expect(unavailable).not.toHaveBeenCalled();

    // The renewal timer is armed again off the extended window, so the session
    // keeps renewing rather than coasting to expiry after one recovered blip.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(provisioner.renew).toHaveBeenCalledTimes(3);
    expect(unavailable).not.toHaveBeenCalled();

    await handle.close('transient-recovery-complete');
  });

  it('keeps retrying a transient failure and tears down only once the certificate window is spent', async () => {
    const handle = await startWithLeaseWindow('ba000002-1111-2222-3333-444444444444');
    const unavailable = vi.fn();
    handle.onUnavailable(unavailable);
    provisioner.renew.mockRejectedValue(new SessionChannelRenewalError('transient', { status: 500 }));

    // Twenty seconds past the first attempt the lease is still valid, so the
    // session must still be alive -- this is the gateway-restart case.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(unavailable).not.toHaveBeenCalled();
    expect(provisioner.renew.mock.calls.length).toBeGreaterThan(1);

    // Past lease expiry the session is egress-dead but still renewable, and the
    // old behaviour killed it here. A pod reschedule routinely outlasts the
    // ~150s a half-life lease window leaves, so this is the case that made
    // every later phase flaky.
    // Detection lags by at most one backoff interval — the flag is set by the
    // first attempt that fails at or after expiry — but the recorded start is
    // the expiry itself.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(unavailable).not.toHaveBeenCalled();
    expect(handle.egressState?.().degradedSince).toBe('2026-07-22T00:01:00.000Z');

    // The budget really does end — at the certificate ceiling, ten minutes in.
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'NanoCo session channel lease renewal exhausted the certificate window' }),
    );

    await handle.close('certificate-window-exhausted');
  });

  it('brackets the degraded window with an entry and a recovery log line', async () => {
    const handle = await startWithLeaseWindow('ba000006-1111-2222-3333-444444444444');
    const unavailable = vi.fn();
    handle.onUnavailable(unavailable);
    provisioner.renew.mockRejectedValue(new SessionChannelRenewalError('transient', { status: 500 }));

    expect(handle.egressState?.().degradedSince).toBeNull();

    await vi.advanceTimersByTimeAsync(95_000);
    // Egress genuinely does not work in this window, so it must be visible from
    // outside the process rather than silently absorbed.
    expect(log.warn).toHaveBeenCalledWith(
      'NanoCo session channel lease expired; egress degraded while the certificate is renewable',
      expect.objectContaining({ certificateNotAfter: '2026-07-22T00:10:00.000Z' }),
    );

    provisioner.renew.mockImplementationOnce(async (channel: ProvisionedSessionChannel) => ({
      ...channel,
      expiresAt: '2026-07-22T00:05:00.000Z',
      leaseVersion: 2,
    }));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(log.info).toHaveBeenCalledWith(
      'NanoCo session channel egress recovered after a degraded window',
      expect.objectContaining({ degradedSince: '2026-07-22T00:01:00.000Z' }),
    );
    expect(handle.egressState?.().degradedSince).toBeNull();
    expect(unavailable).not.toHaveBeenCalled();

    await handle.close('degraded-recovery-complete');
  });

  it('still tears down on the first attempt when the lease was revoked, degraded or not', async () => {
    const handle = await startWithLeaseWindow('ba000007-1111-2222-3333-444444444444');
    const unavailable = vi.fn();
    handle.onUnavailable(unavailable);
    provisioner.renew.mockRejectedValue(
      new SessionChannelRenewalError('fatal', { status: 410, code: 'channel_revoked' }),
    );

    await vi.advanceTimersByTimeAsync(35_000);

    // Widening the transient budget must not lengthen revocation detection:
    // the fatal path never enters the retry loop at all.
    expect(provisioner.renew).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledOnce();
    expect(handle.egressState?.().degradedSince).toBeNull();

    await handle.close('revoked');
  });

  it('tears down immediately without retrying when the lease has been revoked', async () => {
    const handle = await startWithLeaseWindow('ba000003-1111-2222-3333-444444444444');
    const unavailable = vi.fn();
    handle.onUnavailable(unavailable);
    provisioner.renew.mockRejectedValue(
      new SessionChannelRenewalError('fatal', { status: 410, code: 'channel_revoked' }),
    );

    await vi.advanceTimersByTimeAsync(30_000);

    expect(provisioner.renew).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'NanoCo session channel lease renewal failed' }),
    );

    // A revoked lease must not spend the backoff budget: no further attempts.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(provisioner.renew).toHaveBeenCalledTimes(1);

    await handle.close('lease-revoked');
  });

  it('accepts a lease version that skipped ahead after a recovered lost response', async () => {
    const handle = await startWithLeaseWindow('ba000004-1111-2222-3333-444444444444');
    const unavailable = vi.fn();
    handle.onUnavailable(unavailable);
    provisioner.renew.mockImplementationOnce(async (channel: ProvisionedSessionChannel) => ({
      ...channel,
      expiresAt: '2026-07-22T00:02:00.000Z',
      leaseVersion: channel.leaseVersion + 2,
    }));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(unavailable).not.toHaveBeenCalled();
    await handle.close('stale-version-recovered');
    expect(provisioner.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ leaseVersion: 3 }),
      'stale-version-recovered',
    );
  });

  it('still refuses a renewal that moves the lease expiry backwards', async () => {
    const handle = await startWithLeaseWindow('ba000005-1111-2222-3333-444444444444');
    const unavailable = vi.fn();
    handle.onUnavailable(unavailable);
    provisioner.renew.mockImplementation(async (channel: ProvisionedSessionChannel) => ({
      ...channel,
      expiresAt: '2026-07-22T00:00:30.000Z',
      leaseVersion: channel.leaseVersion + 1,
    }));

    await vi.advanceTimersByTimeAsync(30_000);

    // An unclassified failure is fatal, so this ends the session at once.
    expect(provisioner.renew).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'NanoCo session channel lease renewal failed' }),
    );

    await handle.close('non-monotonic-expiry');
  });

  it('closes without waiting out a pending renewal backoff', async () => {
    const handle = await startWithLeaseWindow('ba000006-1111-2222-3333-444444444444');
    provisioner.renew.mockRejectedValue(new SessionChannelRenewalError('transient', { code: 'ECONNREFUSED' }));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(provisioner.renew).toHaveBeenCalledTimes(1);

    // No timer advance here: close must cancel the backoff rather than block on it.
    await handle.close('agent-exit-during-backoff');

    expect(provisioner.revoke).toHaveBeenCalledTimes(1);
    expect(provisioner.release).toHaveBeenCalledTimes(1);
  });

  it('detach quiesces the lease runtime: revokes nothing, releases nothing, stops renewing', async () => {
    // The stop-with-successor half of the teardown contract (D1). A host that
    // detaches walks away: the lease stays live for the successor to re-adopt,
    // the material stays on disk for `adopt` to read back, and the running
    // session is not touched. The mutation this pins: a detach that revokes
    // (or releases, or keeps renewing) fails here.
    const handle = await startWithLeaseWindow('de7ac000-1111-2222-3333-444444444444');

    await handle.detach();
    // Renewal would have armed at t+30s and the certificate window ends at
    // t+10m; nothing may fire in either.
    await vi.advanceTimersByTimeAsync(600_000);

    expect(provisioner.renew).not.toHaveBeenCalled();
    expect(provisioner.revoke).not.toHaveBeenCalled();
    expect(provisioner.release).not.toHaveBeenCalled();
    expect(driver.events.filter((e) => /^(sidecar:stop|sidecar:remove|network:remove)/.test(e))).toEqual([]);
  });

  it('revokes once and cleans the sidecar and both networks before releasing key material', async () => {
    const manager = new NanoCoSessionSidecarManager(
      { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
      provisioner,
      driver,
      () => 'bbbbbbbb-1111-2222-3333-444444444444',
    );
    const handle = await manager.prepare(context);

    await Promise.all([handle.close('agent-exit'), handle.close('ignored-second-reason')]);

    expect(provisioner.revoke).toHaveBeenCalledTimes(1);
    expect(provisioner.release).toHaveBeenCalledTimes(1);
    expect(driver.events.filter((event) => event.startsWith('sidecar:stop:'))).toHaveLength(1);
    expect(driver.events.filter((event) => event.startsWith('sidecar:remove:'))).toHaveLength(1);
    expect(driver.events.filter((event) => event.startsWith('network:remove:'))).toHaveLength(2);
    expect(provisionerEvents.at(-1)).toBe('release:channel-bbbbbbbb-1111-2222-3333-444444444444');
  });

  it('keeps two sessions on independent channels, sidecars, and networks', async () => {
    const ids = ['12121212-1111-2222-3333-444444444444', '34343434-1111-2222-3333-444444444444'];
    const manager = new NanoCoSessionSidecarManager(
      { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
      provisioner,
      driver,
      () => ids.shift()!,
    );

    const first = await manager.prepare(context);
    const second = await manager.prepare({
      ...context,
      session: { ...context.session, id: 'session-2' },
      containerName: 'agent-container-2',
    });

    const firstNetwork = first.agentNetworkArgs[1];
    const secondNetwork = second.agentNetworkArgs[1];
    expect(firstNetwork).not.toBe(secondNetwork);
    expect(driver.events).toContain('sidecar:create:agent-container-1-sidecar');
    expect(driver.events).toContain('sidecar:create:agent-container-2-sidecar');
    expect(provisioner.provision).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: 'session-1', channelId: 'channel-12121212-1111-2222-3333-444444444444' }),
    );
    expect(provisioner.provision).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: 'session-2', channelId: 'channel-34343434-1111-2222-3333-444444444444' }),
    );

    await first.close('first-session-exit');

    expect(driver.events).toContain(`network:remove:${firstNetwork}`);
    expect(driver.events).not.toContain(`network:remove:${secondNetwork}`);
    expect(provisioner.revoke).toHaveBeenCalledTimes(1);

    await second.close('second-session-exit');
    expect(driver.events).toContain(`network:remove:${secondNetwork}`);
    expect(provisioner.revoke).toHaveBeenCalledTimes(2);
  });

  it('rejects a provisioner that changes trusted lineage and revokes its result', async () => {
    provisioner.provision.mockImplementationOnce(async (lineage: SessionChannelLineage) => {
      const channel = provisioned(lineage);
      channel.lineage.agentId = 'agent-substitution';
      return channel;
    });
    const manager = new NanoCoSessionSidecarManager(
      { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
      provisioner,
      driver,
      () => 'cccccccc-1111-2222-3333-444444444444',
    );

    await expect(manager.prepare(context)).rejects.toThrow('Provisioned session channel changed trusted agentId');
    expect(provisioner.revoke).toHaveBeenCalledTimes(1);
    expect(provisioner.release).toHaveBeenCalledTimes(1);
    expect(driver.networks).toEqual([]);
  });

  it('cleans provisioned resources and returns a sanitized error when Docker setup fails', async () => {
    driver.failAt = 'sidecar';
    const manager = new NanoCoSessionSidecarManager(
      { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
      provisioner,
      driver,
      () => 'dddddddd-1111-2222-3333-444444444444',
    );

    await expect(manager.prepare(context)).rejects.toThrow('NanoCo session sidecar failed to start');
    expect(provisioner.revoke).toHaveBeenCalledTimes(1);
    expect(provisioner.release).toHaveBeenCalledTimes(1);
    expect(driver.events.filter((event) => event.startsWith('network:remove:'))).toHaveLength(2);
  });

  it('does not expose provisioner errors that may contain certificate tooling details', async () => {
    provisioner.provision.mockRejectedValueOnce(
      new Error('openssl failed while reading /secrets/session-key.pem: PRIVATE KEY'),
    );
    const manager = new NanoCoSessionSidecarManager(
      { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
      provisioner,
      driver,
      () => 'eeeeeeee-1111-2222-3333-444444444444',
    );

    const error = await manager.prepare(context).catch((caught: unknown) => caught);

    expect(error).toEqual(new Error('NanoCo session channel provisioning failed'));
    expect(String(error)).not.toContain('/secrets/');
    expect(String(error)).not.toContain('PRIVATE KEY');
  });

  it('rejects option values that could be interpreted as Docker arguments', () => {
    expect(
      () =>
        new NanoCoSessionSidecarManager({ deploymentId: 'deployment-1', sidecarImage: '--privileged' }, provisioner),
    ).toThrow('sidecar image is not a safe image reference');
  });
});

describe('adoptPrepared', () => {
  const adoptableLineage: SessionChannelLineage = {
    deploymentId: 'deployment-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
    containerInstanceId: 'container-prev',
    channelId: 'channel-prev',
  };

  function adoptableProvisioner() {
    const base = makeProvisioner(provisionerEvents);
    return {
      ...base,
      adopt: vi.fn(async (lineage: SessionChannelLineage) => provisioned(lineage)),
      findAdoptableLineage: vi.fn((sessionId: string) =>
        sessionId === adoptableLineage.sessionId ? { ...adoptableLineage } : null,
      ),
    };
  }

  /** The pod-shaped capability: egress rides in the session, so adoption owns it. */
  function inSessionDriver(): SessionSidecarDriver {
    return Object.assign(new FakeDriver(), { realizesEgressInSession: true });
  }

  function makeManager(p: SessionChannelProvisioner, d: SessionSidecarDriver) {
    return new NanoCoSessionSidecarManager(
      { deploymentId: 'deployment-1', sidecarImage: 'nanoco-sidecar:test' },
      p,
      d,
    );
  }

  it('re-adopts the lease and returns a live handle that closes like a spawned one', async () => {
    const p = adoptableProvisioner();

    const handle = await makeManager(p, inSessionDriver()).adoptPrepared(context);

    expect(handle).not.toBeNull();
    expect(p.adopt).toHaveBeenCalledExactlyOnceWith(adoptableLineage);
    // The adopted spec was realized when the session spawned: the handle
    // contributes nothing for composition to consume.
    expect(handle!.agentEnvironment).toEqual({});
    expect(handle!.agentNetworkArgs).toEqual([]);
    expect(handle!.containers).toEqual([]);

    await handle!.close('adopted-close');
    expect(p.revoke).toHaveBeenCalledTimes(1);
    expect(p.release).toHaveBeenCalledTimes(1);
  });

  it('re-arms renewal on the adopted lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'));
    const p = adoptableProvisioner();
    p.adopt.mockImplementation(async (lineage: SessionChannelLineage) => {
      const channel = provisioned(lineage);
      channel.expiresAt = '2026-07-22T00:01:00.000Z';
      channel.certificateNotAfter = '2026-07-22T00:10:00.000Z';
      return channel;
    });

    const handle = await makeManager(p, inSessionDriver()).adoptPrepared(context);
    await vi.advanceTimersByTimeAsync(30_000);

    // This is the difference between adoption and the old inert handle: the
    // successor renews the lease it recovered, forever, like any other session.
    expect(p.renew).toHaveBeenCalledTimes(1);
    await handle!.close('renewed-then-closed');
  });

  it('declines on a realization whose egress a successor cannot own', async () => {
    // The Docker shape: sidecar process and networks are out-of-band, created
    // and supervised by the dead host. Gated on the declared capability, never
    // on driver kind — such adoptions take the bounded horizon at the caller.
    const p = adoptableProvisioner();

    expect(await makeManager(p, driver).adoptPrepared(context)).toBeNull();
    expect(p.adopt).not.toHaveBeenCalled();
  });

  it('declines when the provisioner cannot adopt', async () => {
    const p = makeProvisioner(provisionerEvents);

    expect(await makeManager(p, inSessionDriver()).adoptPrepared(context)).toBeNull();
  });

  it('declines when the persisted lineage belongs to a different agent group', async () => {
    const p = adoptableProvisioner();
    p.findAdoptableLineage.mockReturnValue({ ...adoptableLineage, agentId: 'agent-other' });

    expect(await makeManager(p, inSessionDriver()).adoptPrepared(context)).toBeNull();
    expect(p.adopt).not.toHaveBeenCalled();
  });
});

describe('reapOrphanedSessionNetworks', () => {
  function reapingDriver(networks: string[], refuse: string[] = []): SessionSidecarDriver & { removed: string[] } {
    const removed: string[] = [];
    return {
      removed,
      sharesNetworkNamespace: false,
      listInstallNetworks: () => networks,
      removeNetwork: (name: string) => {
        if (refuse.includes(name)) throw new Error('network has active endpoints');
        removed.push(name);
      },
      createNetwork: vi.fn(),
      createSidecar: vi.fn(),
      startSidecar: vi.fn(),
      stopSidecar: vi.fn(),
      removeSidecar: vi.fn(),
      contributedContainers: () => [],
      agentNetworkArgs: () => [],
    } as SessionSidecarDriver & { removed: string[] };
  }

  it('removes the per-session networks a dead host left behind', () => {
    const driver = reapingDriver([`nc-${INSTALL_SLUG}-aaaa-session`, `nc-${INSTALL_SLUG}-aaaa-uplink`]);
    reapOrphanedSessionNetworks(driver);
    expect(driver.removed).toEqual([`nc-${INSTALL_SLUG}-aaaa-session`, `nc-${INSTALL_SLUG}-aaaa-uplink`]);
  });

  it('leaves a network an adopted session is still attached to', () => {
    // Docker refuses to remove a network with a live endpoint, and that refusal
    // is the guard: an adopted session must not lose its network to a sweep.
    const live = `nc-${INSTALL_SLUG}-bbbb-session`;
    const driver = reapingDriver([live, `nc-${INSTALL_SLUG}-cccc-session`], [live]);
    reapOrphanedSessionNetworks(driver);
    expect(driver.removed).toEqual([`nc-${INSTALL_SLUG}-cccc-session`]);
  });

  it('does nothing on a realization that creates no networks', () => {
    const driver = reapingDriver([]);
    delete (driver as { listInstallNetworks?: unknown }).listInstallNetworks;
    expect(() => reapOrphanedSessionNetworks(driver)).not.toThrow();
    expect(driver.removed).toEqual([]);
  });

  it('survives a runtime that cannot be listed at all', () => {
    const driver = reapingDriver([]);
    driver.listInstallNetworks = () => {
      throw new Error('docker daemon not running');
    };
    expect(() => reapOrphanedSessionNetworks(driver)).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith('Failed to list session networks for reaping', expect.anything());
  });
});
