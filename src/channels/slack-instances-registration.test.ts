/**
 * Guard for the native SLACK_INSTANCES registrations (slack.ts).
 *
 * Integration points under guard:
 *  1. The barrel reach-in — `import './slack.js';` in src/channels/index.ts.
 *     Importing the real barrel must run slack.ts's top-level SLACK_INSTANCES
 *     loop; if the import line is deleted, or the barrel fails to evaluate
 *     (e.g. @chat-adapter/slack uninstalled), the instance keys are absent
 *     and this goes red.
 *  2. The shared declaration — every `slack-<name>` registration must carry
 *     the same SLACK_DEFAULTS declaration as the default Slack app (declared
 *     defaults, not the core fallback). hasDeclaredChannelDefaults()
 *     distinguishes a declared entry from fallbackChannelDefaults(), and
 *     `group.threads === true` is the field where the two differ with no
 *     live adapter (fallback resolves threads to false).
 *  3. The shared factory — the per-name factory delegates to
 *     createSlackBridge, whose credential path is driven for real here: with
 *     no SLACK_BOT_TOKEN_<NAME> in .env the factory returns null (the
 *     registry's "credentials missing, skipping" path). The non-null leg —
 *     the typed createSlackBridge({envKeySuffix, instanceKey}) call — is
 *     guarded by the build, which fails if the factory export or its options
 *     shape drifts.
 *
 * SLACK_INSTANCES is read from `.env` at module import (readEnvFile reads
 * process.cwd()/.env, never process.env), so the test chdirs into a temp dir
 * carrying a crafted .env BEFORE dynamically importing the barrel. Vitest's
 * per-file process isolation keeps the chdir and the module cache local to
 * this file.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { getChannelDefaults, getRegisteredChannelNames, hasDeclaredChannelDefaults } from './channel-registry.js';

const originalCwd = process.cwd();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-instances-'));
  writeFileSync(join(dir, '.env'), 'SLACK_INSTANCES=alpha,gh-bot\n');
  process.chdir(dir);
  await import('./index.js'); // the real barrel — triggers every channel's self-registration
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe('slack multi-instance registration', () => {
  it('registers a slack-<name> adapter per SLACK_INSTANCES entry via the channel barrel', () => {
    const names = getRegisteredChannelNames();
    expect(names).toContain('slack-alpha');
    expect(names).toContain('slack-gh-bot');
    // The default app's registration is untouched.
    expect(names).toContain('slack');
  });

  it("every instance registration declares the default app's SLACK_DEFAULTS (not the core fallback)", () => {
    for (const key of ['slack-alpha', 'slack-gh-bot']) {
      expect(hasDeclaredChannelDefaults(key)).toBe(true);
      const defaults = getChannelDefaults(key);
      // One declaration, shared with the default app — a drifting private
      // copy of the defaults would fail this even with equal-looking fields
      // elsewhere.
      expect(defaults).toEqual(getChannelDefaults('slack'));
      // group.threads true is SLACK_DEFAULTS; the no-live-adapter fallback
      // would resolve threads:false. Engagement fields ride along.
      expect(defaults.group.threads).toBe(true);
      expect(defaults.group.engageMode).toBe('mention-sticky');
      expect(defaults.dm).toMatchObject({ engageMode: 'pattern', engagePattern: '.', threads: false });
      expect(defaults.mentions).toBe('platform');
    }
  });
});

describe('instance factory (via the shared createSlackBridge)', () => {
  // Imported dynamically, and only in this describe, which runs AFTER the
  // registration tests above: a static import of ./slack.js would run the
  // registration loop as a side effect of this test file itself (with the
  // original cwd's .env) and mask a deleted barrel line. Via the barrel the
  // module is already in the cache, so this import is a no-op read.
  it('returns null when the instance token set is absent — the registry "credentials missing" path', async () => {
    const { slackInstanceBridgeFactory } = await import('./slack.js');
    // No SLACK_BOT_TOKEN_ALPHA in the temp .env: the shared factory must
    // report missing credentials rather than construct a token-less bridge.
    expect(slackInstanceBridgeFactory('alpha')).toBeNull();
  });

  it('maps an instance name to its env-key suffix (uppercased, dashes → underscores)', async () => {
    const { instanceEnvKeySuffix } = await import('./slack.js');
    expect(instanceEnvKeySuffix('gh-bot')).toBe('GH_BOT');
    expect(instanceEnvKeySuffix('dana')).toBe('DANA');
  });
});
