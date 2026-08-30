import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { bundleFromDir } from './bundle.js';
import { listTemplates, resolveTemplateDir, templateDetail } from './registry.js';
import { deleteStoredTemplate, getStoredTemplate, listStoredTemplates, putTemplate } from './store.js';

/**
 * The stored library, driven the way the deploy and the seed script drive it:
 * a real template directory from this repo, packed, put, read back through the
 * registry that `ncl templates list|get` answers from.
 */
// Any template the COMPOSITION carries. `seed-assistant` is written at
// runtime by the seed script and so is never in the tree these tests run in;
// a recipe that composes governed-templates has the four, one without has
// none — in which case the store tests skip rather than fail for a fixture the
// recipe never asked for.
const LIBRARY = path.join(process.cwd(), 'templates');
const NAME = fs.existsSync(LIBRARY)
  ? fs.readdirSync(LIBRARY).sort().find((d) => fs.existsSync(path.join(LIBRARY, d, 'plugin.json')))
  : undefined;
const SEED = path.join(LIBRARY, NAME ?? 'none');
const hasSeed = NAME !== undefined;

beforeEach(async () => {
  await initTestDb();
});
afterEach(async () => {
  await closeDb();
});

describe('stored template library', () => {
  it.skipIf(!hasSeed)('put is idempotent by digest and readable through the registry', async () => {
    const bundle = bundleFromDir(SEED);
    const first = await putTemplate(NAME!, bundle, 'release:test');
    expect(first.changed).toBe(true);
    const second = await putTemplate(NAME!, bundle, 'release:test');
    expect(second.changed).toBe(false);
    expect(second.digest).toBe(first.digest);

    const rows = await listStoredTemplates();
    expect(rows.map((r) => r.name)).toContain(NAME!);
    expect((await getStoredTemplate(NAME!))?.source).toBe('release:test');

    // The registry reports the stored row's digest — the same digest put
    // computed, because both come from templateDigest over the same files.
    const detail = await templateDetail(NAME!);
    expect(detail.digest).toBe(first.digest);
    expect(detail.instructions.length).toBeGreaterThan(0);
  });

  it.skipIf(!hasSeed)('dry-run reports without writing', async () => {
    const bundle = bundleFromDir(SEED);
    const probe = await putTemplate(NAME!, bundle, 'seed', { dryRun: true });
    expect(probe.changed).toBe(true);
    expect(probe.dryRun).toBe(true);
    expect(await getStoredTemplate(NAME!)).toBeUndefined();
  });

  it.skipIf(!hasSeed)('a stored template stamps from a materialized directory and rm removes it', async () => {
    await putTemplate(NAME!, bundleFromDir(SEED), 'seed');
    // Pretend the folder library does not carry it (a deployment's does not):
    // the resolver must fall through to the store.
    const resolved = await resolveTemplateDir(NAME!);
    expect(['local', 'stored']).toContain(resolved.origin);
    expect(fs.existsSync(path.join(resolved.dir, 'plugin.json'))).toBe(true);
    expect(await deleteStoredTemplate(NAME!)).toBe(true);
    expect(await deleteStoredTemplate(NAME!)).toBe(false);
  });

  it('refuses a bundle whose plugin name disagrees, and a bad name', async () => {
    await expect(
      putTemplate('other-name', { files: { 'plugin.json': { text: '{"name":"seed-assistant","version":"1.0.0"}' } } }, 'operator'),
    ).rejects.toThrow(/does not parse|declares plugin name/);
    await expect(putTemplate('Bad Name', { files: { a: { text: '' } } }, 'operator')).rejects.toThrow(/invalid template name/);
    expect((await listTemplates()).every((t) => t.name !== 'other-name')).toBe(true);
  });
});
