/**
 * Per-PR session bootstrap.
 *
 * On a `pull_request.opened` webhook event:
 *   1. Post a short opener to the configured Slack channel — the response
 *      `ts` becomes the PR thread.
 *   2. Resolve a per-thread session under the PR Factory Worker agent group.
 *   3. Record (channel, thread) → (repo, pr#, session) in `pr_threads`.
 *   4. Fetch the diff, build the agent prompt with [PR_CONTEXT: …] tag,
 *      write to the session's inbound DB, wake the worker container.
 *
 * On a `pull_request.synchronize` event (new commits pushed):
 *   1. Look up the existing pr_threads row for this repo/PR.
 *   2. Kill the running container and clear the session.
 *   3. Re-fetch the diff and write a new trigger into the same thread.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { fetch as undiciFetch, ProxyAgent } from 'undici';

import { ONECLI_URL } from '../../config.js';
import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import { killContainer, wakeContainer } from '../../container-runner.js';
import { deleteSession, getSession } from '../../db/sessions.js';
import { createPrThread, getPrThreadByRepoPr, updatePrThreadSession, type PrThread } from '../../db/pr-threads.js';
import { log } from '../../log.js';
import { prLog } from './activity-log.js';
import { REPO_MIRROR_DIR, triageDirective } from './defaults.js';
import { getTestOrchestrator } from './test-orchestration.js';
import type { PREvent } from './webhook.js';
import type { BootstrapResult } from './bootstrap.js';

const MAX_DIFF_LENGTH = 50_000;

/**
 * Pull latest main in the repo mirror. Best-effort — failures are logged
 * but never block the review pipeline.
 */
async function refreshRepoMirror(): Promise<void> {
  if (!fs.existsSync(REPO_MIRROR_DIR)) return;
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['fetch', 'origin', 'main', '--quiet'], { cwd: REPO_MIRROR_DIR, timeout: 15_000 }, (err) => {
        if (err) return reject(err);
        execFile(
          'git',
          ['reset', '--hard', 'origin/main', '--quiet'],
          { cwd: REPO_MIRROR_DIR, timeout: 10_000 },
          (err2) => (err2 ? reject(err2) : resolve()),
        );
      });
    });
    log.debug('Repo mirror refreshed');
    // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort by contract: a stale mirror must never block triage
  } catch (err) {
    log.warn('Repo mirror refresh failed (non-blocking)', { err });
  }
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Route GitHub calls through OneCLI's gateway (HTTP forward proxy on
// ONECLI_URL's port + 1) so the gateway injects a vault-stored PAT for
// `api.github.com`. Three pieces are load-bearing:
//
//   1. Use undici's own `fetch` + `ProxyAgent`. Node 22's built-in fetch
//      uses a different bundled undici and rejects an external dispatcher.
//   2. Embed the OneCLI agent's access token in the proxy URL as Basic
//      auth (`http://x:<token>@host:port`). Without it the gateway can't
//      identify the calling agent and falls back to "no agent" mode, which
//      injects nothing — symptom is GitHub returning the 60/h
//      unauthenticated rate limit instead of 5000/h.
//   3. Trust the gateway's self-signed CA (~/.onecli/gateway-ca.pem). The
//      gateway MITMs the TLS to splice in the Authorization header, so
//      vanilla CA bundles don't cover it. Scoped to the ProxyAgent, no
//      env-var change needed.
//
// Inert if any piece is unavailable (no token, no CA file): fetchDiff
// then falls back to a direct unauthenticated GitHub call.
let onecliProxyAgent: ProxyAgent | null | undefined;
async function getOnecliProxyAgent(): Promise<ProxyAgent | null> {
  if (onecliProxyAgent !== undefined) return onecliProxyAgent;
  try {
    const adminRes = await fetch(`${ONECLI_URL}/api/agents/default`);
    if (!adminRes.ok) throw new Error(`OneCLI admin API ${adminRes.status}`);
    const agent = (await adminRes.json()) as { accessToken?: string };
    if (!agent.accessToken) throw new Error('OneCLI default agent has no access token');
    const caPath = path.join(os.homedir(), '.onecli', 'gateway-ca.pem');
    const ca = fs.readFileSync(caPath);
    const gatewayBase = ONECLI_URL.replace(/^https?:\/\//, '').replace(/:\d+$/, ':10255');
    onecliProxyAgent = new ProxyAgent({
      uri: `http://x:${agent.accessToken}@${gatewayBase}`,
      requestTls: { ca },
    });
    log.info('OneCLI proxy agent ready', { gateway: gatewayBase });
    return onecliProxyAgent;
    // eslint-disable-next-line no-catch-all/no-catch-all -- documented degradation: no gateway → direct unauthenticated GitHub calls
  } catch (err) {
    log.warn('OneCLI proxy agent unavailable — GitHub calls will go direct', { err });
    onecliProxyAgent = null;
    return null;
  }
}

interface PrStats {
  commits: number;
  changed_files: number;
  additions: number;
  deletions: number;
}

async function fetchPrStats(repoFullName: string, prNumber: number): Promise<PrStats | null> {
  const url = `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`;
  const dispatcher = await getOnecliProxyAgent();
  const headers = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'NanoClaw' };
  try {
    const res = dispatcher ? await undiciFetch(url, { headers, dispatcher }) : await fetch(url, { headers });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return {
      commits: (data.commits as number) || 0,
      changed_files: (data.changed_files as number) || 0,
      additions: (data.additions as number) || 0,
      deletions: (data.deletions as number) || 0,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- stats line is cosmetic; the opener posts without it
  } catch (err) {
    log.warn('Failed to fetch PR stats', { err, repo: repoFullName, pr: prNumber });
    return null;
  }
}

async function fetchPrAreas(repoFullName: string, prNumber: number): Promise<string> {
  const url = `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100`;
  const dispatcher = await getOnecliProxyAgent();
  const headers = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'NanoClaw' };
  try {
    const res = dispatcher ? await undiciFetch(url, { headers, dispatcher }) : await fetch(url, { headers });
    if (!res.ok) return '';
    const files = (await res.json()) as { filename: string }[];
    const counts = new Map<string, number>();
    for (const f of files) {
      const parts = f.filename.split('/');
      const area = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
      counts.set(area, (counts.get(area) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const MAX_SHOWN = 1;
    const shown = ranked.slice(0, MAX_SHOWN).map(([a]) => `\`${a}\``);
    if (ranked.length <= MAX_SHOWN) return shown.join(' · ');
    const remaining = ranked.length - MAX_SHOWN;
    return shown.join(' · ') + ` +${remaining} more`;
    // eslint-disable-next-line no-catch-all/no-catch-all -- areas line is cosmetic; the opener posts without it
  } catch (err) {
    log.warn('Failed to fetch PR files', { err, repo: repoFullName, pr: prNumber });
    return '';
  }
}

async function fetchDiff(repoFullName: string, prNumber: number): Promise<string> {
  const url = `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`;
  const dispatcher = await getOnecliProxyAgent();
  const headers = { Accept: 'application/vnd.github.v3.diff', 'User-Agent': 'NanoClaw' };
  const res = dispatcher ? await undiciFetch(url, { headers, dispatcher }) : await fetch(url, { headers });
  if (!res.ok) {
    log.warn('Failed to fetch PR diff', { status: res.status, repo: repoFullName, pr: prNumber });
    return `(Failed to fetch diff: HTTP ${res.status})`;
  }
  let diff = await res.text();
  if (diff.length > MAX_DIFF_LENGTH) {
    diff =
      diff.slice(0, MAX_DIFF_LENGTH) +
      `\n\n... (diff truncated at ${MAX_DIFF_LENGTH} chars — ask to review specific files for the rest)`;
  }
  return diff;
}

async function postSlackThreadOpener(botToken: string, channelId: string, text: string): Promise<string> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
  });
  if (!res.ok) {
    throw new Error(`Slack chat.postMessage HTTP ${res.status}`);
  }
  const body = (await res.json()) as { ok: boolean; ts?: string; error?: string };
  if (!body.ok || !body.ts) {
    throw new Error(`Slack chat.postMessage failed: ${body.error || 'no ts'}`);
  }
  return body.ts;
}

import { addReaction, removeReaction, EMOJI_OPEN, EMOJI_CLOSED, EMOJI_MERGED, EMOJI_DRAFT } from './reactions.js';

export interface HandlerConfig {
  /** Slack worker app's bot token — used to post the thread opener. */
  workerBotToken: string;
  /** Bare Slack channel id for PR threads, e.g. C0B0XTGUTS5. */
  workerChannelId: string;
  /** Output of bootstrapPrFactory() — agent group + messaging group + platform id. */
  bootstrap: BootstrapResult;
}

export async function handlePullRequest(pr: PREvent, cfg: HandlerConfig): Promise<void> {
  // closed = PR was closed or merged (from GH UI or our tool)
  if (pr.action === 'closed') {
    const existing = getPrThreadByRepoPr(pr.repoFullName, pr.number);
    if (!existing) return;
    const bareChannel = cfg.workerChannelId;
    await removeReaction(cfg.workerBotToken, bareChannel, existing.thread_ts, EMOJI_OPEN);
    await removeReaction(cfg.workerBotToken, bareChannel, existing.thread_ts, EMOJI_DRAFT);
    await addReaction(cfg.workerBotToken, bareChannel, existing.thread_ts, pr.merged ? EMOJI_MERGED : EMOJI_CLOSED);
    prLog(pr.number, pr.repoFullName, 'pr_closed', { merged: pr.merged });
    log.info('PR status reaction updated', { pr: pr.number, merged: pr.merged });

    // Destroy the test VM if one exists for this PR (vm-test-orchestrator
    // component; no-op when not installed).
    const orch = getTestOrchestrator();
    if (orch) {
      try {
        await orch.destroyVm(pr.number);
        // eslint-disable-next-line no-catch-all/no-catch-all -- VM teardown is best-effort on close; the orchestrator reaps stale VMs itself
      } catch (err) {
        log.warn('Failed to destroy test VM on PR close', { pr: pr.number, err });
      }
    }
    return;
  }

  // converted_to_draft = PR marked as draft
  if (pr.action === 'converted_to_draft') {
    const existing = getPrThreadByRepoPr(pr.repoFullName, pr.number);
    if (!existing) return;
    await removeReaction(cfg.workerBotToken, cfg.workerChannelId, existing.thread_ts, EMOJI_OPEN);
    await addReaction(cfg.workerBotToken, cfg.workerChannelId, existing.thread_ts, EMOJI_DRAFT);
    prLog(pr.number, pr.repoFullName, 'converted_to_draft');
    log.info('PR marked as draft', { pr: pr.number });
    return;
  }

  // ready_for_review = draft PR marked as ready — treat like opened
  if (pr.action === 'ready_for_review') {
    const existing = getPrThreadByRepoPr(pr.repoFullName, pr.number);
    if (existing) {
      // Existing thread — swap emoji and re-triage in same thread
      await removeReaction(cfg.workerBotToken, cfg.workerChannelId, existing.thread_ts, EMOJI_DRAFT);
      await addReaction(cfg.workerBotToken, cfg.workerChannelId, existing.thread_ts, EMOJI_OPEN);
      await handleSynchronize(pr, existing, cfg);
      return;
    }
    // No existing thread — fall through to opened flow
  }

  // synchronize = new commits pushed to an existing PR
  if (pr.action === 'synchronize') {
    if (pr.draft) {
      prLog(pr.number, pr.repoFullName, 'synchronize_skipped_draft');
      log.info('PR synchronize on draft — skipping', { pr: pr.number });
      return;
    }
    const existing = getPrThreadByRepoPr(pr.repoFullName, pr.number);
    if (!existing) {
      log.info('PR synchronize but no existing thread, treating as opened', {
        repo: pr.repoFullName,
        pr: pr.number,
      });
      // Fall through to the opened flow below
    } else {
      await handleSynchronize(pr, existing, cfg);
      return;
    }
  }

  const existing = getPrThreadByRepoPr(pr.repoFullName, pr.number);
  if (existing) {
    log.info('PR thread already bootstrapped, skipping', {
      repo: pr.repoFullName,
      pr: pr.number,
      threadTs: existing.thread_ts,
    });
    return;
  }

  const draftLabel = pr.draft ? ' (draft)' : '';
  const [stats, areas] = await Promise.all([
    fetchPrStats(pr.repoFullName, pr.number),
    fetchPrAreas(pr.repoFullName, pr.number),
  ]);
  const statsLine = stats
    ? `${stats.changed_files} file${stats.changed_files !== 1 ? 's' : ''} · ${stats.commits} commit${stats.commits !== 1 ? 's' : ''} · +${stats.additions} −${stats.deletions}`
    : '';
  const areasLine = areas ? `\n${areas}` : '';
  const opener =
    `*<${pr.htmlUrl}|PR #${pr.number}: ${pr.title}>*${draftLabel}\n` +
    statsLine +
    areasLine +
    `\nAuthor: <https://github.com/${pr.author}|${pr.author}>`;

  prLog(pr.number, pr.repoFullName, 'thread_creating', { author: pr.author, title: pr.title, draft: pr.draft });
  const threadTs = await postSlackThreadOpener(cfg.workerBotToken, cfg.workerChannelId, opener);

  // Mark the thread with the appropriate status emoji
  await addReaction(cfg.workerBotToken, cfg.workerChannelId, threadTs, pr.draft ? EMOJI_DRAFT : EMOJI_OPEN);

  const now = new Date().toISOString();
  const sessionThreadId = `${cfg.bootstrap.workerPlatformId}:${threadTs}`;
  const { session } = resolveSession(
    cfg.bootstrap.workerAgentGroupId,
    cfg.bootstrap.workerMessagingGroupId,
    sessionThreadId,
    'per-thread',
  );

  createPrThread({
    channel_id: cfg.bootstrap.workerPlatformId,
    thread_ts: threadTs,
    channel_type: 'slack',
    repo_full_name: pr.repoFullName,
    pr_number: pr.number,
    session_id: session.id,
    created_at: now,
  });

  // Draft PRs: thread + pr_threads row created, but no triage. Triage
  // triggers when the author marks the PR as ready_for_review.
  if (pr.draft) {
    prLog(pr.number, pr.repoFullName, 'draft_thread_created', { threadTs });
    log.info('Draft PR — thread created, triage deferred', { pr: pr.number, repo: pr.repoFullName });
    return;
  }

  // Pre-subscribe the worker to the new PR thread.
  try {
    const workerAdapter = getChannelAdapterExact('slack');
    if (workerAdapter?.subscribe) {
      await workerAdapter.subscribe(cfg.bootstrap.workerPlatformId, sessionThreadId);
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missed pre-subscribe self-heals on the first @-mention; never block triage
  } catch (err) {
    log.warn('Failed to pre-subscribe worker to PR thread', { threadTs, err });
  }

  // Refresh repo mirror so the worker has up-to-date code for codebase searches
  await refreshRepoMirror();

  prLog(pr.number, pr.repoFullName, 'diff_fetching');
  const diff = await fetchDiff(pr.repoFullName, pr.number);
  prLog(pr.number, pr.repoFullName, 'diff_fetched', { length: diff.length });
  const content = [
    triageDirective(),
    '',
    `## Pull Request #${pr.number}: ${pr.title}`,
    `**Author:** ${pr.author}`,
    `**Repository:** ${pr.repoFullName}`,
    `**URL:** ${pr.htmlUrl}`,
    '',
    '### Description',
    pr.body || '(no description)',
    '',
    '### Diff',
    '```diff',
    diff,
    '```',
    '',
    `[PR_CONTEXT: channel=${cfg.bootstrap.workerPlatformId} thread=${threadTs} repo=${pr.repoFullName} pr=${pr.number}]`,
  ].join('\n');

  writeSessionMessage(cfg.bootstrap.workerAgentGroupId, session.id, {
    id: generateId('msg-pr'),
    kind: 'chat',
    timestamp: now,
    platformId: cfg.bootstrap.workerPlatformId,
    channelType: 'slack',
    threadId: sessionThreadId,
    content: JSON.stringify({ text: content, sender: 'GitHub', senderId: 'github-webhook' }),
  });

  prLog(pr.number, pr.repoFullName, 'session_bootstrapped', { sessionId: session.id, threadTs });
  log.info('PR session bootstrapped', {
    sessionId: session.id,
    pr: pr.number,
    repo: pr.repoFullName,
    threadTs,
  });

  const fresh = getSession(session.id);
  if (fresh) {
    prLog(pr.number, pr.repoFullName, 'container_waking');
    await wakeContainer(fresh);
  }
}

/**
 * Handle a synchronize event (new commits pushed to an existing PR).
 * Kills the old container, creates a fresh session in the same Slack thread,
 * and re-triggers triage with the updated diff.
 */
async function handleSynchronize(pr: PREvent, existing: PrThread, cfg: HandlerConfig): Promise<void> {
  prLog(pr.number, pr.repoFullName, 'synchronize', { oldSessionId: existing.session_id });
  // Kill the old container + session
  const oldSession = getSession(existing.session_id);
  if (oldSession) {
    killContainer(oldSession.id, 'PR synchronize — new commits pushed');
    deleteSession(oldSession.id);
  }

  // Create a fresh session in the same thread. The worker's row is the
  // default Slack instance — pass it explicitly for an exact lookup that
  // can never resolve a sibling instance's row on the same channel.
  const sessionThreadId = `${existing.channel_id}:${existing.thread_ts}`;
  const messagingGroup = getMessagingGroupByPlatform('slack', existing.channel_id, 'slack');
  if (!messagingGroup) {
    log.warn('PR synchronize: no messaging group for channel', { channelId: existing.channel_id });
    return;
  }

  const { session } = resolveSession(
    cfg.bootstrap.workerAgentGroupId,
    messagingGroup.id,
    sessionThreadId,
    'per-thread',
  );

  // Update pr_threads to point to the new session
  updatePrThreadSession(existing.channel_id, existing.thread_ts, session.id);

  // Refresh repo mirror + fetch fresh diff
  await refreshRepoMirror();
  const diff = await fetchDiff(pr.repoFullName, pr.number);
  const now = new Date().toISOString();

  const content = [
    `New commits pushed — re-triage PR #${pr.number}. ${triageDirective()}`,
    '',
    `## Pull Request #${pr.number}: ${pr.title}`,
    `**Author:** ${pr.author}`,
    `**Repository:** ${pr.repoFullName}`,
    `**URL:** ${pr.htmlUrl}`,
    '',
    '### Diff (updated)',
    '```diff',
    diff,
    '```',
    '',
    `[PR_CONTEXT: channel=${existing.channel_id} thread=${existing.thread_ts} repo=${pr.repoFullName} pr=${pr.number}]`,
  ].join('\n');

  writeSessionMessage(cfg.bootstrap.workerAgentGroupId, session.id, {
    id: generateId('msg-sync'),
    kind: 'chat',
    timestamp: now,
    platformId: existing.channel_id,
    channelType: 'slack',
    threadId: sessionThreadId,
    content: JSON.stringify({ text: content, sender: 'GitHub', senderId: 'github-webhook' }),
  });

  prLog(pr.number, pr.repoFullName, 'synchronize_bootstrapped', { sessionId: session.id });
  log.info('PR synchronize: session re-bootstrapped in same thread', {
    pr: pr.number,
    repo: pr.repoFullName,
    sessionId: session.id,
    threadTs: existing.thread_ts,
  });

  const fresh = getSession(session.id);
  if (fresh) {
    prLog(pr.number, pr.repoFullName, 'container_waking');
    await wakeContainer(fresh);
  }
}
