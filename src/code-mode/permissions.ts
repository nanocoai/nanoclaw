/**
 * Code mode, piece D: the host-owned permission posture (sandbox-spec D17, T7).
 *
 * Until now the only knob was the deployment-level NANOCLAW_CODE_PERMISSION_MODE
 * env the runner reads at boot; the CLI's own permission config lived in the RW
 * ~/.claude mount, which the agent can edit. This module makes the posture a
 * host-owned artifact: a managed-settings policy file composed per spawn from
 * the deployment mode + the group's override, stamped into the session dir and
 * nested-RO-mounted at the CLI's admin policy tier — the one settings layer
 * nothing the agent can write ever outranks.
 *
 * Verified against the image's pinned CLI (@anthropic-ai/claude-code 2.1.197,
 * container/cli-tools.json) by string-inspecting the release binary:
 *   - on linux the policy dir resolves to /etc/claude-code (darwin/windows get
 *     their own paths; the container is linux), file `managed-settings.json`;
 *   - the policy `permissions` block accepts allow / deny / ask / defaultMode /
 *     disableBypassPermissionsMode ("disable") / additionalDirectories;
 *   - rule paths: a `//` prefix is an absolute filesystem path (a single `/`
 *     resolves relative to the settings file's own directory);
 *   - Bash rules support `prefix:*` prefix matching;
 *   - precedence is deny > ask > allow, so an ask boundary survives a broad
 *     allow, and PreToolUse hooks still run under --dangerously-skip-permissions.
 * Because the managed tier verified exactly as documented, there is no
 * belt-and-suspenders copy in the cwd project settings — one authority, stated
 * once.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import type { VolumeMount } from '../providers/provider-container-registry.js';

/** Mirrors the container's claude-args vocabulary (auto = the CLI prompts). */

/**
 * The gateway-managed env sentinel (FORK CARRY). A fixed PUBLIC marker — not a
 * secret — that composition places in the agent's contributed env so the CLI
 * boots in API-key mode; the governance gateway recognizes the byte-exact
 * value and swaps the real credential onto the wire on policy Allow. The pod
 * admission policy exempts exactly this value, so it must never drift.
 * Upstream removed it with `legacyRuntimeArgs`; the fork's governed code-mode
 * deployments still speak it, so it lives here now, beside its only setter.
 */
export const GATEWAY_MANAGED_ENV_MARKER = 'nanoco-gateway-managed';

export type CodePermissionMode = 'auto' | 'bypass';

/** Host-side name of the stamped policy file — beside the runner cwd, never
 *  inside it (the compose.ts EACCES rule: `<sessDir>/group` may be root-owned
 *  by a past container; `<sessDir>` is the host's own mkdir). */
export const MANAGED_SETTINGS_FILE = 'code-mode-managed-settings.json';

/** The CLI's admin policy tier on linux (verified at 2.1.197 — see header). */
export const MANAGED_SETTINGS_CONTAINER_PATH = '/etc/claude-code/managed-settings.json';

/**
 * Group override > deployment default > 'auto'. Anything unrecognized on
 * either side reads as unset rather than throwing at spawn — the same
 * safe-end rule as the runner's resolvePermissionMode.
 */
export function resolveCodePermissionMode(
  groupMode: string | null | undefined,
  deploymentMode: string | undefined,
): CodePermissionMode {
  if (groupMode === 'auto' || groupMode === 'bypass') return groupMode;
  return deploymentMode === 'bypass' ? 'bypass' : 'auto';
}

/**
 * The deployment-level mode, read exactly where composeSessionSpec reads its
 * code knobs: host process env first, then the .env file (readEnvFile never
 * loads into process.env — see env.ts).
 */
export function deploymentPermissionMode(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.NANOCLAW_CODE_PERMISSION_MODE?.trim() ||
    readEnvFile(['NANOCLAW_CODE_PERMISSION_MODE']).NANOCLAW_CODE_PERMISSION_MODE?.trim() ||
    undefined
  );
}

/**
 * The permissive inside: the sandbox boundary is the container, so tool use
 * within it should not queue prompts nobody reads. `ask` beats `allow`
 * (deny > ask > allow, verified — header), so the boundary rules below still
 * interrupt.
 */
export const SANDBOX_ALLOW_RULES: readonly string[] = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'];

/**
 * The statically expressible boundaries (D17): actions whose effects outlive
 * or escape the sandbox ask, everything else inside flows.
 *
 * - Dev-env release: `ncl envs release <env-id>` carries no lifetime in its
 *   argv (lifetime lives on the env row — cli/resources/envs.ts), so
 *   "pinned-only asks" is not expressible as a static rule. ALL release asks;
 *   the D17 boundary hook is the seam that can refine per-lifetime later.
 * - Custody-adjacent writes, by their in-container paths (`//` = absolute):
 *   this file's own stamp, the settings.json the mailbox hooks live in, and
 *   the group operating manual's mount point.
 *
 * These rules gate the Edit/Write TOOLS only — a Bash redirect to the same
 * paths matches none of them, and 'Bash' is broadly allowed above. That
 * channel is closed elsewhere, in layers: the stamp's /workspace spelling is
 * itself nested-RO-mounted (managedSettingsMounts below — the E-t7 review
 * demonstrated a plain `echo > /workspace/code-mode-managed-settings.json`
 * rewriting the admin tier through the shared inode), the manual's mount is
 * already RO (compose.ts), and the boundary hook substring-classifies Bash
 * commands that name any custody path (code-runner/boundary.ts
 * CUSTODY_COMMAND_MARKERS — a tripwire for the one custody file that must
 * stay writable in-container, settings.json).
 */
export const BOUNDARY_ASK_RULES: readonly string[] = [
  'Bash(ncl envs release:*)',
  `Edit(//workspace/${MANAGED_SETTINGS_FILE})`,
  `Write(//workspace/${MANAGED_SETTINGS_FILE})`,
  'Edit(//home/node/.claude/settings.json)',
  'Write(//home/node/.claude/settings.json)',
  'Edit(//workspace/group/CLAUDE.md)',
  'Write(//workspace/group/CLAUDE.md)',
];

/**
 * The policy file's content, pure so tests pin both postures byte-for-byte.
 *
 * Bypass is D17's dangerouslyBypassPermissions — the FULL escape hatch, not a
 * softer ask-list: the runner already passes --dangerously-skip-permissions,
 * and the managed file deliberately carries no ask rules that would resurrect
 * prompting for a group whose deployment declared the gateway the approver.
 * Auto keeps the CLI's prompting AND pins it: the agent cannot flip
 * --dangerously-skip-permissions on a nested invocation
 * (disableBypassPermissionsMode), and cannot out-write the boundary ask rules
 * from any tier it can reach.
 */
export function composeManagedSettings(mode: CodePermissionMode): Record<string, unknown> {
  if (mode === 'bypass') {
    return { permissions: { defaultMode: 'bypassPermissions' } };
  }
  return {
    permissions: {
      defaultMode: 'default',
      disableBypassPermissionsMode: 'disable',
      allow: [...SANDBOX_ALLOW_RULES],
      ask: [...BOUNDARY_ASK_RULES],
    },
  };
}

/**
 * Stamp the policy for a code-mode session and return its mounts: host-side in
 * `<sessDir>` (the container.json pattern — 'group-state' pins hostPath +
 * scope only, never containerPath, so the /etc target passes both drivers),
 * mounted read-only at the CLI's admin tier.
 *
 * TWO mounts of the one stamped file, because it has two in-container
 * spellings: the /etc admin tier the CLI reads, and the /workspace path the
 * RW session mount would otherwise expose. Both spellings serve the same
 * inode, so before the second mount an in-place Bash redirect at the
 * /workspace path rewrote the policy the /etc mount exists to pin (E-t7
 * review). The nested RO file mount makes the /workspace spelling
 * kernel-refused, and because the RO bind is its own mount the inode cannot
 * be hardlinked out into the RW side either (link(2) across mounts is EXDEV).
 *
 * Failure costs the file, never the session — and losing it fails SAFE in
 * both postures: an 'auto' session without the policy has no allow rules, so
 * it asks MORE, not less; a 'bypass' session already rides the runner's
 * --dangerously-skip-permissions flag and merely loses a redundant statement.
 */
export function managedSettingsMounts(sessDir: string, scope: string, mode: CodePermissionMode): VolumeMount[] {
  const stamped = path.join(sessDir, MANAGED_SETTINGS_FILE);
  try {
    fs.writeFileSync(stamped, JSON.stringify(composeManagedSettings(mode), null, 2) + '\n');
  } catch (error) {
    log.warn('Code mode: managed permission settings not stamped — the CLI runs without the policy file', {
      sessDir,
      mode,
      error: String(error),
    });
    return [];
  }
  return [
    {
      hostPath: stamped,
      containerPath: MANAGED_SETTINGS_CONTAINER_PATH,
      readonly: true,
      mountClass: 'group-state',
      scope,
    },
    {
      hostPath: stamped,
      containerPath: `/workspace/${MANAGED_SETTINGS_FILE}`,
      readonly: true,
      mountClass: 'group-state',
      scope,
    },
  ];
}

/** Host-side name of the decisions dir; the container half cites it as
 *  BOUNDARY_DECISIONS_DIR (code-runner/boundary.ts). */
export const BOUNDARY_DECISIONS_SUBDIR = 'code-boundary-decisions';

/**
 * The D17 decision channel: host-owned, agent-read-only. Requests may ride
 * the RW workspace (a forged request only over-asks), but a decision the
 * agent can write is a boundary the agent can approve — the E-t7 review's
 * one-Bash-loop self-approval. So the decision dir is a nested RO mount of
 * its own, and the hook refuses to poll a dir the kernel will not vouch for
 * (boundary.ts decisionsDirTrusted). That refusal is also why preparation
 * failure here may return [] like every compose helper: a session without
 * the mount loses the detached confirm to an explicit deny, never to an
 * open channel.
 */
export function boundaryDecisionMounts(sessDir: string, scope: string): VolumeMount[] {
  const dir = path.join(sessDir, BOUNDARY_DECISIONS_SUBDIR);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    log.warn('Code mode: boundary decision dir not prepared — detached boundary confirms will deny', {
      sessDir,
      error: String(error),
    });
    return [];
  }
  return [
    {
      hostPath: dir,
      containerPath: `/workspace/${BOUNDARY_DECISIONS_SUBDIR}`,
      readonly: true,
      mountClass: 'group-state',
      scope,
    },
  ];
}
