/**
 * Integration test for the deltachat channel's single reach-in: the
 * self-registration import in the `src/channels/index.ts` barrel. Importing the
 * barrel runs deltachat.ts's top-level `registerChannelAdapter('deltachat', …)`;
 * without the import the channel is silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './deltachat.js';` line is deleted, or the barrel fails to evaluate for
 * any reason (so the channel genuinely would not register), this goes red. A
 * structural check of the import line would falsely pass in that second case.
 *
 * Importing the barrel is safe: registration is a pure top-level call, and
 * deltachat.ts only instantiates DeltaChatOverJsonRpc inside setup() (run at host
 * startup), never at import — so nothing spawns here. It does require the adapter
 * package to be installed, which holds in a composed install: the skill's
 * `pnpm install` step runs before this test in the apply flow.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('deltachat channel registration', () => {
  it('registers deltachat via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('deltachat');
  });
});
