#!/usr/bin/env bun
/**
 * gh.ts — the maintainer template's GitHub helper (Bun, no dependencies).
 *
 * Everything deterministic lives here: fetching issues and pull requests,
 * shaping the `state` TypeSafe judges, picking dedupe candidates by title
 * similarity, matching CODEOWNERS, composing the backlog digest, and the two
 * write actions the persona allows (labels, an upserted marker comment).
 * Judgments come from `typesafe-judge`; prose comes from the agent.
 *
 * Auth: requests carry no Authorization header. The credential gateway
 * injects the GitHub credential connected for api.github.com. A 401/403 means
 * the operator has not connected GitHub yet; the onecli-gateway skill says
 * what to do (present the connect link, never ask for a token).
 *
 * There is deliberately no close, merge, assign, or request-review command.
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const API = 'https://api.github.com';
export const DEFAULT_REPO = 'nanocoai/nanoclaw';
export const BODY_LIMIT = 12_000;
export const FILE_LIMIT = 300;
export const PR_TEMPLATE_MARKER = 'nanoclaw-pr-template:v2';
export const PR_TEMPLATE_SECTIONS = [
  'Summary',
  'Related work',
  'Change kind',
  'Validation',
  'User and release impact',
  'Security and trust boundaries',
  'Skill delivery',
  'AI assistance',
] as const;
const RUBRICS_PATH = new URL('../rubrics/labels.json', import.meta.url);

export interface Rubrics {
  area: { criteria: Record<string, string> };
  kind: { criteria: Record<string, string> };
  priority: { labels: string[]; criteria: string[] };
  needs_repro: { instructions: string; criteria: Record<string, string> };
  pr_ready: { instructions: string; criteria: Record<string, string> };
}

export function loadRubrics(path: string | URL = RUBRICS_PATH): Rubrics {
  return JSON.parse(readFileSync(path, 'utf8')) as Rubrics;
}

// ---------------------------------------------------------------------------
// GitHub fetch
// ---------------------------------------------------------------------------

type Fetch = typeof fetch;

async function gh<T>(path: string, fetchImpl: Fetch, init: RequestInit = {}): Promise<T> {
  const res = await fetchImpl(`${API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nanoclaw maintainer-template',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`GitHub returned ${res.status} for ${path}: the api.github.com credential is not connected in the gateway (or lacks scope)`);
  }
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function ghPages<T>(path: string, fetchImpl: Fetch, limit: number, keep: (row: T) => boolean = () => true): Promise<T[]> {
  const out: T[] = [];
  const joiner = path.includes('?') ? '&' : '?';
  for (let page = 1; out.length < limit && page <= 10; page++) {
    const batch = await gh<T[]>(`${path}${joiner}per_page=100&page=${page}`, fetchImpl);
    out.push(...batch.filter(keep));
    if (batch.length < 100) break;
  }
  return out.slice(0, limit);
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  author_association?: string;
  labels?: { name: string }[];
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  comments?: number;
  draft?: boolean;
  user?: { login: string };
  pull_request?: unknown;
}

export interface IssueState {
  repository: string;
  item_type: 'issue' | 'pull_request';
  number: number;
  title: string;
  body: string;
  author: string;
  author_association: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  comment_count: number;
  url: string;
}

export interface PullState extends IssueState {
  draft: boolean;
  changed_files: string[];
  changed_file_count: number;
  /** True when `changed_files` is a prefix of the real list; scope judgments must not act on it. */
  changed_files_truncated: boolean;
  template: TemplateStatus;
}

export function normalizeIssue(raw: RawIssue, repo: string): IssueState {
  return {
    repository: repo,
    item_type: raw.pull_request ? 'pull_request' : 'issue',
    number: raw.number,
    title: raw.title ?? '',
    body: (raw.body ?? '').slice(0, BODY_LIMIT),
    author: raw.user?.login ?? '',
    author_association: raw.author_association ?? 'NONE',
    labels: (raw.labels ?? []).map((l) => l.name).sort(),
    created_at: raw.created_at ?? '',
    updated_at: raw.updated_at ?? '',
    comment_count: raw.comments ?? 0,
    url: raw.html_url ?? '',
  };
}

/** Sections the PR template says may be deleted when they do not apply. */
export const OPTIONAL_TEMPLATE_SECTIONS = new Set(['Related work', 'User and release impact', 'Skill delivery']);

export interface TemplateStatus {
  nanoclaw_template_marker_present: boolean;
  /** `omitted` is an optional section that was deleted, which the template allows; `missing` is a required one. */
  sections: Record<string, 'filled' | 'empty' | 'missing' | 'omitted'>;
  headings_in_body: string[];
}

/** Which PR-template sections carry real content (placeholders and unchecked boxes do not count). */
export function templateStatus(body: string | null | undefined): TemplateStatus {
  const text = body ?? '';
  const marker = text.includes(PR_TEMPLATE_MARKER);
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '');
  const headings = [...stripped.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => m[1]).slice(0, 40);
  const content = new Map<string, string>();
  for (const chunk of stripped.split(/^##\s+/m).slice(1)) {
    const nl = chunk.indexOf('\n');
    const heading = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
    content.set(heading, nl === -1 ? '' : chunk.slice(nl + 1));
  }
  const sections: TemplateStatus['sections'] = {};
  for (const name of PR_TEMPLATE_SECTIONS) {
    const rest = content.get(name);
    if (rest === undefined) {
      sections[name] = OPTIONAL_TEMPLATE_SECTIONS.has(name) ? 'omitted' : 'missing';
      continue;
    }
    const lines = rest
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !l.startsWith('- [ ]') &&
          !/^#{3,6}\s/.test(l) &&
          l !== '```release-note' &&
          l !== '```' &&
          !l.startsWith('Optional: one user-facing line') &&
          l !== 'Closes #',
      );
    sections[name] = lines.length ? 'filled' : 'empty';
  }
  return { nanoclaw_template_marker_present: marker, sections, headings_in_body: headings };
}

export async function fetchIssue(repo: string, n: number, fetchImpl: Fetch): Promise<IssueState> {
  return normalizeIssue(await gh<RawIssue>(`/repos/${repo}/issues/${n}`, fetchImpl), repo);
}

export async function fetchPull(repo: string, n: number, fetchImpl: Fetch): Promise<PullState> {
  const raw = await gh<RawIssue>(`/repos/${repo}/pulls/${n}`, fetchImpl);
  const files = await ghPages<{ filename: string }>(`/repos/${repo}/pulls/${n}/files`, fetchImpl, FILE_LIMIT + 1);
  const base = normalizeIssue({ ...raw, pull_request: true }, repo);
  return {
    ...base,
    draft: Boolean(raw.draft),
    changed_files: files.map((f) => f.filename).slice(0, FILE_LIMIT),
    changed_file_count: files.length,
    changed_files_truncated: files.length > FILE_LIMIT,
    template: templateStatus(raw.body),
  };
}

export async function fetchOpenIssues(repo: string, limit: number, fetchImpl: Fetch): Promise<IssueState[]> {
  // The issues endpoint interleaves pull requests; filter per page so the limit counts real issues.
  const raw = await ghPages<RawIssue>(`/repos/${repo}/issues?state=open&sort=updated&direction=desc`, fetchImpl, limit, (r) => !r.pull_request);
  return raw.map((r) => normalizeIssue(r, repo));
}

export async function fetchOpenPulls(repo: string, limit: number, fetchImpl: Fetch): Promise<IssueState[]> {
  const raw = await ghPages<RawIssue>(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc`, fetchImpl, limit);
  return raw.map((r) => normalizeIssue({ ...r, pull_request: true }, repo));
}

// ---------------------------------------------------------------------------
// Requests for typesafe-judge
// ---------------------------------------------------------------------------

function subject(isPr: boolean): string {
  return isPr ? '`title`, `body` and `changed_files`' : '`title` and `body`';
}

export function labelQuestions(rubrics: Rubrics, isPr: boolean): Record<string, unknown> {
  const what = isPr ? 'pull request' : 'issue';
  return {
    area: {
      type: 'choice',
      instructions: `Which single NanoClaw subsystem does this ${what} primarily belong to, judging from ${subject(isPr)}? Pick the one area a maintainer would file it under.`,
      criteria: rubrics.area.criteria,
    },
    kind: {
      type: 'choice',
      instructions: `What kind of change or report is this ${what}, judging from ${subject(isPr)}?`,
      criteria: rubrics.kind.criteria,
    },
    priority: {
      type: 'score',
      instructions: `How urgent is this ${what} for NanoClaw maintainers, judging from the impact described in ${subject(isPr)}?`,
      criteria: rubrics.priority.criteria,
    },
  };
}

export function triageRequest(state: IssueState, rubrics: Rubrics): { state: IssueState; questions: Record<string, unknown> } {
  return {
    state,
    questions: {
      ...labelQuestions(rubrics, false),
      needs_repro: { type: 'noul', instructions: rubrics.needs_repro.instructions, criteria: rubrics.needs_repro.criteria },
    },
  };
}

export function routeRequest(state: PullState, rubrics: Rubrics): { state: PullState; questions: Record<string, unknown> } {
  return {
    state,
    questions: {
      ...labelQuestions(rubrics, true),
      pr_ready: { type: 'noul', instructions: rubrics.pr_ready.instructions, criteria: rubrics.pr_ready.criteria },
      scope_matches_title: {
        type: 'noul',
        instructions:
          'Do `changed_files` stay within the scope a reader would expect from `title` and the Summary in `body`? Unrelated files, drive-by refactors, or a second feature mean no. If `changed_files_truncated` is true the list is incomplete: answer no.',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Dedupe candidates
// ---------------------------------------------------------------------------

const STOP = new Set(
  'a an and are as at be by for from in is it of on or that the this to with when after before not no does doesnt cant can will into over via using use'.split(' '),
);

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[`'"“”‘’]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}

/** Jaccard similarity over title tokens, with a small bonus for shared body tokens. */
export function similarity(a: { title: string; body?: string }, b: { title: string; body?: string }): number {
  const ta = tokens(a.title);
  const tb = tokens(b.title);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const titleScore = shared / (ta.size + tb.size - shared);
  const ba = tokens((a.body ?? '').slice(0, 2000));
  const bb = tokens((b.body ?? '').slice(0, 2000));
  let bodyShared = 0;
  for (const t of ba) if (bb.has(t)) bodyShared++;
  const bodyScore = ba.size && bb.size ? bodyShared / Math.min(ba.size, bb.size) : 0;
  return titleScore * 0.8 + bodyScore * 0.2;
}

export function rankCandidates<T extends { number: number; title: string; body?: string }>(issue: T, pool: T[], top = 30): (T & { similarity: number })[] {
  return pool
    .filter((c) => c.number !== issue.number)
    .map((c) => ({ ...c, similarity: Number(similarity(issue, c).toFixed(3)) }))
    .sort((x, y) => y.similarity - x.similarity || x.number - y.number)
    .slice(0, top);
}

export function similarRequest(issue: IssueState, candidates: (IssueState & { similarity: number })[]) {
  const state = {
    repository: issue.repository,
    issue: { number: issue.number, title: issue.title, body: issue.body.slice(0, 6000) },
    candidates: candidates.map((c) => ({ number: c.number, title: c.title, excerpt: c.body.slice(0, 600), labels: c.labels })),
  };
  const questions: Record<string, unknown> = {};
  candidates.forEach((c, i) => {
    questions[`same_as_${c.number}`] = {
      type: 'noul',
      instructions: `Does \`issue\` report the same defect or request as \`candidates[${i}]\` (issue #${c.number}: "${c.title.replace(/"/g, "'")}")? Same root cause or same requested capability means yes; merely the same area or similar wording means no.`,
      criteria: {
        true: 'Fixing or implementing one would resolve the other; they describe the same failure, symptom chain, or requested behavior.',
        false: 'Different defects or requests that happen to share a subsystem, a word, or an error family.',
      },
    };
  });
  return { state, questions };
}

// ---------------------------------------------------------------------------
// Reviewer suggestion: CODEOWNERS first, recent authors second
// ---------------------------------------------------------------------------

export interface OwnerRule {
  pattern: string;
  owners: string[];
}

export function parseCodeowners(text: string): OwnerRule[] {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { pattern, owners: owners.map((o) => o.replace(/^@/, '')) };
    });
}

function globToRegExp(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, ' ').replace(/\*/g, '[^/]*').replace(/ /g, '.*');
  const prefix = anchored ? '^' : '(^|/)';
  const suffix = dirOnly || !p.includes('.') ? '(/.*)?$' : '$';
  return new RegExp(`${prefix}${escaped}${suffix}`);
}

/** Last matching rule wins per file, as GitHub applies CODEOWNERS. */
export function matchCodeowners(rules: OwnerRule[], files: string[]): Record<string, string[]> {
  const byOwner: Record<string, Set<string>> = {};
  for (const file of files) {
    let winner: OwnerRule | undefined;
    for (const rule of rules) if (globToRegExp(rule.pattern).test(file)) winner = rule;
    if (!winner) continue;
    for (const owner of winner.owners) (byOwner[owner] ??= new Set()).add(file);
  }
  return Object.fromEntries(Object.entries(byOwner).map(([o, s]) => [o, [...s].sort()]));
}

export interface ReviewerCandidate {
  login: string;
  reason: string;
  files: string[];
}

export async function reviewerCandidates(repo: string, pr: PullState, fetchImpl: Fetch): Promise<ReviewerCandidate[]> {
  const out: ReviewerCandidate[] = [];
  try {
    const res = await gh<{ content?: string; encoding?: string }>(`/repos/${repo}/contents/.github/CODEOWNERS`, fetchImpl);
    if (res.content && res.encoding === 'base64') {
      const owned = matchCodeowners(parseCodeowners(Buffer.from(res.content, 'base64').toString('utf8')), pr.changed_files);
      for (const [login, files] of Object.entries(owned)) {
        if (login.toLowerCase() === pr.author.toLowerCase()) continue;
        out.push({ login, reason: 'CODEOWNERS', files });
      }
    }
  } catch (err) {
    if (!(err instanceof Error && /404/.test(err.message))) throw err;
  }
  if (out.length > 0) return out.sort((a, b) => b.files.length - a.files.length);
  const counts = new Map<string, Set<string>>();
  for (const file of pr.changed_files.slice(0, 10)) {
    const commits = await gh<{ author?: { login?: string } | null }[]>(
      `/repos/${repo}/commits?path=${encodeURIComponent(file)}&per_page=5`,
      fetchImpl,
    );
    for (const c of commits) {
      const login = c.author?.login;
      if (!login || login.toLowerCase() === pr.author.toLowerCase() || login.endsWith('[bot]')) continue;
      (counts.get(login) ?? counts.set(login, new Set()).get(login)!).add(file);
    }
  }
  return [...counts.entries()]
    .map(([login, files]) => ({ login, reason: 'recent author of touched files', files: [...files].sort() }))
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, 3);
}

// ---------------------------------------------------------------------------
// Backlog digest
// ---------------------------------------------------------------------------

export interface BacklogItem {
  number: number;
  title: string;
  url: string;
  labels: string[];
  updated_at: string;
  comment_count: number;
  /** Absent when the judge withheld: the digest then ranks the item as unknown, never as low or high. */
  priority?: { score: number; level: string; confidence: number };
  needs_repro?: number;
}

/** The proposal floor a priority answer must clear before the digest uses it (typesafe-judge's default --propose). */
export const DIGEST_PRIORITY_FLOOR = 0.6;

export function daysSince(iso: string, now = Date.now()): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : 0;
}

/** Composite rank: priority dominates, staleness and missing evidence adjust. Weights are the maintainer's to tune. */
export function rankScore(item: BacklogItem, now = Date.now()): number {
  const priority = item.priority ? (item.priority.score / 3) * item.priority.confidence : 0.25;
  const stale = Math.min(1, daysSince(item.updated_at, now) / 180);
  const evidenceGap = item.needs_repro ?? 0;
  return Number((priority * 0.7 + stale * 0.2 - evidenceGap * 0.1).toFixed(3));
}

export function composeDigest(items: BacklogItem[], now = Date.now()): string {
  const ranked = [...items].map((i) => ({ ...i, rank: rankScore(i, now), stale_days: daysSince(i.updated_at, now) })).sort((a, b) => b.rank - a.rank);
  const line = (i: (typeof ranked)[number]) =>
    `- #${i.number} ${i.title} — ${i.priority ? `${i.priority.level} (${i.priority.confidence.toFixed(2)})` : 'priority unknown'}, ${i.stale_days}d quiet` +
    (i.needs_repro !== undefined && i.needs_repro >= 0.7 ? ', needs repro' : '') +
    (i.labels.includes('triage/unresolved') ? ', untriaged' : '');
  const top = ranked.slice(0, 10);
  // Only a known low priority qualifies for the closure list; an unknown one is not "low".
  const stale = ranked.filter((i) => i.stale_days >= 90 && i.priority !== undefined && i.priority.score < 1.5).slice(0, 10);
  const untriaged = ranked.filter((i) => i.labels.includes('triage/unresolved')).length;
  const uncertain = ranked.filter((i) => i.priority === undefined).length;
  return [
    `## Backlog digest (${items.length} open issues scanned)`,
    '',
    '### Act on next',
    ...(top.length ? top.map(line) : ['- nothing ranked']),
    '',
    '### Quiet and low priority (candidates for the maintainer to close; the agent never closes)',
    ...(stale.length ? stale.map(line) : ['- none']),
    '',
    `Untriaged: ${untriaged}. Priority withheld by the judge (ranked as unknown): ${uncertain}. ` +
      'Ranking = 0.7·priority·confidence + 0.2·staleness − 0.1·missing-repro.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Writes: labels and one upserted comment per skill
// ---------------------------------------------------------------------------

export async function addLabels(repo: string, n: number, labels: string[], fetchImpl: Fetch): Promise<void> {
  if (labels.length === 0) return;
  await gh(`/repos/${repo}/issues/${n}/labels`, fetchImpl, { method: 'POST', body: JSON.stringify({ labels }) });
}

export async function removeLabel(repo: string, n: number, label: string, fetchImpl: Fetch): Promise<void> {
  try {
    await gh(`/repos/${repo}/issues/${n}/labels/${encodeURIComponent(label)}`, fetchImpl, { method: 'DELETE' });
  } catch (err) {
    if (!(err instanceof Error && /404/.test(err.message))) throw err; // already absent
  }
}

export function markerFor(skill: string): string {
  return `<!-- maintainer:${skill} -->`;
}

/** The login the gateway's GitHub credential acts as; undefined when the token cannot read /user (an app installation token). */
export async function currentLogin(fetchImpl: Fetch): Promise<string | undefined> {
  try {
    const me = await gh<{ login?: string }>('/user', fetchImpl);
    return me.login || undefined;
  } catch (err) {
    if (err instanceof Error && /returned 40[13]/.test(err.message)) return undefined;
    throw err;
  }
}

/**
 * Create or update the single comment carrying this skill's marker. A marker
 * quoted by someone else is not ours: the match requires our own login when
 * the credential can tell us who we are, and otherwise a comment that starts
 * with the marker (the shape this helper writes, not the shape a quote takes).
 */
export async function upsertComment(repo: string, n: number, skill: string, body: string, fetchImpl: Fetch): Promise<'created' | 'updated'> {
  const marker = markerFor(skill);
  const full = `${marker}\n${body.trim()}\n`;
  const me = await currentLogin(fetchImpl);
  const comments = await ghPages<{ id: number; body?: string; user?: { login?: string } }>(`/repos/${repo}/issues/${n}/comments`, fetchImpl, 2000);
  const existing = comments.find((c) =>
    me ? c.user?.login === me && (c.body ?? '').includes(marker) : (c.body ?? '').startsWith(marker),
  );
  if (existing) {
    await gh(`/repos/${repo}/issues/comments/${existing.id}`, fetchImpl, { method: 'PATCH', body: JSON.stringify({ body: full }) });
    return 'updated';
  }
  await gh(`/repos/${repo}/issues/${n}/comments`, fetchImpl, { method: 'POST', body: JSON.stringify({ body: full }) });
  return 'created';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `gh.ts — GitHub helper for the maintainer template (reads by default; writes only labels and marker comments)

  bun gh.ts triage-request <issue>            → {state, questions} for triage-issues (pipe into typesafe-judge --gate)
  bun gh.ts route-request <pr>                → {state, questions} for route-pr, state includes reviewer_candidates
  bun gh.ts similar-request <issue> [--top 30] [--pool 300]
                                              → {state, questions} with one noul per candidate for dedupe-issues
  bun gh.ts backlog-requests [--limit 60]     → NDJSON: one {state, questions} per open issue for rank-backlog
  bun gh.ts digest <results.ndjson>           → Markdown digest from lines of {"state":..., "answers":..., "gate":...} (typesafe-judge --gate output merged with state)
  bun gh.ts issue <n> | pr <n>                → the normalized state alone
  bun gh.ts labels <n> --add a,b --remove c,d → add and remove labels (idempotent)
  bun gh.ts comment <n> --skill <name> --body-file <file>
                                              → create or update the one comment carrying <!-- maintainer:<name> -->

Options: --repo owner/name (default ${DEFAULT_REPO}). Auth is injected by the gateway.`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function needNumber(v: string | undefined, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} must be a positive integer`);
  return n;
}

export async function main(argv: string[], fetchImpl: Fetch, out: (s: string) => void): Promise<number> {
  const [cmd, ...rest] = argv;
  const repo = flag(rest, '--repo') ?? DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo must be owner/name');
  const rubrics = loadRubrics();
  switch (cmd) {
    case 'issue':
      out(JSON.stringify(await fetchIssue(repo, needNumber(rest[0], 'issue number'), fetchImpl), null, 2) + '\n');
      return 0;
    case 'pr':
      out(JSON.stringify(await fetchPull(repo, needNumber(rest[0], 'pr number'), fetchImpl), null, 2) + '\n');
      return 0;
    case 'triage-request': {
      const state = await fetchIssue(repo, needNumber(rest[0], 'issue number'), fetchImpl);
      out(JSON.stringify(triageRequest(state, rubrics)) + '\n');
      return 0;
    }
    case 'route-request': {
      const pr = await fetchPull(repo, needNumber(rest[0], 'pr number'), fetchImpl);
      const reviewers = await reviewerCandidates(repo, pr, fetchImpl);
      const req = routeRequest(pr, rubrics);
      out(JSON.stringify({ ...req, state: { ...req.state, reviewer_candidates: reviewers } }) + '\n');
      return 0;
    }
    case 'similar-request': {
      const n = needNumber(rest[0], 'issue number');
      const top = Number(flag(rest, '--top') ?? 30);
      const pool = Number(flag(rest, '--pool') ?? 300);
      const issue = await fetchIssue(repo, n, fetchImpl);
      const open = await fetchOpenIssues(repo, pool, fetchImpl);
      const candidates = rankCandidates(issue, open, top);
      out(JSON.stringify(similarRequest(issue, candidates)) + '\n');
      return 0;
    }
    case 'backlog-requests': {
      const limit = Number(flag(rest, '--limit') ?? 60);
      for (const issue of await fetchOpenIssues(repo, limit, fetchImpl)) {
        const req = triageRequest(issue, rubrics);
        out(JSON.stringify({ state: req.state, questions: { priority: req.questions.priority, needs_repro: req.questions.needs_repro } }) + '\n');
      }
      return 0;
    }
    case 'digest': {
      const file = rest[0];
      if (!file || !existsSync(file)) throw new Error('digest needs a results NDJSON file');
      const items: BacklogItem[] = [];
      for (const line of readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())) {
        const r = JSON.parse(line) as {
          state: IssueState;
          answers: Record<string, { score?: number; legend?: Record<string, string>; confidence?: number; noul?: number }>;
          gate?: Record<string, { decision?: string }>;
        };
        const p = r.answers?.priority;
        // Honor the judge's gate when present; otherwise apply the same proposal floor here.
        const withheld = r.gate?.priority ? r.gate.priority.decision === 'withhold' : (p?.confidence ?? 0) < DIGEST_PRIORITY_FLOOR;
        items.push({
          number: r.state.number,
          title: r.state.title,
          url: r.state.url,
          labels: r.state.labels,
          updated_at: r.state.updated_at,
          comment_count: r.state.comment_count,
          ...(p && !withheld && typeof p.score === 'number' && typeof p.confidence === 'number'
            ? {
                priority: {
                  score: p.score,
                  level: rubrics.priority.labels[Math.max(0, Math.min(3, Math.floor(p.score + 0.5)))],
                  confidence: p.confidence,
                },
              }
            : {}),
          ...(typeof r.answers?.needs_repro?.noul === 'number' ? { needs_repro: r.answers.needs_repro.noul } : {}),
        });
      }
      out(composeDigest(items) + '\n');
      return 0;
    }
    case 'labels': {
      const n = needNumber(rest[0], 'item number');
      const add = (flag(rest, '--add') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const remove = (flag(rest, '--remove') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      await addLabels(repo, n, add, fetchImpl);
      for (const l of remove) await removeLabel(repo, n, l, fetchImpl);
      out(JSON.stringify({ number: n, added: add, removed: remove }) + '\n');
      return 0;
    }
    case 'comment': {
      const n = needNumber(rest[0], 'item number');
      const skill = flag(rest, '--skill');
      const bodyFile = flag(rest, '--body-file');
      if (!skill || !/^[a-z0-9-]+$/.test(skill)) throw new Error('--skill must be a kebab-case skill name');
      if (!bodyFile || !existsSync(bodyFile)) throw new Error('--body-file must point at an existing file');
      const result = await upsertComment(repo, n, skill, readFileSync(bodyFile, 'utf8'), fetchImpl);
      out(JSON.stringify({ number: n, skill, comment: result }) + '\n');
      return 0;
    }
    case undefined:
    case '-h':
    case '--help':
      out(USAGE + '\n');
      return 0;
    default:
      throw new Error(`unknown command ${cmd}\n${USAGE}`);
  }
}

const invokedDirectly = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2), (...args) => fetch(...args), (s) => process.stdout.write(s)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
