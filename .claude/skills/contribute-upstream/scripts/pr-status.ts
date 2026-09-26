import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { DEFAULTS, flagValue, resolveForkOwner } from './config.js';
import { parseLedger, type LedgerEntry } from './inventory.js';

export interface PullRequestSnapshot {
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly isDraft: boolean;
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  readonly mergeStateStatus: string;
  readonly reviewDecision: string | null;
  readonly headCommittedAt: string;
  readonly comments: readonly { readonly author: string; readonly createdAt: string }[];
  readonly reviews: readonly { readonly author: string; readonly state: string; readonly submittedAt: string }[];
}

export interface BranchSnapshot {
  readonly exists: boolean;
  readonly commitsAhead: number;
  readonly commitsBehind: number;
  readonly conflictsWithBase: boolean;
}

export interface StatusRow {
  readonly slug: string;
  readonly state: string;
  readonly detail: string;
  readonly nextAction: string;
  readonly prUrl?: string;
}

const PR_URLS = /https:\/\/github\.com\/[^\s|,]+\/pull\/\d+/g;
const PR_FIELDS = 'state,isDraft,mergeable,mergeStateStatus,reviewDecision,comments,reviews,commits';
const MERGE_TREE_CONFLICT_EXIT = 1;

export function prUrlsOf(entry: LedgerEntry): string[] {
  return [...new Set(entry.status.match(PR_URLS) ?? [])];
}

function feedbackSinceHead(pr: PullRequestSnapshot, forkOwner: string): number {
  const fromOthers = (author: string, at: string): boolean => author !== forkOwner && at > pr.headCommittedAt;
  return (
    pr.comments.filter((comment) => fromOthers(comment.author, comment.createdAt)).length +
    pr.reviews.filter((review) => fromOthers(review.author, review.submittedAt)).length
  );
}

export function summarizePullRequest(slug: string, forkOwner: string, pr: PullRequestSnapshot): StatusRow {
  const newFeedback = feedbackSinceHead(pr, forkOwner);
  const detail = [
    `review: ${pr.reviewDecision ?? 'none'}`,
    `merge: ${pr.mergeStateStatus.toLowerCase()}`,
    `${pr.comments.length} comment(s), ${pr.reviews.length} review(s), ${newFeedback} new since last push`,
  ].join(' · ');
  if (pr.state === 'MERGED') {
    return { slug, state: 'merged', detail, nextAction: 'run `reconcile` after the next /update-nanoclaw' };
  }
  if (pr.state === 'CLOSED') {
    return { slug, state: 'closed', detail, nextAction: 'record the maintainer reason, set decision keep-local' };
  }
  const state = pr.isDraft ? 'draft' : 'open';
  if (pr.mergeable === 'CONFLICTING') {
    return { slug, state, detail, nextAction: 'rebase on the base branch and resolve conflicts, then Gate 2 again' };
  }
  const lastChangeRequest = pr.reviews
    .filter((review) => review.state === 'CHANGES_REQUESTED')
    .map((review) => review.submittedAt)
    .sort()
    .at(-1);
  if (pr.reviewDecision === 'CHANGES_REQUESTED' && lastChangeRequest && lastChangeRequest < pr.headCommittedAt) {
    return { slug, state, detail, nextAction: 'none — changes pushed, waiting for re-review' };
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    return { slug, state, detail, nextAction: 'address requested changes, then Gate 2 again' };
  }
  if (newFeedback > 0) {
    return { slug, state, detail, nextAction: 'read and answer new comments' };
  }
  if (pr.mergeStateStatus === 'BEHIND') {
    return { slug, state, detail, nextAction: 'update branch from base' };
  }
  const blockedOnlyByReview = pr.mergeStateStatus === 'BLOCKED' && pr.reviewDecision === 'REVIEW_REQUIRED';
  if (pr.mergeStateStatus === 'UNSTABLE' || (pr.mergeStateStatus === 'BLOCKED' && !blockedOnlyByReview)) {
    return { slug, state, detail, nextAction: 'check failing CI or required reviews' };
  }
  if (pr.reviewDecision === 'APPROVED') {
    return { slug, state, detail, nextAction: 'none — waiting for maintainer merge' };
  }
  return { slug, state, detail, nextAction: 'none — waiting for review' };
}

export function summarizeBranch(entry: LedgerEntry, branch: BranchSnapshot): StatusRow {
  if (entry.decision !== 'contribute') {
    return { slug: entry.slug, state: entry.decision, detail: entry.status, nextAction: 'none' };
  }
  if (!branch.exists) {
    return {
      slug: entry.slug,
      state: 'no-branch',
      detail: '',
      nextAction: 'create the worktree (contribute mode step 1)',
    };
  }
  const detail = `${branch.commitsAhead} ahead, ${branch.commitsBehind} behind base`;
  if (branch.conflictsWithBase) {
    return {
      slug: entry.slug,
      state: 'conflicts',
      detail,
      nextAction: 'rebase on the base branch and resolve conflicts',
    };
  }
  if (branch.commitsAhead === 0) {
    return { slug: entry.slug, state: 'not-started', detail, nextAction: 'implement the generic base in the worktree' };
  }
  return { slug: entry.slug, state: 'unpushed', detail, nextAction: 'verify, scrub, then Gate 2' };
}

export function prLink(url: string | undefined): string {
  if (!url) {
    return '—';
  }
  const number = /\/pull\/(\d+)$/.exec(url)?.[1];
  return number ? `[#${number}](${url})` : `[PR](${url})`;
}

export function labelRows(rows: readonly StatusRow[]): StatusRow[] {
  if (rows.length < 2) {
    return [...rows];
  }
  return rows.map((row, index) => ({ ...row, slug: `${row.slug} (${index + 1}/${rows.length})` }));
}

export function renderStatus(rows: readonly StatusRow[], generatedAt: string): string {
  const needsAction = rows.filter((row) => !row.nextAction.startsWith('none'));
  return [
    '# Contribution status',
    '',
    `Generated ${generatedAt} by \`/contribute-upstream status\`. Do not edit by hand.`,
    `${rows.length} row(s), ${needsAction.length} need action.`,
    '',
    '| # | Slug | State | PR | Detail | Next action |',
    '|---|---|---|---|---|---|',
    ...rows.map((row, index) => {
      const pr = row.prUrl ? `${prLink(row.prUrl)} ${row.state}` : prLink(row.prUrl);
      return `| ${index + 1} | \`${row.slug}\` | ${row.state} | ${pr} | ${row.detail} | ${row.nextAction} |`;
    }),
    '',
  ].join('\n');
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function readBranch(slug: string, defaultBase: string): BranchSnapshot {
  const branch = `contrib/${slug}`;
  if (spawnSync('git', ['rev-parse', '--verify', '--quiet', branch]).status !== 0) {
    return { exists: false, commitsAhead: 0, commitsBehind: 0, conflictsWithBase: false };
  }
  const baseProbe = spawnSync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { encoding: 'utf8' });
  const base = baseProbe.status === 0 ? baseProbe.stdout.trim() : defaultBase;
  const [behind, ahead] = git(['rev-list', '--left-right', '--count', `${base}...${branch}`])
    .split(/\s+/)
    .map(Number);
  const mergeTree = spawnSync('git', ['merge-tree', '--write-tree', base, branch]);
  return {
    exists: true,
    commitsAhead: ahead,
    commitsBehind: behind,
    conflictsWithBase: mergeTree.status === MERGE_TREE_CONFLICT_EXIT,
  };
}

interface GhPullRequest {
  state: PullRequestSnapshot['state'];
  isDraft: boolean;
  mergeable: PullRequestSnapshot['mergeable'];
  mergeStateStatus: string;
  reviewDecision: string | null;
  comments: { author: { login: string } | null; createdAt: string }[];
  reviews: { author: { login: string } | null; state: string; submittedAt: string }[];
  commits: { committedDate: string }[];
}

function readPullRequest(url: string): PullRequestSnapshot {
  const raw = JSON.parse(
    execFileSync('gh', ['pr', 'view', url, '--json', PR_FIELDS], { encoding: 'utf8' }),
  ) as GhPullRequest;
  return {
    state: raw.state,
    isDraft: raw.isDraft,
    mergeable: raw.mergeable,
    mergeStateStatus: raw.mergeStateStatus,
    reviewDecision: raw.reviewDecision || null,
    headCommittedAt: raw.commits.at(-1)?.committedDate ?? '',
    comments: raw.comments.map((comment) => ({ author: comment.author?.login ?? '', createdAt: comment.createdAt })),
    reviews: raw.reviews.map((review) => ({
      author: review.author?.login ?? '',
      state: review.state,
      submittedAt: review.submittedAt,
    })),
  };
}

interface StatusContext {
  readonly forkOwner: string;
  readonly upstreamRef: string;
}

function pullRequestRow(slug: string, url: string, context: StatusContext): StatusRow {
  try {
    return { ...summarizePullRequest(slug, context.forkOwner, readPullRequest(url)), prUrl: url };
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return {
      slug,
      state: 'unknown',
      detail: `gh failed: ${reason}`,
      nextAction: 'check gh auth (`gh auth status`; switch to the fork owner account)',
      prUrl: url,
    };
  }
}

function statusFor(entry: LedgerEntry, context: StatusContext): StatusRow[] {
  const urls = prUrlsOf(entry);
  if (urls.length === 0) {
    return [summarizeBranch(entry, readBranch(entry.slug, context.upstreamRef))];
  }
  return labelRows(urls.map((url) => pullRequestRow(entry.slug, url, context)));
}

function main(): void {
  const argv = process.argv.slice(2);
  const ledgerPath = flagValue(argv, '--ledger', DEFAULTS.ledger);
  const statusPath = flagValue(argv, '--status-file', DEFAULTS.status);
  if (!existsSync(ledgerPath)) {
    console.error(`ledger ${ledgerPath} not found — run /contribute-upstream map first`);
    process.exit(2);
  }
  const context: StatusContext = {
    forkOwner: resolveForkOwner(argv),
    upstreamRef: flagValue(argv, '--upstream-ref', DEFAULTS.upstreamRef),
  };
  if (!context.forkOwner) {
    console.error('warning: fork owner unknown (pass --owner or set CONTRIB_FORK_OWNER); own comments count as new');
  }
  const rows = parseLedger(readFileSync(ledgerPath, 'utf8'))
    .filter((entry) => entry.decision === 'contribute')
    .flatMap((entry) => statusFor(entry, context));
  writeFileSync(statusPath, renderStatus(rows, new Date().toISOString()));
  console.log(`wrote ${statusPath}: ${rows.length} row(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
