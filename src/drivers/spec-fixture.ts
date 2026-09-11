/**
 * The one session spec every driver test starts from.
 *
 * Shared so assertions about two drivers are demonstrably about the same
 * input — which is what makes the conformance cases mean anything. Only the
 * Docker driver ships in this tree; an out-of-tree driver plugs its harness
 * into the same suite against this same fixture.
 *
 * `fixtureSpec()` is the agent-only session this tree's realization actually
 * runs. `fixtureSpecWithAux()` adds an overlay-composed auxiliary container:
 * it exercises the multi-container contract rules (identity-material custody,
 * per-role mount checks) through `validateSpec`, and the refusal rule on
 * drivers that do not manage auxiliary containers — a driver never realizes a
 * subset of a spec.
 */
import type { ContainerSpec, MountPolicy, SessionSpec } from './types.js';

export const FIXTURE_POLICY: MountPolicy = {
  groupsRoot: '/install/groups',
  dataRoot: '/install/data',
  surfaceRoots: ['/install/container/agent-runner/src', '/install/container/skills', '/install/container/CLAUDE.md'],
  materialsRoot: '/install/data/session-materials',
};

export function fixtureSpec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  const spec: SessionSpec = {
    key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' },
    labels: {
      'nanoclaw-container-name': 'nanoclaw-v2-agent-one-1700000000000',
      // D9: composition stamps the group folder for admission to join on.
      'nanoclaw-group-folder': 'agent-one',
    },
    containers: [
      {
        role: 'agent',
        image: 'nanoclaw-agent:spike-p0',
        env: { TZ: 'UTC', HTTPS_PROXY: 'http://127.0.0.1:15001' },
        command: ['bash', '-c'],
        args: ['exec bun run /app/src/index.ts'],
        labels: { 'session-channel': 'channel-abc' },
        mounts: [
          {
            class: 'group-state',
            hostPath: '/install/data/v2-sessions/g1/s1',
            containerPath: '/workspace',
            mode: 'rw',
            groupScope: 'g1',
          },
          {
            class: 'install-surface',
            hostPath: '/install/container/agent-runner/src',
            containerPath: '/app/src',
            mode: 'ro',
            groupScope: 'g1',
          },
          {
            class: 'install-surface',
            hostPath: '/install/container/CLAUDE.md',
            containerPath: '/app/CLAUDE.md',
            mode: 'ro',
            groupScope: 'g1',
          },
        ],
      },
    ],
    network: 'shared-private',
    hardening: 'standard',
    resources: { shmSizeMb: 1024, pidsLimit: 2048 },
    runtimeTier: 'container',
    runAs: { uid: 501, gid: 1000 },
    stopGraceSeconds: 1,
    ...overrides,
  };
  return spec;
}

/**
 * An overlay-composed auxiliary container: exercises every multi-container
 * rule (identity-material custody, per-role mount checks) without this tree
 * shipping such a composer itself.
 */
export function fixtureAuxContainer(): ContainerSpec {
  return {
    role: 'egress-proxy',
    image: 'example-egress-proxy:test',
    env: { PROXY_LISTEN_ADDR: '0.0.0.0:15001' },
    mounts: [
      {
        class: 'identity-material',
        hostPath: '/install/data/session-materials/channel-abc-XXXX/session-key.pem',
        containerPath: '/run/session/session-key.pem',
        mode: 'ro',
        groupScope: 'g1',
      },
      {
        // A deployment CA from outside the material root — NOT the material
        // root. A fixture where every auxiliary mount shared one root could
        // not distinguish a correct classification from a uniform one, and a
        // uniform one shipped: it denied every spawn on the node while this
        // suite stayed green.
        class: 'allowlisted-extra',
        hostPath: '/pki/upstream-ca.pem',
        containerPath: '/run/session/upstream-ca.pem',
        mode: 'ro',
        groupScope: 'g1',
      },
    ],
  };
}

/** The two-container session an overlay composes; see the module comment. */
export function fixtureSpecWithAux(overrides: Partial<SessionSpec> = {}): SessionSpec {
  const spec = fixtureSpec(overrides);
  spec.containers = [...spec.containers, fixtureAuxContainer()];
  return spec;
}
