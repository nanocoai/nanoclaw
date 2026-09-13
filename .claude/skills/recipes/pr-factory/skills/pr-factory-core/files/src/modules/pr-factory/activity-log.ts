/**
 * Per-PR activity log — append-only NDJSON files, one per PR.
 *
 * Files live at `data/pr-activity/<owner>/<repo>/<pr-number>.log`.
 * Each line is a JSON object with ts, event, pr, repo, and arbitrary details.
 *
 * Stream live:
 *   tail -f data/pr-activity/<owner>/<repo>/42.log   # single PR
 *   tail -f data/pr-activity/<owner>/<repo>/*.log    # all PRs
 */
import fs from 'fs';
import path from 'path';

const BASE_DIR = path.resolve('data', 'pr-activity');

const dirCache = new Set<string>();

function ensureDir(dir: string): void {
  if (dirCache.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  dirCache.add(dir);
}

export function prLog(prNumber: number, repo: string, event: string, details?: Record<string, unknown>): void {
  // Non-PR-scoped events on installs without PR_FACTORY_DEFAULT_REPO land
  // under a literal "unconfigured" directory rather than corrupting paths.
  const dir = path.join(BASE_DIR, ...(repo ? repo.split('/') : ['unconfigured']));
  ensureDir(dir);

  const entry = {
    ts: new Date().toISOString(),
    event,
    pr: prNumber,
    repo,
    ...details,
  };

  fs.appendFileSync(path.join(dir, `${prNumber}.log`), JSON.stringify(entry) + '\n');
}
