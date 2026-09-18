/**
 * Guard for the native TELEGRAM_INSTANCES registrations (telegram.ts).
 *
 * What breaks without it: a second bot listed in .env never registers, or
 * registers from the wrong env key, or starts a second getUpdates poller on a
 * token another bot already holds (Telegram answers that with 409 conflicts),
 * and nothing at boot says so.
 *
 * Integration points under guard, each with its kill condition:
 *  1. The barrel reach-in, `import './telegram.js';` in src/channels/index.ts.
 *     Importing the real barrel must run telegram.ts's top-level
 *     TELEGRAM_INSTANCES loop; delete the import line (or the loop) and the
 *     `telegram-<name>` keys are absent. The default bot registers before any
 *     named one (registry insertion order is boot order), so on a duplicate
 *     token the default bot is the one that keeps it.
 *  2. The shared declaration: every `telegram-<name>` registration carries the
 *     same TELEGRAM_DEFAULTS as the default bot. Drop `defaults:` from the
 *     loop's registerChannelAdapter call and hasDeclaredChannelDefaults() is
 *     false for the instance keys.
 *  3. The env-key mapping and the shared factory: TELEGRAM_BOT_TOKEN_GH_BOT
 *     (name uppercased, dashes to underscores) makes `gh-bot` construct
 *     through createTelegramBridge with instance 'telegram-gh-bot'; a name
 *     without a token returns null (the registry's "credentials missing,
 *     skipping" path). Break instanceEnvKeySuffix or the `_${suffix}` join
 *     and gh-bot returns null.
 *  4. Token dedupe: a name whose token is already claimed returns null. Delete
 *     the claimedBotIds check and `twin` constructs a second poller on
 *     gh-bot's token.
 *  5. Name validation: an entry outside ^[a-z0-9][a-z0-9-]*$ is skipped.
 *  6. The default bot: the zero-suffix createTelegramBridge() call (what the
 *     'telegram' registration invokes) builds from TELEGRAM_BOT_TOKEN under
 *     registry key 'telegram', and it claims that token before any named
 *     instance. Change that default to a suffixed call, or drop the
 *     claimed-token check, and `dup` (same token as the default bot) turns
 *     this red.
 *
 * TELEGRAM_INSTANCES is read from `.env` at module import (readEnvFile reads
 * process.cwd()/.env, never process.env), so the test chdirs into a temp dir
 * carrying a crafted .env BEFORE dynamically importing the barrel. Vitest's
 * per-file process isolation keeps the chdir and the module cache local to
 * this file. fetch is stubbed because constructing a bridge kicks off the
 * bot-username lookup (getMe); nothing here may reach the network.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getChannelDefaults, getRegisteredChannelNames, hasDeclaredChannelDefaults } from './channel-registry.js';

const originalCwd = process.cwd();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-instances-'));
  writeFileSync(
    join(dir, '.env'),
    [
      'TELEGRAM_INSTANCES=mega,gh-bot,twin,dup,Bad_Name',
      'TELEGRAM_BOT_TOKEN=100:default-bot-token-AAAAAAAAAAAAAAAAAAA',
      'TELEGRAM_BOT_TOKEN_GH_BOT=200:gh-bot-token',
      // Same value as gh-bot: must be refused, never a second poller.
      'TELEGRAM_BOT_TOKEN_TWIN=200:gh-bot-token',
      // Same value as the default bot: refused too, the default bot claimed it first.
      'TELEGRAM_BOT_TOKEN_DUP=100:default-bot-token-AAAAAAAAAAAAAAAAAAA',
      '',
    ].join('\n'),
  );
  process.chdir(dir);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { username: 'bot' } }), { status: 200 })),
  );
  await import('./index.js'); // the real barrel, triggers every channel's self-registration
});

afterAll(() => {
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
});

describe('telegram multi-instance registration', () => {
  it('registers a telegram-<name> adapter per TELEGRAM_INSTANCES entry via the channel barrel', () => {
    const names = getRegisteredChannelNames();
    expect(names).toContain('telegram-mega');
    expect(names).toContain('telegram-gh-bot');
    // The default bot's registration is untouched, and it boots first.
    expect(names).toContain('telegram');
    expect(names.indexOf('telegram')).toBeLessThan(names.indexOf('telegram-mega'));
    // Outside ^[a-z0-9][a-z0-9-]*$: skipped, not registered under any key.
    expect(names.filter((n) => n.toLowerCase() === 'telegram-bad_name')).toEqual([]);
  });

  it("every instance registration declares the default bot's TELEGRAM_DEFAULTS (not the core fallback)", () => {
    for (const key of ['telegram-mega', 'telegram-gh-bot']) {
      expect(hasDeclaredChannelDefaults(key)).toBe(true);
      const defaults = getChannelDefaults(key);
      // One declaration, shared with the default bot.
      expect(defaults).toEqual(getChannelDefaults('telegram'));
      // group.engageMode 'mention' is TELEGRAM_DEFAULTS; the no-live-adapter
      // fallback would resolve 'mention-sticky'.
      expect(defaults.group.engageMode).toBe('mention');
      expect(defaults.dm).toMatchObject({ engageMode: 'pattern', engagePattern: '.', threads: false });
    }
  });
});

describe('instance factory (via the shared createTelegramBridge)', () => {
  // Imported dynamically, and only once this describe starts, which is AFTER
  // the registration tests above: a static import of ./telegram.js would run
  // the registration loop as a side effect of this test file itself (with the
  // original cwd's .env) and mask a deleted barrel line. Via the barrel the
  // module is already in the cache, so this import is a no-op read.
  let tg: typeof import('./telegram.js');
  beforeAll(async () => {
    tg = await import('./telegram.js');
  });

  it('returns null when the instance token is absent: the registry "credentials missing" path', () => {
    // No TELEGRAM_BOT_TOKEN_MEGA in the temp .env.
    expect(tg.telegramInstanceBridgeFactory('mega')).toBeNull();
  });

  it('builds a named instance from TELEGRAM_BOT_TOKEN_<NAME> (uppercased, dashes to underscores)', () => {
    expect(tg.telegramInstanceBridgeFactory('gh-bot')).toMatchObject({
      channelType: 'telegram',
      instance: 'telegram-gh-bot',
    });
  });

  it('skips a name whose token another instance already holds: one poller per token', () => {
    // gh-bot claimed 200:gh-bot-token in the test above, as it would at boot.
    expect(tg.telegramInstanceBridgeFactory('twin')).toBeNull();
  });

  describe('default bot claims TELEGRAM_BOT_TOKEN before any named instance', () => {
    it("builds the 'telegram' adapter from TELEGRAM_BOT_TOKEN and refuses a named instance on the same token", () => {
      const adapter = tg.createTelegramBridge();
      expect(adapter).not.toBeNull();
      expect(adapter).toMatchObject({ name: 'telegram', channelType: 'telegram' });
      expect(adapter!.instance).toBeUndefined();
      // dup's token is the default bot's: refused, the default bot keeps its poller.
      expect(tg.telegramInstanceBridgeFactory('dup')).toBeNull();
    });
  });
});
