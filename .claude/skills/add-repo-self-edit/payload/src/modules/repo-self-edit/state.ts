/**
 * On-disk state shared by the host module and the watchdog script: the
 * in-flight lock (one self-edit at a time) and the result marker the
 * watchdog leaves for the next host boot. Both live under `data/`, which is
 * gitignored and outside every editable path.
 */
import fs from 'fs';
import path from 'path';

/** Stale after this long — a watchdog that died mid-run must not block edits forever. */
const LOCK_STALE_MS = 30 * 60 * 1000;

export function repoRoot(): string {
  return process.cwd();
}

export function lockPath(root: string): string {
  return path.join(root, 'data', 'repo-self-edit.lock');
}

export function resultPath(root: string): string {
  return path.join(root, 'data', 'repo-self-edit-result.json');
}

export function isLocked(root: string): boolean {
  try {
    return Date.now() - fs.statSync(lockPath(root)).mtimeMs < LOCK_STALE_MS;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missing lock is the unlocked state
  } catch {
    return false;
  }
}

export function takeLock(root: string, sha: string): void {
  fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
  fs.writeFileSync(lockPath(root), `${sha}\n`);
}

export function releaseLock(root: string): void {
  fs.rmSync(lockPath(root), { force: true });
}

export interface WatchdogResult {
  ok: boolean;
  sessionId: string;
  newSha: string;
  revertSha: string | null;
  detail: string;
}

/** Read and delete the watchdog's result marker. */
export function takeResult(root: string): WatchdogResult | null {
  const file = resultPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WatchdogResult;
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable marker is dropped, never retried
  } catch {
    return null;
  } finally {
    fs.rmSync(file, { force: true });
  }
}
