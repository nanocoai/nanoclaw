/**
 * Telegram polling-collision detection.
 *
 * The Telegram Bot API enforces an exclusive polling session per token —
 * concurrent `getUpdates` calls return HTTP 409 with a
 * `Conflict: terminated by other getUpdates request` description. The
 * `@chat-adapter/telegram` SDK reports this as a generic `ValidationError`
 * (its 400-499 catch-all bucket) or as a `NetworkError` when the failure
 * is connection-level — both indistinguishable from real transient
 * issues, which the surrounding `withRetry` then masks by retrying for
 * 30+ seconds before throwing.
 *
 * Detect the collision up-front via a one-shot probe (`getUpdates`
 * with `timeout=0`) so the adapter setup fails fast with a message that
 * points at the actual problem: another live client is holding the bot's
 * polling session. The most common cause is an orphaned dev process
 * running alongside the systemd-managed host — see the single-instance
 * lock PR for the upstream root-cause fix.
 *
 * `isTelegramPollingCollision(err)` is exported so the `withRetry`
 * wrapper can also short-circuit if a 409 surfaces from `bridge.setup`
 * directly (defence-in-depth).
 */
import { log } from '../log.js';

const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramPollingCollisionError extends Error {
  constructor(public readonly description: string) {
    super(
      `Telegram bot polling session is already held by another client ` +
        `(${description}). The most likely cause is a duplicate NanoClaw ` +
        `host or another process polling the same bot token. Stop the other ` +
        `client and try again.`,
    );
    this.name = 'TelegramPollingCollisionError';
  }
}

/**
 * Heuristic: is this error a Telegram polling-session collision?
 *
 * Three shapes we recognise:
 *
 * 1. Our own `TelegramPollingCollisionError` (from `probeBotPollingFreedom`).
 * 2. A chat-adapter error with a `Conflict` description — the SDK's
 *    `ValidationError` (mapped from 400-499) carrying Telegram's text.
 * 3. Any error whose message mentions `409` or `Conflict: terminated by
 *    other getUpdates` — a defensive catch-all in case the SDK changes
 *    its error class.
 */
export function isTelegramPollingCollision(err: unknown): boolean {
  if (err instanceof TelegramPollingCollisionError) return true;
  if (!(err instanceof Error)) return false;
  const message = err.message || '';
  if (/\bConflict\b/i.test(message) && /getUpdates/i.test(message)) return true;
  if (/\b409\b/.test(message) && /telegram/i.test(message)) return true;
  return false;
}

/**
 * Internal: parse a probe response. Exposed for tests so we don't need a
 * fetch mock with full Response semantics.
 */
export function classifyProbeResponse(status: number, body: unknown): TelegramPollingCollisionError | null {
  if (status !== 409) return null;
  const description =
    typeof body === 'object' && body !== null && 'description' in body
      ? String((body as { description: unknown }).description ?? '')
      : '';
  return new TelegramPollingCollisionError(description || 'Conflict reported by Telegram');
}

/**
 * Retry a one-shot setup operation that can fail on transient network
 * errors at cold-start (DNS hiccups, brief upstream outages). Exponential
 * backoff capped at `maxAttempts` (default 5) — if the network is truly
 * down we surface the error instead of hanging the service indefinitely.
 *
 * Polling-collision errors (HTTP 409 from `getUpdates`) skip the retry
 * loop entirely. Retrying a 409 just stretches a deterministic failure
 * across 30+ seconds for no benefit; whoever is holding the bot's polling
 * session will keep holding it.
 */
export async function withSetupRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isTelegramPollingCollision(err)) {
        log.error('Telegram bot polling session is held by another client — failing fast', {
          label,
          err,
        });
        break;
      }
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * One-shot probe of the bot's polling session.
 *
 * Calls `getUpdates` with `timeout=0` and `offset=-1`. Telegram answers
 * immediately with either:
 *   - 200 OK + `[]`        — nobody else is polling, safe to start
 *   - 409 Conflict + body  — another client is polling
 *   - network-level error  — best-effort: log and continue (the real setup
 *                            will retry properly; we don't want a transient
 *                            DNS hiccup to block startup)
 *
 * `offset=-1` discards any pending updates (we'd rather drop a few than
 * accidentally consume the in-flight ones from the running adapter).
 *
 * @throws {TelegramPollingCollisionError} when Telegram returns 409.
 */
export async function probeBotPollingFreedom(token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = `${TELEGRAM_API}/bot${token}/getUpdates`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeout: 0, offset: -1 }),
    });
  } catch (err) {
    // Network-level failure on the probe itself — don't block startup.
    // The actual bridge.setup will retry with proper backoff.
    log.warn('Telegram polling probe network error — proceeding to bridge.setup', { err });
    return;
  }

  if (response.status === 409) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Body wasn't JSON — fall through with an empty description.
    }
    const collision = classifyProbeResponse(response.status, body);
    if (collision) throw collision;
  }
  // Other non-200s aren't our concern — bridge.setup will surface real
  // problems (auth, etc.) with proper context.
}
