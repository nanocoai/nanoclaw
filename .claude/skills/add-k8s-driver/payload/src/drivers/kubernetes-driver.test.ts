import { describe, expect, it, vi } from 'vitest';

import {
  KubernetesApiError,
  KubernetesSessionDriver,
  kubernetesJobForSession,
  kubernetesOptionsFromEnvironment,
  type KubernetesApi,
  type KubernetesDriverOptions,
} from './kubernetes-driver.js';
import { getSessionDriverFactory } from './driver-registry.js';
import type { SessionSpec } from './types.js';

class FakeApi implements KubernetesApi {
  readonly request = vi.fn(async () => ({}));
  readonly watch = vi.fn(async () => undefined);
}

const policy = {
  groupsRoot: '/opt/nanoclaw/groups',
  dataRoot: '/opt/nanoclaw/data',
  surfaceRoots: ['/opt/nanoclaw/container/agent-runner/src', '/opt/nanoclaw/container/skills'],
  materialsRoot: '/opt/nanoclaw/data/session-materials',
  gatewayTrustRoot: '/opt/nanoclaw/data/gateway-trust',
};

function options(api = new FakeApi()): KubernetesDriverOptions {
  return {
    ...policy,
    namespace: 'agents',
    serviceAccountName: 'agent-session',
    persistentVolumeMounts: [
      { hostRoot: policy.groupsRoot, claimName: 'agent-state', claimSubPath: 'groups' },
      { hostRoot: policy.dataRoot, claimName: 'agent-state', claimSubPath: 'data' },
    ],
    bakedSurfaces: [
      { hostRoot: policy.surfaceRoots[0], containerRoot: '/app/src' },
      { hostRoot: policy.surfaceRoots[1], containerRoot: '/app/skills' },
    ],
    api,
  };
}

function spec(): SessionSpec {
  return {
    key: { installSlug: 'test', agentGroupId: 'group-1', sessionId: 'session-1' },
    labels: { 'nanoclaw-group-folder': 'agent-one' },
    containers: [
      {
        role: 'agent',
        image: 'registry.example/agent@sha256:' + 'a'.repeat(64),
        env: { TZ: 'Europe/Amsterdam' },
        command: ['bash', '-c'],
        args: ['exec bun run /app/src/index.ts'],
        mounts: [
          {
            class: 'group-state',
            hostPath: '/opt/nanoclaw/data/v2-sessions/group-1/session-1',
            containerPath: '/workspace',
            mode: 'rw',
            groupScope: 'group-1',
          },
          {
            class: 'install-surface',
            hostPath: '/opt/nanoclaw/container/agent-runner/src',
            containerPath: '/app/src',
            mode: 'ro',
            groupScope: 'group-1',
          },
        ],
      },
    ],
    network: 'shared-private',
    networkAccess: {
      endpoint: 'gateway.agents.svc',
      target: { kind: 'runtime', identity: 'gateway' },
    },
    hardening: 'standard',
    resources: { cpus: '1', memoryMb: 1024, pidsLimit: 2048, shmSizeMb: 64 },
    runtimeTier: 'container',
    runAs: { uid: 1000, gid: 1000 },
    stopGraceSeconds: 30,
  };
}

describe('KubernetesSessionDriver', () => {
  it('self-registers as kubernetes', () => {
    expect(getSessionDriverFactory('kubernetes')).toBeTypeOf('function');
  });

  it('reads generic Kubernetes settings without deployment-specific defaults', () => {
    expect(
      kubernetesOptionsFromEnvironment(policy, {
        NANOCLAW_KUBERNETES_NAMESPACE: 'agents',
        NANOCLAW_KUBERNETES_SERVICE_ACCOUNT: 'agent-session',
        NANOCLAW_KUBERNETES_MOUNTS: JSON.stringify({
          persistentVolumeMounts: [{ hostRoot: '/opt/nanoclaw/data', claimName: 'agent-state', claimSubPath: 'data' }],
        }),
      }),
    ).toMatchObject({
      namespace: 'agents',
      serviceAccountName: 'agent-session',
      persistentVolumeMounts: [{ hostRoot: '/opt/nanoclaw/data', claimName: 'agent-state', claimSubPath: 'data' }],
    });
  });

  it('builds a suspended restricted Job with PVC state and no raw credential', () => {
    const job = kubernetesJobForSession(spec(), 'ncl-home-session-1', options()) as {
      spec: {
        suspend: boolean;
        template: {
          spec: {
            serviceAccountName: string;
            automountServiceAccountToken: boolean;
            restartPolicy: string;
            securityContext: Record<string, unknown>;
            containers: Array<Record<string, unknown> & { volumeMounts: Array<Record<string, unknown>> }>;
            volumes: Array<Record<string, unknown>>;
          };
        };
      };
    };
    expect(job.spec.suspend).toBe(true);
    expect(job.spec.template.spec).toMatchObject({
      serviceAccountName: 'agent-session',
      automountServiceAccountToken: false,
      restartPolicy: 'Never',
      securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
    });
    expect(job.spec.template.spec.containers[0]).toMatchObject({
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
      env: [{ name: 'TZ', value: 'Europe/Amsterdam' }],
    });
    expect(job.spec.template.spec.containers[0].volumeMounts).toContainEqual(
      expect.objectContaining({
        name: 'state-0',
        mountPath: '/workspace',
        subPath: 'data/v2-sessions/group-1/session-1',
      }),
    );
    expect(job.spec.template.spec.volumes).toContainEqual({
      name: 'state-0',
      persistentVolumeClaim: { claimName: 'agent-state' },
    });
    expect(JSON.stringify(job)).not.toMatch(/hostPath|sk-ant-|sk-proj-/);
  });

  it('prepares with CREATE, starts by unsuspending, and stops by foreground deletion', async () => {
    const api = new FakeApi();
    api.request.mockRejectedValueOnce(new KubernetesApiError(404, 'missing')).mockResolvedValue({});
    const handle = await new KubernetesSessionDriver(options(api)).prepare(spec());
    expect(api.request).toHaveBeenNthCalledWith(2, 'POST', expect.stringContaining('/jobs'), expect.any(Object));
    await handle.start();
    expect(api.request).toHaveBeenLastCalledWith(
      'PATCH',
      expect.stringContaining('/jobs/'),
      { spec: { suspend: false } },
      'application/merge-patch+json',
    );
    await handle.stop('test');
    expect(api.request).toHaveBeenLastCalledWith(
      'DELETE',
      expect.stringContaining('/jobs/'),
      expect.objectContaining({ propagationPolicy: 'Foreground' }),
    );
  });

  it('rejects mounts with no PVC or baked-image realization', () => {
    const invalid = spec();
    invalid.containers[0].mounts.push({
      class: 'allowlisted-extra',
      hostPath: '/srv/foreign',
      containerPath: '/foreign',
      mode: 'ro',
      groupScope: 'group-1',
    });
    expect(() => kubernetesJobForSession(invalid, 'ncl-home-session-1', options())).toThrow(
      /no PVC or baked-image realization/,
    );
  });
});
