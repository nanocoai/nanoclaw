/**
 * Turn stamp — the host-visible half of the idle/busy state.
 *
 * agent-state.ts lives under /tmp (container-private) because the mailbox
 * delivery loop is its only reader. The host mirrors a coding session's
 * progress to a chat surface (src/code-mode/session-channel) and needs the
 * same two facts — is a turn running, and when did the last one end — so the
 * mailbox hook stamps them a second time here, under /workspace, which IS
 * the session dir on the host (the boundary request seam rides the same
 * mount, boundary.ts).
 *
 * Deliberately a separate file from the agent state: the agent state is
 * per child life (deleted on every spawn to re-arm the readiness gate) and
 * carries the notify high-water mark; this stamp is per session, survives a
 * respawn and a reap, and carries nothing the mailbox cares about. The host
 * treats a stamp as informative only while the container is running.
 *
 * `seq` is a monotonic counter so a reader can tell a NEW idle stamp from
 * the one it already acted on when two turns end inside one poll interval.
 * The file is agent-writable like everything under /workspace; a forged
 * stamp can only mislabel the agent's own session status.
 *
 * Same file discipline as the agent state: tmp+rename, and a torn or absent
 * file parses as null.
 */
import fs from 'fs';
import path from 'path';

/** In-container home; host-side this is `<sessDir>/code-turns/state.json`. */
export const TURN_STATE_PATH = '/workspace/code-turns/state.json';

export interface TurnState {
  state: 'idle' | 'busy';
  /** ISO timestamp of the write. */
  at: string;
  /** Monotonic write counter for this session (starts at 1). */
  seq: number;
}

export function readTurnState(filePath: string = TURN_STATE_PATH): TurnState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as TurnState;
    if (raw.state !== 'idle' && raw.state !== 'busy') return null;
    if (typeof raw.seq !== 'number' || !Number.isFinite(raw.seq)) return null;
    if (typeof raw.at !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeTurnState(state: TurnState['state'], filePath: string = TURN_STATE_PATH): TurnState {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const previous = readTurnState(filePath);
  const next: TurnState = { state, at: new Date().toISOString(), seq: (previous?.seq ?? 0) + 1 };
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, filePath);
  return next;
}
