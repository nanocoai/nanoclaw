/**
 * Guards the ChannelDefaults declarations every channel module registers.
 *
 * Each module is imported directly (not via the barrel — many imports there
 * are commented out until the corresponding /add-<channel> skill installs
 * them). Importing runs the top-level registerChannelAdapter(name, { …,
 * defaults }) call; factories are never invoked, so getChannelDefaults
 * resolves from the registration tier.
 *
 * Two exclusions, both import-time-only (typecheck still covers them):
 *  - deltachat: its runtime dep (@deltachat/stdio-rpc-server) is
 *    skill-installed and absent from this branch's package.json.
 *  - matrix: @beeper/chat-adapter-matrix's dist has an extensionless ESM
 *    import (matrix-js-sdk/lib/http-api/errors) that Node/vitest can't
 *    resolve, so the module can't be evaluated in this environment.
 */
import { describe, it, expect } from 'vitest';

import type { ChannelDefaults } from './adapter.js';
import { getChannelDefaults } from './channel-registry.js';

import './cli.js';
import './discord.js';
import './slack.js';
import './telegram.js';
import './github.js';
import './linear.js';
import './gchat.js';
import './teams.js';
import './whatsapp-cloud.js';
import './resend.js';
import './webex.js';
import './imessage.js';
import './whatsapp.js';
import './signal.js';
import './emacs.js';
import './wechat.js';

/** channel → key facts of its declaration (the parts that differ per channel). */
const EXPECTED: Record<
  string,
  { groupMode: ChannelDefaults['group']['engageMode']; groupThreads: boolean; mentions: ChannelDefaults['mentions'] }
> = {
  cli: { groupMode: 'pattern', groupThreads: false, mentions: 'never' },
  discord: { groupMode: 'mention-sticky', groupThreads: true, mentions: 'platform' },
  slack: { groupMode: 'mention-sticky', groupThreads: true, mentions: 'platform' },
  telegram: { groupMode: 'mention', groupThreads: false, mentions: 'platform' },
  github: { groupMode: 'mention', groupThreads: true, mentions: 'platform' },
  linear: { groupMode: 'pattern', groupThreads: true, mentions: 'never' },
  gchat: { groupMode: 'mention', groupThreads: true, mentions: 'platform' },
  teams: { groupMode: 'mention', groupThreads: true, mentions: 'platform' },
  'whatsapp-cloud': { groupMode: 'mention', groupThreads: false, mentions: 'platform' },
  resend: { groupMode: 'pattern', groupThreads: false, mentions: 'dm-only' },
  webex: { groupMode: 'mention', groupThreads: true, mentions: 'platform' },
  imessage: { groupMode: 'pattern', groupThreads: false, mentions: 'dm-only' },
  // whatsapp is env-computed; the test env has no ASSISTANT_HAS_OWN_NUMBER=true
  // so the shared-number declaration applies. (Dedicated mode is covered by
  // the adapter's own tests once PR8 lands the behavior split.)
  whatsapp: { groupMode: 'pattern', groupThreads: false, mentions: 'never' },
  // signal emits top-level isGroup/isMention (DM→true, group→account tagged);
  // non-threaded, so group mode is 'mention', never sticky.
  signal: { groupMode: 'mention', groupThreads: false, mentions: 'platform' },
  emacs: { groupMode: 'pattern', groupThreads: false, mentions: 'never' },
  // wechat emits isMention only for DMs (shared account, no group-mention
  // metadata), so mention wirings are dm-only and groups stay name-pattern.
  wechat: { groupMode: 'pattern', groupThreads: false, mentions: 'dm-only' },
};

describe('channel default declarations', () => {
  for (const [channel, expected] of Object.entries(EXPECTED)) {
    describe(channel, () => {
      const decl = getChannelDefaults(channel);

      it('declares the expected group mode, threads, and mention capability', () => {
        expect(decl.group.engageMode).toBe(expected.groupMode);
        expect(decl.group.threads).toBe(expected.groupThreads);
        expect(decl.mentions).toBe(expected.mentions);
      });

      it('declares a valid pattern default in every pattern-mode context', () => {
        for (const ctx of [decl.dm, decl.group]) {
          if (ctx.engageMode === 'pattern') {
            expect(ctx.engagePattern).toBeTruthy();
            // Must compile once {name} is substituted (resolveWiringDefaults
            // regex-escapes the name, so any literal stands in).
            expect(() => new RegExp(ctx.engagePattern!.replaceAll('{name}', 'Agent'))).not.toThrow();
          }
        }
      });

      it('never declares a mention mode the channel says can never fire', () => {
        if (expected.mentions === 'never') {
          expect(decl.dm.engageMode).toBe('pattern');
          expect(decl.group.engageMode).toBe('pattern');
        }
      });

      it('DMs engage on every message', () => {
        expect(decl.dm.engageMode).toBe('pattern');
        expect(decl.dm.engagePattern).toBe('.');
      });
    });
  }
});
