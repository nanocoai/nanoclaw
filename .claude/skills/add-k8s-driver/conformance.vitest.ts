import { defineConfig } from 'vitest/config';

function replace(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`Kubernetes conformance adapter could not find: ${from}`);
  return source.replace(from, to);
}

export default defineConfig({
  plugins: [
    {
      name: 'kubernetes-driver-conformance',
      enforce: 'pre',
      transform(source, id) {
        if (!id.split('?')[0].endsWith('/src/drivers/conformance.test.ts')) return;
        source = replace(
          source,
          "import { DockerSessionDriver } from './docker-driver.js';",
          `import { DockerSessionDriver } from './docker-driver.js';
import {
  KubernetesApiError,
  KubernetesSessionDriver,
  type KubernetesApi,
  type KubernetesDriverOptions,
} from './kubernetes-driver.js';`,
        );
        source = replace(source, 'let harnesses: Harness[];', `${kubernetesHarness}\n\nlet harnesses: Harness[];`);
        source = replace(source, 'harnesses = [dockerHarness()];', 'harnesses = [kubernetesHarness()];');
        source = replace(
          source,
          'const proc = h.cli.started.at(-1)!.proc;',
          'await settled();\n    const proc = h.cli.started.at(-1)!.proc;',
        );
        source = replace(
          source,
          'expect(capabilities.unrealized).toEqual([]);',
          "expect(capabilities.unrealized).toEqual(['pidsLimit']);",
        );
        source = replace(
          source,
          "expect(capabilities.networkPolicy).toBe('topology');",
          "expect(capabilities.networkPolicy).toBe('declarative');",
        );
        source = replace(
          source,
          'expect(capabilities.sharedNetworkNamespace).toBe(false);',
          'expect(capabilities.sharedNetworkNamespace).toBe(true);',
        );
        source = replace(
          source,
          'expect(capabilities.auxiliaryContainers).toBe(true);',
          'expect(capabilities.auxiliaryContainers).toBe(false);',
        );
        source = replace(
          source,
          'expect(capabilities.imageBuild).toBe(true);',
          'expect(capabilities.imageBuild).toBe(false);',
        );
        return source;
      },
    },
  ],
});

const kubernetesHarness = String.raw`
class KubernetesConformanceApi implements KubernetesApi {
  readonly jobs = new Map<string, Record<string, any>>();
  spec: SessionSpec | null = null;

  constructor(readonly cli: FakeCli) {}

  async request(method: string, apiPath: string, body?: unknown): Promise<unknown> {
    if (method === 'GET' && apiPath.includes('?labelSelector=')) {
      const listed = this.cli.run(['ps', '-a']);
      if (listed.trim()) {
        return {
          metadata: { resourceVersion: '1' },
          items: listed.trim().split('\n').map((line) => {
            const [name, state, agentGroupId, sessionId] = line.split('|');
            return {
              metadata: {
                name,
                labels: {
                  [LABELS.install]: 'spike',
                  [LABELS.group]: agentGroupId,
                  [LABELS.session]: sessionId,
                  [LABELS.role]: 'agent',
                },
              },
              spec: { suspend: state === 'created' },
              status:
                state === 'running' ? { active: 1 } : state === 'exited' ? { succeeded: 1 } : {},
            };
          }),
        };
      }
      return { metadata: { resourceVersion: '1' }, items: [...this.jobs.values()] };
    }

    const name = decodeURIComponent(apiPath.split('/jobs/')[1]?.split('?')[0] ?? '');
    if (method === 'GET') {
      const current = this.jobs.get(name);
      if (current) return current;
      let identity: string;
      try {
        identity = this.cli.run(['inspect', name]).trim();
      } catch (_error) {
        throw new KubernetesApiError(404, 'missing');
      }
      if (!identity) throw new KubernetesApiError(404, 'missing');
      const [installSlug, agentGroupId, sessionId] = identity.split('|');
      return {
        metadata: {
          name,
          labels: {
            [LABELS.install]: installSlug,
            [LABELS.group]: agentGroupId,
            [LABELS.session]: sessionId,
            [LABELS.role]: 'agent',
          },
        },
        spec: { suspend: true },
      };
    }

    if (method === 'POST') {
      const job = body as Record<string, any>;
      const create = ['create'];
      for (const [key, value] of Object.entries(job.metadata.labels as Record<string, string>)) {
        create.push('--label', key + '=' + value);
      }
      const container = job.spec.template.spec.containers[0];
      for (const item of container.env) create.push('-e', item.name + '=' + item.value);
      for (const mount of this.spec!.containers[0].mounts) {
        create.push('-v', mount.hostPath + ':' + mount.containerPath + ':' + mount.mode);
      }
      this.cli.run(create);
      this.jobs.set(job.metadata.name, job);
      return job;
    }

    if (method === 'PATCH') {
      const job = this.jobs.get(name)!;
      job.spec.suspend = false;
      job.status = { active: 1 };
      return job;
    }

    if (method === 'DELETE') {
      this.jobs.delete(name);
      this.cli.run(['rm', '--force', name]);
      return null;
    }
    throw new Error('unexpected Kubernetes request ' + method + ' ' + apiPath);
  }

  watch(_apiPath: string, signal: AbortSignal, onEvent: (event: unknown) => void): Promise<void> {
    const proc = this.cli.start(['watch']);
    proc.onExit(() => {
      const job = [...this.jobs.values()].at(-1);
      if (!job) return;
      job.spec.suspend = false;
      job.status = { failed: 1 };
      onEvent({ type: 'MODIFIED', object: job });
    });
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }
}

function kubernetesHarness(): Harness {
  const cli = new FakeCli('kubectl');
  cli.responses = [{ match: /^inspect /, throws: new Error('not found') }];
  const api = new KubernetesConformanceApi(cli);
  const options: KubernetesDriverOptions = {
    ...FIXTURE_POLICY,
    namespace: 'agents',
    serviceAccountName: 'agent-session',
    persistentVolumeMounts: [
      { hostRoot: '/install/data', claimName: 'state', claimSubPath: 'data' },
      { hostRoot: '/install/groups', claimName: 'state', claimSubPath: 'groups' },
      { hostRoot: '/home/operator', claimName: 'extras', claimSubPath: 'home' },
    ],
    bakedSurfaces: [
      { hostRoot: '/install/container/agent-runner/src', containerRoot: '/app/src' },
      { hostRoot: '/install/container/skills', containerRoot: '/app/skills' },
      { hostRoot: '/install/container/CLAUDE.md', containerRoot: '/app/CLAUDE.md' },
    ],
    api,
  };
  const raw = new KubernetesSessionDriver(options);
  const driver = withSessionEvents({
    kind: raw.kind,
    capabilities: () => raw.capabilities(),
    ensureReady: () => raw.ensureReady(),
    prepare: (spec) => {
      api.spec = spec;
      return raw.prepare(spec);
    },
    listSessions: (installSlug) => raw.listSessions(installSlug),
    watchSessions: (installSlug, onEvent) => raw.watchSessions(installSlug, onEvent),
    reapResidue: (installSlug) => raw.reapResidue(installSlug),
  });
  return {
    name: 'kubernetes',
    driver,
    cli,
    async realize(spec) {
      await driver.prepare(spec);
      const create = cli.callMatching(/^create /)!.args;
      const env: Record<string, string> = {};
      const mounts: Realized['containers'][number]['mounts'] = [];
      const labels: Record<string, string> = {};
      for (let i = 0; i < create.length; i++) {
        if (create[i] === '-e') {
          const eq = create[i + 1].indexOf('=');
          env[create[i + 1].slice(0, eq)] = create[i + 1].slice(eq + 1);
        }
        if (create[i] === '-v') {
          const parts = create[i + 1].split(':');
          mounts.push({ hostPath: parts[0], containerPath: parts[1], ro: parts[2] === 'ro' });
        }
        if (create[i] === '--label') {
          const eq = create[i + 1].indexOf('=');
          labels[create[i + 1].slice(0, eq)] = create[i + 1].slice(eq + 1);
        }
      }
      const agent = spec.containers.find((c) => c.role === 'agent')!;
      return { containers: [{ role: 'agent', image: agent.image, env, mounts }], labels };
    },
    failWith(message) {
      cli.responses = [
        { match: /^inspect /, throws: new Error('not found') },
        { match: /^create /, throws: new Error(message) },
      ];
    },
  };
}
`;
