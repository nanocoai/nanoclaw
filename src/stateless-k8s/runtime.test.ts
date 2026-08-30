import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FakeCli } from '../drivers/fake-cli.js';
import { PodSessionDriver } from '../drivers/pod-driver.js';
import { FIXTURE_POLICY, fixtureSpec } from '../drivers/spec-fixture.js';
import { validateSpec, type MountSpec } from '../drivers/types.js';
import '../providers/index.js';
import {
  getProviderContainerConfig,
  providerRequiresHostFilesystem,
  registerProviderContainerConfig,
} from '../providers/provider-container-registry.js';
import { resolveProjectDocument } from '../container-runner.js';
import {
  configuredStatelessK8sHost,
  statelessAgentMounts,
  workspaceComposerContainer,
  workspaceComposerDbInitContainer,
} from './runtime.js';
import { statelessEgressContainers } from './session-egress.js';

const group = { id: 'group-a', name: 'A', folder: 'a', agent_provider: null, created_at: '', provisioned_user_id: null };
const session = { id: 'session-a', agent_group_id: 'group-a' } as never;
const config = {
  mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all', groupName: 'A',
  assistantName: 'A', agentGroupId: 'group-a',
} as never;
const projectDocument = {
  fileName: 'CLAUDE.md', baseDocPath: 'container/CLAUDE.md', maxBytes: 4 * 1024 * 1024,
  containerPath: '/workspace/agent/CLAUDE.md',
};
const customProjectDocument = {
  fileName: 'AGENTS.md', baseDocPath: 'container/AGENTS.md', containerPath: '/workspace/agent/AGENTS.md',
};
const contribution = {
  projectDocument,
  stateVolumes: [{ name: 'claude-state', containerPath: '/home/node/.claude', scope: 'group' as const }],
  skillViews: [{ containerPath: '/home/node/.claude/skills', mode: 'rw' as const }],
  seedFiles: [{ containerPath: '/home/node/.claude/settings.json', content: '{}\n', owner: 'materializer' as const }],
};

registerProviderContainerConfig(
  'test-surface-provider',
  () => ({ projectDocument: customProjectDocument }),
  { providesAgentSurfaces: true, requiresHostFilesystem: false },
);

describe('stateless Kubernetes materialization', () => {
  it('keeps the existing Claude env adapter without granting Host files', () => {
    expect(getProviderContainerConfig('claude')).toBeDefined();
    expect(providerRequiresHostFilesystem('claude')).toBe(false);
  });

  it('resolves one project document without provider-name filename guessing', () => {
    expect(resolveProjectDocument('claude', {})).toEqual(projectDocument);
    expect(resolveProjectDocument('test-surface-provider', { projectDocument: customProjectDocument })).toEqual(customProjectDocument);
    expect(() => resolveProjectDocument('test-surface-provider', {})).toThrow('supplied no project document');
    expect(() => validateSpec(fixtureSpec({ projectDocument: { ...customProjectDocument, containerPath: '../AGENTS.md' } }), FIXTURE_POLICY)).toThrow('project document');
    expect(() => validateSpec(fixtureSpec({
      containers: [
        ...fixtureSpec().containers,
        { role: 'workspace-composer', image: 'materializer', env: {}, mounts: [] },
      ],
    }), FIXTURE_POLICY)).toThrow('missing its provider project document');
  });

  it('requires the Pod driver and gives the agent no Host-backed mount', () => {
    expect(() => configuredStatelessK8sHost({ NANOCO_STATELESS_K8S_HOST: '1', NANOCLAW_RUNTIME_DRIVER: 'docker' })).toThrow('pod');
    expect(configuredStatelessK8sHost({ NANOCO_STATELESS_K8S_HOST: '1', NANOCLAW_RUNTIME_DRIVER: 'pod' })).toBe(true);
    const mounts = statelessAgentMounts(group, session, config, projectDocument, contribution);
    expect(mounts.every((mount) => mount.source)).toBe(true);
    const contextMount = mounts.find((mount) => mount.containerPath === '/run/nanoclaw/session-context');
    expect(contextMount).toMatchObject({ readonly: true });
    expect(contextMount).not.toHaveProperty('subPath');
    expect(mounts.find((mount) => mount.containerPath === '/workspace/agent/container.json')).toMatchObject({ readonly: true, subPath: 'container.json' });
    expect(mounts.find((mount) => mount.containerPath === projectDocument.containerPath)).toMatchObject({ readonly: true, subPath: projectDocument.fileName });
    expect(mounts.find((mount) => mount.containerPath === '/workspace/agent/plugins')).toMatchObject({ readonly: true, subPath: 'plugins' });
    expect(mounts.find((mount) => mount.containerPath === '/workspace/agent/plugin-data')).toMatchObject({ readonly: false, subPath: 'plugin-data' });
    expect(mounts.some((mount) => ['/app/src', '/app/node_modules', '/app/bin', '/app/skills'].includes(mount.containerPath))).toBe(false);
    expect(mounts.some((mount) => mount.containerPath.includes('.claude-fragments'))).toBe(false);
  });

  it('keeps Host, materializer, and agent runtime files in their images', () => {
    const agent = fs.readFileSync('container/Dockerfile', 'utf8');
    const materializerSource = fs.readFileSync(new URL('./materializer.ts', import.meta.url), 'utf8');
    expect(agent).toContain('agent-runner/src ./src');
    expect(agent).toContain('bun install --frozen-lockfile');
    if (fs.existsSync('deploy/k8s/Dockerfile')) {
      const host = fs.readFileSync('deploy/k8s/Dockerfile', 'utf8');
      const materializer = fs.readFileSync('deploy/k8s/Materializer.Dockerfile', 'utf8');
      expect(host).toContain('pnpm install --frozen-lockfile');
      expect(host).toContain('pnpm run build');
      expect(materializer).toContain('FROM ${HOST_IMAGE}');
    }
    expect(materializerSource).toContain('composeGroupProjectDoc(group, groupDir, projectDocument)');
    expect(materializerSource).toContain('lstatSync(link, { throwIfNoEntry: false })');
    expect(materializerSource).not.toContain('existsSync(link)');
    expect(materializerSource).not.toContain('composeGroupClaudeMd');
  });

  it('puts all five writers in the pod-local materializer', () => {
    const composer = workspaceComposerContainer({
      agentGroup: group,
      session,
      containerConfig: config,
      projectDocument,
      contribution,
      mailboxContext: { capability: 'a'.repeat(64) },
      env: {
        NANOCO_MATERIALIZER_IMAGE: `registry/materializer@sha256:${'a'.repeat(64)}`,
        NANOCLAW_DB_URL: 'postgresql://host@database/system',
      },
    });
    expect(composer.role).toBe('workspace-composer');
    expect(composer.mounts.every((mount) => mount.source)).toBe(true);
    expect(composer.mounts.find((mount) => mount.source?.name === 'composer-db')).toMatchObject({
      class: 'identity-material', containerPath: '/run/nanoclaw/composer', mode: 'ro', source: { kind: 'emptyDir' },
    });
    expect(composer.mounts.find((mount) => mount.source?.name === 'composer-db')).not.toHaveProperty('subPath');
  });

  it('renders only emptyDir and Secret volumes with no placement pinning', () => {
    const spec = fixtureSpec();
    spec.projectDocument = projectDocument;
    const toMount = (mount: ReturnType<typeof statelessAgentMounts>[number]): MountSpec => ({
      class: mount.mountClass!, hostPath: mount.hostPath, containerPath: mount.containerPath,
      mode: mount.readonly ? 'ro' : 'rw', groupScope: mount.scope!, source: mount.source,
      ...(mount.subPath ? { subPath: mount.subPath } : {}),
    });
    spec.containers[0]!.mounts = statelessAgentMounts(group, session, config, projectDocument, contribution).map(toMount);
    spec.containers.push(workspaceComposerDbInitContainer({ uid: 1000, gid: 1000 }, {
      NANOCO_MATERIALIZER_IMAGE: `materializer@sha256:${'a'.repeat(64)}`,
    }), workspaceComposerContainer({
      agentGroup: group,
      session,
      containerConfig: config,
      projectDocument,
      contribution,
      mailboxContext: { capability: 'a'.repeat(64) },
      env: {
        NANOCO_MATERIALIZER_IMAGE: `materializer@sha256:${'a'.repeat(64)}`,
        NANOCLAW_DB_URL: 'postgresql://host@database/system',
      },
    }));
    const egress = statelessEgressContainers({
      deploymentId: 'deployment', groupId: group.id, sessionId: 'session-a',
      containerInstanceId: 'container-2', channelId: 'channel-2', claim: 'ab'.repeat(64),
      claimUrl: 'https://gateway-claim.system.svc.cluster.local:9446', claimServerName: 'gateway.internal',
      gatewayAddress: 'gateway-session.system.svc.cluster.local:9443', gatewayServerName: 'gateway.internal',
      sidecarImage: `sidecar@sha256:${'b'.repeat(64)}`, materializerImage: `materializer@sha256:${'a'.repeat(64)}`,
    });
    spec.containers[0]!.mounts.push(egress.agentMount);
    spec.containers.push(...egress.containers);
    const pod = new PodSessionDriver({
      ...FIXTURE_POLICY,
      cli: new FakeCli(),
      statHostPath: () => { throw new Error('Host path was inspected'); },
    }).composePod(spec);
    const rendered = JSON.stringify(pod);
    expect(rendered).not.toContain('hostPath');
    expect(rendered).not.toContain('persistentVolumeClaim');
    expect(rendered).not.toContain('nodeSelector');
    expect(rendered).not.toContain('nodeName');
    expect(rendered).not.toContain('affinity');
    const podSpec = pod.spec as {
      volumes: Array<{ name: string; emptyDir?: unknown; secret?: unknown }>;
      initContainers: Array<{ name: string }>;
    };
    expect(podSpec.volumes.every((volume) => volume.emptyDir || volume.secret)).toBe(true);
    expect(podSpec.volumes.find((volume) => volume.name === 'composer-db-source')?.secret)
      .toMatchObject({ defaultMode: 0o400 });
    const initNames = podSpec.initContainers.map((container) => container.name);
    expect(initNames.indexOf('workspace-composer-db')).toBeLessThan(initNames.indexOf('workspace-composer'));
  });
});
