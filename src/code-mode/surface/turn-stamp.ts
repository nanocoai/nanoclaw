/**
 * Host-side reader of the runner's turn stamp.
 *
 * The runner writes `<sessDir>/code-turns/state.json` from the mailbox hook
 * (container/agent-runner/src/code-runner/turn-stamp.ts — the two files
 * cannot share code across the host/container wall, so each cites the
 * other; keep the path and the shape in lockstep). A torn, absent or
 * unrecognized file reads as null, which the mapper treats as "idle".
 */
import fs from 'node:fs';

import type { TurnStamp } from './mapper.js';

/** Where the stamp lands inside a session dir (the container's /workspace/code-turns/state.json). */
export const TURN_STAMP_SUBDIR = 'code-turns/state.json';

export function readTurnStamp(filePath: string): TurnStamp | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const stamp = raw as Partial<TurnStamp>;
  if (stamp.state !== 'idle' && stamp.state !== 'busy') return null;
  if (typeof stamp.seq !== 'number' || !Number.isFinite(stamp.seq)) return null;
  if (typeof stamp.at !== 'string') return null;
  return { state: stamp.state, at: stamp.at, seq: stamp.seq };
}
