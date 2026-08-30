import path from 'node:path';

import type { ContainerConfig } from '../container-config.js';
import { configFromDb } from '../container-config.js';
import { getContainerConfig } from '../db/container-configs.js';
import type { ContainerSpec, RuntimeVolumeSource } from '../drivers/types.js';
import type {
  ProviderContainerContribution,
  ProviderProjectDocument,
  ProviderStateVolume,
  VolumeMount,
} from '../providers/provider-container-registry.js';
import type { AgentGroup, Session } from '../types.js';

const DB_PASSWORD_PATH = '/run/nanoclaw/composer/central-db-password';
const DB_PASSWORD_SOURCE_PATH = '/run/nanoclaw/composer-source/central-db-password';
const DB_PASSWORD_STAGE_DIR = '/run/nanoclaw/composer-stage';
const MATERIAL_ROOT = '/materialized';

export function configuredStatelessK8sHost(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NANOCO_STATELESS_K8S_HOST?.trim() ?? '';
  if (value !== '' && value !== '1') throw new Error("NANOCO_STATELESS_K8S_HOST must be '1' or unset");
  if (value === '1' && env.NANOCLAW_RUNTIME_DRIVER !== 'pod') {
    throw new Error("NANOCO_STATELESS_K8S_HOST=1 requires NANOCLAW_RUNTIME_DRIVER='pod'");
  }
  return value === '1';
}

export async function loadContainerConfigWithoutMaterializing(group: AgentGroup): Promise<ContainerConfig> {
  const row = await getContainerConfig(group.id);
  if (!row) throw new Error(`Container config not found for agent group: ${group.id}`);
  return configFromDb(row, group);
}

function emptyDir(name: string, sizeLimit?: string, medium?: 'Memory'): RuntimeVolumeSource {
  return { kind: 'emptyDir', name, ...(medium ? { medium } : {}), ...(sizeLimit ? { sizeLimit } : {}) };
}

function volume(
  source: RuntimeVolumeSource,
  containerPath: string,
  readonly: boolean,
  mountClass: VolumeMount['mountClass'],
  scope: string,
  subPath?: string,
): VolumeMount {
  return {
    hostPath: `/nanoclaw-runtime/${source.name}${subPath ? `/${subPath}` : ''}`,
    containerPath,
    readonly,
    mountClass,
    scope,
    source,
    ...(subPath ? { subPath } : {}),
  };
}

const SESSION = emptyDir('session-state', '2Gi');
const GROUP = emptyDir('group-state', '2Gi');
const CONTROL = emptyDir('session-control', '1Mi', 'Memory');
const TMP = emptyDir('composer-tmp', '128Mi', 'Memory');
const DB_SECRET = {
  kind: 'secret',
  name: 'composer-db-source',
  secretName: 'nanoclaw-composer-db',
  key: 'central-db-password',
  mode: 0o400,
} as const satisfies RuntimeVolumeSource;
const DB_STAGE = emptyDir('composer-db', '1Mi', 'Memory');
// Shared with the agent container (pod-driver mounts the same named volume at
// /workspace/.heartbeat). The composer seeds it, which is why `heartbeat-init`
// no longer needs to exist: seeding a file before the agent starts is
// composition, and the composer already writes the agent's tree.
const HEARTBEAT = emptyDir('agent-heartbeat', '1Mi', 'Memory');
/** MATERIAL_ROOT itself. The composer creates `groups/` and `store/` under it,
 *  and only `provider-state/*` and `data/v2-sessions/*` are mounted — so
 *  without this volume the root is a directory kubelet auto-creates on the
 *  container's rootfs to host those nested mounts, owned by root and not
 *  covered by fsGroup, and the materializer dies on `EACCES … mkdir
 *  '/materialized/groups'`. Small on purpose: `groups/<folder>` is a symlink to
 *  the group-state volume, so the composed bytes never land here. */
const MATERIAL = emptyDir('composer-material', '64Mi');

export function statelessAgentMounts(
  group: AgentGroup,
  session: Session,
  config: ContainerConfig,
  projectDocument: ProviderProjectDocument,
  contribution: ProviderContainerContribution = {},
): VolumeMount[] {
  validateProviderContribution(contribution);
  if (config.additionalMounts.length > 0) {
    throw new Error('stateless Kubernetes Host does not accept Host-path additional mounts');
  }
  if (contribution.mounts?.some((mount) => !mount.source)) {
    throw new Error('stateless Kubernetes Host accepts only provider mounts backed by driver-owned volumes');
  }
  const scope = group.id;
  const mounts: VolumeMount[] = [
    volume(SESSION, '/workspace', false, 'group-state', scope),
    volume(GROUP, '/workspace/agent', false, 'group-state', scope),
    volume(GROUP, '/workspace/agent/container.json', true, 'group-state', scope, 'container.json'),
    volume(GROUP, projectDocument.containerPath, true, 'group-state', scope, projectDocument.fileName),
    volume(GROUP, '/workspace/agent/plugins', true, 'install-surface', scope, 'plugins'),
    volume(GROUP, '/workspace/agent/plugin-data', false, 'group-state', scope, 'plugin-data'),
    // The composer creates the context after Kata prepares every container's
    // mounts. Mount the pod-private directory; a file subPath would become a
    // directory before the file exists inside the guest.
    volume(CONTROL, '/run/nanoclaw/session-context', true, 'group-state', scope),
  ];
  for (const state of providerMountsFor(contribution.stateVolumes ?? [], scope)) {
    mounts.push(state.mount);
  }
  return [
    ...mounts,
    ...providerSkillMounts(contribution, scope),
    ...(contribution.mounts ?? []).filter((mount) => mount.source),
  ];
}

export function validateProviderContribution(contribution: ProviderContainerContribution): void {
  const destinations = new Set<string>();
  const safePath = (value: string): boolean => value.startsWith('/') &&
    value.split('/').every((part, index) => index === 0 || Boolean(part && part !== '.' && part !== '..'));
  for (const state of contribution.stateVolumes ?? []) {
    if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(state.name) || !safePath(state.containerPath)) {
      throw new Error('invalid provider state volume');
    }
    if (destinations.has(state.containerPath)) throw new Error(`duplicate provider destination: ${state.containerPath}`);
    destinations.add(state.containerPath);
  }
  for (const view of contribution.skillViews ?? []) {
    if (!safePath(view.containerPath)) throw new Error('invalid provider skill view');
  }
  for (const seed of contribution.seedFiles ?? []) {
    if (!safePath(seed.containerPath) || !contribution.stateVolumes?.some((state) =>
      seed.containerPath.startsWith(`${state.containerPath}/`))) {
      throw new Error('provider seed is outside declared state');
    }
  }
}

function providerMountsFor(
  states: ProviderStateVolume[],
  scope: string,
): Array<{ source: RuntimeVolumeSource; mount: VolumeMount }> {
  return states.map((state) => {
    const source = emptyDir(state.name, state.sizeLimit ?? '512Mi');
    return { source, mount: volume(source, state.containerPath, false, 'group-state', scope) };
  });
}

function providerSkillMounts(
  contribution: ProviderContainerContribution,
  scope: string,
): VolumeMount[] {
  const states = contribution.stateVolumes ?? [];
  const mounts: VolumeMount[] = [];
  for (const view of contribution.skillViews ?? []) {
    if (states.some((state) => view.containerPath === state.containerPath || view.containerPath.startsWith(`${state.containerPath}/`))) {
      continue;
    }
    const subPath = path.posix.basename(view.containerPath);
    mounts.push(volume(GROUP, view.containerPath, view.mode === 'ro', 'group-state', scope, subPath));
  }
  return mounts;
}

export interface WorkspaceComposerInput {
  agentGroup: AgentGroup;
  session: Session;
  containerConfig: ContainerConfig;
  projectDocument: ProviderProjectDocument;
  contribution: ProviderContainerContribution;
  mailboxContext: unknown;
  env?: NodeJS.ProcessEnv;
}

export function workspaceComposerDbInitContainer(
  runAs: { uid: number; gid: number } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ContainerSpec {
  const image = materializerImage(env);
  if (!runAs || runAs.uid === 0) throw new Error('workspace composer requires a non-root Host identity');
  const source = {
    ...DB_SECRET,
    secretName: env.NANOCO_COMPOSER_DB_SECRET?.trim() || DB_SECRET.secretName,
  };
  const scope = 'composer-db';
  return {
    role: 'workspace-composer-db',
    image,
    command: ['/bin/sh', '-c'],
    args: [
      // Set the mode while root still OWNS the copy, and hand it over last.
      // `install -m -o -g` chowns before it chmods, so the final chmod lands on
      // a file this process no longer owns and needs CAP_FOWNER on top of
      // CAP_CHOWN — under `drop: ['ALL']` that surfaced as
      // `install: cannot change permissions … Operation not permitted`.
      // Splitting the steps keeps the added capability set to CHOWN alone.
      'install -m 0400 "$3" "$4" && chown "$1:$2" "$4"',
      'composer-db-init',
      String(runAs.uid),
      String(runAs.gid),
      DB_PASSWORD_SOURCE_PATH,
      path.posix.join(DB_PASSWORD_STAGE_DIR, 'central-db-password'),
    ],
    env: {},
    mounts: [
      volume(source, DB_PASSWORD_SOURCE_PATH, true, 'identity-material', scope, 'central-db-password'),
      volume(DB_STAGE, DB_PASSWORD_STAGE_DIR, false, 'identity-material', scope),
    ].map((mount) => ({
      class: mount.mountClass!,
      hostPath: mount.hostPath,
      containerPath: mount.containerPath,
      mode: mount.readonly ? ('ro' as const) : ('rw' as const),
      groupScope: mount.scope!,
      source: mount.source!,
      ...(mount.subPath ? { subPath: mount.subPath } : {}),
    })),
  };
}

export function workspaceComposerContainer(input: WorkspaceComposerInput): ContainerSpec {
  const env = input.env ?? process.env;
  const sourceRoot = hostSourceRoot(env);
  const image = materializerImage(env);
  const dbUrl = env.NANOCLAW_DB_URL?.trim() ?? '';
  if (!/^postgres(?:ql)?:\/\/[^:@\s]+@[^\s]+$/.test(dbUrl)) {
    throw new Error('workspace composer requires a passwordless NANOCLAW_DB_URL');
  }
  const scope = input.agentGroup.id;
  // `sessionContextPath` is deliberately OUTSIDE the agent-writable session
  // directory — `<data>/v2-sessions/<group>/.context/<session>.json` — so an
  // agent that plants a symlink where its own session dir used to be cannot
  // redirect the host's write (session-manager.test.ts pins that property).
  // Mount CONTROL on that `.context` directory rather than on the session dir:
  // the composer then writes into a volume it owns, and the agent still
  // receives only its own context file, read-only, through a subPath.
  const sessionControlDir = path.posix.join(
    MATERIAL_ROOT,
    'data/v2-sessions',
    scope,
    '.context',
  );
  const mounts = [
    // First: the nested provider-state and session-control mounts below land
    // inside this one, so the composer owns every path it has to create.
    volume(MATERIAL, MATERIAL_ROOT, false, 'group-state', scope),
    volume(SESSION, '/workspace', false, 'group-state', scope),
    volume(GROUP, '/workspace/agent', false, 'group-state', scope),
    volume(CONTROL, sessionControlDir, false, 'group-state', scope),
    volume(TMP, '/tmp', false, 'allowlisted-extra', scope),
    volume(HEARTBEAT, '/heartbeat', false, 'allowlisted-extra', scope),
    // Mount the directory, not a file subPath created by the previous init.
    // Kata prepares every container's subPath before init execution and turns
    // the then-missing file into a 0777 directory inside the guest.
    volume(DB_STAGE, path.posix.dirname(DB_PASSWORD_PATH), true, 'identity-material', scope),
    ...providerMountsFor(input.contribution.stateVolumes ?? [], scope).map(({ source }) =>
      volume(source, path.posix.join(MATERIAL_ROOT, 'provider-state', source.name), false, 'group-state', scope)),
  ].map((mount) => ({
    class: mount.mountClass!,
    hostPath: mount.hostPath,
    containerPath: mount.containerPath,
    mode: mount.readonly ? ('ro' as const) : ('rw' as const),
    groupScope: mount.scope!,
    source: mount.source!,
    ...(mount.subPath ? { subPath: mount.subPath } : {}),
  }));
  return {
    role: 'workspace-composer',
    image,
    command: ['node', `${sourceRoot}/dist/storage/workspace-materializer-lock.js`, `${sourceRoot}/dist/stateless-k8s/materializer.js`],
    env: {
      NANOCO_COMPOSER_GROUP_ID: scope,
      NANOCO_COMPOSER_SESSION_ID: input.session.id,
      NANOCO_COMPOSER_PROVIDER: input.containerConfig.provider ?? 'claude',
      NANOCO_COMPOSER_SOURCE_ROOT: sourceRoot,
      NANOCO_COMPOSER_PROJECT_DOC_B64: Buffer.from(JSON.stringify(input.projectDocument), 'utf8').toString('base64url'),
      NANOCO_COMPOSER_PROVIDER_CONTRIBUTION_B64: Buffer.from(JSON.stringify(input.contribution), 'utf8').toString('base64url'),
      NANOCLAW_DB_URL: dbUrl,
      NANOCLAW_DB_PASSWORD_FILE: DB_PASSWORD_PATH,
      NANOCLAW_GROUPS_DIR: `${MATERIAL_ROOT}/groups`,
      NANOCLAW_DATA_DIR: `${MATERIAL_ROOT}/data`,
      NANOCLAW_STORE_DIR: `${MATERIAL_ROOT}/store`,
      NANOCLAW_TEMPLATES_DIR: `${sourceRoot}/templates`,
    },
    sensitiveEnv: {
      NANOCO_COMPOSER_CONTEXT_B64: Buffer.from(JSON.stringify(input.mailboxContext), 'utf8').toString('base64url'),
    },
    mounts,
    labels: { 'nanoclaw-group': scope },
  };
}

function materializerImage(env: NodeJS.ProcessEnv): string {
  const image = env.NANOCO_MATERIALIZER_IMAGE?.trim() ?? '';
  if (!/^\S+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error('NANOCO_MATERIALIZER_IMAGE must be an immutable image reference');
  }
  return image;
}

function hostSourceRoot(env: NodeJS.ProcessEnv): string {
  const root = env.NANOCO_HOST_SOURCE_ROOT?.trim() || '/opt/nanoclaw';
  if (!path.posix.isAbsolute(root) || root === '/' || root.includes('..')) throw new Error('invalid Host source root');
  return root.replace(/\/$/, '');
}
