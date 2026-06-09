/**
 * Health monitor module.
 *
 * Runs every 5 minutes and checks for "can't run" level issues:
 *   1. OAuth token near-expiry (belt-and-suspenders on top of pre-spawn refresh)
 *   2. Silent-fail pattern: session completed processing but produced no output
 *      — the signature of a 401 auth failure swallowed by the agent-runner
 *
 * On detection, posts a direct Discord alert to the keepalive channel and
 * injects a diagnostic task into the health-monitor agent so Claude can
 * investigate and report.
 *
 * Alert deduplication: each unique issue key is suppressed for 1 hour after
 * the first alert so the channel isn't spammed on repeated sweeps.
 */
import { getActiveSessions } from '../../db/sessions.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { ensureHealthMonitorSetup } from './setup.js';
import { checkTokenExpiry, checkSilentFail } from './checks.js';
import { postAlert, injectTask } from './alert.js';
import { tryRefreshOauthToken } from './token-refresh.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1_000;

const alertedAt = new Map<string, number>();

function shouldAlert(key: string): boolean {
  const last = alertedAt.get(key) ?? 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
  alertedAt.set(key, Date.now());
  return true;
}

async function runChecks(): Promise<void> {
  // Check 1: OAuth token near-expiry — attempt auto-refresh first, only alert if it fails
  for (const { agentGroupId, minutesLeft } of checkTokenExpiry()) {
    const key = `token:${agentGroupId}`;
    if (!shouldAlert(key)) continue;

    log.warn('[health-monitor] Token near-expiry, attempting auto-refresh', { agentGroupId, minutesLeft });
    const result = await tryRefreshOauthToken(agentGroupId);

    const timeDesc =
      minutesLeft < 0 ? `already expired ${Math.abs(minutesLeft)} min ago` : `expires in ${minutesLeft} min`;

    if (result === 'refreshed') {
      await postAlert(
        `✅ **OAuth token auto-refreshed** — agent group \`${agentGroupId}\` (${timeDesc}). ` +
          `New token written to claude.json and Keychain. No action needed.`,
      );
    } else {
      // Cause is known: refresh_token expired or missing. No point asking the agent
      // to investigate — just tell the user what to do.
      const reason =
        result === 'no-token'
          ? 'no refresh token found in claude.json'
          : 'refresh token rejected by Anthropic (likely expired)';
      log.warn('[health-monitor] Token auto-refresh failed', { agentGroupId, result });
      await postAlert(
        `⚠️ **OAuth token expiring** — agent group \`${agentGroupId}\` ${timeDesc}. ` +
          `Auto-refresh failed (${reason}). Run \`claude login\` on the host to re-authenticate.`,
      );
    }
  }

  // Check 2: Silent-fail pattern per active session
  for (const session of getActiveSessions()) {
    if (!checkSilentFail(session)) continue;
    const agentGroup = getAgentGroup(session.agent_group_id);
    const groupName = agentGroup?.name ?? session.agent_group_id;
    const key = `silent-fail:${session.id}`;
    if (!shouldAlert(key)) continue;
    const msg =
      `🚨 **Silent task failure** — \`${groupName}\` (session \`${session.id.slice(-8)}\`) ` +
      `completed processing in the last 2h but produced no output. ` +
      `Likely cause: 401 auth error swallowed by agent-runner.`;
    log.warn('[health-monitor] Silent fail detected', { sessionId: session.id, agentGroupId: session.agent_group_id });
    await postAlert(msg);
    await injectTask(
      `Investigate silent task failure in agent "${groupName}" (session ID: ${session.id}). ` +
        `The session shows completed processing_ack entries but zero messages_out in the last 2 hours. ` +
        `Typical cause: OAuth 401 error — the container started, got auth failure, reported "completed" with no output. ` +
        `Steps to diagnose:\n` +
        `1. Check the most recent container logs: docker logs $(docker ps -a --filter "name=nanoclaw-v2-${agentGroup?.folder ?? session.agent_group_id}" --format "{{.Names}}" | head -1) 2>&1 | tail -30\n` +
        `2. Check token status: python3 -c "import json,datetime,os; d=json.load(open('data/v2-sessions/${session.agent_group_id}/claude.json')); o=d.get('claudeAiOauth',{}); ts=o.get('expiresAt',0)/1000; print('expires:', datetime.datetime.utcfromtimestamp(ts), 'UTC', '— EXPIRED' if datetime.datetime.utcnow() > datetime.datetime.utcfromtimestamp(ts) else '— VALID')"\n` +
        `3. Report findings and recommended action to this channel.`,
    );
  }
}

let timer: NodeJS.Timeout | null = null;

function schedule(): void {
  timer = setTimeout(async () => {
    try {
      await runChecks();
    } catch (err) {
      log.error('[health-monitor] Check error', { err });
    }
    schedule();
  }, CHECK_INTERVAL_MS);
}

/**
 * Called from src/index.ts after initDb() — must NOT be called at module
 * import time since the central DB isn't open yet.
 */
export function startHealthMonitor(): void {
  ensureHealthMonitorSetup();
  schedule();
  log.info('[health-monitor] Started (interval: 5 min)');
}
