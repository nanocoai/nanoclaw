import type { WatchdogIssue } from './watchdog.js';

const SERVICE_NAME = '__NANOCLAW_SERVICE_NAME__';

export function buildPrompt(issue: WatchdogIssue, agentGroupName: string, repo: string): string {
  const sessionBlock = issue.sessionId
    ? `Session info:
  agentGroupId : ${issue.agentGroupId}
  agentGroupName: ${agentGroupName}
  sessionId    : ${issue.sessionId}
  dbPath       : ${issue.dbPath}`.trim()
    : `agentGroupName: ${agentGroupName} (global issue — no specific session)`;

  return `
You are remediating a NanoClaw watchdog alert. Work from the repo at: ${repo}

${sessionBlock}

Issue type  : ${issue.type}
Issue detail: ${issue.detail}

---
REMEDIATION STEPS
---

${buildFixInstructions(issue, agentGroupName, repo)}

${buildNotifyInstructions(issue, agentGroupName, repo)}

Log what you did at each step to stdout.
`.trim();
}

function buildFixInstructions(issue: WatchdogIssue, agentGroupName: string, repo: string): string {
  switch (issue.type) {
    case 'dead-recurring':   return buildDeadRecurringFix(issue, repo);
    case 'stuck-processing': return buildStuckProcessingFix(issue, repo);
    case 'service-down':     return buildServiceDownFix(agentGroupName, repo);
    default: {
      const _exhaustive: never = issue.type;
      return `Unknown issue type: ${_exhaustive}`;
    }
  }
}

function buildDeadRecurringFix(issue: WatchdogIssue, repo: string): string {
  return `
STEP 1 — Find the failed recurring row:
  pnpm exec tsx scripts/q.ts "${issue.dbPath}" "SELECT id, recurrence, tries, platform_id, channel_type, thread_id FROM messages_in WHERE status='failed' AND recurrence IS NOT NULL"

STEP 2 — Reset it to pending so NanoClaw will pick it up again:
  pnpm exec tsx scripts/q.ts "${issue.dbPath}" "UPDATE messages_in SET status='pending', tries=0 WHERE status='failed' AND recurrence IS NOT NULL"

STEP 3 — Confirm the reset (should show status=pending, tries=0):
  pnpm exec tsx scripts/q.ts "${issue.dbPath}" "SELECT id, status, tries, recurrence FROM messages_in WHERE recurrence IS NOT NULL ORDER BY timestamp DESC LIMIT 5"
`.trim();
}

function buildStuckProcessingFix(issue: WatchdogIssue, repo: string): string {
  return `
STEP 1 — Find the stuck processing row:
  pnpm exec tsx scripts/q.ts "${issue.dbPath}" "SELECT id, timestamp FROM messages_in WHERE status='processing' AND datetime(timestamp) < datetime('now','-45 minutes')"

STEP 2 — Reset it to pending:
  pnpm exec tsx scripts/q.ts "${issue.dbPath}" "UPDATE messages_in SET status='pending', tries=0 WHERE status='processing' AND datetime(timestamp) < datetime('now','-45 minutes')"

STEP 3 — Find and stop the stuck container (NanoClaw will respawn automatically):
  docker ps --filter label=nanoclaw.session=${issue.sessionId}
  (If listed, stop it: docker stop <container_id>)

STEP 4 — Confirm no more stuck rows:
  pnpm exec tsx scripts/q.ts "${issue.dbPath}" "SELECT id, status, tries FROM messages_in WHERE status='processing'"
`.trim();
}

function buildServiceDownFix(agentGroupName: string, repo: string): string {
  return `
STEP 1 — Restart the NanoClaw service:
  systemctl --user restart ${SERVICE_NAME}

STEP 2 — Confirm it came back up:
  sleep 5 && systemctl --user is-active ${SERVICE_NAME}

STEP 3 — Find most recently active session for agent group "${agentGroupName}":
  find ${repo}/data/v2-sessions -name '.heartbeat' -printf '%T@ %p\\n' | sort -n | tail -5
  Use that session's inbound.db for the notification inject below.
`.trim();
}

function buildNotifyInstructions(issue: WatchdogIssue, agentGroupName: string, repo: string): string {
  const dbPathRef = issue.type === 'service-down'
    ? '<inbound.db path found in STEP 3 above>'
    : issue.dbPath;

  const issueSummary = describeIssue(issue, agentGroupName);

  return `
NOTIFICATION INJECT — after fix steps, insert a pending task so the agent notifies the user:

  A) Find routing coordinates:
     pnpm exec tsx scripts/q.ts "${dbPathRef}" "SELECT platform_id, channel_type, thread_id FROM messages_in WHERE status IN ('completed','pending') AND platform_id IS NOT NULL ORDER BY timestamp DESC LIMIT 1"

  B) Compute next even seq:
     pnpm exec tsx scripts/q.ts "${dbPathRef}" "SELECT COALESCE(MAX(seq),0) FROM messages_in"
     Add 2 if even, or round up to next even number.

  C) Insert notification task (substitute real values):
     pnpm exec tsx scripts/q.ts "${dbPathRef}" "INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence, series_id, trigger) VALUES ('watchdog-notify-$(date +%s%3N)', <next_even_seq>, 'task', datetime('now'), 'pending', '<platform_id>', '<channel_type>', '<thread_id>', '{\"text\":\"Watchdog detected and fixed an issue: ${issueSummary}. Please notify the user with a brief summary.\"}', NULL, NULL, 'watchdog-notify-$(date +%s%3N)', 1)"

  D) Log what was done.
`.trim();
}

function describeIssue(issue: WatchdogIssue, agentGroupName: string): string {
  switch (issue.type) {
    case 'dead-recurring':
      return `dead-recurring in agent ${agentGroupName} (${issue.detail})`;
    case 'stuck-processing':
      return `stuck-processing in agent ${agentGroupName} session ${issue.sessionId} (${issue.detail})`;
    case 'service-down':
      return `service-down — ${SERVICE_NAME} was not active`;
    default:
      return `${issue.type} — ${issue.detail}`;
  }
}
