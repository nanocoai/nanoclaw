/**
 * Orchestrator — coordination layer between the (optional) test-orchestrator
 * component and NanoClaw.
 *
 * Pure NanoClaw coordination. Never SSHes into anything — the VM control
 * plane lives in the vm-test-orchestrator component, reached only through
 * the TestOrchestratorModule seam (test-orchestration.ts).
 *
 * Responsibilities:
 *   - Wires callbacks into the registered test orchestrator (onVmReady, onRunFailed)
 *   - Wakes the tester agent when a VM is ready
 *   - Handles test results arriving via the submit_test_results MCP tool
 *   - Enforces a 30-minute timeout per test run
 *   - Posts results, wakes the worker to propose merge on PASS / analyze on FAIL
 */
import { getPrThreadByRepoPr } from '../../db/pr-threads.js';
import { getSession } from '../../db/sessions.js';
import { resolveSession, writeOutboundDirect, writeSessionMessage } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { prLog } from './activity-log.js';
import { createCanvas } from './canvas.js';
import { DEFAULT_REPO } from './defaults.js';
import type { TestOrchestratorModule } from './test-orchestration.js';
import { postRetryCard } from './testing-approval.js';
import type { Session } from '../../types.js';

// ── Constants ──

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ── State ──

let testOrch: TestOrchestratorModule | null = null;
let testerAgGroupId: string = '';
let testerMgId: string = '';
const timeouts = new Map<number, ReturnType<typeof setTimeout>>();

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Tester agent wake ──

async function onVmReady(prNumber: number, repo: string, vmHost: string, planContent: string): Promise<void> {
  const pr = getPrThreadByRepoPr(repo, prNumber);
  if (!pr) {
    log.warn('onVmReady: no PR thread found', { prNumber, repo });
    return;
  }

  const sessionThreadId = `${pr.channel_id}:${pr.thread_ts}`;
  const { session } = resolveSession(testerAgGroupId, testerMgId, sessionThreadId, 'per-thread');

  const triggerContent = [
    `Execute the test plan below on the test VM at \`${vmHost}\`.`,
    '',
    `## Test Plan — PR #${prNumber}`,
    `**Repository:** ${repo}`,
    `**VM:** ${vmHost}`,
    '',
    planContent,
    '',
    `[PR_CONTEXT: channel=${pr.channel_id} thread=${pr.thread_ts} repo=${repo} pr=${prNumber}]`,
  ].join('\n');

  const now = new Date().toISOString();
  writeSessionMessage(testerAgGroupId, session.id, {
    id: generateId('msg-test'),
    kind: 'chat',
    timestamp: now,
    platformId: pr.channel_id,
    channelType: 'slack',
    threadId: sessionThreadId,
    content: JSON.stringify({
      text: triggerContent,
      sender: 'Test Orchestrator',
      senderId: 'test-orchestrator',
    }),
  });

  const fresh = getSession(session.id);
  if (fresh) {
    await wakeContainer(fresh);
  }

  // Start 30-min timeout. Clear any timer already armed for this PR first —
  // a re-run (e.g. a second VM-ready for the same PR) would otherwise orphan
  // the previous timer, which then fires against the wrong run and is never
  // cleared. Keyed by prNumber (a factory instance serves one repo).
  const prev = timeouts.get(prNumber);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    handleTimeout(prNumber, repo).catch((err) => log.error('Timeout handler error', { prNumber, err }));
  }, TIMEOUT_MS);
  timeouts.set(prNumber, timer);

  prLog(prNumber, repo, 'vm_ready', { vmHost, sessionId: session.id });
  log.info('Tester agent woken', { prNumber, vmHost, sessionId: session.id });
}

async function onRunFailed(prNumber: number, repo: string, reason: string, planContent: string): Promise<void> {
  const pr = getPrThreadByRepoPr(repo, prNumber);
  if (!pr) {
    log.warn('onRunFailed: no PR thread found', { prNumber, repo });
    return;
  }

  const session = getSession(pr.session_id);
  if (!session) {
    log.warn('onRunFailed: worker session not found', { prNumber, sessionId: pr.session_id });
    return;
  }

  const sessionThreadId = `${pr.channel_id}:${pr.thread_ts}`;
  const text = `\n━━━  ❌ Test Setup Failed  ━━━━━━━━\n\nPR #${prNumber}: ${reason}`;

  writeOutboundDirect(session.agent_group_id, session.id, {
    id: generateId('test-fail'),
    kind: 'chat',
    platformId: pr.channel_id,
    channelType: pr.channel_type,
    threadId: sessionThreadId,
    content: JSON.stringify({ text }),
  });

  // Post retry card after a short delay so the error message is delivered first
  await new Promise((r) => setTimeout(r, 1000));
  await postRetryCard(session, prNumber, repo, planContent);

  prLog(prNumber, repo, 'vm_setup_failed', { reason });
  log.info('VM setup failure posted to PR thread', { prNumber, reason });
}

// ── Timeout ──

async function handleTimeout(prNumber: number, repo: string): Promise<void> {
  timeouts.delete(prNumber);
  prLog(prNumber, repo, 'test_timeout', { timeoutMs: TIMEOUT_MS });
  log.warn('Test run timed out', { prNumber, timeoutMs: TIMEOUT_MS });

  if (testOrch) {
    await testOrch.cancelRun(prNumber);
  }

  const pr = getPrThreadByRepoPr(repo, prNumber);
  if (!pr) return;

  const session = getSession(pr.session_id);
  if (!session) return;

  const sessionThreadId = `${pr.channel_id}:${pr.thread_ts}`;
  writeOutboundDirect(session.agent_group_id, session.id, {
    id: generateId('timeout'),
    kind: 'chat',
    platformId: pr.channel_id,
    channelType: pr.channel_type,
    threadId: sessionThreadId,
    content: JSON.stringify({
      text: `\n━━━  ⏰ Test Timeout  ━━━━━━━━━━━━━━\n\nPR #${prNumber}: no results after ${TIMEOUT_MS / 60_000} minutes. Test VM destroyed.`,
    }),
  });
}

// ── Result handling (delivery action for pr_submit_test_results) ──

export async function handleTestResults(content: Record<string, unknown>, _session: Session): Promise<void> {
  const prNumber = content.pr_number as number;
  const repo = (content.repo as string) || DEFAULT_REPO;
  const verdict = content.verdict as string;
  const resultContent = content.content as string;

  prLog(prNumber || 0, repo, 'test_results_received', { verdict });
  if (!prNumber || !verdict || !resultContent) {
    log.warn('handleTestResults: missing required fields', { prNumber, verdict: !!verdict, content: !!resultContent });
    return;
  }

  // Cancel timeout
  const timer = timeouts.get(prNumber);
  if (timer) {
    clearTimeout(timer);
    timeouts.delete(prNumber);
  }

  // Mark run complete in the test orchestrator (VM stays alive for investigation)
  if (testOrch) {
    testOrch.completeRun(prNumber);
  }

  // Look up worker session via PR thread
  const pr = getPrThreadByRepoPr(repo, prNumber);
  if (!pr) {
    log.warn('handleTestResults: no PR thread found', { prNumber, repo });
    return;
  }

  const workerSession = getSession(pr.session_id);
  if (!workerSession) {
    log.warn('handleTestResults: worker session not found', { prNumber, sessionId: pr.session_id });
    return;
  }

  const sessionThreadId = `${pr.channel_id}:${pr.thread_ts}`;

  // Render the results as a canvas when the slack-canvas component is
  // installed; otherwise the plain summary carries the verdict.
  const bareChannel = pr.channel_id.replace(/^slack:/, '');
  const canvas = await createCanvas(`Test Results — PR #${prNumber}`, resultContent, bareChannel);

  const summaryLine = `Verdict: **${verdict}**`;
  let summary: string;
  if (canvas) {
    summary = `\n━━━  ✅ Test Results  ━━━━━━━━━━━━━━\n\n${summaryLine}\n\n[View test results](${canvas.permalink})`;
  } else {
    summary = `\n━━━  ✅ Test Results  ━━━━━━━━━━━━━━\n\n${summaryLine}`;
  }

  const msgId = generateId('test-result');
  writeOutboundDirect(workerSession.agent_group_id, workerSession.id, {
    id: msgId,
    kind: 'chat',
    platformId: pr.channel_id,
    channelType: pr.channel_type,
    threadId: sessionThreadId,
    content: JSON.stringify({ text: summary }),
  });

  // Verdict-based action — wake the worker for both PASS and FAIL.
  // Never auto-propose merge from the orchestrator: the test results
  // chat message (writeOutboundDirect above) triggers a Slack event that
  // wakes the worker via mention-sticky, so both the orchestrator and
  // the worker would propose merge, producing duplicate approval cards.
  if (verdict === 'PASS') {
    const passPrompt = [
      `Test results are back for PR #${prNumber}: verdict **${verdict}**. All tests passed.`,
      '',
      'Propose merge via `credentialed_gh`.',
      '',
      `[PR_CONTEXT: channel=${pr.channel_id} thread=${pr.thread_ts} repo=${pr.repo_full_name} pr=${prNumber}]`,
    ].join('\n');

    const now = new Date().toISOString();
    writeSessionMessage(workerSession.agent_group_id, workerSession.id, {
      id: generateId('test-pass'),
      kind: 'chat',
      timestamp: now,
      platformId: pr.channel_id,
      channelType: pr.channel_type,
      threadId: sessionThreadId,
      content: JSON.stringify({
        text: passPrompt,
        sender: 'Test Orchestrator',
        senderId: 'test-orchestrator',
      }),
    });

    const freshWorker = getSession(workerSession.id);
    if (freshWorker) {
      await wakeContainer(freshWorker);
    }
    prLog(prNumber, repo, 'worker_woken_for_merge');
    log.info('Worker woken to propose merge after tests passed', { prNumber, verdict });
  } else {
    // FAIL or PARTIAL — wake worker to analyze
    const failurePrompt = [
      `Test results are back for PR #${prNumber}: verdict **${verdict}**.`,
      '',
      'Analyze the results and determine if failures are PR-related or pre-existing/environmental.',
      'Post a ONE-LINE conclusion, then take the appropriate action (merge anyway, request fixes, or close). No preamble.',
      '',
      '### Test Results',
      '```',
      resultContent,
      '```',
      '',
      `[PR_CONTEXT: channel=${pr.channel_id} thread=${pr.thread_ts} repo=${pr.repo_full_name} pr=${prNumber}]`,
    ].join('\n');

    const now = new Date().toISOString();
    writeSessionMessage(workerSession.agent_group_id, workerSession.id, {
      id: generateId('test-analysis'),
      kind: 'chat',
      timestamp: now,
      platformId: pr.channel_id,
      channelType: pr.channel_type,
      threadId: sessionThreadId,
      content: JSON.stringify({
        text: failurePrompt,
        sender: 'Test Orchestrator',
        senderId: 'test-orchestrator',
      }),
    });

    const freshWorker = getSession(workerSession.id);
    if (freshWorker) {
      await wakeContainer(freshWorker);
    }
    prLog(prNumber, repo, 'worker_woken_for_analysis', { verdict });
    log.info('Worker woken to analyze test results', { prNumber, verdict });
  }

  log.info('Test results processed', { prNumber, verdict });
}

// ── Init / shutdown ──

export function initOrchestrator(
  testOrchestratorRef: TestOrchestratorModule,
  testerAgentGroupId: string,
  testerMessagingGroupId: string,
): void {
  testOrch = testOrchestratorRef;
  testerAgGroupId = testerAgentGroupId;
  testerMgId = testerMessagingGroupId;

  testOrch.init({
    onVmReady,
    onRunFailed,
  });

  log.info('Orchestrator initialized', { testerAgentGroupId, testerMessagingGroupId });
}

export function shutdownOrchestrator(): void {
  for (const timer of timeouts.values()) {
    clearTimeout(timer);
  }
  timeouts.clear();
  testOrch = null;
  log.info('Orchestrator shut down');
}
