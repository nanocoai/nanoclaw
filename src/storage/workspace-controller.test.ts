import { afterEach, describe, expect, it, vi } from 'vitest';

import { Kube, WorkspaceController } from './workspace-controller.js';
import { labelId } from './workspace-plane.js';

class FakeKube extends Kube {
  readonly values = new Map<string, any>();
  constructor() {
    super();
    this.values.set(this.key('node', 'node-a'), { metadata: { name: 'node-a', labels: { 'nanoco.ai/workspace-nvme': 'true' } }, spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }] } });
  }
  key(kind: string, name: string, namespace?: string): string { return `${namespace ?? ''}/${kind.toLowerCase().replace('.coordination.k8s.io', '')}/${name}`; }
  override async get(kind: string, name: string, namespace?: string): Promise<any | null> { return this.values.get(this.key(kind, name, namespace)) ?? null; }
  override async list(kind: string, namespace?: string, selector?: string): Promise<any[]> {
    const singular = kind.toLowerCase().replace('.coordination.k8s.io', '').replace(/s$/, '');
    const prefix = `${namespace ?? ''}/${singular}/`;
    const required = (selector ?? '').split(',').filter(Boolean).map((entry) => entry.split('='));
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value)
      .filter((value) => required.every(([key, expected]) => value.metadata?.labels?.[key] === expected));
  }
  override async apply(value: any): Promise<any> {
    const copy = structuredClone(value);
    if (copy.kind === 'Pod') copy.status = { conditions: [{ type: 'Ready', status: 'True' }] };
    this.values.set(this.key(copy.kind, copy.metadata.name, copy.metadata.namespace), copy);
    return copy;
  }
  override async run(): Promise<string> { return ''; }
  override async delete(kind: string, name: string, namespace: string): Promise<void> { this.values.delete(this.key(kind, name, namespace)); }
  override async patch(kind: string, name: string, namespace: string, value: any): Promise<void> {
    const key = this.key(kind, name, namespace);
    const current = this.values.get(key);
    this.values.set(key, { ...current, ...value, metadata: { ...current.metadata, ...value.metadata, annotations: { ...current.metadata?.annotations, ...value.metadata?.annotations } } });
  }
}

describe('WorkspaceController', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.NANOCLAW_WORKSPACE_S3_TRANSPORT;
  });

  it('projects a renewable Gateway relay without cloud credentials', async () => {
    process.env.NANOCLAW_WORKSPACE_S3_TRANSPORT = 'gateway';
    const kube = new FakeKube();
    const controller = new WorkspaceController({
      namespace: 'system', agentsNamespace: 'agents', hostRoot: '/var/lib/nanoco/workspaces',
      image: `host@sha256:${'a'.repeat(64)}`, token: 'x'.repeat(32), nodeName: 'node-a', kube,
    });
    const relay = {
      claim: 'opaque.claim', requestCapability: 'c'.repeat(64), deploymentId: 'deployment-1',
      agentId: 'group-a', sessionId: 'session-1', containerInstanceId: 'workspace-1', channelId: 'workspace-1',
      claimUrl: 'https://gateway-claim.system.svc.cluster.local:9446', claimServerName: 'gateway.internal',
      gatewayAddress: 'gateway-session.system.svc.cluster.local:9443', gatewayServerName: 'gateway.internal',
      sidecarImage: `sidecar@sha256:${'b'.repeat(64)}`,
    };

    await controller.ensure({ groupId: 'group-a', sessionId: 'session-1', runtimeTier: 'vm', relay });

    const pod = [...kube.values.values()].find((value) => value.kind === 'Pod');
    expect(pod.spec.initContainers.map((container: any) => container.name)).toEqual([
      'workspace-identity-manager', 'workspace-egress-sidecar',
    ]);
    expect(pod.spec.initContainers.every((container: any) => container.restartPolicy === 'Always')).toBe(true);
    expect(pod.spec.initContainers[1].image).toBe(relay.sidecarImage);
    expect(pod.spec.containers[0].env).toContainEqual({ name: 'AWS_EC2_METADATA_DISABLED', value: 'true' });
    expect(pod.spec.containers[0].env).toContainEqual({ name: 'NANOCLAW_MAILBOX_GATEWAY_PROXY', value: 'http://127.0.0.1:15001' });
    expect(pod.spec.containers[0].startupProbe).toMatchObject({ httpGet: { path: '/ready' } });
    expect(pod.spec.containers[0].readinessProbe).toMatchObject({ httpGet: { path: '/ready' } });
    expect(pod.spec.containers[0].livenessProbe).toMatchObject({ httpGet: { path: '/live' } });
    expect(JSON.stringify(pod)).not.toContain(relay.claim);
    expect(JSON.stringify(pod)).not.toContain(relay.requestCapability);
    const secret = await kube.get('secret', 'nanoclaw-custodian-relay-e610eab3e8256d8d', 'system');
    expect(Buffer.from(secret.data.claim, 'base64').toString()).toBe(relay.claim);
    expect(Buffer.from(secret.data['request-capability'], 'base64').toString()).toBe(relay.requestCapability);
  });

  it('uses its scheduled node without cluster-wide node discovery', async () => {
    class ScopedKube extends FakeKube {
      override async list(kind: string, namespace?: string, selector?: string): Promise<any[]> {
        if (kind === 'nodes') throw new Error('node RBAC is intentionally absent');
        return super.list(kind, namespace, selector);
      }
    }
    const kube = new ScopedKube();
    const controller = new WorkspaceController({
      namespace: 'workspace-child', agentsNamespace: 'child-agents', hostRoot: '/var/lib/nanoco/workspaces',
      image: `host@sha256:${'a'.repeat(64)}`, token: 'x'.repeat(32), nodeName: 'node-a', kube,
    });
    await expect(controller.ensure({ groupId: 'group-a', sessionId: 'session-1', runtimeTier: 'vm' }))
      .resolves.toMatchObject({ nodeName: 'node-a', generation: 1 });
  });

  it('reuses one node, generation, Custodian and tier for concurrent group sessions', async () => {
    const kube = new FakeKube();
    const controller = new WorkspaceController({ namespace: 'system', agentsNamespace: 'agents', hostRoot: '/var/lib/nanoco/workspaces', image: `host@sha256:${'a'.repeat(64)}`, token: 'x'.repeat(32), kube });
    const [first, second] = await Promise.all([
      controller.ensure({ groupId: 'group-a', sessionId: 'session-1', runtimeTier: 'container' }),
      controller.ensure({ groupId: 'group-a', sessionId: 'session-2', runtimeTier: 'container' }),
    ]);
    expect(first.sessionId).toBe('session-1');
    expect(second.sessionId).toBe('session-2');
    expect(second).toMatchObject({ nodeName: first.nodeName, generation: first.generation, plainHostPath: first.plainHostPath });
    expect([...kube.values.values()].filter((value) => value.kind === 'Pod')).toHaveLength(1);
    expect([...kube.values.values()].filter((value) => value.kind === 'Lease').every((value) => /\.\d{6}Z$/.test(value.spec.renewTime))).toBe(true);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ready: true }), { status: 200 })) as unknown as typeof fetch;
    await controller.ensurePaths({ ...first, paths: ['agent', 'provider-state/claude-state'] });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/paths/ensure'), expect.objectContaining({ body: JSON.stringify({ paths: ['agent', 'provider-state/claude-state'] }) }));
    await expect(controller.ensure({ groupId: 'group-a', sessionId: 'session-3', runtimeTier: 'vm' })).rejects.toThrow('active on runtime tier container');

    const custodian = [...kube.values.values()].find((value) => value.kind === 'Pod');
    custodian.status = { phase: 'Failed' };
    await kube.apply({ apiVersion: 'v1', kind: 'Pod', metadata: {
      name: 'session-1', namespace: 'agents', labels: { 'nanoco.ai/workspace': 'true', 'nanoco.ai/workspace-group': labelId('group-a') },
      annotations: { 'nanoco.ai/workspace-group-id': 'group-a', 'nanoco.ai/workspace-session-id': 'session-1' }, finalizers: ['nanoco.ai/workspace-checkpoint'],
    }, status: { phase: 'Running' } });
    await controller.reconcile();
    expect(await kube.get('pod', 'session-1', 'agents')).toBeNull();
    const recovered = await controller.ensure({ groupId: 'group-a', sessionId: 'session-3', runtimeTier: 'container' });
    expect(recovered.generation).toBe(2);
  });

  it('removes a failed generation before waiting on its replacement', async () => {
    class FailedReplacementKube extends FakeKube {
      failWait = false;
      override async run(): Promise<string> {
        if (this.failWait) throw new Error('replacement did not become Ready');
        return '';
      }
    }
    const kube = new FailedReplacementKube();
    const controller = new WorkspaceController({ namespace: 'system', agentsNamespace: 'agents', hostRoot: '/var/lib/nanoco/workspaces', image: `host@sha256:${'a'.repeat(64)}`, token: 'x'.repeat(32), kube });
    await controller.ensure({ groupId: 'group-a', sessionId: 'session-1', runtimeTier: 'container' });
    const first = await kube.get('pod', 'nanoclaw-custodian-e610eab3e8256d8d-g1', 'system');
    first.status = { phase: 'Failed' };
    kube.failWait = true;

    await expect(controller.ensure({ groupId: 'group-a', sessionId: 'session-2', runtimeTier: 'container' }))
      .rejects.toThrow('replacement did not become Ready');

    expect(await kube.get('pod', 'nanoclaw-custodian-e610eab3e8256d8d-g1', 'system')).toBeNull();
    expect(await kube.get('pod', 'nanoclaw-custodian-e610eab3e8256d8d-g2', 'system')).not.toBeNull();
  });

  it('checkpoints dirty data after a replacement reservation disappears', async () => {
    const kube = new FakeKube();
    const controller = new WorkspaceController({ namespace: 'system', agentsNamespace: 'agents', hostRoot: '/var/lib/nanoco/workspaces', image: `host@sha256:${'a'.repeat(64)}`, token: 'x'.repeat(32), kube });
    await controller.ensure({ groupId: 'group-a', sessionId: 'session-1', runtimeTier: 'container' });
    const replacement = await controller.ensure({ groupId: 'group-a', sessionId: 'session-2', runtimeTier: 'container' });
    await kube.apply({ apiVersion: 'v1', kind: 'Pod', metadata: {
      name: 'session-1', namespace: 'agents', labels: { 'nanoco.ai/workspace': 'true', 'nanoco.ai/workspace-group': labelId('group-a') },
      annotations: { 'nanoco.ai/workspace-group-id': 'group-a', 'nanoco.ai/workspace-session-id': 'session-1' }, finalizers: ['nanoco.ai/workspace-checkpoint'],
    } });
    (await kube.get('pod', 'session-1', 'agents')).status = { phase: 'Succeeded' };
    await controller.reconcile();
    expect((await kube.get('pod', 'session-1', 'agents')).metadata.finalizers).toEqual([]);

    await controller.release(replacement);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ snapshotId: 'snap-1' }), { status: 200 })) as unknown as typeof fetch;
    await controller.reconcile();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/checkpoint'), expect.anything());
    const lease = [...kube.values.values()].find((value) => value.kind === 'Lease' && value.metadata.labels?.['nanoco.ai/workspace-group-lease'] === 'true');
    expect(lease.metadata.annotations['nanoco.ai/workspace-dirty']).toBe('false');
    expect(lease.metadata.annotations['nanoco.ai/workspace-snapshot']).toBe('snap-1');
  });

  it('reaps terminal idle Custodian resources without calling its dead API', async () => {
    const kube = new FakeKube();
    const controller = new WorkspaceController({ namespace: 'system', agentsNamespace: 'agents', hostRoot: '/var/lib/nanoco/workspaces', image: `host@sha256:${'a'.repeat(64)}`, token: 'x'.repeat(32), kube });
    const assignment = await controller.ensure({ groupId: 'group-a', sessionId: 'session-1', runtimeTier: 'container' });
    await controller.release(assignment);
    const pod = await kube.get('pod', 'nanoclaw-custodian-e610eab3e8256d8d-g1', 'system');
    pod.status = { phase: 'Failed' };
    const lease = [...kube.values.values()].find((value) => value.kind === 'Lease' && value.metadata.labels?.['nanoco.ai/workspace-group-lease'] === 'true');
    lease.metadata.annotations['nanoco.ai/workspace-dirty'] = 'false';
    lease.metadata.annotations['nanoco.ai/workspace-last-idle-at'] = new Date(0).toISOString();
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await controller.reconcile();

    expect(fetch).not.toHaveBeenCalled();
    expect(await kube.get('pod', 'nanoclaw-custodian-e610eab3e8256d8d-g1', 'system')).toBeNull();
    expect(await kube.get('service', 'nanoclaw-custodian-e610eab3e8256d8d', 'system')).toBeNull();
    expect(await kube.get('secret', 'nanoclaw-custodian-token-e610eab3e8256d8d', 'system')).toBeNull();
    expect(await kube.get('serviceaccount', 'nanoclaw-custodian-e610eab3e8256d8d', 'system')).toBeNull();
  });

  it('checkpoints and rolls an idle Custodian onto the Controller image', async () => {
    const kube = new FakeKube();
    const first = new WorkspaceController({ namespace: 'system', agentsNamespace: 'agents', hostRoot: '/var/lib/nanoco/workspaces', image: `host@sha256:${'a'.repeat(64)}`, token: 'x'.repeat(32), kube });
    const assignment = await first.ensure({ groupId: 'group-a', sessionId: 'session-1', runtimeTier: 'container' });
    await first.release(assignment);
    globalThis.fetch = vi.fn(async (input) => new Response(JSON.stringify(String(input).endsWith('/v1/checkpoint') ? { snapshotId: 'snap-upgrade' } : { stopped: true }), { status: 200 })) as unknown as typeof fetch;
    const upgraded = new WorkspaceController({ namespace: 'system', agentsNamespace: 'agents', hostRoot: '/var/lib/nanoco/workspaces', image: `host@sha256:${'b'.repeat(64)}`, token: 'x'.repeat(32), kube });
    const next = await upgraded.ensure({ groupId: 'group-a', sessionId: 'session-1', runtimeTier: 'container' });
    expect(next.generation).toBe(2);
    expect(([...kube.values.values()].find((value) => value.kind === 'Pod') as any).spec.containers[0].image).toBe(`host@sha256:${'b'.repeat(64)}`);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/checkpoint'), expect.anything());
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/shutdown'), expect.anything());
  });

  it('treats a deleting Pending Pod as stopped and clears its finalizer after checkpoint', async () => {
    const kube = new FakeKube();
    const controller = new WorkspaceController({ namespace: 'system', agentsNamespace: 'agents', hostRoot: '/var/lib/nanoco/workspaces', image: `host@sha256:${'a'.repeat(64)}`, token: 'x'.repeat(32), kube });
    const assignment = await controller.ensure({ groupId: 'group-a', sessionId: 'session-1', runtimeTier: 'container' });
    await controller.release(assignment);
    await kube.apply({ apiVersion: 'v1', kind: 'Pod', metadata: {
      name: 'session-1', namespace: 'agents', deletionTimestamp: new Date().toISOString(), labels: { 'nanoco.ai/workspace': 'true', 'nanoco.ai/workspace-group': labelId('group-a') },
      annotations: { 'nanoco.ai/workspace-group-id': 'group-a', 'nanoco.ai/workspace-session-id': 'session-1' }, finalizers: ['nanoco.ai/workspace-checkpoint'],
    } });
    (await kube.get('pod', 'session-1', 'agents')).status = { phase: 'Pending', initContainerStatuses: [{ state: { waiting: { reason: 'PodInitializing' } } }] };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ snapshotId: 'snap-delete' }), { status: 200 })) as unknown as typeof fetch;
    await controller.reconcile();
    expect((await kube.get('pod', 'session-1', 'agents')).metadata.finalizers).toEqual([]);
  });

  it('does not publish another checkpoint when finalizer removal retries', async () => {
    class RetryKube extends FakeKube {
      failFinalizer = true;
      override async patch(kind: string, name: string, namespace: string, value: any): Promise<void> {
        if (kind === 'pod' && this.failFinalizer) {
          this.failFinalizer = false;
          throw new Error('admission temporarily rejected metadata update');
        }
        await super.patch(kind, name, namespace, value);
      }
    }
    const kube = new RetryKube();
    const controller = new WorkspaceController({ namespace: 'system', agentsNamespace: 'agents', hostRoot: '/var/lib/nanoco/workspaces', image: `host@sha256:${'a'.repeat(64)}`, token: 'x'.repeat(32), kube });
    const assignment = await controller.ensure({ groupId: 'group-a', sessionId: 'session-1', runtimeTier: 'container' });
    await controller.release(assignment);
    await kube.apply({ apiVersion: 'v1', kind: 'Pod', metadata: {
      name: 'session-1', namespace: 'agents', deletionTimestamp: new Date().toISOString(), labels: { 'nanoco.ai/workspace': 'true', 'nanoco.ai/workspace-group': labelId('group-a') },
      annotations: { 'nanoco.ai/workspace-group-id': 'group-a', 'nanoco.ai/workspace-session-id': 'session-1' }, finalizers: ['nanoco.ai/workspace-checkpoint'],
    }, status: { phase: 'Failed' } });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ snapshotId: 'snap-once' }), { status: 200 })) as unknown as typeof fetch;

    await expect(controller.reconcile()).rejects.toThrow('admission temporarily rejected');
    await controller.reconcile();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await kube.get('pod', 'session-1', 'agents')).metadata.finalizers).toEqual([]);
  });

  it('refreshes group state after a concurrent Custodian generation starts', async () => {
    let resume!: () => void;
    let snapshotReady!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const snapshot = new Promise<void>((resolve) => { snapshotReady = resolve; });
    class RacingKube extends FakeKube {
      pause = false;
      override async list(kind: string, namespace?: string, selector?: string): Promise<any[]> {
        const values = await super.list(kind, namespace, selector);
        if (this.pause && selector === 'nanoco.ai/workspace-group-lease=true') {
          snapshotReady();
          await gate;
          return structuredClone(values);
        }
        return values;
      }
    }
    const kube = new RacingKube();
    const controller = new WorkspaceController({ namespace: 'system', agentsNamespace: 'agents', hostRoot: '/var/lib/nanoco/workspaces', image: `host@sha256:${'a'.repeat(64)}`, token: 'x'.repeat(32), kube });
    const first = await controller.ensure({ groupId: 'group-a', sessionId: 'session-1', runtimeTier: 'container' });
    await controller.release(first);
    const oldPod = [...kube.values.values()].find((value) => value.kind === 'Pod');
    oldPod.status = { phase: 'Failed' };
    const lease = [...kube.values.values()].find((value) => value.kind === 'Lease' && value.metadata.labels?.['nanoco.ai/workspace-group-lease'] === 'true');
    lease.metadata.annotations['nanoco.ai/workspace-last-idle-at'] = new Date(0).toISOString();

    kube.pause = true;
    const reconcile = controller.reconcile();
    await snapshot;
    const next = await controller.ensure({ groupId: 'group-a', sessionId: 'session-2', runtimeTier: 'container' });
    resume();
    await reconcile;

    expect(next.generation).toBe(2);
    expect(await kube.get('secret', 'nanoclaw-custodian-token-e610eab3e8256d8d', 'system')).not.toBeNull();
    expect((await kube.get('pod', 'nanoclaw-custodian-e610eab3e8256d8d-g2', 'system')).status.conditions[0].status).toBe('True');
  });
});
