/**
 * PR Factory testing approval — staged gate between review and orchestrator.
 *
 * Flow:
 *   1. Worker agent writes test plan as .md.pending to /workspace/agent/test-plans/
 *   2. Worker calls `send_to_testing` MCP tool → system action lands here
 *   3. Host reads the .pending file, posts it in the PR thread, adds approval card
 *   4. Human clicks Accept → host submits plan to the registered test orchestrator
 *   5. Human clicks Reject → plan deleted, agent notified
 *
 * The VM control plane is the vm-test-orchestrator component — reached only
 * through the test-orchestration seam, so this flow degrades to an
 * informative notify when no orchestrator is installed.
 */
import fs from 'fs';
import path from 'path';

import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { GROUPS_DIR } from '../../config.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getPrThreadBySession } from '../../db/pr-threads.js';
import { createPendingApproval, updatePendingApprovalPlatformMessageId } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { prLog } from './activity-log.js';
import { dismissStaleApprovals } from './dismiss-approvals.js';
import { registerApprovalHandler, notifyAgent } from '../approvals/primitive.js';
import type { ApprovalHandlerContext } from '../approvals/primitive.js';
import type { Session } from '../../types.js';

import { WORKER_FOLDER } from './bootstrap.js';
import { createCanvas } from './canvas.js';
import { DEFAULT_REPO } from './defaults.js';
import { markAwaitingApproval, clearAwaitingApproval } from './reactions.js';
import { getTestOrchestrator } from './test-orchestration.js';

const TEST_PLAN_DIR = path.resolve(GROUPS_DIR, WORKER_FOLDER, 'test-plans');

function testingOptions(summaryLine: string): RawOption[] {
  const ctx = summaryLine || 'test plan';
  return [
    { label: 'Send to Testing', selectedLabel: `✅ Sent — ${ctx}`, value: 'approve' },
    { label: 'Reject', selectedLabel: `❌ Rejected — ${ctx}`, value: 'reject' },
  ];
}

function retryOptions(summaryLine: string): RawOption[] {
  const ctx = summaryLine || 'test plan';
  return [
    { label: 'Retry Test', selectedLabel: `✅ Retrying — ${ctx}`, value: 'approve' },
    { label: 'Dismiss', selectedLabel: `❌ Dismissed`, value: 'reject' },
  ];
}

function extractSummaryLine(planContent: string): string {
  const depthMatch = planContent.match(/\*\*Depth:\*\*\s*(.+)/);
  const depth = depthMatch ? depthMatch[1].trim() : '';
  const tableRows = (planContent.match(/^\|\s*\d+\s*\|/gm) || []).length;
  return [tableRows ? `${tableRows} tests` : '', depth ? `Depth: ${depth}` : ''].filter(Boolean).join(', ');
}

function findPlanFile(sessionId: string): { filePath: string; fileName: string; content: string } | null {
  const pr = getPrThreadBySession(sessionId);
  if (!pr) return null;

  let files: string[];
  try {
    files = fs.readdirSync(TEST_PLAN_DIR).filter((f) => f.startsWith('pr-') && f.endsWith('.md.pending'));
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missing test-plans dir means "no plan yet"; the caller notifies the agent
  } catch {
    return null;
  }

  const prPrefix = `pr-${pr.pr_number}-thread-`;
  const match = files.find((f) => f.startsWith(prPrefix));
  if (!match) return null;

  const filePath = path.join(TEST_PLAN_DIR, match);
  try {
    return { filePath, fileName: match, content: fs.readFileSync(filePath, 'utf8') };
    // eslint-disable-next-line no-catch-all/no-catch-all -- a vanished plan file means "no plan yet"; the caller notifies the agent
  } catch {
    return null;
  }
}

export async function handleSendToTesting(_content: Record<string, unknown>, session: Session): Promise<void> {
  const plan = findPlanFile(session.id);
  if (!plan) {
    log.warn('pr_send_to_testing: no plan file found', { sessionId: session.id });
    notifyAgent(
      session,
      'No test plan file found. Write the plan to /workspace/agent/test-plans/ as .md.pending first.',
    );
    return;
  }

  const pr = getPrThreadBySession(session.id);
  if (!pr) {
    log.warn('pr_send_to_testing: no pr_threads entry', { sessionId: session.id });
    return;
  }

  const mg = getMessagingGroup(session.messaging_group_id!);
  if (!mg) {
    log.warn('pr_send_to_testing: messaging group not found', { sessionId: session.id });
    return;
  }

  const threadId = session.thread_id;
  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('pr_send_to_testing: no delivery adapter');
    return;
  }

  const summaryLine = extractSummaryLine(plan.content);

  // Render the plan as a canvas when the slack-canvas component is installed.
  const bareChannel = mg.platform_id.replace(/^slack:/, '');
  const canvas = await createCanvas(`Test Plan — PR #${pr.pr_number}`, plan.content, bareChannel);

  let summary: string;
  let planFiles: { filename: string; data: Buffer }[] | undefined;

  if (canvas) {
    summary =
      `\n━━━  🧪 Test Plan  ━━━━━━━━━━━━━━━━\n` +
      (summaryLine ? `\n${summaryLine}` : '') +
      `\n\n[View test plan](${canvas.permalink})`;
  } else {
    // No canvas — upload the plan as an .md file instead
    summary = `\n━━━  🧪 Test Plan  ━━━━━━━━━━━━━━━━\n` + (summaryLine ? `\n${summaryLine}` : '');
    planFiles = [{ filename: `test-plan-pr-${pr.pr_number}.md`, data: Buffer.from(plan.content) }];
  }

  // Post plan (canvas link or file) first, then the approval card
  await adapter.deliver(
    mg.channel_type,
    mg.platform_id,
    threadId,
    'chat',
    JSON.stringify({ text: summary }),
    planFiles,
    mg.instance,
  );

  // Dismiss any existing approval cards in this thread before posting a new one
  await dismissStaleApprovals(session);

  // Post approval card after file is delivered
  const approvalId = `appr-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const options = testingOptions(summaryLine);
  const normalizedOptions = normalizeOptions(options);

  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action: 'pr_send_to_testing',
    payload: JSON.stringify({
      filePath: plan.filePath,
      fileName: plan.fileName,
      prNumber: pr.pr_number,
      repo: pr.repo_full_name,
    }),
    created_at: new Date().toISOString(),
    title: 'Send to Testing',
    options_json: JSON.stringify(normalizedOptions),
  });

  // Small delay to ensure Slack finishes processing the file upload
  await new Promise((r) => setTimeout(r, 1000));

  const platformMsgId = await adapter.deliver(
    mg.channel_type,
    mg.platform_id,
    threadId,
    'chat-sdk',
    JSON.stringify({
      type: 'ask_question',
      questionId: approvalId,
      title: 'Send to Testing',
      question: summaryLine || 'Send to testing?',
      options,
    }),
    undefined,
    mg.instance,
  );
  if (platformMsgId) updatePendingApprovalPlatformMessageId(approvalId, platformMsgId);

  await markAwaitingApproval(session);
  prLog(pr.pr_number, pr.repo_full_name, 'test_plan_posted', { approvalId });
  log.info('Testing approval card posted', { approvalId, prNumber: pr.pr_number, sessionId: session.id });
}

// Approval handler — fires when human clicks Accept
async function onTestingApproved(ctx: ApprovalHandlerContext): Promise<void> {
  await clearAwaitingApproval(ctx.session);
  const { payload } = ctx;
  const filePath = payload.filePath as string;
  const fileName = payload.fileName as string;

  if (!fs.existsSync(filePath)) {
    ctx.notify(`Test plan file ${fileName} no longer exists.`);
    return;
  }

  const orch = getTestOrchestrator();
  if (!orch) {
    ctx.notify('No test orchestrator installed — cannot submit test plan (vm-test-orchestrator component missing).');
    return;
  }

  const prNumber = payload.prNumber as number;
  const repo = (payload.repo as string) || DEFAULT_REPO;
  try {
    const planContent = fs.readFileSync(filePath, 'utf8');
    orch.submitTest({ prNumber, repo, planContent });
    fs.unlinkSync(filePath);
    prLog(prNumber, repo, 'testing_approved', { fileName });
    log.info('Testing approved — plan submitted to test queue', { prNumber, fileName });
    ctx.notify(`Test plan approved — submitted to test queue.`);
    // eslint-disable-next-line no-catch-all/no-catch-all -- the human already approved; surface the failure to the agent instead of crashing the response handler
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Failed to submit approved plan to test queue', { fileName, err: msg });
    ctx.notify(`Test plan approved but submission failed: ${msg}.`);
  }
}

registerApprovalHandler('pr_send_to_testing', onTestingApproved);

// ── Retry after technical failure ──

export async function postRetryCard(
  session: Session,
  prNumber: number,
  repo: string,
  planContent: string,
): Promise<void> {
  const mg = getMessagingGroup(session.messaging_group_id!);
  if (!mg) {
    log.warn('postRetryCard: messaging group not found', { sessionId: session.id });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('postRetryCard: no delivery adapter');
    return;
  }

  // Dismiss any existing approval cards in this thread before posting a new one
  await dismissStaleApprovals(session);

  const summaryLine = extractSummaryLine(planContent);
  const approvalId = `appr-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const options = retryOptions(summaryLine);
  const normalizedOptions = normalizeOptions(options);

  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action: 'pr_retry_test',
    payload: JSON.stringify({ prNumber, repo, planContent }),
    created_at: new Date().toISOString(),
    title: 'Retry Test',
    options_json: JSON.stringify(normalizedOptions),
  });

  const platformMsgId = await adapter.deliver(
    mg.channel_type,
    mg.platform_id,
    session.thread_id,
    'chat-sdk',
    JSON.stringify({
      type: 'ask_question',
      questionId: approvalId,
      title: 'Retry Test',
      question: summaryLine ? `Retry: ${summaryLine}` : 'Retry test?',
      options,
    }),
    undefined,
    mg.instance,
  );
  if (platformMsgId) updatePendingApprovalPlatformMessageId(approvalId, platformMsgId);

  await markAwaitingApproval(session);
  prLog(prNumber, repo, 'retry_card_posted', { approvalId });
  log.info('Retry test card posted', { approvalId, prNumber, sessionId: session.id });
}

async function onRetryTestApproved(ctx: ApprovalHandlerContext): Promise<void> {
  await clearAwaitingApproval(ctx.session);
  const { payload } = ctx;
  const prNumber = payload.prNumber as number;
  const repo = payload.repo as string;
  const planContent = payload.planContent as string;

  const orch = getTestOrchestrator();
  if (!orch) {
    ctx.notify('No test orchestrator installed — cannot retry test (vm-test-orchestrator component missing).');
    return;
  }

  try {
    orch.submitTest({ prNumber, repo, planContent });
    prLog(prNumber, repo, 'retry_approved');
    log.info('Test retry approved — plan re-submitted to test queue', { prNumber });
    // eslint-disable-next-line no-catch-all/no-catch-all -- the human already approved; surface the failure to the agent instead of crashing the response handler
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Failed to re-submit test plan on retry', { prNumber, err: msg });
    ctx.notify(`Retry failed: ${msg}.`);
  }
}

registerApprovalHandler('pr_retry_test', onRetryTestApproved);
