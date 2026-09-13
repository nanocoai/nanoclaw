import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../src/config.js';
import {
  addMarketplace,
  removeMarketplace,
  installPlugin,
  uninstallPlugin,
  listMarketplaces,
  listEnabledPlugins,
  parsePluginSpec,
} from './plugins-config.js';
import { writeContainerConfig } from '../../src/container-config.js';

let testFolders: string[];

beforeEach(() => {
  testFolders = [];
});

afterEach(() => {
  for (const folder of testFolders) {
    fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
  }
});

function makeFolder(suffix: string): string {
  const folder = `__test-${process.pid}-${Date.now()}-${suffix}`;
  testFolders.push(folder);
  fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
  // Seed with empty container.json.
  writeContainerConfig(folder, {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
  });
  return folder;
}

describe('parsePluginSpec', () => {
  it('parses valid name@marketplace', () => {
    expect(parsePluginSpec('foo@bar')).toEqual({ name: 'foo', marketplace: 'bar' });
  });
  it('rejects missing @', () => {
    expect(() => parsePluginSpec('foo-bar')).toThrow(/name@marketplace/);
  });
  it('rejects empty name', () => {
    expect(() => parsePluginSpec('@bar')).toThrow();
  });
  it('rejects empty marketplace', () => {
    expect(() => parsePluginSpec('foo@')).toThrow();
  });
  it('rejects marketplace with whitespace', () => {
    expect(() => parsePluginSpec('foo@bar baz')).toThrow();
  });
  it('rejects marketplace with slashes', () => {
    expect(() => parsePluginSpec('foo@bar/baz')).toThrow();
  });
  it('handles @ inside plugin name (uses last @)', () => {
    expect(parsePluginSpec('a@b@c')).toEqual({ name: 'a@b', marketplace: 'c' });
  });
});

describe('addMarketplace / listMarketplaces', () => {
  it('first add returns added=true', async () => {
    const folder = makeFolder('add1');
    const r = await addMarketplace(folder, 'mp1', {
      source: 'github',
      repo: 'a/b',
    });
    expect(r).toEqual({ added: true, replaced: false });
    const list = listMarketplaces(folder);
    expect(list.mp1?.source).toEqual({ source: 'github', repo: 'a/b' });
  });

  it('idempotent re-add returns added=false, replaced=false', async () => {
    const folder = makeFolder('add-idem');
    await addMarketplace(folder, 'mp1', { source: 'github', repo: 'a/b' });
    const r = await addMarketplace(folder, 'mp1', { source: 'github', repo: 'a/b' });
    expect(r).toEqual({ added: false, replaced: false });
  });

  it('different source replaces', async () => {
    const folder = makeFolder('add-replace');
    await addMarketplace(folder, 'mp1', { source: 'github', repo: 'old/repo' });
    const r = await addMarketplace(folder, 'mp1', { source: 'github', repo: 'new/repo' });
    expect(r).toEqual({ added: false, replaced: true });
    const list = listMarketplaces(folder);
    expect(list.mp1?.source).toMatchObject({ repo: 'new/repo' });
  });

  it('rejects invalid name', async () => {
    const folder = makeFolder('add-bad');
    await expect(
      addMarketplace(folder, 'has space', { source: 'github', repo: 'a/b' }),
    ).rejects.toThrow(/invalid characters/);
  });
});

describe('removeMarketplace', () => {
  it('removes when no plugins reference it', async () => {
    const folder = makeFolder('rm1');
    await addMarketplace(folder, 'mp1', { source: 'github', repo: 'a/b' });
    const r = await removeMarketplace(folder, 'mp1');
    expect(r).toEqual({ removed: true, blockedBy: [] });
    expect(listMarketplaces(folder).mp1).toBeUndefined();
  });

  it('returns removed=false for unknown name', async () => {
    const folder = makeFolder('rm-unknown');
    const r = await removeMarketplace(folder, 'never-added');
    expect(r.removed).toBe(false);
    expect(r.blockedBy).toEqual([]);
  });

  it('blocks when plugins reference it', async () => {
    const folder = makeFolder('rm-blocked');
    await addMarketplace(folder, 'mp1', { source: 'github', repo: 'a/b' });
    await installPlugin(folder, 'plug1@mp1');
    const r = await removeMarketplace(folder, 'mp1');
    expect(r.removed).toBe(false);
    expect(r.blockedBy).toEqual(['plug1@mp1']);
    // Marketplace still there.
    expect(listMarketplaces(folder).mp1).toBeDefined();
  });

  it('blocks listing all referencing plugins', async () => {
    const folder = makeFolder('rm-blocked-multi');
    await addMarketplace(folder, 'mp1', { source: 'github', repo: 'a/b' });
    await installPlugin(folder, 'a@mp1');
    await installPlugin(folder, 'b@mp1');
    await installPlugin(folder, 'c@mp1');
    const r = await removeMarketplace(folder, 'mp1');
    expect(r.removed).toBe(false);
    expect(r.blockedBy.sort()).toEqual(['a@mp1', 'b@mp1', 'c@mp1']);
  });
});

describe('installPlugin', () => {
  it('enables when marketplace already registered', async () => {
    const folder = makeFolder('inst1');
    await addMarketplace(folder, 'mp1', { source: 'github', repo: 'a/b' });
    const r = await installPlugin(folder, 'plug1@mp1');
    expect(r).toEqual({ wasEnabled: true, marketplaceAdded: false });
    expect(listEnabledPlugins(folder)['plug1@mp1']).toBe(true);
  });

  it('throws when marketplace not registered and no inline source', async () => {
    const folder = makeFolder('inst-no-mp');
    await expect(installPlugin(folder, 'plug1@mp1')).rejects.toThrow(/not registered/);
  });

  it('inline --source registers and enables in one shot', async () => {
    const folder = makeFolder('inst-source');
    const r = await installPlugin(folder, 'plug1@mp1', {
      source: 'github',
      repo: 'a/b',
    });
    expect(r).toEqual({ wasEnabled: true, marketplaceAdded: true });
    expect(listMarketplaces(folder).mp1).toBeDefined();
    expect(listEnabledPlugins(folder)['plug1@mp1']).toBe(true);
  });

  it('inline source updates existing marketplace if different', async () => {
    const folder = makeFolder('inst-source-update');
    await addMarketplace(folder, 'mp1', { source: 'github', repo: 'old/old' });
    const r = await installPlugin(folder, 'plug1@mp1', {
      source: 'github',
      repo: 'new/new',
    });
    expect(r.marketplaceAdded).toBe(true);
    expect(listMarketplaces(folder).mp1?.source).toMatchObject({ repo: 'new/new' });
  });

  it('idempotent re-enable returns wasEnabled=false', async () => {
    const folder = makeFolder('inst-idem');
    await addMarketplace(folder, 'mp1', { source: 'github', repo: 'a/b' });
    await installPlugin(folder, 'plug1@mp1');
    const r = await installPlugin(folder, 'plug1@mp1');
    expect(r).toEqual({ wasEnabled: false, marketplaceAdded: false });
  });

  it('rejects malformed plugin spec', async () => {
    const folder = makeFolder('inst-bad-spec');
    await expect(installPlugin(folder, 'no-at-sign')).rejects.toThrow(/name@marketplace/);
  });
});

describe('uninstallPlugin', () => {
  it('disables an enabled plugin', async () => {
    const folder = makeFolder('uninst1');
    await addMarketplace(folder, 'mp1', { source: 'github', repo: 'a/b' });
    await installPlugin(folder, 'plug1@mp1');
    const r = await uninstallPlugin(folder, 'plug1@mp1');
    expect(r.wasDisabled).toBe(true);
    expect(listEnabledPlugins(folder)['plug1@mp1']).toBeUndefined();
    // Marketplace stays.
    expect(listMarketplaces(folder).mp1).toBeDefined();
  });

  it('returns wasDisabled=false if not enabled', async () => {
    const folder = makeFolder('uninst-not-enabled');
    const r = await uninstallPlugin(folder, 'plug1@mp1');
    expect(r.wasDisabled).toBe(false);
  });

  it('after uninstall, removeMarketplace succeeds', async () => {
    const folder = makeFolder('uninst-then-rm');
    await addMarketplace(folder, 'mp1', { source: 'github', repo: 'a/b' });
    await installPlugin(folder, 'plug1@mp1');
    await uninstallPlugin(folder, 'plug1@mp1');
    const r = await removeMarketplace(folder, 'mp1');
    expect(r.removed).toBe(true);
  });
});
