/**
 * Resolving a worker's freeform destination text ("East Commerce Ave",
 * "voy a Cecil Street") against the known property/address reference
 * (`properties` + `property_operational_info.aliases`) -- never a fuzzy
 * LLM guess, a deterministic, testable match against durable data.
 *
 * Multiple `properties` rows can share the same address (one row per
 * unit) -- that's not ambiguity, that's normal, and destination
 * suggestions are meant to aggregate across units at one address (see
 * the example in the Trello-read-access proposal: "3 things open there:
 * Apt A -- ..., Apt B -- ..."). Ambiguity means the text plausibly
 * matches more than one DISTINCT address, not more than one unit.
 *
 * Ported from old commit 824318ff, adapted to the async DbDriver
 * (`await getDb().all(...)`).
 */
import { getDb } from '../../db/connection.js';

export interface PropertyMatch {
  id: string;
  canonical_name: string;
  address: string;
  unit: string | null;
}

export type PropertyResolution =
  | { status: 'matched'; address: string; properties: PropertyMatch[] }
  | { status: 'ambiguous'; candidates: PropertyMatch[] }
  | { status: 'no_match' };

/** Text shorter than this never matches anything -- avoids degenerate over-matching on short substrings. */
const MIN_MATCH_LENGTH = 3;

function parseAliases(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

function dedupeById(matches: PropertyMatch[]): PropertyMatch[] {
  const seen = new Map<string, PropertyMatch>();
  for (const m of matches) seen.set(m.id, m);
  return [...seen.values()];
}

export async function findPropertyByFreeText(text: string): Promise<PropertyResolution> {
  const trimmed = text.trim();
  if (trimmed.length < MIN_MATCH_LENGTH) return { status: 'no_match' };
  const needle = trimmed.toLowerCase();

  const db = getDb();
  const all = await db.all<PropertyMatch>('SELECT id, canonical_name, address, unit FROM properties');

  const substringMatches = all.filter((p) => {
    const addr = p.address.toLowerCase();
    const name = p.canonical_name.toLowerCase();
    return addr.includes(needle) || needle.includes(addr) || name.includes(needle) || needle.includes(name);
  });

  const aliasRows = await db.all<{ property_id: string; aliases: string }>(
    'SELECT property_id, aliases FROM property_operational_info',
  );
  const aliasMatchedIds = new Set<string>();
  for (const row of aliasRows) {
    for (const alias of parseAliases(row.aliases)) {
      const a = alias.toLowerCase().trim();
      if (a.length >= MIN_MATCH_LENGTH && (a === needle || a.includes(needle) || needle.includes(a))) {
        aliasMatchedIds.add(row.property_id);
      }
    }
  }
  const aliasMatches = all.filter((p) => aliasMatchedIds.has(p.id));

  const combined = dedupeById([...substringMatches, ...aliasMatches]);
  if (combined.length === 0) return { status: 'no_match' };

  const distinctAddresses = new Set(combined.map((p) => p.address.toLowerCase()));
  if (distinctAddresses.size === 1) {
    return { status: 'matched', address: combined[0].address, properties: combined };
  }
  return { status: 'ambiguous', candidates: combined };
}
