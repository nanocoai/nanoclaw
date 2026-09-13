/**
 * Stop → interrupt the coding session's current turn.
 *
 * The interrupt path is the session's own: the runner keeps the interactive
 * CLI in a tmux session on a container-private socket
 * (code-runner/tmux-session.ts), and Escape is how a human at that terminal
 * interrupts a turn. The host reaches the same pane the way attach does —
 * the driver's exec dialect (SessionHandle.execSpec) — and presses Escape
 * with `tmux send-keys`. Nothing is archived and nothing else changes: the
 * session stays attached, the workspace stays, and the next human message
 * resumes it (mapper.ts stopped gate).
 *
 * `ncl sandboxes stop` and a Stop from a chat surface both come here. A
 * session that is not running has nothing to interrupt; that is a success —
 * the stop is honoured by the mirror's gate alone.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { findSandboxSessions } from '../../db/sessions.js';
import { getSessionDriver, type SessionExecSpec, type SessionHandle } from '../../drivers/index.js';
import { getInstallSlug } from '../../install-slug.js';
import { TMUX_SESSION_NAME, TMUX_SOCKET_PATH } from '../sandboxes.js';
import type { SurfaceEvent } from './types.js';

const execFileAsync = promisify(execFile);

/** The keystroke the runner's terminal understands as "interrupt this turn". */
export const INTERRUPT_COMMAND: readonly string[] = [
  'tmux',
  '-S',
  TMUX_SOCKET_PATH,
  'send-keys',
  '-t',
  TMUX_SESSION_NAME,
  'Escape',
];

/** A surface-wide stop (a thread-scoped stop is relayed only; the turn runs on). */
export function isStopEvent(event: SurfaceEvent): boolean {
  return event.type === 'stop' && !event.threadId;
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
