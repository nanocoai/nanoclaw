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

  it('write then read round-trips, with version/via/updatedAt', () => {
    const written = writeUpgradeState({ version: '9.9.9', via: 'test' });
    expect(written).toMatchObject({ version: '9.9.9', via: 'test' });
    expect(written.updatedAt).toBeTruthy();
    expect(readUpgradeState()).toEqual(written);
  });

  it('write defaults the version to the code version', () => {
    expect(writeUpgradeState({ via: 'test' }).version).toBe(getCodeVersion());
  });

  it('isUpgradeCurrent: false when absent, false on mismatch, true on match', () => {
    expect(isUpgradeCurrent()).toBe(false);
    writeUpgradeState({ version: '0.0.0-nope', via: 'test' });
    expect(isUpgradeCurrent()).toBe(false);
    writeUpgradeState({ version: getCodeVersion(), via: 'test' });
    expect(isUpgradeCurrent()).toBe(true);
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
