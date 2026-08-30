/**
 * Run the workspace controller inside the Host process.
 *
 * The controller began as its own Deployment, reached over HTTP. Every cost of
 * that split showed up in production and none of the benefits did:
 *
 * - The ensure hop is the call that fails. `fetch failed` and
 *   `The operation was aborted due to timeout` at workspace-plane's `request()`
 *   are how a session stops spawning, and the controller's own log stays empty
 *   because the request never arrives.
 * - A claimed dev environment pays a whole companion namespace for one pod —
 *   Deployment, Service, ServiceAccount and a cross-namespace RoleBinding that
 *   has already been wrong in the field (`cannot list resource "pods" in the
 *   namespace ...`). That is one grant per environment that can fail open.
 * - That controller outlives the instance it serves. Two were found still
 *   Running and error-looping against namespaces that no longer existed, one of
 *   them for over two hours, because teardown hung off in-memory state.
 * - Two reconcilers write the same lease — the Host's `ensure()` and the
 *   controller's own sweep — which is how a Custodian got started without its
 *   relay identity and could never reach KMS or S3.
 *
 * And it bought no isolation to weigh against that: the Host's ClusterRole is a
 * strict superset of the controller's (nodes, PVs, namespaces, deployments and
 * statefulsets on top of the controller's pods/services/secrets/leases), both
 * are singletons, and the Host already owns the lifecycle that should end the
 * reconciler.
 *
 * So the transport moves in-process while the seam stays: set
 * `NANOCO_WORKSPACE_CONTROLLER_URL` and the plane still speaks HTTP to a
 * separate controller, which is what a split deployment needs. Absent that, the
 * Host runs it here, where the call cannot time out and the reconciler cannot
 * outlive its owner.
 */
import { onHostShutdown, onHostStart } from '../host-lifecycle.js';
import { log } from '../log.js';
import { startEmbeddedWorkspaceController } from './workspace-controller.js';
import { useLocalWorkspaceController } from './workspace-plane.js';

/** Set to opt a deployment back into a separately-deployed controller. */
function remoteControllerConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NANOCO_WORKSPACE_CONTROLLER_URL?.trim());
}

/** The controller only has work where the Host places sessions on Kubernetes. */
function podRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.NANOCLAW_RUNTIME_DRIVER === 'pod';
}

/**
 * The Custodian image the controller starts. The separately-deployed controller
 * carried `NANOCO_WORKSPACE_IMAGE` on its own Deployment; the Host does not, but
 * it already holds the same digest as the materializer image — the Custodian and
 * the composer both run the Host runtime. Resolve rather than require, so
 * embedding needs no new key on the Host's environment.
 */
function workspaceImage(env: NodeJS.ProcessEnv): string | undefined {
  return env.NANOCO_WORKSPACE_IMAGE?.trim() || env.NANOCO_MATERIALIZER_IMAGE?.trim() || undefined;
}

let stopEmbedded: (() => void) | null = null;

onHostStart(async () => {
  const env = process.env;
  if (!podRuntime(env)) return;
  if (remoteControllerConfigured(env)) {
    log.info('Workspace controller: using the configured remote controller', {
      url: env.NANOCO_WORKSPACE_CONTROLLER_URL,
    });
    return;
  }
  // A module callback that throws ABORTS host startup — `startHostModules`
  // rethrows and `main()` treats it as fatal. A workspace plane that cannot be
  // constructed must not take the whole Host down with it: the Host still
  // delivers messages, serves ncl and runs every other plane. Log it loudly and
  // leave the HTTP transport in place, where the next ensure fails with a clear
  // configuration error against the one session that needed a workspace.
  try {
    const { controller, stop } = await startEmbeddedWorkspaceController({
      ...env,
      NANOCO_WORKSPACE_IMAGE: workspaceImage(env),
    });
    stopEmbedded = stop;
    useLocalWorkspaceController(controller);
    log.info('Workspace controller: running in-process (no HTTP hop, no companion namespace)');
  } catch (err) {
    log.error('Workspace controller: in-process start failed — the workspace plane stays on its HTTP transport', { err });
  }
});

onHostShutdown(() => {
  // Detach the plane BEFORE stopping the loop: a caller that reaches the plane
  // during shutdown should get the HTTP transport's clear configuration error
  // rather than a controller whose reconcile timer has already been cleared.
  useLocalWorkspaceController(null);
  stopEmbedded?.();
  stopEmbedded = null;
});
