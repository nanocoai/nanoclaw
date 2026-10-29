/**
 * Client-side deadline for Telegram's getUpdates long poll.
 *
 * @chat-adapter/telegram long-polls getUpdates with no client-side timeout.
 * When the connection is black-holed (no RST, e.g. after a network blip or a
 * NAT/Wi-Fi change) the request hangs until the kernel gives up on
 * retransmits, about 15 minutes, and no inbound message arrives meanwhile;
 * outbound keeps working on fresh sockets.
 */
/** Slack on top of Telegram's long-poll `timeout` before the request counts as dead. */
const POLL_GRACE_SECONDS = 30;

type TelegramFetch = (method: string, payload?: unknown, request?: { signal?: AbortSignal }) => Promise<unknown>;

/**
 * Abort getUpdates after the long-poll timeout plus a grace period and throw
 * a plain error: the poll loop treats AbortError as "polling stopped" and
 * returns, but backs off and retries on anything else.
 */
export function withPollDeadline(original: TelegramFetch): TelegramFetch {
  return async function (this: unknown, method, payload, request) {
    if (method !== 'getUpdates') return original.call(this, method, payload, request);
    const pollSeconds = Number((payload as { timeout?: unknown } | undefined)?.timeout) || 0;
    const deadlineMs = (pollSeconds + POLL_GRACE_SECONDS) * 1000;
    const controller = new AbortController();
    const outer = request?.signal;
    const forward = () => controller.abort(outer?.reason);
    if (outer?.aborted) forward();
    outer?.addEventListener('abort', forward, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
    try {
      return await original.call(this, method, payload, { ...request, signal: controller.signal });
    } catch (err) {
      if (timedOut && !outer?.aborted) {
        throw new Error(`Telegram getUpdates got no response in ${deadlineMs / 1000}s`, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forward);
    }
  };
}

/**
 * Install the deadline on one adapter instance. The adapter routes every Bot
 * API call through its `telegramFetch` method; only getUpdates is touched.
 * Returns false (and changes nothing) if the method is missing, e.g. after an
 * adapter rewrite — polling then keeps its old, unbounded behavior.
 */
export function installPollDeadline(adapter: object): boolean {
  const target = adapter as { telegramFetch?: unknown };
  if (typeof target.telegramFetch !== 'function') return false;
  target.telegramFetch = withPollDeadline(target.telegramFetch as TelegramFetch);
  return true;
}
