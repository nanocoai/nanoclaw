/**
 * Thin PostHog emitter shared across setup:auto code. Fire-and-forget —
 * never throws, never blocks. Reuses data/install-id (same file bash
 * uses in setup/lib/diagnostics.sh) so events from the bash and node
 * halves of a single install join into one funnel.
 *
 * Honors NANOCLAW_NO_DIAGNOSTICS=1.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { readChannelSetting } from '../../scripts/update/channel.js';

const POSTHOG_KEY = 'phc_fx1Hhx9ucz8GuaJC8LVZWO8u03yXZZJJ6ObS4yplnaP';
const POSTHOG_URL = 'https://us.i.posthog.com/capture/';
const INSTALL_ID_PATH = path.join('data', 'install-id');
/** Set by nanoclaw.sh (diagnostics.sh) and inherited by retries and the `sg docker` re-exec. */
export const RUN_ID_ENV = 'NANOCLAW_SETUP_RUN_ID';

let cached: string | null = null;
let cachedVersion: string | null = null;

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

function nanoclawVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const { version } = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { version?: unknown };
    cachedVersion = typeof version === 'string' && version ? version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

function releaseChannel(): string {
  try {
    return readChannelSetting(process.cwd(), process.env.NANOCLAW_UPDATE_CHANNEL || undefined);
  } catch {
    return 'unknown';
  }
}

/** Fields every event carries; diagnostics.sh sends the same set. */
function commonProps(): Record<string, string> {
  if (!process.env[RUN_ID_ENV]) process.env[RUN_ID_ENV] = randomUUID().toLowerCase();
  return {
    platform: process.platform,
    arch: process.arch,
    nanoclaw_version: nanoclawVersion(),
    release_channel: releaseChannel(),
    run_id: process.env[RUN_ID_ENV]!,
  };
}

/**
 * curl runs in its own process, started before emit() returns, so the event
 * survives a process.exit() or a spawnSync right after the call. An in-process
 * fetch was dropped in both cases.
 */
function send(body: string): void {
  try {
    const child = spawn(
      'curl',
      ['-sS', '--max-time', '3', '-X', 'POST', POSTHOG_URL, '-H', 'Content-Type: application/json', '-d', body],
      { detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true },
    );
    child.on('error', () => sendWithFetch(body));
    child.unref();
  } catch {
    sendWithFetch(body);
  }
}

/** No curl on PATH: in-process send, which still loses events on an immediate exit. */
function sendWithFetch(body: string): void {
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

export function emit(
  event: string,
  props: Record<string, string | number | boolean | undefined> = {},
  opts: { persistId?: boolean } = {},
): void {
  if (process.env.NANOCLAW_NO_DIAGNOSTICS === '1') return;

  const cleaned: Record<string, unknown> = commonProps();
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

  send(body);
}
