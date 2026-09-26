import { describe, expect, it } from 'vitest';

import {
  labelRows,
  prLink,
  prUrlsOf,
  renderStatus,
  summarizeBranch,
  summarizePullRequest,
  type PullRequestSnapshot,
} from './pr-status.js';

const HEAD_AT = '2026-01-15T10:00:00Z';
const OWNER = 'fork-owner';

function pr(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    headCommittedAt: HEAD_AT,
    comments: [],
    reviews: [],
    ...overrides,
  };
}

describe('prUrlsOf', () => {
  it('extracts every distinct PR URL from the ledger status cell', () => {
    const entry = {
      slug: 'x',
      decision: 'contribute',
      status:
        'pr-open https://github.com/nanocoai/nanoclaw/pull/42, https://github.com/nanocoai/nanoclaw/pull/51 https://github.com/nanocoai/nanoclaw/pull/42',
    };
    expect(prUrlsOf(entry)).toEqual([
      'https://github.com/nanocoai/nanoclaw/pull/42',
      'https://github.com/nanocoai/nanoclaw/pull/51',
    ]);
    expect(prUrlsOf({ ...entry, status: 'worktree-ready' })).toEqual([]);
  });
});

describe('labelRows', () => {
  it('numbers rows only when a feature has several PRs', () => {
    const row = { slug: 'x', state: 'open', detail: '', nextAction: 'none' };
    expect(labelRows([row])[0].slug).toBe('x');
    expect(labelRows([row, { ...row, state: 'merged' }]).map((r) => r.slug)).toEqual(['x (1/2)', 'x (2/2)']);
  });
});

describe('summarizePullRequest', () => {
  it('maps terminal states to reconcile or close actions', () => {
    expect(summarizePullRequest('x', OWNER, pr({ state: 'MERGED' })).nextAction).toContain('reconcile');
    expect(summarizePullRequest('x', OWNER, pr({ state: 'CLOSED' })).nextAction).toContain('keep-local');
  });

  it('puts conflicts before review feedback', () => {
    const row = summarizePullRequest('x', OWNER, pr({ mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' }));
    expect(row.nextAction).toContain('resolve conflicts');
  });

  it('waits for re-review once changes were pushed after the request', () => {
    const snapshot = pr({
      reviewDecision: 'CHANGES_REQUESTED',
      reviews: [{ author: 'maintainer', state: 'CHANGES_REQUESTED', submittedAt: '2026-01-15T09:00:00Z' }],
    });
    expect(summarizePullRequest('x', OWNER, snapshot).nextAction).toBe('none — changes pushed, waiting for re-review');
  });

  it('flags requested changes', () => {
    expect(summarizePullRequest('x', OWNER, pr({ reviewDecision: 'CHANGES_REQUESTED' })).nextAction).toContain(
      'requested changes',
    );
  });

  it('counts only feedback from others after the last push', () => {
    const snapshot = pr({
      comments: [
        { author: 'maintainer', createdAt: '2026-01-15T11:00:00Z' },
        { author: 'maintainer', createdAt: '2026-01-15T09:00:00Z' },
        { author: OWNER, createdAt: '2026-01-15T12:00:00Z' },
      ],
    });
    const row = summarizePullRequest('x', OWNER, snapshot);
    expect(row.nextAction).toBe('read and answer new comments');
    expect(row.detail).toContain('1 new since last push');
  });

  it('asks to update when behind and to wait when clean', () => {
    expect(summarizePullRequest('x', OWNER, pr({ mergeStateStatus: 'BEHIND' })).nextAction).toBe(
      'update branch from base',
    );
    expect(summarizePullRequest('x', OWNER, pr({ reviewDecision: 'APPROVED' })).nextAction).toContain(
      'waiting for maintainer merge',
    );
    expect(summarizePullRequest('x', OWNER, pr({ isDraft: true })).state).toBe('draft');
    const awaitingReview = pr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' });
    expect(summarizePullRequest('x', OWNER, awaitingReview).nextAction).toBe('none — waiting for review');
    expect(summarizePullRequest('x', OWNER, pr({ mergeStateStatus: 'BLOCKED' })).nextAction).toContain('failing CI');
  });
});

describe('summarizeBranch', () => {
  const entry = { slug: 'x', decision: 'contribute', status: 'worktree-ready' };

  it('reports missing, conflicting, empty and unpushed branches', () => {
    const base = { exists: true, commitsAhead: 0, commitsBehind: 0, conflictsWithBase: false };
    expect(summarizeBranch(entry, { ...base, exists: false }).state).toBe('no-branch');
    expect(summarizeBranch(entry, { ...base, conflictsWithBase: true }).state).toBe('conflicts');
    expect(summarizeBranch(entry, base).state).toBe('not-started');
    expect(summarizeBranch(entry, { ...base, commitsAhead: 3 }).nextAction).toBe('verify, scrub, then Gate 2');
  });
});

describe('renderStatus', () => {
  it('counts rows that need action', () => {
    const markdown = renderStatus(
      [
        {
          slug: 'a',
          state: 'merged',
          detail: '',
          nextAction: 'none — waiting for review',
          prUrl: 'https://github.com/nanocoai/nanoclaw/pull/7',
        },
        { slug: 'b', state: 'conflicts', detail: '', nextAction: 'rebase' },
      ],
      HEAD_AT,
    );
    expect(markdown).toContain('2 row(s), 1 need action.');
    expect(markdown).toContain('| 2 | `b` | conflicts | — |  | rebase |');
    expect(markdown).toContain('[#7](https://github.com/nanocoai/nanoclaw/pull/7) merged');
  });
});

describe('prLink', () => {
  it('renders a numbered markdown link or a dash', () => {
    expect(prLink('https://github.com/nanocoai/nanoclaw/pull/42')).toBe(
      '[#42](https://github.com/nanocoai/nanoclaw/pull/42)',
    );
    expect(prLink(undefined)).toBe('—');
  });
});
