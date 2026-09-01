/**
 * The S3 mailbox wire protocol — the only things the Host store and the agent
 * runner's store MUST agree on.
 *
 * These two stores are separate implementations over one bucket: the Host
 * serves many sessions and both sides, the agent serves one session and writes
 * only its own replies. That split is deliberate and worth keeping. What is
 * not worth keeping is two copies of the layout they share, because a
 * divergence there does not fail — it goes quiet. An agent that bumps a
 * pointer the Host never reads simply delivers late, with nothing to notice.
 *
 * So the shared surface lives here, in one canonical file with no imports,
 * mirrored byte-for-byte into the runner tree as `wire.generated.ts` — the
 * same discipline `src/mailbox/model.ts` already uses for the record model,
 * pinned by a test that compares the two files.
 *
 * Everything in here is a pure function of strings. Keep it that way: the
 * moment this file needs an import, the mirror stops being a copy.
 */

export type MailboxWireSide = 'inbound' | 'outbound';

/** Envelope version stamped into protocol objects this file owns. */
export const S3_MAILBOX_WIRE_VERSION = 1;

/**
 * How long a side may go on pointer answers alone before it lists for real.
 *
 * The change pointer is an optimisation, never the record: a writer that
 * stores objects and then dies before bumping would otherwise be invisible for
 * as long as nobody else writes. This bounds that window.
 *
 * Expressed in TIME, not in refreshes, and that is the load-bearing part. A
 * count ties the reconcile rate to the poll rate, so polling faster to cut
 * latency would multiply the listings this design exists to remove — the
 * saving would quietly fund its own undoing. In time, the two are independent:
 * poll as fast as latency wants, list as rarely as safety allows.
 */
export const LISTING_RECONCILE_AFTER_MS = 60_000;

/**
 * The per-side change pointer.
 *
 * It carries a token and nothing else — deliberately not the object list. With
 * a list, a writer whose flush lands between another writer's refresh and its
 * flush is dropped from the list that gets written, and its messages go unread
 * until a reconcile. With a token, every write rewrites the pointer, every
 * rewrite changes the ETag, and every changed ETag sends the reader to the
 * listing that was always authoritative. The optimisation can cost a listing;
 * it can never hide an object.
 */
export function changePointerKey(sessionPrefix: string, side: MailboxWireSide): string {
  return `${trimSlashes(sessionPrefix)}/meta/${side}-change.json`;
}

/** The body of a change pointer. Only its ETag is ever read; the token exists
 *  to guarantee a new ETag on every write, including a rewrite by the same
 *  writer with otherwise identical content. */
export function changePointerBody(token: string): string {
  return JSON.stringify({ version: S3_MAILBOX_WIRE_VERSION, token });
}

/** Conditional-read headers for a pointer whose version we may already hold. */
export function changePointerReadHeaders(knownEtag: string | null): Record<string, string> {
  return knownEtag ? { 'if-none-match': knownEtag } : {};
}

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
