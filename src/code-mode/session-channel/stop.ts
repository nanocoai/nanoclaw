/**
 * Stop from the chat surface → interrupt the coding session's current turn.
 *
 * The interrupt path is the session's own: the runner keeps the interactive
 * CLI in a tmux session on a container-private socket
 * (code-runner/tmux-session.ts), and Escape is how a human at that terminal
 * interrupts a turn. The host reaches the same pane the way attach does —
 * the driver's exec dialect (SessionHandle.execSpec, cli/attach-resolve.ts) —
 * and presses Escape with `tmux send-keys`. Nothing is archived and nothing
 * else changes: the session stays attached, the workspace stays, and the
 * next human message resumes it (mapper.ts stopped gate).
 *
 * The socket and session literals are the runner's (hand-synced, exactly as
 * attach-resolve.ts pins them). A stopped session that is not running has
 * nothing to interrupt; that is a success — the Stop is honoured by the
 * mirror's gate alone.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { findSandboxSessions } from '../../db/sessions.js';
import { getSessionDriver, type SessionExecSpec, type SessionHandle } from '../../drivers/index.js';
import { getInstallSlug } from '../../install-slug.js';
import { STOPPED_EVENT, type ChannelEvent } from './client.js';

const execFileAsync = promisify(execFile);

/** The keystroke the runner's terminal understands as "interrupt this turn". */
export const INTERRUPT_COMMAND: readonly string[] = [
  'tmux',
  '-S',
  '/tmp/code-runner/tmux.sock',
  'send-keys',
  '-t',
  'agent',
  'Escape',
];

/** A channel-wide stop (a thread stop is relayed only; the turn runs on). */
export function isStopEvent(event: Pick<ChannelEvent, 'type' | 'threadTs'>): boolean {
  return event.type === STOPPED_EVENT && !event.threadTs;
}

export interface InterruptDeps {
  /** The live runtime handle for the group's coding session, if any. */
  findLiveHandle?: (agentGroupId: string) => Promise<SessionHandle | undefined>;
  /** Run the driver-composed exec (the plain, non-tty argv). */
  run?: (spec: SessionExecSpec) => Promise<void>;
}

/** Discovery through the driver, like attach: the listing's phase is the truth. */
export async function findLiveSandboxHandle(agentGroupId: string): Promise<SessionHandle | undefined> {
  const sessions = await findSandboxSessions(agentGroupId);
  if (sessions.length === 0) return undefined;
  const wanted = new Set(sessions.map((s) => s.id));
  for (const snapshot of await getSessionDriver().listSessions(getInstallSlug())) {
    if (snapshot.phase === 'running' && wanted.has(snapshot.handle.key.sessionId)) return snapshot.handle;
  }
  return undefined;
}

async function runExec(spec: SessionExecSpec): Promise<void> {
  await execFileAsync(spec.bin, spec.argsPlain, { timeout: 15_000 });
}

/**
 * Press Escape in the group's coding session. Resolves true when a live
 * session received the keystroke, false when there was no live session to
 * interrupt. Throws when the exec itself failed.
 */
export async function interruptCodingSession(agentGroupId: string, deps: InterruptDeps = {}): Promise<boolean> {
  const handle = await (deps.findLiveHandle ?? findLiveSandboxHandle)(agentGroupId);
  if (!handle) return false;
  await (deps.run ?? runExec)(handle.execSpec([...INTERRUPT_COMMAND]));
  return true;
}
