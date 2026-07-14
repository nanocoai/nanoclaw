import fs from 'fs';
import path from 'path';

import { getAllAgentGroups } from '../../db/agent-groups.js';
import { DATA_DIR } from '../../config.js';
import { isContainerRunning } from '../../container-runner.js';
import { openOutboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';

const TOKEN_WARN_MINUTES = 60;

export interface TokenIssue {
  agentGroupId: string;
  minutesLeft: number;
}

export function checkTokenExpiry(): TokenIssue[] {
  const issues: TokenIssue[] = [];
  for (const group of getAllAgentGroups()) {
    const claudeJsonPath = path.join(DATA_DIR, 'v2-sessions', group.id, 'claude.json');
    if (!fs.existsSync(claudeJsonPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      const expiresAt = data?.claudeAiOauth?.expiresAt;
      if (!expiresAt) continue;
      const minutesLeft = Math.floor((expiresAt - Date.now()) / 60_000);
      if (minutesLeft < TOKEN_WARN_MINUTES) {
        issues.push({ agentGroupId: group.id, minutesLeft });
      }
    } catch {
      // Ignore unreadable files
    }
  }
  return issues;
}

/**
 * Returns true when a session has recent completed processing_acks but produced
 * zero messages_out in the same window — the signature of a silent 401 failure.
 */
export function checkSilentFail(session: Session): boolean {
  // Skip the health-monitor itself, and skip sessions whose container is still alive
  if (session.agent_group_id === 'health-monitor') return false;
  if (isContainerRunning(session.id)) return false;

  try {
    const outDb = openOutboundDb(session.agent_group_id, session.id);
    try {
      const { count: ackCount } = outDb
        .prepare(
          "SELECT COUNT(*) as count FROM processing_ack WHERE status='completed' AND datetime(status_changed) > datetime('now', '-2 hours')",
        )
        .get() as { count: number };

      if (ackCount === 0) return false;

      const { count: outCount } = outDb
        .prepare("SELECT COUNT(*) as count FROM messages_out WHERE datetime(timestamp) > datetime('now', '-2 hours')")
        .get() as { count: number };

      return outCount === 0;
    } finally {
      outDb.close();
    }
  } catch {
    return false;
  }
}
