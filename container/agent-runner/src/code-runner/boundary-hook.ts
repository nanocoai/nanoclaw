/**
 * Boundary hook — the detached D17 confirm (its OWN settings entry, with the
 * long timeout; the mailbox entries keep their timeout:10 and are never
 * touched by this flow).
 *
 * PreToolUse only. The flow, in the order the postures short-circuit:
 *
 *   no managed policy → silent exit; not a code-mode container (chat mode
 *                      never mounts the admin tier), or a stamp the spawn
 *                      lost — either way there are no managed allow rules to
 *                      override, so the CLI's own defaults hold.
 *   not a boundary   → silent exit; ordinary sandbox work never blocks here.
 *   bypass posture   → permissionDecision allow. D17's
 *                      dangerouslyBypassPermissions is the FULL escape hatch:
 *                      PreToolUse hooks still run under
 *                      --dangerously-skip-permissions (verified at the pinned
 *                      2.1.197), so without this the boundary would quietly
 *                      resurrect for exactly the groups that opted out. The
 *                      posture is read from the host's RO policy stamp, never
 *                      from this process's environment — env rides the
 *                      agent's Bash tool into nested CLI runs, and an
 *                      env-carried 'bypass' was mintable by the agent itself
 *                      (E-t7 review).
 *   attached (live)  → permissionDecision ask: force the CLI's own dialog on
 *                      the PTY where the human is. Not a silent exit — the
 *                      static prefix rules cannot express the substring-
 *                      shaped boundaries this hook classifies, so deferring
 *                      silently would gate the attached path weaker than the
 *                      detached one. "Live" means fresh human evidence
 *                      (agent-state.ts hasLiveAttachEvidence); an exec-shim
 *                      orphan's socket falls through to the approver card.
 *   detached         → verify the decision dir is the host's RO mount (the
 *                      kernel's EROFS is the proof — boundary.ts
 *                      decisionsDirTrusted), stamp busy with a bounded
 *                      busyUntil (the pod must survive the wait), write the
 *                      request file, poll for the host's decision file,
 *                      return permissionDecision allow/deny. Timeout => deny
 *                      (D17); an unverifiable decision dir => deny, because
 *                      polling a forgeable path is self-approval with extra
 *                      steps.
 *
 * Test seams ride argv, not env: the production command in settings.json
 * (settings-hooks.ts BOUNDARY_HOOK_COMMAND) carries no flags, settings.json
 * itself is custody-gated, and env is the one channel a nested invocation
 * inherits from the agent's own Bash line (E-t7 review).
 *
 * Contract mirrors mailbox-hook.ts: payload on stdin, result on stdout,
 * ALWAYS exit 0. And like it, this file EXECUTES on import — anything
 * shareable lives in boundary.js (the canary lesson, agent-state.ts header).
 */
import fs from 'fs';

import {
  AGENT_STATE_PATH,
  ATTACH_STATE_PATH,
  hasLiveAttachEvidence,
  readAttachState,
  writeAgentState,
} from './agent-state.js';
import {
  BOUNDARY_APPROVAL_TTL_MS,
  BOUNDARY_DECISIONS_DIR,
  BOUNDARY_DIR,
  BOUNDARY_POLL_MS,
  classifyBoundary,
  decisionPath,
  decisionsDirTrusted,
  MANAGED_SETTINGS_PATH,
  readPermissionPosture,
  requestPath,
  waitForDecision,
  writeBoundaryRequest,
} from './boundary.js';

function argvFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const managedSettingsPath = argvFlag('managed-settings') || MANAGED_SETTINGS_PATH;
const boundaryDir = argvFlag('boundary-dir') || BOUNDARY_DIR;
const decisionsDir = argvFlag('decisions-dir') || BOUNDARY_DECISIONS_DIR;
const attachStatePath = argvFlag('attach-state') || ATTACH_STATE_PATH;
const statePath = argvFlag('state') || AGENT_STATE_PATH;
const ttlMs = positiveInt(argvFlag('ttl-ms')) ?? BOUNDARY_APPROVAL_TTL_MS;
const pollMs = positiveInt(argvFlag('poll-ms')) ?? BOUNDARY_POLL_MS;
// Tests cannot make an RO mount without root; production never passes this.
const skipDecisionsProbe = process.argv.includes('--skip-decisions-probe');

/** Margin past the poll ceiling so the lease outlives the decision, not vice versa. */
const BUSY_MARGIN_MS = 60_000;

function positiveInt(raw: string | undefined): number | null {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

function emitDecision(decision: 'allow' | 'deny' | 'ask', reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function main(): Promise<void> {
  // Settings survive a flip back to chat mode; the mailbox hook self-heals
  // them on its first firing (it owns the settings file) — this hook only
  // has to stay out of the chat runner's way, and a chat container has no
  // managed policy mounted.
  const posture = readPermissionPosture(managedSettingsPath);
  if (posture === null) process.exit(0);

  let payload: HookPayload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf-8')) as HookPayload;
  } catch {
    process.exit(0); // malformed input: no opinion, never block
  }
  if (payload.hook_event_name !== 'PreToolUse') process.exit(0);

  const reason = classifyBoundary(payload.tool_name ?? '', payload.tool_input ?? {});
  if (!reason) process.exit(0);

  if (posture === 'bypass') {
    emitDecision('allow', `${reason} — bypass posture: the deployment gateway is the approver (D17)`);
    process.exit(0);
  }

  if (hasLiveAttachEvidence(readAttachState(attachStatePath), Date.now())) {
    emitDecision('ask', `${reason} — a client is on the PTY; the human there is the approver (D17)`);
    process.exit(0);
  }

  if (!skipDecisionsProbe && !decisionsDirTrusted(decisionsDir)) {
    emitDecision('deny', `${reason} — decision dir is not the host's RO mount; denied (D17 fails closed)`);
    process.exit(0);
  }

  // The lease must survive the whole wait: the poll below fires no further
  // hooks, exactly the permission-prompt shape the Notification hold covers
  // on the attached path.
  writeAgentState({ state: 'busy', busyUntil: new Date(Date.now() + ttlMs + BUSY_MARGIN_MS).toISOString() }, statePath);

  const id = crypto.randomUUID();
  try {
    writeBoundaryRequest(boundaryDir, {
      id,
      toolName: payload.tool_name ?? '',
      toolInput: payload.tool_input ?? {},
      reason,
      at: new Date().toISOString(),
    });
  } catch {
    // A request the host will never see must not wait for it.
    emitDecision('deny', `${reason} — boundary request could not be written; denied (D17 fails closed)`);
    process.exit(0);
  }

  const decision = await waitForDecision(decisionPath(decisionsDir, id), { ttlMs, pollMs });
  emitDecision(decision.decision, decision.reason ?? `${reason} — ${decision.decision} by approver`);

  // The request half is ours to clear; the decision half sits in the RO
  // mount, so the host's age sweep owns it (modules/approvals/code-boundary.ts).
  fs.rmSync(requestPath(boundaryDir, id), { force: true });
  process.exit(0);
}

main().catch(() => process.exit(0));
