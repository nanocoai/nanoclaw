/**
 * Mailbox hook — the claude-code command hook for code-mode sessions
 * (sandbox-spec D15; plan T2: "turn-end = idle, tool-use = busy").
 *
 * One script, four events (settings.json routes them all here):
 *   SessionStart      → ready + idle (the TUI is up; injection may begin)
 *   UserPromptSubmit  → busy (a turn started)
 *   PreToolUse        → busy (belt — mid-turn confirmation)
 *   Stop              → idle (turn over; the delivery loop injects within a tick)
 *   PostToolUse       → busy-path notify: if NEW inbound mail is pending,
 *                       return additionalContext so the working agent learns
 *                       mid-turn ("a hook riding on a tool response", D15).
 *                       Deduped via a seq high-water mark in the state file.
 *   Notification      → permission-prompt hold: a waiting dialog fires no
 *                       other hook, so stamp busy with a bounded busyUntil
 *                       or the pod expires mid-prompt (D14 gap, D17).
 *
 * Contract (mirrors memory/hook.ts): payload on stdin, result on stdout,
 * ALWAYS exit 0 — a broken hook must never block the agent's real work.
 */
import fs from 'fs';

import {
  AGENT_STATE_PATH,
  MAIL_NOTICE_PATH,
  PERMISSION_PROMPT_HOLD_MS,
  readAgentState,
  readMailNotice,
  writeAgentState,
} from './agent-state.js';
import { removeMailboxHooks } from './settings-hooks.js';

// Env overrides are a test seam — production always runs at the real paths.
const CONTAINER_JSON_PATH = process.env.NANOCLAW_CONTAINER_JSON || '/workspace/agent/container.json';
const MAIL_NOTICE = process.env.NANOCLAW_MAIL_NOTICE || MAIL_NOTICE_PATH;

/**
 * The hook entries live in per-group settings.json, which SURVIVES a flip
 * back to chat mode — and the chat runner executes settings hooks too. So
 * the hook self-gates: in a non-code-mode container it deregisters itself
 * (settings self-heal; chat runner stays untouched per D22) and exits.
 */
function inCodeMode(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONTAINER_JSON_PATH, 'utf8')) as { codeMode?: boolean };
    return config.codeMode === true;
  } catch {
    return false;
  }
}

interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { timeout?: unknown };
  /** Notification events only (payload verified at CLI 2.1.197): which
   *  notification fired — 'permission_prompt' is the one that owns a hold. */
  notification_type?: string;
}

/** Ceiling on a declared tool window — a bogus timeout must not mint immortality. */
const MAX_DECLARED_TOOL_MS = 4 * 3600_000;

/**
 * Pending mail the agent has not been shown, above the notify high-water
 * mark — read from the delivery loop's stamp (agent-state.ts
 * writeMailNotice), never from the mailbox itself.
 *
 * The hook holds NO transport knowledge. It fires on every tool call, and
 * since the upstream mailbox seam the transport may be an object store,
 * where opening a mailbox per tool call is a network listing; the delivery
 * loop is already the one process with a live mailbox and already polls
 * every second, so it publishes and this reads. A missing, torn or empty
 * stamp reads as nothing waiting — fail closed: no notify, no crash, and
 * the loop still injects at turn end.
 */
function newPendingMail(sinceSeq: number): { count: number; maxSeq: number } {
  const notice = readMailNotice(MAIL_NOTICE);
  const fresh = (notice?.seqs ?? []).filter((seq) => seq > sinceSeq);
  return { count: fresh.length, maxSeq: fresh.reduce((max, seq) => Math.max(max, seq), sinceSeq) };
}

function main(): void {
  if (!inCodeMode()) {
    try {
      removeMailboxHooks();
    } catch {
      // self-healing is best-effort; never block the (chat) agent
    }
    process.exit(0);
  }

  let payload: HookPayload = {};
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf-8')) as HookPayload;
  } catch {
    process.exit(0); // malformed input: do nothing, never block
  }

  const statePath = process.argv[2] || AGENT_STATE_PATH;

  switch (payload.hook_event_name) {
    case 'SessionStart':
    case 'Stop':
      writeAgentState({ state: 'idle' }, statePath);
      break;
    case 'UserPromptSubmit':
      writeAgentState({ state: 'busy' }, statePath);
      break;
    case 'PreToolUse': {
      // A declared Bash timeout extends the busy lease through the call —
      // no hook fires DURING a tool, so 45 silent minutes of test suite
      // would otherwise expire the lease mid-run (mirrors host-sweep's
      // kill-ceiling extension on the chat side).
      const timeout = payload.tool_name === 'Bash' ? payload.tool_input?.timeout : undefined;
      const busyUntil =
        typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
          ? new Date(Date.now() + Math.min(timeout, MAX_DECLARED_TOOL_MS)).toISOString()
          : undefined;
      writeAgentState({ state: 'busy', busyUntil }, statePath);
      break;
    }
    case 'Notification': {
      // Only the permission dialog owns a hold. 'idle_prompt' (claude waiting
      // for input at its main prompt) is exactly the reapable idle state and
      // must not extend the lease; unknown types stay no-ops for the same
      // reason a malformed payload does.
      if (payload.notification_type === 'permission_prompt') {
        writeAgentState(
          { state: 'busy', busyUntil: new Date(Date.now() + PERMISSION_PROMPT_HOLD_MS).toISOString() },
          statePath,
        );
      }
      break;
    }
    case 'PostToolUse': {
      const seen = readAgentState(statePath)?.notifiedSeq ?? 0;
      const mail = newPendingMail(seen);
      if (mail.count > 0) {
        writeAgentState({ state: 'busy', notifiedSeq: mail.maxSeq }, statePath);
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PostToolUse',
              additionalContext: `[nanoclaw] ${mail.count} new message(s) arrived while you work. They will be injected when you finish, or read them now: ncl inbox read`,
            },
          }),
        );
      }
      break;
    }
    default:
      break; // unknown event: no-op
  }
  process.exit(0);
}

main();
