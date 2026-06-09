import path from 'path';

import { DATA_DIR } from '../../config.js';
import { refreshOauthTokenIfNeeded } from '../../oauth-token-refresh.js';

export async function tryRefreshOauthToken(agentGroupId: string): Promise<'refreshed' | 'failed' | 'no-token'> {
  const claudeJsonPath = path.join(DATA_DIR, 'v2-sessions', agentGroupId, 'claude.json');
  const result = await refreshOauthTokenIfNeeded(claudeJsonPath, `[health-monitor:${agentGroupId}]`);
  // Map 'not-needed' to 'refreshed' — from the caller's perspective, if token is healthy, nothing to do
  return result === 'not-needed' ? 'refreshed' : result;
}
