import fs from 'fs';
import path from 'path';

import { getAllAgentGroups } from '../../db/agent-groups.js';
import { upsertTokenStatus } from '../../db/token-status.js';
import { DATA_DIR } from '../../config.js';
import { refreshOauthTokenIfNeeded } from '../../oauth-token-refresh.js';

export interface TokenSweepResult {
  agentGroupId: string;
  status: 'ok' | 'refreshed' | 'failed' | 'no-token';
  minutesLeft: number | null;
}

function readMinutesLeft(claudeJsonPath: string): { minutesLeft: number | null; expiresAt: number | null } {
  try {
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    const expiresAt = data?.claudeAiOauth?.expiresAt as number | undefined;
    if (!expiresAt) return { minutesLeft: null, expiresAt: null };
    return { minutesLeft: Math.floor((expiresAt - Date.now()) / 60_000), expiresAt };
  } catch {
    return { minutesLeft: null, expiresAt: null };
  }
}

/**
 * Checks OAuth tokens for all agent groups. Groups with tokens expiring
 * within the threshold are refreshed automatically. Results are written
 * to the token_status table and returned for alerting.
 *
 * Skips the health-monitor group itself (no claude.json).
 */
export async function sweepAllTokens(): Promise<TokenSweepResult[]> {
  const results: TokenSweepResult[] = [];

  for (const group of getAllAgentGroups()) {
    if (group.id === 'health-monitor') continue;

    const claudeJsonPath = path.join(DATA_DIR, 'v2-sessions', group.id, 'claude.json');

    const raw = await refreshOauthTokenIfNeeded(claudeJsonPath, `[token-sweep:${group.id}]`);
    const status: TokenSweepResult['status'] = raw === 'not-needed' ? 'ok' : raw;

    const { minutesLeft, expiresAt } = readMinutesLeft(claudeJsonPath);

    upsertTokenStatus({
      agentGroupId: group.id,
      checkedAt: Date.now(),
      expiresAt,
      minutesLeft,
      status,
    });

    results.push({ agentGroupId: group.id, status, minutesLeft });
  }

  return results;
}
