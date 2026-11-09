/**
 * LivenessSource — the single seam for "when did this session's agent last
 * show activity". One seam, never a second mechanism: every consumer (stuck
 * detection, typing freshness) reads activity through it, so an alternative
 * source (e.g. driver-reported events) can replace the file stat without
 * touching consumers.
 *
 * The default implementation is today's heartbeat-file stat, verbatim.
 * The source reports observations only. Fallbacks for "nothing observed yet"
 * (e.g. container start time) belong to the consumer — `decideStuckAction`
 * keeps its zero-sentinel semantics.
 */
import fs from 'fs';

import { heartbeatPath } from './session-manager.js';

export interface LivenessSource {
  /**
   * Epoch ms of the last observed agent activity for this session, or null
   * when nothing has been observed (no heartbeat yet).
   */
  lastActivityMs(session: { id: string; agent_group_id: string }): Promise<number | null>;
}

/** Today's behavior, extracted: heartbeat-file mtime, null when absent. */
export function createHeartbeatFileLivenessSource(
  pathFor: (agentGroupId: string, sessionId: string) => string = heartbeatPath,
): LivenessSource {
  return {
    async lastActivityMs(session) {
      try {
        return fs.statSync(pathFor(session.agent_group_id, session.id)).mtimeMs;
      } catch {
        return null;
      }
    },
  };
}
