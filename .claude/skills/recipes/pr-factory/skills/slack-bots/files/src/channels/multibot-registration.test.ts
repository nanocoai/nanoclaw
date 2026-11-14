/**
 * pr-factory slack-bots guard — barrel registration of the supervisor and
 * tester Slack adapters.
 *
 * The skill's registration reach-in is two appended lines in the
 * `src/channels/index.ts` barrel (`import './slack-supervisor.js';` and
 * `import './slack-tester.js';`). Importing the barrel runs each module's
 * top-level `registerChannelAdapter(...)` call; without its import line the
 * adapter is silently absent at boot.
 *
 * Behavior, not structural: this imports the REAL barrel and asserts the
 * registry actually contains both adapters. It goes red on a deleted barrel
 * line, a barrel that fails to evaluate, or a missing `@chat-adapter/slack`
 * package (the unmocked import throws) — so it also covers the dependency
 * integration point. Do not mock the adapter package here.
 *
 * Importing the barrel is safe and needs no env priming: registration is a
 * pure top-level `registerChannelAdapter` call. All env-gating
 * (SLACK_SUPERVISOR_BOT_TOKEN / SLACK_TESTER_BOT_TOKEN) lives inside each
 * factory, which only runs at host startup via initChannelAdapters(). The
 * factory-level instance behavior (exact-key resolution, echo guard) is
 * guarded in slack-ignore-senders.test.ts, where the adapter package's
 * network edge is stubbed.
 *
 * The `'slack'` assertion pins this skill's prerequisite: the stock
 * /add-slack channel must be installed (this skill patches its factory).
 */
import { describe, expect, it } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

// Snapshot the registry immediately after the barrel evaluates. Registration
// must be attributable to the barrel's own import lines: statically importing
// slack-supervisor.js / slack-tester.js here (e.g. for their instance-name
// constants) would run their top-level registerChannelAdapter calls and mask
// a deleted barrel line. The constants test below uses dynamic import, which
// only evaluates after this snapshot is taken.
const namesAfterBarrel = getRegisteredChannelNames();

describe('pr-factory slack bots registration', () => {
  it('registers slack-supervisor via the channel barrel', () => {
    expect(namesAfterBarrel).toContain('slack-supervisor');
  });

  it('registers slack-tester via the channel barrel', () => {
    expect(namesAfterBarrel).toContain('slack-tester');
  });

  it('stock slack channel is present (prerequisite: /add-slack)', () => {
    expect(namesAfterBarrel).toContain('slack');
  });

  it('instance-name exports stay stable (cross-skill contract with pr-factory-core)', async () => {
    // pr-factory-core's bootstrap stamps messaging_groups.instance with these
    // values; the webhook routes /webhook/<instance> and the Chat SDK state
    // namespaces derive from them too. Renaming either breaks live installs.
    const { SUPERVISOR_INSTANCE } = await import('./slack-supervisor.js');
    const { TESTER_INSTANCE } = await import('./slack-tester.js');
    expect(SUPERVISOR_INSTANCE).toBe('slack-supervisor');
    expect(TESTER_INSTANCE).toBe('slack-tester');
  });
});
