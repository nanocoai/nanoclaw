import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { MountSpec, RuntimeVolumeSource, SessionSpec } from '../drivers/types.js';

export const WORKSPACE_FINALIZER = 'nanoco.ai/workspace-checkpoint';
export const WORKSPACE_LABEL = 'nanoco.ai/workspace';
export const WORKSPACE_GROUP_LABEL = 'nanoco.ai/workspace-group';
export const WORKSPACE_SESSION_LABEL = 'nanoco.ai/workspace-session';
export const WORKSPACE_GENERATION_LABEL = 'nanoco.ai/workspace-generation';
export const WORKSPACE_GROUP_ANNOTATION = 'nanoco.ai/workspace-group-id';
export const WORKSPACE_SESSION_ANNOTATION = 'nanoco.ai/workspace-session-id';
export const WORKSPACE_TIER_ANNOTATION = 'nanoco.ai/workspace-runtime-tier';
export const WORKSPACE_RECOVERY_ANNOTATION = 'nanoco.ai/workspace-recovery';

export type WorkspaceAssignment = {
  groupId: string;
  sessionId: string;
  nodeName: string;
  generation: number;
  plainHostPath: string;
  runtimeTier: 'container' | 'vm';
};

export type WorkspaceRelay = {
  claim: string;
  requestCapability: string;
  deploymentId: string;
  agentId: string;
  sessionId: string;
  containerInstanceId: string;
  channelId: string;
  claimUrl: string;
  claimServerName: string;
  gatewayAddress: string;
  gatewayServerName: string;
  sidecarImage: string;
};

type EnsureInput = Pick<WorkspaceAssignment, 'groupId' | 'sessionId' | 'runtimeTier'> & {
  relay?: WorkspaceRelay;
};

export async function ensureWorkspace(input: EnsureInput, env: NodeJS.ProcessEnv = process.env): Promise<WorkspaceAssignment> {
  validateId(input.groupId, 'group');
  validateId(input.sessionId, 'session');
  if (input.relay) validateWorkspaceRelay(input.relay, input);
  const assignment = await request('/v1/workspaces/ensure', input, env) as WorkspaceAssignment;
  validateAssignment(assignment, input, env);
  return assignment;
}

export function validateWorkspaceRelay(
  value: WorkspaceRelay,
  expected: { groupId: string; sessionId: string },
): void {
  if (!value || value.agentId !== expected.groupId || value.sessionId !== expected.sessionId) {
    throw new Error('workspace relay does not belong to the requested session');
  }
  for (const [name, id] of Object.entries({
    deploymentId: value.deploymentId,
    agentId: value.agentId,
    sessionId: value.sessionId,
    containerInstanceId: value.containerInstanceId,
    channelId: value.channelId,
  })) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) throw new Error(`invalid workspace relay ${name}`);
  }
  if (!/^[a-f0-9]{64}$/.test(value.requestCapability)) throw new Error('invalid workspace relay request capability');
  if (!value.claim || value.claim.length > 16_384 || /\s/.test(value.claim)) throw new Error('invalid workspace relay claim');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(value.claimUrl)) throw new Error('invalid workspace relay claim URL');
  if (!/^[a-z0-9.-]+$/.test(value.claimServerName)) throw new Error('invalid workspace relay claim server name');
  if (!/^[a-z0-9.-]+:\d+$/.test(value.gatewayAddress)) throw new Error('invalid workspace relay Gateway address');
  if (!/^[a-z0-9.-]+$/.test(value.gatewayServerName)) throw new Error('invalid workspace relay Gateway server name');
  if (!/^\S+@sha256:[0-9a-f]{64}$/.test(value.sidecarImage)) throw new Error('invalid workspace relay sidecar image');
}

export async function releaseWorkspace(assignment: WorkspaceAssignment, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  validateAssignment(assignment, assignment, env);
  await request('/v1/workspaces/release', assignment, env);
}

export async function ensureWorkspacePaths(spec: SessionSpec, assignment: WorkspaceAssignment, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  validateAssignment(assignment, { groupId: spec.key.agentGroupId, sessionId: spec.key.sessionId, runtimeTier: spec.runtimeTier }, env);
  await request('/v1/workspaces/paths', { ...assignment, paths: workspacePaths(spec, assignment) }, env);
}

export function bindWorkspaceSpec(spec: SessionSpec, assignment: WorkspaceAssignment): void {
  validateAssignment(assignment, { groupId: spec.key.agentGroupId, sessionId: spec.key.sessionId, runtimeTier: spec.runtimeTier }, {
    NANOCO_WORKSPACE_HOST_ROOT: workspaceHostRootFrom(assignment.plainHostPath, assignment),
  });
  if (spec.key.agentGroupId !== assignment.groupId || spec.key.sessionId !== assignment.sessionId) {
    throw new Error('workspace assignment does not belong to the session spec');
  }
  if (spec.runtimeTier !== assignment.runtimeTier) throw new Error('workspace runtime tier changed after allocation');
  for (const container of spec.containers) {
    container.mounts = container.mounts.map((mount) => bindMount(mount, assignment));
  }
  spec.workspace = assignment;
  spec.labels[WORKSPACE_LABEL] = 'true';
  spec.labels[WORKSPACE_GROUP_LABEL] = labelId(assignment.groupId);
  spec.labels[WORKSPACE_SESSION_LABEL] = labelId(assignment.sessionId);
  spec.labels[WORKSPACE_GENERATION_LABEL] = String(assignment.generation);
}

export function labelId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function bearerMatches(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function workspacePaths(spec: SessionSpec, assignment: WorkspaceAssignment): string[] {
  const prefix = `${assignment.plainHostPath}/`;
  return validateWorkspacePaths(spec.containers.flatMap((container) => container.mounts).flatMap((mount) => {
    if (mount.class !== 'group-state' || mount.source?.kind !== 'hostPath') return [];
    const candidate = mount.source.path;
    if (!candidate.startsWith(prefix)) throw new Error('workspace mount path escapes its assigned generation');
    return [candidate.slice(prefix.length)];
  }));
}

export function validateWorkspacePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error('invalid workspace path list');
  const paths = [...new Set(value)];
  if (!paths.every((entry): entry is string => typeof entry === 'string'
    && (entry === 'agent' || /^provider-state\/[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(entry)))) {
    throw new Error('invalid workspace path');
  }
  return paths.sort();
}

function bindMount(mount: MountSpec, assignment: WorkspaceAssignment): MountSpec {
  if (mount.class !== 'group-state' || mount.source?.kind !== 'emptyDir') return mount;
  const name = mount.source.name;
  if (name === 'composer-material' || name === 'session-state' || name === 'session-control') return mount;
  const relative = name === 'group-state'
    ? 'agent'
    : path.posix.join('provider-state', name);
  const hostPath = path.posix.join(assignment.plainHostPath, relative);
  const source: RuntimeVolumeSource = {
    kind: 'hostPath',
    name: `workspace-${labelId(relative).slice(0, 16)}`,
    path: hostPath,
    type: 'Directory',
  };
  return { ...mount, hostPath, source };
}

/**
 * The controller, when it runs INSIDE this process.
 *
 * It began life as its own Deployment reached over HTTP, and every cost of that
 * split showed up in production: the ensure call is the hop that times out
 * (`fetch failed` / `The operation was aborted due to timeout`); a claimed dev
 * environment needs a whole companion namespace holding one pod, its Service,
 * ServiceAccount and a cross-namespace RoleBinding that has already been wrong
 * (`cannot list resource "pods"`); that controller outlives the instance it
 * serves, error-looping for hours after its namespace is gone; and two
 * reconcilers — the host's ensure() and the controller's own sweep — write the
 * same lease, which is how a relay-less Custodian got built.
 *
 * None of it bought isolation: the host's RBAC is a strict superset of the
 * controller's, both are singletons, and the host already owns the lifecycle
 * that should end the reconciler. So the seam stays (a remote controller is
 * still addressable for a split deployment) but the default is in-process,
 * where the call cannot time out and the state cannot outlive its owner.
 */
let localController: WorkspacePlaneController | null = null;

/** The subset of the controller this plane calls. Structural on purpose: the
 *  controller module imports THIS file, so naming its class here would be a
 *  cycle. */
export interface WorkspacePlaneController {
  ensure(input: { groupId: string; sessionId: string; runtimeTier: 'container' | 'vm'; relay?: WorkspaceRelay }): Promise<WorkspaceAssignment>;
  release(input: WorkspaceAssignment): Promise<void>;
  ensurePaths(input: WorkspaceAssignment & { paths: string[] }): Promise<void>;
}

/** Run the workspace plane in this process. Called once at Host boot; passing
 *  null restores the HTTP transport (the tests' escape hatch). */
export function useLocalWorkspaceController(controller: WorkspacePlaneController | null): void {
  localController = controller;
}

export function localWorkspaceControllerInstalled(): boolean {
  return localController !== null;
}

async function request(route: string, body: unknown, env: NodeJS.ProcessEnv): Promise<unknown> {
  if (localController) {
    switch (route) {
      case '/v1/workspaces/ensure':
        return await localController.ensure(body as Parameters<WorkspacePlaneController['ensure']>[0]);
      case '/v1/workspaces/release':
        await localController.release(body as WorkspaceAssignment);
        return {};
      case '/v1/workspaces/paths':
        await localController.ensurePaths(body as WorkspaceAssignment & { paths: string[] });
        return {};
      default:
        throw new Error(`unknown workspace plane route ${route}`);
    }
  }
  const base = env.NANOCO_WORKSPACE_CONTROLLER_URL?.trim();
  const tokenFile = env.NANOCO_WORKSPACE_CONTROLLER_TOKEN_FILE?.trim();
  if (!base || !/^http:\/\/[a-z0-9.-]+(?::\d+)?$/.test(base)) {
    throw new Error('NANOCO_WORKSPACE_CONTROLLER_URL must be a private HTTP service URL');
  }
  if (!tokenFile || !path.isAbsolute(tokenFile)) throw new Error('workspace Controller token file is required');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (token.length < 32) throw new Error('workspace Controller token is invalid');
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(result.error || `workspace Controller returned HTTP ${response.status}`);
  return result;
}

function validateAssignment(value: WorkspaceAssignment, input: { groupId: string; sessionId: string; runtimeTier?: string }, env: NodeJS.ProcessEnv): void {
  if (!value || value.groupId !== input.groupId || value.sessionId !== input.sessionId) throw new Error('workspace Controller returned another session assignment');
  validateId(value.groupId, 'group');
  validateId(value.sessionId, 'session');
  if (!value.nodeName || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(value.nodeName)) throw new Error('workspace Controller returned an invalid node');
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error('workspace Controller returned an invalid generation');
  if (value.runtimeTier !== 'container' && value.runtimeTier !== 'vm') throw new Error('workspace Controller returned an invalid runtime tier');
  if (input.runtimeTier && value.runtimeTier !== input.runtimeTier) throw new Error('workspace Controller changed the runtime tier');
  const root = env.NANOCO_WORKSPACE_HOST_ROOT?.trim();
  if (!root || !path.posix.isAbsolute(root)) throw new Error('NANOCO_WORKSPACE_HOST_ROOT is required');
  const expected = path.posix.join(root, value.groupId, 'generations', String(value.generation), 'plain');
  if (value.plainHostPath !== expected) throw new Error('workspace Controller returned a path outside the assigned group generation');
}

function workspaceHostRootFrom(plain: string, value: WorkspaceAssignment): string {
  const suffix = path.posix.join(value.groupId, 'generations', String(value.generation), 'plain');
  if (!plain.endsWith(`/${suffix}`)) throw new Error('invalid workspace assignment path');
  return plain.slice(0, -(suffix.length + 1)) || '/';
}

function validateId(value: string, kind: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error(`invalid workspace ${kind} ID`);
}
