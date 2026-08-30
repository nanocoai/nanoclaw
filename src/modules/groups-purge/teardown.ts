/**
 * External-teardown helpers for `ncl groups purge` (groups-purge skill).
 *
 * Wraps the container-runtime and container-runner primitives so the purge
 * verb can kill a group's running containers and remove its per-group Docker
 * image. Lives in its own module so the reach-ins into core stay import-only:
 * nothing in `src/container-runner.ts` or `src/container-runtime.ts` is
 * edited.
 */
import { execSync } from 'child_process';

import { CONTAINER_IMAGE_BASE } from '../../config.js';
import { isContainerRunning, killContainer } from '../../container-runner.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';

/**
 * Remove a container image by tag. Validates the tag to avoid shell injection,
 * then `docker rmi`. Throws on failure (no such image, image in use) so callers
 * can decide whether that's benign.
 */
export function removeImage(image: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/.test(image)) {
    throw new Error(`Invalid image tag: ${image}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} rmi ${image}`, { stdio: 'pipe' });
}

/**
 * Kill every running container in an agent group WITHOUT respawn.
 *
 * Unlike `restartAgentGroupContainers`, no `onExit` callback is passed, so the
 * containers stay down. Used by `groups purge` to tear a group down before its
 * session dir and DB rows are removed. Returns the count signalled.
 */
export async function killGroupContainers(agentGroupId: string, reason: string): Promise<number> {
  const sessions = (await getSessionsByAgentGroup(agentGroupId)).filter((s) => isContainerRunning(s.id));
  for (const session of sessions) {
    killContainer(session.id, reason); // no onExit ⇒ no respawn
  }
  if (sessions.length > 0) {
    log.info('Killed agent group containers (purge)', { agentGroupId, count: sessions.length });
  }
  return sessions.length;
}

/**
 * Remove a group's per-group image, if one was built. Best-effort: returns true
 * if an image was removed, false if there was none or removal failed. Never
 * throws.
 *
 * Only ever targets `${CONTAINER_IMAGE_BASE}:${agentGroupId}` — the tag embeds
 * the group id, so this can never touch the shared base image.
 */
export function deleteAgentGroupImage(agentGroupId: string): boolean {
  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;
  try {
    removeImage(imageTag);
    log.info('Removed per-agent-group image', { agentGroupId, imageTag });
    return true;
  } catch (err) {
    // No such image (e.g. a packageless group never built one) or rmi failed —
    // both benign for purge.
    log.debug('No per-agent-group image removed', { agentGroupId, imageTag, err });
    return false;
  }
}
