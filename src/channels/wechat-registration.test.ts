/**
 * Integration test for the wechat channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs wechat.ts's
 * top-level `registerChannelAdapter('wechat', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './wechat.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * wechat is a native adapter (no Chat SDK bridge). Importing the barrel is safe:
 * registration is a pure top-level call and wechat.ts opens connections / spawns
 * subprocesses only inside setup() (run at host startup), never at import. It does
 * require the adapter package (`wechat-ilink-client`) to be installed, which holds in a composed
 * install: the skill's `pnpm install` step runs before this test — so this test also
 * implicitly guards that dependency (an unmocked import throws if the package is missing).
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('wechat channel registration', () => {
  it('registers wechat via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('wechat');
  });
});
