/**
 * Fixture tests for the "did the author answer?" check in the `answered` job
 * of .github/workflows/stale.yml. That job removes triage labels live from
 * merge, so a false "answered" silently drops a maintainer's request. The
 * tests extract the exact code between the NANOCLAW-STALE-ANSWER markers, so
 * the tested function and the shipped function cannot drift.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface User {
  login: string;
}

interface AnswerInput {
  author: string;
  askedAt: number;
  comments?: Array<{ user: User | null; created_at: string }>;
  reviews?: Array<{ user: User | null; submitted_at: string }>;
  commits?: Array<{
    author: User | null;
    committer: User | null;
    commit: { author: { date: string }; committer: { date: string } };
    parents: Array<{ sha: string }>;
  }>;
  events?: Array<{ event: string; actor: User | null; created_at: string }>;
}

function extractAuthorAnswered(): (input: AnswerInput) => boolean {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'stale.yml'), 'utf8');
  const start = workflow.indexOf('NANOCLAW-STALE-ANSWER-START');
  const end = workflow.indexOf('NANOCLAW-STALE-ANSWER-END');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('NANOCLAW-STALE-ANSWER markers not found in stale.yml');
  }
  // Strip the YAML block-scalar indentation so the code parses standalone.
  const code = workflow
    .slice(start, end)
    .split('\n')
    .slice(1) // drop the START marker line itself
    .map((line) => line.replace(/^ {12}/, ''))
    .join('\n');
  return new Function(`${code}\nreturn authorAnswered;`)() as (input: AnswerInput) => boolean;
}

const authorAnswered = extractAuthorAnswered();

const AUTHOR = 'drive-by-contributor';
const MAINTAINER = 'glifocat';
const ASKED = '2026-10-02T10:58:00Z';
const askedAt = Date.parse(ASKED);
const BEFORE = '2026-09-20T12:00:00Z';
const AFTER = '2026-10-16T11:54:23Z';

const user = (login: string | null): User | null => (login ? { login } : null);

/** A commit as pulls.listCommits returns it, cut to the fields the check may read. */
function commit(opts: {
  author: string | null;
  committer: string | null;
  authored: string;
  committed?: string;
  merge?: boolean;
}) {
  return {
    author: user(opts.author),
    committer: user(opts.committer),
    commit: { author: { date: opts.authored }, committer: { date: opts.committed ?? opts.authored } },
    parents: opts.merge ? [{ sha: 'a' }, { sha: 'b' }] : [{ sha: 'a' }],
  };
}

describe('maintainer activity after the ask is not an answer', () => {
  it('a maintainer "Update branch" merge commit (#1938 shape)', () => {
    const commits = [
      commit({ author: AUTHOR, committer: AUTHOR, authored: '2026-04-23T13:38:59Z' }),
      commit({ author: MAINTAINER, committer: 'web-flow', authored: AFTER, merge: true }),
    ];
    expect(authorAnswered({ author: AUTHOR, askedAt, commits })).toBe(false);
  });

  it('a maintainer merge plus a maintainer commit, original commit unlinked (#1604 shape)', () => {
    const commits = [
      commit({ author: null, committer: null, authored: '2026-04-02T21:53:45Z' }),
      commit({ author: MAINTAINER, committer: MAINTAINER, authored: '2026-10-19T10:15:04Z', merge: true }),
      commit({ author: MAINTAINER, committer: MAINTAINER, authored: '2026-10-19T10:16:25Z' }),
    ];
    expect(authorAnswered({ author: AUTHOR, askedAt, commits })).toBe(false);
  });

  it("a maintainer rebase that re-commits the author's old work", () => {
    const commits = [commit({ author: AUTHOR, committer: MAINTAINER, authored: BEFORE, committed: AFTER })];
    expect(authorAnswered({ author: AUTHOR, askedAt, commits })).toBe(false);
  });

  it('a maintainer rebase with --reset-author-date', () => {
    const commits = [commit({ author: AUTHOR, committer: MAINTAINER, authored: AFTER })];
    const events = [{ event: 'head_ref_force_pushed', actor: user(MAINTAINER), created_at: AFTER }];
    expect(authorAnswered({ author: AUTHOR, askedAt, commits, events })).toBe(false);
  });

  it('a maintainer force-push, comment or review', () => {
    expect(
      authorAnswered({
        author: AUTHOR,
        askedAt,
        events: [{ event: 'head_ref_force_pushed', actor: user(MAINTAINER), created_at: AFTER }],
        comments: [{ user: user(MAINTAINER), created_at: AFTER }],
        reviews: [{ user: user(MAINTAINER), submitted_at: AFTER }],
      }),
    ).toBe(false);
  });
});

describe('author activity', () => {
  it('a commit the author wrote after the ask is an answer', () => {
    const commits = [commit({ author: AUTHOR, committer: AUTHOR, authored: AFTER })];
    expect(authorAnswered({ author: AUTHOR, askedAt, commits })).toBe(true);
  });

  it('the author cherry-picking or rebasing their own older commit after the ask is an answer', () => {
    const commits = [commit({ author: AUTHOR, committer: AUTHOR, authored: BEFORE, committed: AFTER })];
    expect(authorAnswered({ author: AUTHOR, askedAt, commits })).toBe(true);
  });

  it("a commit the author made in GitHub's web editor after the ask is an answer", () => {
    const commits = [commit({ author: AUTHOR, committer: 'web-flow', authored: AFTER })];
    expect(authorAnswered({ author: AUTHOR, askedAt, commits })).toBe(true);
  });

  it('a force-push by the author after the ask is an answer, even with old author dates', () => {
    const commits = [commit({ author: AUTHOR, committer: AUTHOR, authored: BEFORE, committed: AFTER })];
    const events = [{ event: 'head_ref_force_pushed', actor: user(AUTHOR), created_at: AFTER }];
    expect(authorAnswered({ author: AUTHOR, askedAt, commits, events })).toBe(true);
  });

  it('a comment or a review reply by the author after the ask is an answer', () => {
    expect(authorAnswered({ author: AUTHOR, askedAt, comments: [{ user: user(AUTHOR), created_at: AFTER }] })).toBe(
      true,
    );
    expect(authorAnswered({ author: AUTHOR, askedAt, reviews: [{ user: user(AUTHOR), submitted_at: AFTER }] })).toBe(
      true,
    );
  });

  it('author activity from before the ask is not an answer', () => {
    expect(
      authorAnswered({
        author: AUTHOR,
        askedAt,
        comments: [{ user: user(AUTHOR), created_at: BEFORE }],
        reviews: [{ user: user(AUTHOR), submitted_at: BEFORE }],
        commits: [commit({ author: AUTHOR, committer: AUTHOR, authored: BEFORE })],
        events: [{ event: 'head_ref_force_pushed', actor: user(AUTHOR), created_at: BEFORE }],
      }),
    ).toBe(false);
  });
});
