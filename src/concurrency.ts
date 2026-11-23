/**
 * Bounded-concurrency map with per-item isolation. `fn` runs over `items`
 * with at most `limit` calls in flight; results come back in input order as
 * settled results, so one failing item never hides the others' outcomes and
 * the caller decides what a rejection means.
 *
 * The host's per-session loops (delivery polls, the sweep's workqueue) fan
 * over hundreds of session mailboxes. Against a remote mailbox each visit is
 * independent network IO that should overlap; the limit keeps a burst from
 * opening unbounded connections and keeps a slow key from monopolizing the
 * loop.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      /* eslint-disable no-catch-all/no-catch-all -- isolation is the point: every rejection is returned to the caller as a settled result */
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
