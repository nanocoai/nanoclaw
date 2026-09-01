/**
 * Idle/busy state shared between the mailbox hook script and the delivery
 * loop (sandbox-spec D15; plan T2: "turn-end = idle, tool-use = busy").
 *
 * The hook script (a claude subprocess) writes; the code runner's delivery
 * loop reads. Container-private, like the attach socket — /tmp is not a
 * shared mount. Writes are tmp+rename so a half-written file can never be
 * parsed as state.
 *
 * Readiness works by ABSENCE, per child life: the code runner deletes this
 * file on every claude spawn (respawns included), and the delivery loop
 * refuses to inject while no hook of the CURRENT life has written state —
 * a booting TUI must not be typed at. The loop fails open after
 * READY_FALLBACK_MS in case hooks are broken (a malformed settings.json
 * silently disables every hook) — injection jank beats a dead mailbox.
 */
import fs from 'fs';
import path from 'path';

export const AGENT_STATE_PATH = '/tmp/code-runner/agent-state.json';

/** If no hook has ever fired this long after boot, assume hooks are broken and treat the session as idle. */
export const READY_FALLBACK_MS = 60_000;

/**
 * How long a pending permission prompt holds the liveness lease (D14/D17).
 *
 * Lives here — not in the hook script — because mailbox-hook.ts EXECUTES on
 * import (it is claude's hook subprocess entrypoint); anything that wants the
 * constant without running a hook imports it from the state vocabulary. The
 * CLI fires Notification/'permission_prompt' ONCE per dialog (about 6s after
 * it appears with no operator input — verified against the pinned 2.1.197
 * binary), and no further hook fires while the dialog waits, so the single
 * busyUntil stamp is the whole hold: bounded, never re-armed, never
 * immortality. Past it the pod expires at the lease as before — the prompt
 * was going nowhere anyway, and D17's detached-boundary approvals are the
 * real answer.
 */
export const PERMISSION_PROMPT_HOLD_MS = 30 * 60_000;

export interface AgentState {
  state: 'idle' | 'busy';
  /** ISO timestamp of the last transition. */
  at: string;
  /**
   * ISO deadline of a tool call's DECLARED timeout (PreToolUse). Extends the
   * busy leg of the liveness lease past the staleness cap — no hook fires
   * during a tool call, so this is the only signal that long silence is
   * work. Cleared by the next state write (PostToolUse / Stop).
   */
  busyUntil?: string;
  /** Highest inbound seq the busy-notify hook has already surfaced (dedupe). */
  notifiedSeq?: number;
}

export function readAgentState(filePath: string = AGENT_STATE_PATH): AgentState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AgentState;
    if (raw.state !== 'idle' && raw.state !== 'busy') return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeAgentState(
  update: Partial<AgentState> & { state: AgentState['state'] },
  filePath: string = AGENT_STATE_PATH,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const previous = readAgentState(filePath);
  // Concurrent hook subprocesses race this read-modify-write (parallel tool
  // calls). tmp+rename prevents torn files; the max() keeps the notify
  // high-water mark monotonic so a lost update can at worst duplicate one
  // notification, never resurrect old ones.
  const notifiedSeq = Math.max(previous?.notifiedSeq ?? 0, update.notifiedSeq ?? 0) || undefined;
  const next: AgentState = {
    ...update,
    notifiedSeq,
    at: new Date().toISOString(),
  };
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, filePath);
}

/**
 * What mail is waiting, stamped beside the agent state so the PostToolUse
 * hook can nudge a working agent mid-turn WITHOUT opening the mailbox
 * itself (D15's busy-path notify).
 *
 * The hook fires on every tool call. Reading the mailbox there was two
 * cheap local file reads while the transport was always SQLite; since the
 * upstream mailbox seam it can be an object store, where the same read is a
 * network listing per tool call. So the delivery loop — which already holds
 * a live mailbox and already polls every second — is the sole writer here
 * and hooks only ever read. Same file discipline as the agent state:
 * container-private under /tmp, tmp+rename, and a torn or absent file
 * parses as "nothing waiting" (fail closed: no notify, never a crash).
 *
 * Carries the pending SEQUENCES, not a count, so the hook keeps its
 * high-water dedupe: only sequences above `notifiedSeq` are new.
 */
export const MAIL_NOTICE_PATH = '/tmp/code-runner/mail-notice.json';

export interface MailNotice {
  /** Sequences of due, wake-eligible, unclaimed, non-system inbound mail. */
  seqs: number[];
  /** ISO timestamp of the stamp — at most one poll interval old. */
  at: string;
}

export function readMailNotice(filePath: string = MAIL_NOTICE_PATH): MailNotice | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as MailNotice;
    if (!Array.isArray(raw.seqs) || raw.seqs.some((s) => typeof s !== 'number')) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeMailNotice(notice: { seqs: number[] }, filePath: string = MAIL_NOTICE_PATH): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const next: MailNotice = { seqs: notice.seqs, at: new Date().toISOString() };
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, filePath);
}

/**
 * Attach presence, stamped beside the agent state so HOOK SUBPROCESSES can
 * tell attached from detached (D17): a permission prompt with a client on the
 * PTY is answerable with a keystroke; a detached one needs the approvals
 * path. The code runner (which owns the AttachServer object) writes on every
 * connect/disconnect; hooks only ever read. Same file discipline as the agent
 * state: container-private under /tmp, tmp+rename so a torn file parses as
 * absent — and absent reads as detached, the end that escalates rather than
 * the end that waits forever.
 */
export const ATTACH_STATE_PATH = '/tmp/code-runner/attach-state.json';

/**
 * How stale the stamp itself may be before a hook stops believing it. The
 * code runner re-stamps every liveness tick (30s, index.ts), so a stamp older
 * than this is a dead life's leftover, not a report.
 */
export const ATTACH_STAMP_FRESH_MS = 5 * 60_000;

/**
 * How old the newest human evidence (keystroke or connect) may be before an
 * open attach socket stops counting as "someone is watching the PTY". Same
 * window and same reasoning as the D14 idle lease (liveness.ts): docker/
 * kubectl exec orphans hold the socket forever after the human's ssh dies,
 * so a bare clients>0 would route boundary confirms to a PTY nobody watches
 * (E-t7 review) — only human-shaped evidence counts.
 */
export const ATTACH_EVIDENCE_MS = 30 * 60_000;

export interface AttachState {
  /** AttachServer.clientCount at the time of the stamp. */
  clients: number;
  /** ISO timestamp of the stamp. */
  at: string;
  /** Epoch ms of the last client keystroke (0 if none) — human evidence. */
  lastInputAt?: number;
  /** Epoch ms of the last client connect (0 if none) — human evidence. */
  lastConnectAt?: number;
}

export function readAttachState(filePath: string = ATTACH_STATE_PATH): AttachState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AttachState;
    if (typeof raw.clients !== 'number' || !Number.isFinite(raw.clients)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeAttachState(
  clients: number,
  filePath: string = ATTACH_STATE_PATH,
  evidence: { lastInputAt?: number; lastConnectAt?: number } = {},
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const next: AttachState = { clients, at: new Date().toISOString(), ...evidence };
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, filePath);
}

/**
 * Door-exec activity (liveness v2). The host's door policy
 * (src/cli/attach-resolve.ts — a hand-synced literal, same discipline as the
 * attach-socket and tmux-socket paths) wraps every exec it routes into the
 * pod so it touches this file on the way in; the runner reads the MTIME in
 * its liveness tick and counts it as plain activity. That closes the 08-22
 * reaper: a working day of door-routed execs with no chat traffic holds the
 * lease. Raw `kubectl exec` deliberately stamps nothing — an operator
 * backdoor stays invisible to the lease, stated here rather than accidental.
 * The file is agent-writable like everything under /tmp/code-runner, but a
 * forged stamp only extends the agent's own pod — no new capability over
 * the heartbeat file the workspace already exposes.
 */
export const DOOR_ACTIVITY_PATH = '/tmp/code-runner/door-activity';

/** Epoch ms of the last door-routed exec (mtime; 0 when never stamped). */
export function readDoorActivityAt(filePath: string = DOOR_ACTIVITY_PATH): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * "Attached" as the boundary confirm should mean it: clients on the socket,
 * a stamp the current runner life is still refreshing, and human evidence
 * inside the window. Anything less falls to the detached path — the approver
 * card — which is the end that still reaches a human when the PTY's watcher
 * is a dead ssh session's orphan. Note the stamp is agent-writable (/tmp is
 * shared with the agent's uid), so both verdicts here stay human-gated: a
 * forged "attached" lands on the CLI's own ask dialog, a forged "detached"
 * lands on the approver card.
 */
export function hasLiveAttachEvidence(state: AttachState | null, now: number): boolean {
  if (!state || state.clients <= 0) return false;
  const stampedAt = Date.parse(state.at);
  if (!Number.isFinite(stampedAt) || now - stampedAt > ATTACH_STAMP_FRESH_MS) return false;
  const evidenceAt = Math.max(state.lastInputAt ?? 0, state.lastConnectAt ?? 0);
  return now - evidenceAt <= ATTACH_EVIDENCE_MS;
}
