/**
 * Append-only record of destination-based Trello suggestions actually
 * shown to a worker -- what's used to decide whether the same suggestion
 * would just be a repeat ("nagging") versus something that's changed and
 * is worth mentioning again. Durable on purpose (see
 * module-maintenance-trello-suggestion-log.ts) rather than living in
 * conversational memory, which doesn't survive a container respawn.
 *
 * Dedup is keyed on `destination_key`, not `property_id` -- a worker's
 * destination doesn't always resolve to a row in `properties` (the raw-text
 * Trello fallback searches on destinations that never will), so
 * `destination_key` is the one key that always exists:
 *   - resolved property: `property:<property_id>` -- `property_id` is also
 *     kept on the row (nullable now) for auditing/future property
 *     intelligence, but it is never the dedup key itself.
 *   - unresolved/raw-text destination: `raw:<normalized text>`,
 *     `property_id` NULL. Never a fabricated `properties` row just to
 *     satisfy a FK.
 *
 * Ported from old commit 824318ff, adapted to the async DbDriver
 * (`await getDb().run/get`). No migration here -- the trello_suggestion_log
 * table itself is deferred to the Trello schema slice of Priority 5, so
 * these functions are not yet reachable until that migration lands; the
 * dedup logic itself is unaffected either way.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';

export interface TrelloSuggestionRecord {
  id: string;
  worker_user_id: string;
  property_id: string | null;
  destination_key: string;
  card_ids: string[];
  shown_at: string;
}

/**
 * Normalizes worker-reported destination text into a stable raw dedup key.
 * Deliberately conservative -- trims, lowercases, collapses whitespace, and
 * drops only trailing sentence punctuation. Never infers or rewrites street
 * names (no abbreviation expansion, no fuzzy merge) -- two genuinely
 * different destinations must never collapse onto the same key.
 */
export function normalizeRawDestination(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:]+$/g, '')
    .trim();
}

/** Dedup key for a destination that resolved to a known property. */
export function propertyDestinationKey(propertyId: string): string {
  return `property:${propertyId}`;
}

/** Dedup key for a destination that did not resolve to any known property. */
export function rawDestinationKey(text: string): string {
  return `raw:${normalizeRawDestination(text)}`;
}

export async function recordTrelloSuggestion(
  workerUserId: string,
  destinationKey: string,
  cardIds: string[],
  propertyId?: string | null,
): Promise<void> {
  await getDb().run(
    `INSERT INTO trello_suggestion_log (id, worker_user_id, property_id, destination_key, card_ids, shown_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    randomUUID(),
    workerUserId,
    propertyId ?? null,
    destinationKey,
    JSON.stringify(cardIds),
    new Date().toISOString(),
  );
}

/** Most recent suggestion shown to this worker for this destination, or undefined if none yet. */
export async function getLatestTrelloSuggestion(
  workerUserId: string,
  destinationKey: string,
): Promise<TrelloSuggestionRecord | undefined> {
  const row = await getDb().get<{
    id: string;
    worker_user_id: string;
    property_id: string | null;
    destination_key: string;
    card_ids: string;
    shown_at: string;
  }>(
    `SELECT id, worker_user_id, property_id, destination_key, card_ids, shown_at
     FROM trello_suggestion_log
     WHERE worker_user_id = ? AND destination_key = ?
     ORDER BY shown_at DESC LIMIT 1`,
    workerUserId,
    destinationKey,
  );
  if (!row) return undefined;
  return { ...row, card_ids: JSON.parse(row.card_ids) as string[] };
}

/**
 * True if `currentCardIds` is exactly the same set already shown most
 * recently for this worker+destination -- i.e. nothing has changed, so a
 * fresh suggestion would just be a repeat. An empty current set is never
 * treated as "same as last time" even if the last suggestion was also
 * empty -- there's nothing to suppress if there's nothing to say.
 */
export async function isRepeatSuggestion(
  workerUserId: string,
  destinationKey: string,
  currentCardIds: string[],
): Promise<boolean> {
  if (currentCardIds.length === 0) return false;
  const latest = await getLatestTrelloSuggestion(workerUserId, destinationKey);
  if (!latest) return false;
  const prev = new Set(latest.card_ids);
  const curr = new Set(currentCardIds);
  if (prev.size !== curr.size) return false;
  for (const id of curr) if (!prev.has(id)) return false;
  return true;
}
