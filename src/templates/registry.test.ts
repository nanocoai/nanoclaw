import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetRegistryStateForTest,
  ensureTemplateLocal,
  fetchRegistryIndex,
  REGISTRY_INDEX_FAILURE_TTL_MS,
  REGISTRY_INDEX_TTL_MS,
  type ClonedRegistry,
} from './registry.js';

const COMMIT = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

let base: string;
let cloneDir: string;

/** A fake registry clone carrying sales/sdr, with a cleanup spy. */
function fakeClone(): ClonedRegistry {
  return { dir: cloneDir, commit: COMMIT, cleanup: vi.fn<() => void>() };
}

beforeEach(() => {
  _resetRegistryStateForTest();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-registry-base-'));
  cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-registry-clone-'));
  fs.mkdirSync(path.join(cloneDir, 'sales', 'sdr'), { recursive: true });
  fs.writeFileSync(path.join(cloneDir, 'sales', 'sdr', 'plugin.json'), '{"name":"sdr"}');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(cloneDir, { recursive: true, force: true });
});

describe('ensureTemplateLocal', () => {
  it('returns the existing local copy without cloning', async () => {
    fs.mkdirSync(path.join(base, 'sales', 'sdr'), { recursive: true });
    const clone = vi.fn();

    const result = await ensureTemplateLocal('sales/sdr', { baseDir: base, deps: { clone } });

    expect(result).toEqual({ ref: 'sales/sdr', dir: path.join(base, 'sales', 'sdr'), source: 'local' });
    expect(result.commit).toBeUndefined();
    expect(clone).not.toHaveBeenCalled();
  });

  it('rejects an invalid ref before any work', async () => {
    const clone = vi.fn();
    await expect(ensureTemplateLocal('a/../b', { baseDir: base, deps: { clone } })).rejects.toThrow(/Invalid/);
    expect(clone).not.toHaveBeenCalled();
  });

  // Pins the in-flight-first ordering in ensureTemplateLocal: the second
  // caller must join the first clone, never observe a partially materialized
  // templates/<ref> and report it as 'local'.
  it('clones once for two concurrent same-ref calls, both seeing the registry result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = fakeClone();
    const clone = vi.fn(async () => {
      await gate;
      return registry;
    });

    const first = ensureTemplateLocal('sales/sdr', { baseDir: base, deps: { clone } });
    const second = ensureTemplateLocal('sales/sdr', { baseDir: base, deps: { clone } });
    release();
    const results = await Promise.all([first, second]);

    expect(clone).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.source).toBe('registry');
      expect(result.commit).toBe(COMMIT);
    }
    expect(fs.existsSync(path.join(base, 'sales', 'sdr', 'plugin.json'))).toBe(true);
    expect(registry.cleanup).toHaveBeenCalled();
  });

  it('cleans up the clone dir when the ref is missing from the registry', async () => {
    const registry = fakeClone();
    const clone = vi.fn(async () => registry);

    await expect(ensureTemplateLocal('sales/missing', { baseDir: base, deps: { clone } })).rejects.toThrow(
      /not found/i,
    );

    expect(registry.cleanup).toHaveBeenCalled();
    // Stage-then-rename: no partial dir, no staging residue.
    expect(fs.existsSync(path.join(base, 'sales', 'missing'))).toBe(false);
    expect(fs.readdirSync(base).filter((entry) => entry.startsWith('.tpl-staging-'))).toEqual([]);
  });

  it('propagates a clone failure and leaves templates/ untouched', async () => {
    const clone = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(ensureTemplateLocal('sales/sdr', { baseDir: base, deps: { clone } })).rejects.toThrow('offline');

    expect(fs.readdirSync(base)).toEqual([]);
  });
});

describe('fetchRegistryIndex', () => {
  // Wire shape: grouped by category; parsing flattens to `templates`.
  const index = {
    schema: 1,
    categories: { sales: [{ ref: 'sales/sdr', name: 'sdr', version: '1.0.0', description: 'An SDR agent' }] },
  };

  function fetchReturning(body: unknown, ok = true, status = 200): typeof fetch & ReturnType<typeof vi.fn> {
    return vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response) as typeof fetch &
      ReturnType<typeof vi.fn>;
  }

  it('caches within the TTL and refetches after it', async () => {
    let clock = 1_000;
    const now = (): number => clock;
    const fetchImpl = fetchReturning(index);

    const first = await fetchRegistryIndex({ fetchImpl, now });
    expect(first.templates).toEqual(index.categories.sales);
    clock += REGISTRY_INDEX_TTL_MS - 1;
    const second = await fetchRegistryIndex({ fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    clock += 2;
    await fetchRegistryIndex({ fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects an index with an unknown schema version', async () => {
    const fetchImpl = fetchReturning({ schema: 2, categories: {} });
    await expect(fetchRegistryIndex({ fetchImpl })).rejects.toThrow(/schema 2 requires a newer NanoClaw/);
  });

  it('rejects an entry filed under the wrong category', async () => {
    const fetchImpl = fetchReturning({
      schema: 1,
      categories: { data: [{ ref: 'sales/sdr', name: 'sdr', version: '1.0.0', description: 'An SDR agent' }] },
    });
    await expect(fetchRegistryIndex({ fetchImpl })).rejects.toThrow(/outside its category "data"/);
  });

  it('rejects a non-2xx response', async () => {
    const fetchImpl = fetchReturning({}, false, 404);
    await expect(fetchRegistryIndex({ fetchImpl })).rejects.toThrow(/404/);
  });

  it('negative-caches a failure, then fetches again after the failure TTL', async () => {
    let clock = 1_000;
    const now = (): number => clock;
    const fetchImpl = fetchReturning({}, false, 404);

    await expect(fetchRegistryIndex({ fetchImpl, now })).rejects.toThrow(/404/);
    clock += REGISTRY_INDEX_FAILURE_TTL_MS - 1;
    // Within the failure TTL: rethrows without touching the network.
    await expect(fetchRegistryIndex({ fetchImpl, now })).rejects.toThrow(/404/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock += 2;
    await expect(fetchRegistryIndex({ fetchImpl, now })).rejects.toThrow(/404/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
