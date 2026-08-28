/**
 * trello_suggestion_log -- append-only history of what Trello suggestions
 * were actually shown to which worker for which destination, and the dedup
 * logic that reads it: same card set as last time -> repeat, suppress;
 * new/changed card set -> fresh, worth mentioning.
 *
 * Dedup is keyed on `destination_key`, which covers both a resolved
 * property (`property:<id>`) and a raw-text destination that never matched
 * anything in `properties` (`raw:<normalized text>`) -- the raw-text
 * Trello-fallback path this table originally couldn't record at all.
 *
 * Ported from old commit 824318ff, adapted from sync
 * `getDb().prepare(sql).run/get(...)` to the current async DbDriver
 * (`await getDb().run/get(...)`); every function under test is now async.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import {
  getLatestTrelloSuggestion,
  isRepeatSuggestion,
  normalizeRawDestination,
  propertyDestinationKey,
  rawDestinationKey,
  recordTrelloSuggestion,
} from './trello-suggestion-log.js';
// Side-effect: registers trello_suggestion_log's migration (this module)
// and properties/property_operational_info's (maintenance-properties).
import './index.js';
import '../maintenance-properties/index.js';

const IVAN = 'telegram:900000002';
const ELEHAZAR = 'telegram:900000001';

function now(): string {
  return new Date().toISOString();
}

async function insertProperty(id: string): Promise<void> {
  await getDb().run(
    `INSERT INTO properties (id, canonical_name, address, unit, source, synced_at, created_at) VALUES (?, 'Test Property', 'Test Address', NULL, 'lease-manager-sync', ?, ?)`,
    id,
    now(),
    now(),
  );
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await insertProperty('p1');
  await insertProperty('p2');
});

afterEach(async () => {
  await closeDb();
});

describe('normalizeRawDestination / rawDestinationKey', () => {
  it('trims, lowercases, and collapses whitespace', () => {
    expect(normalizeRawDestination('  Cecil Street  ')).toBe('cecil street');
    expect(normalizeRawDestination('Cecil    Street')).toBe('cecil street');
  });

  it('drops trailing sentence punctuation only', () => {
    expect(normalizeRawDestination('Cecil Street.')).toBe('cecil street');
    expect(normalizeRawDestination('Cecil Street!')).toBe('cecil street');
  });

  it('does not merge genuinely different destinations', () => {
    expect(normalizeRawDestination('Cecil Street')).not.toBe(normalizeRawDestination('Cecil Ave'));
    expect(normalizeRawDestination('114 S Cecil Street')).not.toBe(normalizeRawDestination('Cecil Street'));
  });

  it('" CECIL STREET " normalizes to the same key as "cecil street"', () => {
    expect(rawDestinationKey(' CECIL STREET ')).toBe(rawDestinationKey('cecil street'));
    expect(rawDestinationKey(' CECIL STREET ')).toBe('raw:cecil street');
  });
});

describe('propertyDestinationKey / rawDestinationKey shape', () => {
  it('property keys are prefixed distinctly from raw keys', () => {
    expect(propertyDestinationKey('p1')).toBe('property:p1');
    expect(rawDestinationKey('p1')).toBe('raw:p1');
    expect(propertyDestinationKey('p1')).not.toBe(rawDestinationKey('p1'));
  });
});

describe('recordTrelloSuggestion / getLatestTrelloSuggestion', () => {
  it('returns undefined when nothing has been recorded yet', async () => {
    expect(await getLatestTrelloSuggestion(IVAN, propertyDestinationKey('p1'))).toBeUndefined();
  });

  it('resolved property destination: records with destination_key = property:<id> and keeps property_id', async () => {
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1', 'card-2'], 'p1');
    const latest = await getLatestTrelloSuggestion(IVAN, propertyDestinationKey('p1'));
    expect(latest).toBeDefined();
    expect(latest?.destination_key).toBe('property:p1');
    expect(latest?.property_id).toBe('p1');
    expect(latest?.card_ids).toEqual(['card-1', 'card-2']);
  });

  it('unmatched raw-text destination: records with destination_key = raw:<normalized text> and NULL property_id', async () => {
    await recordTrelloSuggestion(IVAN, rawDestinationKey('Cecil Street'), ['card-9']);
    const latest = await getLatestTrelloSuggestion(IVAN, 'raw:cecil street');
    expect(latest).toBeDefined();
    expect(latest?.destination_key).toBe('raw:cecil street');
    expect(latest?.property_id).toBeNull();
    expect(latest?.card_ids).toEqual(['card-9']);
  });

  it('append-only: recording twice keeps both rows, latest lookup returns the newer one', async () => {
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1'], 'p1');
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1', 'card-2'], 'p1');
    const rows = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM trello_suggestion_log');
    expect(rows!.n).toBe(2);
    expect((await getLatestTrelloSuggestion(IVAN, propertyDestinationKey('p1')))?.card_ids).toEqual([
      'card-1',
      'card-2',
    ]);
  });

  it('keeps different workers separate', async () => {
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1'], 'p1');
    expect(await getLatestTrelloSuggestion(ELEHAZAR, propertyDestinationKey('p1'))).toBeUndefined();
  });

  it('keeps different properties separate for the same worker', async () => {
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1'], 'p1');
    expect(await getLatestTrelloSuggestion(IVAN, propertyDestinationKey('p2'))).toBeUndefined();
  });

  it('keeps different raw destinations separate for the same worker', async () => {
    await recordTrelloSuggestion(IVAN, rawDestinationKey('Cecil Street'), ['card-1']);
    expect(await getLatestTrelloSuggestion(IVAN, rawDestinationKey('Wilfred Ave'))).toBeUndefined();
  });

  it('a resolved property key and a raw key never collide even with confusingly similar text', async () => {
    // A property id that happens to equal the normalized text of a raw
    // destination must not be reachable via the raw lookup, and vice versa
    // -- the "property:" / "raw:" prefix is what keeps them apart.
    await insertProperty('cecil street');
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('cecil street'), ['card-prop'], 'cecil street');
    await recordTrelloSuggestion(IVAN, rawDestinationKey('cecil street'), ['card-raw']);

    expect((await getLatestTrelloSuggestion(IVAN, propertyDestinationKey('cecil street')))?.card_ids).toEqual([
      'card-prop',
    ]);
    expect((await getLatestTrelloSuggestion(IVAN, rawDestinationKey('cecil street')))?.card_ids).toEqual([
      'card-raw',
    ]);
  });

  it('property_id remains FK-checked when present', async () => {
    await expect(
      recordTrelloSuggestion(IVAN, propertyDestinationKey('does-not-exist'), ['card-1'], 'does-not-exist'),
    ).rejects.toThrow();
  });

  it('a raw-text destination never requires (or creates) a properties row', async () => {
    const before = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM properties'))!.n;
    await recordTrelloSuggestion(IVAN, rawDestinationKey('Some Street Nobody Synced'), ['card-1']);
    const after = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM properties'))!.n;
    expect(after).toBe(before);
  });
});

describe('isRepeatSuggestion', () => {
  it('is false when nothing was shown before', async () => {
    expect(await isRepeatSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1'])).toBe(false);
  });

  it('is true when the exact same card set was just shown (resolved property)', async () => {
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1', 'card-2'], 'p1');
    expect(await isRepeatSuggestion(IVAN, propertyDestinationKey('p1'), ['card-2', 'card-1'])).toBe(true); // order-independent
  });

  it('repeated raw-text destination with the same card set suppresses the repeat', async () => {
    const key = rawDestinationKey('Cecil Street');
    await recordTrelloSuggestion(IVAN, key, ['card-9']);
    expect(await isRepeatSuggestion(IVAN, key, ['card-9'])).toBe(true);
    expect(await isRepeatSuggestion(IVAN, rawDestinationKey('CECIL STREET'), ['card-9'])).toBe(true);
  });

  it('a changed/new card set at the same raw destination allows a fresh suggestion', async () => {
    const key = rawDestinationKey('Cecil Street');
    await recordTrelloSuggestion(IVAN, key, ['card-9']);
    expect(await isRepeatSuggestion(IVAN, key, ['card-9', 'card-10'])).toBe(false);
  });

  it('is false when a new card has appeared since last shown', async () => {
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1'], 'p1');
    expect(await isRepeatSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1', 'card-2'])).toBe(false);
  });

  it('is false when a previously-shown card is no longer present (something changed)', async () => {
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1', 'card-2'], 'p1');
    expect(await isRepeatSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1'])).toBe(false);
  });

  it('is false for an empty current set even if the last suggestion was also empty', async () => {
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('p1'), [], 'p1');
    expect(await isRepeatSuggestion(IVAN, propertyDestinationKey('p1'), [])).toBe(false);
  });

  it('never cross-suppresses across different workers', async () => {
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1'], 'p1');
    expect(await isRepeatSuggestion(ELEHAZAR, propertyDestinationKey('p1'), ['card-1'])).toBe(false);
  });

  it('never cross-suppresses across different properties', async () => {
    await recordTrelloSuggestion(IVAN, propertyDestinationKey('p1'), ['card-1'], 'p1');
    expect(await isRepeatSuggestion(IVAN, propertyDestinationKey('p2'), ['card-1'])).toBe(false);
  });

  it('never cross-suppresses across different raw destinations', async () => {
    await recordTrelloSuggestion(IVAN, rawDestinationKey('Cecil Street'), ['card-1']);
    expect(await isRepeatSuggestion(IVAN, rawDestinationKey('Wilfred Ave'), ['card-1'])).toBe(false);
  });

  it('never cross-suppresses across different workers at the same raw destination', async () => {
    await recordTrelloSuggestion(IVAN, rawDestinationKey('Cecil Street'), ['card-1']);
    expect(await isRepeatSuggestion(ELEHAZAR, rawDestinationKey('Cecil Street'), ['card-1'])).toBe(false);
  });
});
