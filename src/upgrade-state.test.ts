import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-upgrade-state' };
});

const TEST_DIR = '/tmp/nanoclaw-test-upgrade-state';

import {
  enforceUpgradeTripwire,
  getCodeIdentity,
  getCodeVersion,
  isUpgradeCurrent,
  markerPath,
  readUpgradeState,
  writeUpgradeState,
} from './upgrade-state.js';

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('upgrade-state', () => {
  it('getCodeVersion reads the package.json version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(getCodeVersion()).toBe(pkg.version);
  });

  it('readUpgradeState returns null when the marker is absent', () => {
    expect(readUpgradeState()).toBeNull();
  });

  it('write then read round-trips, with version/commit/tree/via/updatedAt', () => {
    const written = writeUpgradeState({ version: '9.9.9', via: 'test' });
    expect(written).toMatchObject({ version: '9.9.9', via: 'test' });
    expect(written.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(written.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(written.updatedAt).toBeTruthy();
    expect(readUpgradeState()).toEqual(written);
  });

  it('write defaults the version to the code version', () => {
    expect(writeUpgradeState({ via: 'test' }).version).toBe(getCodeVersion());
  });

  it('binds the marker to the exact Git commit and tree', () => {
    expect(writeUpgradeState({ via: 'test' })).toMatchObject(getCodeIdentity());
  });

  it('can stamp and validate a recovery marker when Git is unavailable', () => {
    const projectRoot = fs.mkdtempSync('/tmp/nanoclaw-no-git-');
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    try {
      expect(getCodeIdentity(projectRoot)).toEqual({ version: '1.2.3', commit: 'unknown', tree: 'unknown' });
      expect(writeUpgradeState({ via: 'recovery', projectRoot })).toMatchObject({
        version: '1.2.3',
        commit: 'unknown',
        tree: 'unknown',
      });
      expect(isUpgradeCurrent(projectRoot)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('isUpgradeCurrent: false when absent, false on mismatch, true on match', () => {
    expect(isUpgradeCurrent()).toBe(false);
    writeUpgradeState({ version: '0.0.0-nope', via: 'test' });
    expect(isUpgradeCurrent()).toBe(false);
    writeUpgradeState({ version: getCodeVersion(), via: 'test' });
    expect(isUpgradeCurrent()).toBe(true);
  });

  it('rejects a legacy version-only marker even when the package version matches', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(TEST_DIR, 'upgrade-state.json'),
      JSON.stringify({ version: getCodeVersion(), updatedAt: new Date().toISOString(), via: 'legacy' }),
    );
    expect(isUpgradeCurrent()).toBe(false);
  });

  it('treats a corrupt marker as absent (fails closed, never throws)', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, 'upgrade-state.json'), '{ this is not json');
    expect(() => readUpgradeState()).not.toThrow();
    expect(readUpgradeState()).toBeNull();
    expect(isUpgradeCurrent()).toBe(false);
  });

  it('markerPath is upgrade-state.json under the data dir', () => {
    expect(markerPath()).toBe(path.join(TEST_DIR, 'upgrade-state.json'));
  });

  it('enforceUpgradeTripwire exits when not current and passes when current', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // No marker → trips.
    expect(() => enforceUpgradeTripwire()).toThrow('exit:1');

    // Stale marker → trips.
    writeUpgradeState({ version: '0.0.0-nope', via: 'test' });
    expect(() => enforceUpgradeTripwire()).toThrow('exit:1');

    // Matching marker → passes.
    writeUpgradeState({ version: getCodeVersion(), via: 'test' });
    expect(() => enforceUpgradeTripwire()).not.toThrow();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
