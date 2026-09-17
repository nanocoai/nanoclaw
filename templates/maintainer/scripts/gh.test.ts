/**
 * Tests for the maintainer template's GitHub helper (bun:test, mocked fetch).
 * Run: `cd templates/maintainer/scripts && bun test`.
 */
import { describe, expect, it } from 'bun:test';

import {
  composeDigest,
  fetchOpenIssues,
  fetchPull,
  loadRubrics,
  matchCodeowners,
  parseCodeowners,
  rankCandidates,
  rankScore,
  reviewerCandidates,
  routeRequest,
  similarRequest,
  templateStatus,
  triageRequest,
  upsertComment,
  type IssueState,
  type PullState,
} from './gh.ts';

const NOW = Date.parse('2026-09-17T00:00:00Z');

function issue(n: number, title: string, extra: Partial<IssueState> = {}): IssueState {
  return {
    repository: 'nanocoai/nanoclaw',
    item_type: 'issue',
    number: n,
    title,
    body: '',
    author: 'someone',
    author_association: 'NONE',
    labels: [],
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    comment_count: 0,
    url: `https://github.com/nanocoai/nanoclaw/issues/${n}`,
    ...extra,
  };
}

function fakeFetch(routes: Record<string, (init?: RequestInit, url?: string) => { status?: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) return new Response('{"message":"Not Found"}', { status: 404 });
    const r = routes[key](init, u);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe('templateStatus', () => {
  it('reports filled, empty and missing sections and ignores placeholders', () => {
    const body = [
      '<!-- nanoclaw-pr-template:v2 -->',
      '## Summary',
      'Fixes the thing.',
      '## Related work',
      'Closes #',
      '## Change kind',
      '- [ ] `kind/bug`',
      '- [x] `kind/feature`',
      '## Validation',
      '```release-note',
      'Optional: one user-facing line for the changelog. Skip it and a maintainer will write one.',
      '```',
    ].join('\n');
    const s = templateStatus(body);
    expect(s.nanoclaw_template_marker_present).toBe(true);
    expect(s.sections.Summary).toBe('filled');
    expect(s.sections['Related work']).toBe('empty');
    expect(s.sections['Change kind']).toBe('filled');
    expect(s.sections.Validation).toBe('empty');
    expect(s.sections['AI assistance']).toBe('missing');
    // Optional sections the template allows deleting are reported as omitted, not missing.
    expect(s.sections['User and release impact']).toBe('omitted');
    expect(s.sections['Skill delivery']).toBe('omitted');
  });
});

describe('requests', () => {
  const rubrics = loadRubrics();

  it('triage asks area, kind, priority and needs_repro with the rubric options', () => {
    const req = triageRequest(issue(1, 'Container never starts'), rubrics);
    expect(Object.keys(req.questions)).toEqual(['area', 'kind', 'priority', 'needs_repro']);
    const area = req.questions.area as { criteria: Record<string, string> };
    expect(Object.keys(area.criteria)).toContain('area/core');
    expect(Object.keys(area.criteria)).toHaveLength(16);
    const priority = req.questions.priority as { type: string; criteria: string[] };
    expect(priority.type).toBe('score');
    expect(priority.criteria).toHaveLength(4);
  });

  it('route adds pr_ready and scope_matches_title over the PR state', () => {
    const pr: PullState = { ...issue(2, 'fix: thing'), item_type: 'pull_request', draft: false, changed_files: ['src/a.ts'], changed_file_count: 1, changed_files_truncated: false, template: templateStatus('') };
    const req = routeRequest(pr, rubrics);
    expect(Object.keys(req.questions)).toEqual(['area', 'kind', 'priority', 'pr_ready', 'scope_matches_title']);
  });

  it('similar builds one noul per candidate, most similar first, never the issue itself', () => {
    const me = issue(10, 'Container exits with code 137 after update', { body: 'docker exit 137 memory' });
    const pool = [
      me,
      issue(11, 'Docs typo in README'),
      issue(12, 'Container killed with exit 137 on update', { body: 'exit 137 after nanoclaw.sh' }),
      issue(13, 'Slack adapter drops threads'),
      issue(14, 'After update the container exits 137'),
    ];
    const cands = rankCandidates(me, pool, 2);
    // #14 shares four of five title tokens; #12 shares three plus a body bonus.
    expect(cands.map((c) => c.number)).toEqual([14, 12]);
    expect(cands[0].similarity).toBeGreaterThan(cands[1].similarity);
    const req = similarRequest(me, cands);
    expect(Object.keys(req.questions)).toEqual(['same_as_14', 'same_as_12']);
    expect((req.state as { candidates: unknown[] }).candidates).toHaveLength(2);
  });
});

describe('CODEOWNERS', () => {
  const rules = parseCodeowners(['# comment', '/src/ @alice @bob', '/container/ @alice', '/.claude/skills/', '*.md @docs'].join('\n'));

  it('parses rules and drops comments', () => {
    expect(rules).toHaveLength(4);
    expect(rules[0]).toEqual({ pattern: '/src/', owners: ['alice', 'bob'] });
    expect(rules[2]).toEqual({ pattern: '/.claude/skills/', owners: [] });
  });

  it('matches files with last-rule-wins and groups by owner', () => {
    // `*.md @docs` is the last rule, so it wins for every .md file, including one under the ownerless skills path.
    const owned = matchCodeowners(rules, ['src/index.ts', 'container/Dockerfile', '.claude/skills/x/SKILL.md', '.claude/skills/x/run.sh', 'docs/a.md']);
    expect(owned).toEqual({ alice: ['container/Dockerfile', 'src/index.ts'], bob: ['src/index.ts'], docs: ['.claude/skills/x/SKILL.md', 'docs/a.md'] });
  });

  it('suggests CODEOWNERS first and excludes the PR author', async () => {
    const codeowners = Buffer.from('/src/ @alice @bob\n').toString('base64');
    const { fetch } = fakeFetch({
      '/contents/.github/CODEOWNERS': () => ({ body: { content: codeowners, encoding: 'base64' } }),
    });
    const pr: PullState = { ...issue(3, 't'), item_type: 'pull_request', author: 'bob', draft: false, changed_files: ['src/a.ts'], changed_file_count: 1, changed_files_truncated: false, template: templateStatus('') };
    const r = await reviewerCandidates('o/r', pr, fetch);
    expect(r).toEqual([{ login: 'alice', reason: 'CODEOWNERS', files: ['src/a.ts'] }]);
  });

  it('falls back to recent authors of the touched files when no CODEOWNERS matches', async () => {
    const { fetch } = fakeFetch({
      '/contents/.github/CODEOWNERS': () => ({ status: 404, body: {} }),
      '/commits?path=': () => ({ body: [{ author: { login: 'carol' } }, { author: { login: 'bob' } }, { author: { login: 'dep[bot]' } }] }),
    });
    const pr: PullState = { ...issue(3, 't'), item_type: 'pull_request', author: 'bob', draft: false, changed_files: ['src/a.ts'], changed_file_count: 1, changed_files_truncated: false, template: templateStatus('') };
    const r = await reviewerCandidates('o/r', pr, fetch);
    expect(r).toEqual([{ login: 'carol', reason: 'recent author of touched files', files: ['src/a.ts'] }]);
  });
});

describe('fetchPull', () => {
  it('normalizes the PR and its files and sends no Authorization header', async () => {
    const { fetch, calls } = fakeFetch({
      '/pulls/7/files': () => ({ body: [{ filename: 'src/a.ts' }, { filename: 'docs/b.md' }] }),
      '/pulls/7': () => ({ body: { number: 7, title: 'feat: x', body: '## Summary\nDoes x.', draft: true, user: { login: 'zed' }, labels: [{ name: 'core-team' }] } }),
    });
    const pr = await fetchPull('o/r', 7, fetch);
    expect(pr.item_type).toBe('pull_request');
    expect(pr.draft).toBe(true);
    expect(pr.changed_files).toEqual(['src/a.ts', 'docs/b.md']);
    expect(pr.template.sections.Summary).toBe('filled');
    for (const c of calls) expect(Object.keys((c.init?.headers as Record<string, string>) ?? {})).not.toContain('Authorization');
  });

  it('flags a truncated file list so scope judgments cannot act on a prefix', async () => {
    const many = Array.from({ length: 301 }, (_, i) => ({ filename: i === 300 ? 'src/credentials.ts' : `docs/${i}.md` }));
    const { fetch } = fakeFetch({
      '/pulls/8/files': (_init, url) => {
        const page = Number(/[?&]page=(\d+)/.exec(url ?? '')?.[1] ?? 1);
        return { body: many.slice((page - 1) * 100, page * 100) };
      },
      '/pulls/8': () => ({ body: { number: 8, title: 't', body: '', user: { login: 'zed' } } }),
    });
    const pr = await fetchPull('o/r', 8, fetch);
    expect(pr.changed_files).toHaveLength(300);
    expect(pr.changed_file_count).toBe(301);
    expect(pr.changed_files_truncated).toBe(true);
    expect(pr.changed_files).not.toContain('src/credentials.ts');
  });

  it('counts real issues, not pull requests, toward the open-issue limit', async () => {
    const { fetch } = fakeFetch({
      '/issues?state=open': () => ({
        body: Array.from({ length: 100 }, (_, i) => (i < 60 ? { number: i, title: `pr ${i}`, pull_request: {} } : { number: i, title: `issue ${i}` })),
      }),
    });
    const issues = await fetchOpenIssues('o/r', 20, fetch);
    expect(issues).toHaveLength(20);
    expect(issues.every((i) => i.item_type === 'issue')).toBe(true);
  });

  it('turns 401 into an actionable error', async () => {
    const { fetch } = fakeFetch({ '/pulls/7': () => ({ status: 401, body: {} }) });
    await expect(fetchPull('o/r', 7, fetch)).rejects.toThrow(/not connected in the gateway/);
  });
});

describe('digest', () => {
  it('ranks priority first, then staleness, and lists quiet low-priority items separately', () => {
    const items = [
      { number: 1, title: 'critical thing', url: '', labels: [], updated_at: '2026-09-15T00:00:00Z', comment_count: 2, priority: { score: 2.8, level: 'priority/critical', confidence: 0.9 } },
      { number: 2, title: 'old cosmetic', url: '', labels: ['triage/unresolved'], updated_at: '2026-01-01T00:00:00Z', comment_count: 0, priority: { score: 0.2, level: 'priority/low', confidence: 0.8 }, needs_repro: 0.9 },
      { number: 3, title: 'unknown', url: '', labels: [], updated_at: '2026-09-16T00:00:00Z', comment_count: 0 },
      { number: 4, title: 'old but uncertain', url: '', labels: [], updated_at: '2026-01-01T00:00:00Z', comment_count: 0 },
    ];
    expect(rankScore(items[0], NOW)).toBeGreaterThan(rankScore(items[1], NOW));
    const md = composeDigest(items, NOW);
    const actIdx = md.indexOf('#1 critical thing');
    const oldIdx = md.indexOf('#2 old cosmetic');
    expect(actIdx).toBeGreaterThan(-1);
    expect(actIdx).toBeLessThan(oldIdx);
    expect(md).toContain('needs repro');
    expect(md).toContain('Untriaged: 1');
    expect(md.split('### Quiet and low priority')[1]).toContain('#2 old cosmetic');
    // An unknown priority is not "low": #4 is quiet but must not be offered for closure.
    expect(md.split('### Quiet and low priority')[1]).not.toContain('#4 old but uncertain');
    expect(md).toContain('Priority withheld by the judge (ranked as unknown): 2');
    expect(md).toContain('never closes');
  });
});

describe('upsertComment', () => {
  it('updates only our own comment carrying the marker, never a human comment that quotes it', async () => {
    const { fetch, calls } = fakeFetch({
      '/user': () => ({ body: { login: 'maintainer-bot' } }),
      '/issues/comments/55': () => ({ body: {} }),
      '/issues/9/comments': (init) =>
        init?.method === 'POST'
          ? { body: { id: 99 } }
          : {
              body: [
                { id: 53, body: 'quoting <!-- maintainer:triage-issues --> here', user: { login: 'human' } },
                { id: 54, body: 'hi', user: { login: 'maintainer-bot' } },
                { id: 55, body: '<!-- maintainer:triage-issues -->\nold', user: { login: 'maintainer-bot' } },
              ],
            },
    });
    expect(await upsertComment('o/r', 9, 'triage-issues', 'new text', fetch)).toBe('updated');
    const patch = calls.find((c) => c.init?.method === 'PATCH');
    expect(patch?.url).toContain('/issues/comments/55');
    expect(JSON.parse(String(patch?.init?.body)).body).toBe('<!-- maintainer:triage-issues -->\nnew text\n');
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('creates the comment when no marker is present', async () => {
    const { fetch, calls } = fakeFetch({
      '/user': () => ({ body: { login: 'maintainer-bot' } }),
      '/issues/9/comments': (init) => (init?.method === 'POST' ? { body: { id: 99 } } : { body: [] }),
    });
    expect(await upsertComment('o/r', 9, 'route-pr', 'text', fetch)).toBe('created');
    expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
  });

  it('without a readable /user, matches only comments that start with the marker', async () => {
    const { fetch, calls } = fakeFetch({
      '/user': () => ({ status: 403, body: {} }),
      '/issues/comments/61': () => ({ body: {} }),
      '/issues/9/comments': (init) =>
        init?.method === 'POST'
          ? { body: { id: 99 } }
          : { body: [{ id: 60, body: 'see <!-- maintainer:route-pr --> above' }, { id: 61, body: '<!-- maintainer:route-pr -->\nold' }] },
    });
    expect(await upsertComment('o/r', 9, 'route-pr', 'text', fetch)).toBe('updated');
    expect(calls.find((c) => c.init?.method === 'PATCH')?.url).toContain('/issues/comments/61');
  });
});
