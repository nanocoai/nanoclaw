/**
 * Attach resolution — the shared host-side path from an agent group to the
 * exec spec the ncl client runs. `groups attach` and `sandboxes attach |
 * new` resolve through the exact same policy (code-mode/sandboxes.ts owns
 * it); error texts are pinned by groups-attach.test.ts and must not drift.
 *
 * Attachment always execs the image's tmux client against the runner's
 * private socket. Detach is Ctrl-b then d; exit codes are tmux's.
 */
import { attachSandbox, type AttachTarget } from '../code-mode/sandboxes.js';
import type { SessionExecSpec } from '../drivers/index.js';
import type { AgentGroup } from '../types.js';

export { ATTACH_WAKE_WAIT_MS, type AttachTarget } from '../code-mode/sandboxes.js';

/** What the ncl client needs to hand its terminal over (cli/attach-exec.ts). */
export interface AttachResolution {
  attachExec: SessionExecSpec;
  group: string;
  containerName: string;
}

/** The argv for an attach target: the driver's handle composes it — only the driver knows its exec dialect. */
export function attachResolution(target: AttachTarget): AttachResolution {
  return {
    attachExec: target.handle.execSpec(target.command),
    group: target.group,
    containerName: target.containerName,
  };
}

/**
 * Resolve an attach for `group` and return the exec spec the driver's
 * handle composed. The client (which owns the terminal) execs this; policy —
 * which container, which entry — is decided host-side.
 */
export async function resolveAttachForGroup(
  group: AgentGroup,
  opts?: { wakeWaitMs?: number },
): Promise<AttachResolution> {
  return attachResolution(await attachSandbox(group, opts));
}
