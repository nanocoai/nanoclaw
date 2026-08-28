/**
 * findPropertyByFreeText -- resolving a worker's freeform destination
 * text against the durable properties/aliases reference. Exact/substring
 * address match, alias match, multi-unit-at-one-address is NOT ambiguity,
 * genuinely distinct addresses IS ambiguity, and no match fails closed.
 *
 * Ported from old commit 824318ff, adapted from sync
 * `getDb().prepare(sql).run(...)` to the current async DbDriver
 * (`await getDb().run(...)`); findPropertyByFreeText is now async too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { findPropertyByFreeText } from './properties.js';
// Side-effect: registers the properties/property_operational_info migration.
import '../maintenance-properties/index.js';

function now(): string {
  return new Date().toISOString();
}

async function insertProperty(
  id: string,
  canonicalName: string,
  address: string,
  unit: string | null = null,
): Promise<void> {
  await getDb().run(
    `INSERT INTO properties (id, canonical_name, address, unit, source, synced_at, created_at)
     VALUES (?, ?, ?, ?, 'lease-manager-sync', ?, ?)`,
    id,
    canonicalName,
    address,
    unit,
    now(),
    now(),
  );
}

async function insertAliases(propertyId: string, aliases: string[]): Promise<void> {
  await getDb().run(
    `INSERT INTO property_operational_info (property_id, aliases, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(property_id) DO UPDATE SET aliases = excluded.aliases, updated_at = excluded.updated_at`,
    propertyId,
    JSON.stringify(aliases),
    now(),
  );
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('findPropertyByFreeText — exact and substring address match', () => {
  it('matches on exact address (case-insensitive)', async () => {
    await insertProperty('p1', '115 Edgewood', '115 Edgewood Ave');
    const result = await findPropertyByFreeText('115 edgewood ave');
    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.address).toBe('115 Edgewood Ave');
      expect(result.properties.map((p) => p.id)).toEqual(['p1']);
    }
  });

  it('matches when the destination text is a substring of the stored address', async () => {
    await insertProperty('p1', '115 East Commerce', '115 East Commerce Avenue');
    const result = await findPropertyByFreeText('East Commerce Ave');
    expect(result.status).toBe('matched');
  });

  it('matches when the stored address is a substring of the destination text', async () => {
    await insertProperty('p1', 'Cecil St', 'Cecil Street');
    const result = await findPropertyByFreeText('leaving Cecil Street now');
    expect(result.status).toBe('matched');
  });

  it('no match for unrelated text', async () => {
    await insertProperty('p1', '115 Edgewood', '115 Edgewood Ave');
    const result = await findPropertyByFreeText('999 Nowhere Lane');
    expect(result.status).toBe('no_match');
  });

  it('no match for text shorter than the minimum match length', async () => {
    await insertProperty('p1', 'Ab St', 'Ab Street');
    const result = await findPropertyByFreeText('ab');
    expect(result.status).toBe('no_match');
  });
});

describe('findPropertyByFreeText — alias match', () => {
  it('matches via a registered alias not present in address/canonical_name at all', async () => {
    await insertProperty('p1', '115 Edgewood', '115 Edgewood Avenue');
    await insertAliases('p1', ['The Edgewood house', 'Old Miller place']);
    const result = await findPropertyByFreeText('Old Miller place');
    expect(result.status).toBe('matched');
    if (result.status === 'matched') expect(result.properties.map((p) => p.id)).toEqual(['p1']);
  });

  it('does not match on an alias belonging to a different property', async () => {
    await insertProperty('p1', '115 Edgewood', '115 Edgewood Avenue');
    await insertProperty('p2', '200 Commerce', '200 Commerce Street');
    await insertAliases('p1', ['The Edgewood house']);
    const result = await findPropertyByFreeText('200 Commerce Street');
    expect(result.status).toBe('matched');
    if (result.status === 'matched') expect(result.properties.map((p) => p.id)).toEqual(['p2']);
  });
});

describe('findPropertyByFreeText — multiple units at one address is NOT ambiguity', () => {
  it('aggregates all unit rows sharing the same address into one matched result', async () => {
    await insertProperty('p1', '115 East Commerce Apt A', '115 East Commerce Ave', 'A');
    await insertProperty('p2', '115 East Commerce Apt B', '115 East Commerce Ave', 'B');
    const result = await findPropertyByFreeText('East Commerce Ave');
    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.address).toBe('115 East Commerce Ave');
      expect(result.properties.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    }
  });
});

describe('findPropertyByFreeText — genuinely distinct addresses IS ambiguity', () => {
  it('flags ambiguous when the text plausibly matches two different addresses, never guesses', async () => {
    await insertProperty('p1', 'Commerce North', '115 North Commerce Street');
    await insertProperty('p2', 'Commerce South', '200 South Commerce Street');
    const result = await findPropertyByFreeText('Commerce Street');
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      const addresses = result.candidates.map((c) => c.address);
      expect(addresses).toContain('115 North Commerce Street');
      expect(addresses).toContain('200 South Commerce Street');
    }
  });
});
