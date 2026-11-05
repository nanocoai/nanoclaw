/**
 * Thin PostHog emitter shared across setup:auto code. Fire-and-forget —
 * never throws, never blocks. Reuses data/install-id (same file bash
 * uses in setup/lib/diagnostics.sh) so events from the bash and node
 * halves of a single install join into one funnel.
 *
 * Honors NANOCLAW_NO_DIAGNOSTICS=1.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const POSTHOG_KEY = 'phc_fx1Hhx9ucz8GuaJC8LVZWO8u03yXZZJJ6ObS4yplnaP';
const POSTHOG_URL = 'https://us.i.posthog.com/capture/';
const INSTALL_ID_PATH = path.join('data', 'install-id');

let cached: string | null = null;

/**
 * `persist: false` reads an existing id but never creates `data/install-id`
 * — required by the uninstall path, which must not mutate the filesystem
 * before (or instead of) removing it. Events in one process still join:
 * the generated id is cached.
 */
export function installId(persist = true): string {
  if (cached) return cached;
  try {
    const existing = fs.readFileSync(INSTALL_ID_PATH, 'utf-8').trim();
    if (existing) {
      cached = existing;
      return existing;
    }
  } catch {
    // fall through to create
  }
  const id = randomUUID().toLowerCase();
  if (persist) {
    try {
      fs.mkdirSync(path.dirname(INSTALL_ID_PATH), { recursive: true });
      fs.writeFileSync(INSTALL_ID_PATH, id);
    } catch {
      // best-effort; still return the id so the event fires
    }
  }
  cached = id;
  return id;
}

export function emit(
  event: string,
  props: Record<string, string | number | boolean | undefined> = {},
  opts: { persistId?: boolean } = {},
): void {
  if (process.env.NANOCLAW_NO_DIAGNOSTICS === '1') return;

  const cleaned: Record<string, unknown> = { platform: process.platform };
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    cleaned[k] = v;
  }

  const body = JSON.stringify({
    api_key: POSTHOG_KEY,
    event,
    distinct_id: installId(opts.persistId !== false),
    properties: cleaned,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  void fetch(POSTHOG_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: ctrl.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}
