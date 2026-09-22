/**
 * Guard for the native TEAMS_INSTANCES registrations and the 'teams' instance
 * factory (teams.ts), mirroring slack-instances-registration.test.ts.
 *
 * Integration points under guard:
 *  1. The import-time TEAMS_INSTANCES loop — one `teams-<name>` registration
 *     per listed name, beside the default `teams` registration.
 *  2. The shared declaration — every `teams-<name>` registration carries the
 *     same TEAMS_DEFAULTS declaration as the default app (declared defaults,
 *     not the core fallback): `group.threads === true` is where the two
 *     differ with no live adapter.
 *  3. The shared factory — the per-name factory resolves credentials through
 *     the provider at start; with no TEAMS_APP_ID_<NAME> in .env it resolves
 *     null (the registry's "credentials missing, skipping" path).
 *  4. The instance factory seam — `registerChannelInstanceFactory('teams', …)`
 *     ran at import, so a stored connection can be turned into an instance.
 *
 * teams.ts is imported directly (not through the barrel): Teams is opt-in on
 * the channels branch (its barrel line is commented out) and /add-teams
 * appends the import on install.
 *
 * TEAMS_INSTANCES is read from `.env` at module import (readEnvFile reads
 * process.cwd()/.env, never process.env), so the test chdirs into a temp dir
 * carrying a crafted .env BEFORE importing the module.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getChannelDefaults,
  getChannelInstanceFactory,
  getRegisteredChannelNames,
  hasDeclaredChannelDefaults,
} from './channel-registry.js';

const originalCwd = process.cwd();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teams-instances-'));
  writeFileSync(join(dir, '.env'), 'TEAMS_INSTANCES=hq,eu-west\n');
  process.chdir(dir);
  await import('./teams.js');
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe('teams multi-instance registration', () => {
  it('registers a teams-<name> adapter per TEAMS_INSTANCES entry beside the default app', () => {
    const names = getRegisteredChannelNames();
    expect(names).toContain('teams-hq');
    expect(names).toContain('teams-eu-west');
    expect(names).toContain('teams');
  });

  it("every instance registration declares the default app's TEAMS_DEFAULTS (not the core fallback)", () => {
    for (const key of ['teams-hq', 'teams-eu-west']) {
      expect(hasDeclaredChannelDefaults(key)).toBe(true);
      const defaults = getChannelDefaults(key);
      expect(defaults).toEqual(getChannelDefaults('teams'));
      expect(defaults.group.threads).toBe(true);
      expect(defaults.group.engageMode).toBe('mention');
      expect(defaults.dm).toMatchObject({ engageMode: 'pattern', engagePattern: '.', threads: false });
      expect(defaults.mentions).toBe('platform');
    }
  });

  it('registers the instance factory an operator surface builds connections through', () => {
    expect(getChannelInstanceFactory('teams')).toBeTypeOf('function');
  });
});

describe('instance factory (via the shared createTeamsBridge)', () => {
  it('resolves null when the instance credential set is absent — the registry "credentials missing" path', async () => {
    const { teamsInstanceBridgeFactory } = await import('./teams.js');
    await expect(teamsInstanceBridgeFactory('hq')).resolves.toBeNull();
  });
});
