/**
 * The single, structural chokepoint for every Trello API call Maintenance
 * Coordinator's tools make. GET-only by construction, not by convention:
 * the function signature has no `method` or `body` parameter at all, so
 * there is no code path through which a caller could request a write --
 * this isn't a runtime check that could be bypassed, it's a shape nothing
 * else in this file can produce.
 *
 * Host is a literal constant, never built from caller input. The path
 * must match one of a small, explicit allowlist of read-endpoint shapes
 * before any network call happens -- anything else fails closed with an
 * error, never a best-effort request.
 *
 * Credentials are never handled here. Whatever process runs this
 * (Maintenance Coordinator's container) already has its outbound HTTPS
 * traffic proxied through the OneCLI gateway, which injects the Trello
 * key/token at the network layer for requests to api.trello.com -- the
 * same mechanism the existing host-side sync script
 * (scripts/sync-maintenance-trello-cache.ts) already relies on.
 *
 * Ported verbatim from old commit 824318ff -- no DB access, no async
 * adaptation needed.
 */

const TRELLO_HOST = 'api.trello.com';

/** Every endpoint shape this codebase is allowed to call. GET-shaped reads only. */
const ALLOWED_PATHS: RegExp[] = [
  /^\/1\/members\/me\/?$/,
  /^\/1\/members\/me\/boards\/?$/,
  /^\/1\/boards\/[A-Za-z0-9]+\/?$/,
  /^\/1\/cards\/[A-Za-z0-9]+\/?$/,
  /^\/1\/search\/?$/,
];

export class TrelloReadClientError extends Error {}

/**
 * Issue a GET request to the Trello REST API. `path` must match the
 * allowlist above; `params` become query-string parameters. Throws
 * (never silently degrades) on a disallowed path or a non-2xx response.
 */
export async function trelloGet(path: string, params: Record<string, string | undefined> = {}): Promise<unknown> {
  if (!ALLOWED_PATHS.some((re) => re.test(path))) {
    throw new TrelloReadClientError(`trello-read-client: path not on the read-endpoint allowlist: ${path}`);
  }

  const url = new URL(`https://${TRELLO_HOST}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) {
    throw new TrelloReadClientError(`Trello GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}
