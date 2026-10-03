/**
 * PR Factory module — Slack edition.
 *
 * Listens for GitHub `pull_request.opened` events on the shared webhook
 * server, opens a Slack thread in the configured channel, spins up a
 * per-thread session under the PR Factory Worker agent group, and seeds
 * it with the PR diff + a triage instruction.
 *
 * If a supervisor admin channel is configured (and the second Slack app
 * is set up), also bootstraps the PR Factory Supervisor agent group with
 * wirings to its admin channel and to the worker's PR channel.
 *
 * Inert if `GITHUB_WEBHOOK_SECRET` is unset.
 *
 * Optional sibling components plug into seams owned here and degrade
 * gracefully when absent:
 *   - gh-action-approval   → setGhActionHandler (gh-action.ts)
 *   - vm-test-orchestrator → registerTestOrchestrator (test-orchestration.ts)
 *   - slack-canvas         → registerCanvasProvider (canvas.ts)
 *
 * Env vars (read from .env):
 *   GITHUB_WEBHOOK_SECRET                  — required to enable the module
 *   PR_FACTORY_SLACK_CHANNEL_ID            — bare Slack channel id for PR threads
 *   SLACK_BOT_TOKEN                        — worker bot token (reused from /add-slack)
 *   PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID — optional: enables supervisor wiring
 *   SLACK_SUPERVISOR_BOT_TOKEN             — required when supervisor enabled
 *   SLACK_SUPERVISOR_SIGNING_SECRET        — required when supervisor enabled
 */
import { readEnvFile } from '../../env.js';
import { onShutdown } from '../../response-registry.js';
import { onDeliveryAdapterReady, registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { registerApprovalResolvedHandler } from '../approvals/primitive.js';
import { TESTER_INSTANCE } from '../../channels/slack-tester.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { clearAwaitingApproval } from './reactions.js';
import { registerGitHubWebhook } from './webhook.js';
import { handlePullRequest } from './handler.js';
import { bootstrapPrFactory, TESTER_FOLDER } from './bootstrap.js';
import { getTestOrchestrator } from './test-orchestration.js';
import { dispatchGhAction } from './gh-action.js';
import { initOrchestrator, shutdownOrchestrator, handleTestResults } from './orchestrator.js';
import { handleSendToTesting } from './testing-approval.js';
import { handleProposeSkillEdit } from './skill-edit-approval.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';

const env = readEnvFile([
  'GITHUB_WEBHOOK_SECRET',
  'PR_FACTORY_SLACK_CHANNEL_ID',
  'PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID',
  'SLACK_BOT_TOKEN',
]);

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || env.GITHUB_WEBHOOK_SECRET || '';
const WORKER_CHANNEL_ID = process.env.PR_FACTORY_SLACK_CHANNEL_ID || env.PR_FACTORY_SLACK_CHANNEL_ID || '';
const SUPERVISOR_CHANNEL_ID =
  process.env.PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID || env.PR_FACTORY_SUPERVISOR_SLACK_CHANNEL_ID || '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN || '';

// Clear the 👀 awaiting-approval reaction on a PR thread when an admin
// rejects an approval card. Approve paths clear it inside each approval
// handler; the reject path resolves in core, so we observe it via the
// approvals module's resolved hook. No-op for sessions without a
// pr_threads row. (The event's userId is namespaced `<channel>:<handle>`;
// this consumer ignores it.)
registerApprovalResolvedHandler(async ({ session, outcome }) => {
  if (outcome !== 'reject') return;
  await clearAwaitingApproval(session);
});

if (!GITHUB_WEBHOOK_SECRET) {
  log.debug('PR factory: GITHUB_WEBHOOK_SECRET not set, module disabled');
} else if (!WORKER_CHANNEL_ID) {
  log.warn('PR factory: GITHUB_WEBHOOK_SECRET set but PR_FACTORY_SLACK_CHANNEL_ID missing');
} else if (!SLACK_BOT_TOKEN) {
  log.warn('PR factory: GITHUB_WEBHOOK_SECRET set but SLACK_BOT_TOKEN missing (run /add-slack first)');
} else {
  // Register supervisor MCP action handlers up front — they don't depend on
  // adapter readiness and may need to fire as soon as a session is alive.
  // The container tools omit `repo` when the agent doesn't pass one — the
  // default is applied HERE, host-side, from PR_FACTORY_DEFAULT_REPO (the
  // container never sees that env var). pr_submit_test_results applies the
  // same default inside handleTestResults. pr_gh dispatches through the
  // gh-action seam so the agent gets feedback even when the
  // gh-action-approval component isn't installed.
  registerDeliveryAction('pr_send_to_testing', async (content, session) => {
    await handleSendToTesting(content, session);
  });
  registerDeliveryAction('pr_propose_skill_edit', async (content, session) => {
    await handleProposeSkillEdit(content, session);
  });
  registerDeliveryAction('pr_gh', async (content, session) => {
    await dispatchGhAction(content, session);
  });
  registerDeliveryAction('pr_submit_test_results', async (content, session) => {
    await handleTestResults(content, session);
  });

  // Wait for delivery adapters so the Slack adapter is connected before we
  // try to look up its messaging_groups row in bootstrap.
  onDeliveryAdapterReady(() => {
    log.info('PR factory: onDeliveryAdapterReady callback fired');
    const bootstrap = bootstrapPrFactory({
      workerChannelId: WORKER_CHANNEL_ID,
      supervisorChannelId: SUPERVISOR_CHANNEL_ID || undefined,
    });

    registerGitHubWebhook(GITHUB_WEBHOOK_SECRET, (pr) =>
      handlePullRequest(pr, {
        workerBotToken: SLACK_BOT_TOKEN,
        workerChannelId: WORKER_CHANNEL_ID,
        bootstrap,
      }),
    );

    // Initialize the coordination layer when BOTH the vm-test-orchestrator
    // component is installed (registered its module at import time) AND the
    // operator-created tester agent group + its PR-channel wiring exist.
    const workerPlatformId = `slack:${WORKER_CHANNEL_ID}`;
    const testOrchestrator = getTestOrchestrator();
    const testerAg = getAgentGroupByFolder(TESTER_FOLDER);
    const testerMg = testerAg ? getMessagingGroupByPlatform('slack', workerPlatformId, TESTER_INSTANCE) : undefined;
    if (testOrchestrator && testerAg && testerMg) {
      initOrchestrator(testOrchestrator, testerAg.id, testerMg.id);
      log.info('Test orchestrator initialized', {
        testerAgentGroupId: testerAg.id,
        testerMessagingGroupId: testerMg.id,
      });
    } else {
      log.info('Test orchestrator disabled', {
        componentInstalled: !!testOrchestrator,
        testerAgentGroup: !!testerAg,
        testerMessagingGroup: !!testerMg,
      });
    }

    onShutdown(async () => {
      shutdownOrchestrator();
      await getTestOrchestrator()?.shutdown();
    });

    log.info('PR factory module started', {
      workerChannel: WORKER_CHANNEL_ID,
      supervisorEnabled: !!SUPERVISOR_CHANNEL_ID,
      testOrchestratorEnabled: !!(testOrchestrator && testerAg && testerMg),
    });
  });
}
